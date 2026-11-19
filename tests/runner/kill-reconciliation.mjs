#!/usr/bin/env node
// Real native edit completion -> durable local outbox -> SIGKILL -> ordinary replay.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareProject, startRustConcierge, testingClientToken, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const binary = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'target/debug/loom-node')
const cap = 1024 * 1024
const paths = Object.fromEntries(['challenge', 'register', 'heartbeat', 'acknowledge', 'artifacts', 'reports']
  .map(name => [name, `POST /api/v1/nodes/${name}`]))
paths.poll = 'POST /api/v1/nodes/assignments/poll'
const allowed = new Set(Object.values(paths))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const cloneJson = value => JSON.parse(JSON.stringify(value))
const canonical = value => JSON.stringify(sortCanonical(value))
function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortCanonical(value[key])]))
  return value
}
const secrets = new Set()
const children = new Set()
const processHistory = []
const result = { schema: 'loom.native-kill-reconciliation.v1', overall: 'NOT RUN',
  scope: 'actual durable succeeded completion and local outbox, before any admission or central evidence',
  not_claimed: ['physical network loss', 'multi-host', 'DSH profile/model', 'global exactly-once'] }
let root, evidenceDir, center, proxy, first, proxyStopped = null, centerStopped = null
const redact = value => {
  let text = String(value)
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted-test-secret]')
  return text.replace(/authorization\s*[:=]\s*bearer\s+\S+/gi, 'authorization: [redacted]')
}
async function bounded(promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
function launch(name, args, enrollment) {
  if (enrollment) secrets.add(enrollment)
  const child = spawn(binary, args, { cwd: root, env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  const entry = { name, child, stdout: '', stderr: '', result: null, timedOut: false }
  children.add(entry)
  child.once('error', error => { entry.spawnError = redact(error.message) })
  for (const [key, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', chunk => { if (entry[key].length < cap) entry[key] += String(chunk).slice(0, cap - entry[key].length) })
  }
  entry.exited = new Promise(resolve => child.once('exit', (code, signal) => {
    entry.result = { code, signal }; children.delete(entry); processHistory.push({ name: entry.name, code, signal }); resolve(entry)
  }))
  return entry
}
function processPublic(entry) {
  return { name: entry.name, pid: entry.child.pid, result: entry.result, timedOut: entry.timedOut,
    stdout: redact(entry.stdout).slice(0, 4096), stderr: redact(entry.stderr).slice(0, 4096), spawn_error: entry.spawnError }
}
async function exitWithin(entry, ms = 20000) {
  let timer
  try {
    const arrived = await Promise.race([entry.exited.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => { entry.timedOut = true; resolve(false) }, ms)
    })])
    assert.ok(arrived && entry.result, `${entry.name} did not exit: ${JSON.stringify(processPublic(entry))}`)
    assert.equal(entry.timedOut, false, `${entry.name} cannot pass on SIGTERM/timeout`)
  } finally { clearTimeout(timer) }
  return entry
}
async function complete(entry) {
  await exitWithin(entry)
  assert.equal(entry.result.code, 0, JSON.stringify(processPublic(entry)))
  assert.equal(entry.result.signal, null)
}
async function admin(method, route, body) {
  const response = await fetch(`${center.baseUrl}/api/v1${route}`, {
    method, headers: { authorization: `Bearer ${center.clientToken}`, accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.length <= cap)
  const value = JSON.parse(bytes.toString('utf8'))
  assert.ok(response.ok, `${method} ${route}: ${response.status}: ${JSON.stringify(value.error)}`)
  return value
}
function receive(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0, done = false
    const fail = error => { if (!done) { done = true; request.destroy(); reject(error) } }
    request.on('data', chunk => { length += chunk.length; if (length > cap) fail(new Error('proxy body exceeds 1 MiB')); else chunks.push(chunk) })
    request.once('error', fail)
    request.once('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
  })
}
function forward(upstream, incoming, body) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(incoming.url, upstream), {
      path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false }, resolve)
    outgoing.once('error', reject)
    outgoing.setTimeout(30000, () => outgoing.destroy(new Error('upstream timeout')))
    outgoing.end(body)
  })
}
async function responseBytes(response) {
  const chunks = []; let length = 0
  for await (const chunk of response) { length += chunk.length; assert.ok(length <= cap); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
async function startProxy(upstream, expected) {
  const counters = new Map(); const sockets = new Set(); const pending = new Set()
  const publicGates = []; const upstreamCounts = new Map()
  let heldResolve, releaseResolve, forwardedAcks = 0, heldCount = 0, closing = false
  let deadline, reopening = false, acceptedAck
  let heldAuthorization, heldAckBody
  const held = new Promise(resolve => { heldResolve = resolve })
  const release = () => { clearTimeout(deadline); releaseResolve?.() }
  const server = createServer(async (request, response) => {
    const key = `${request.method} ${request.url.split('?', 1)[0]}`
    counters.set(key, (counters.get(key) || 0) + 1)
    let upstreamResponse
    try {
      assert.ok(allowed.has(key), `unapproved native route ${key}`)
      const bytes = await receive(request)
      // Both pre-spawn/final cancellation observations are forwarded unchanged.
      // Hold only the first-owner ordinary ACK before its real upstream call.
      if (key === paths.acknowledge) {
        const body = JSON.parse(bytes.toString('utf8'))
        assert.equal(body.ticket_id, expected.ticketId)
        assert.equal(body.assignment_id, expected.assignmentId)
        assert.equal(body.node_id, expected.nodeId)
        assert.equal(body.installation_id, expected.installationId)
        assert.equal(body.lease_id, expected.leaseId)
        assert.equal(body.lease_epoch, expected.leaseEpoch)
        assert.equal(body.accepted, true)
        assert.equal(body.acknowledgement, 'accepted')
        assert.notEqual(body.cancel_requested, true)
        assert.notEqual(body.cancellation, true)
        if (!reopening) {
          assert.equal(heldCount, 0, 'only the first-owner ordinary ACK is withheld')
          heldCount = 1
          assert.match(request.headers.authorization || '', /^Bearer .+/)
          heldAuthorization = request.headers.authorization
          heldAckBody = bytes.toString('utf8')
          heldResolve({ ticket_id: body.ticket_id, assignment_id: body.assignment_id,
            node_id: body.node_id, lease_id: body.lease_id, lease_epoch: body.lease_epoch })
          pending.add(response)
          deadline = setTimeout(release, 20000)
          await new Promise(resolve => { releaseResolve = resolve })
          pending.delete(response)
          if (closing || request.destroyed || response.destroyed) return
        }
      }
      upstreamCounts.set(key, (upstreamCounts.get(key) || 0) + 1)
      upstreamResponse = await forward(upstream, request, bytes)
      const bytesOut = await responseBytes(upstreamResponse)
      if (key === paths.acknowledge) {
        forwardedAcks++
        const value = JSON.parse(bytesOut.toString('utf8'))
        assert.ok(upstreamResponse.statusCode === 200 && value.accepted === true, 'real recovering ACK must be accepted')
        assert.ok(Date.parse(value.acknowledged_at))
        acceptedAck = { accepted: true, acknowledged_at: value.acknowledged_at, duplicate: value.duplicate ?? null }
      }
      if (reopening && ((key === paths.acknowledge && upstreamResponse.statusCode === 200) || key === paths.artifacts || key === paths.reports)) {
        publicGates.push({ key, status: upstreamResponse.statusCode })
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      response.end(bytesOut)
    } catch (error) {
      upstreamResponse?.destroy()
      if (closing || request.destroyed || response.destroyed) { response.destroy(); return }
      result.proxyFailures ||= []
      result.proxyFailures.push({ route: key, error: redact(error.message) })
      response.writeHead(504, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify({ error: { code: 'owned_proxy_failure', message: 'forwarding failed' } }))
    }
  })
  server.keepAliveTimeout = 250; server.headersTimeout = 2000; server.requestTimeout = 30000
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`, held, release, counters, publicGates,
    releaseHeldAck() { assert.equal(heldCount, 1); assert.equal(first?.result?.signal, 'SIGKILL'); release(); reopening = true },
    count: key => counters.get(key) || 0, heldCount: () => heldCount,
    upstreamCount: key => upstreamCounts.get(key) || 0,
    acceptedAck: () => acceptedAck,
    duplicateAdmission: () => ({ authorization: heldAuthorization, body: heldAckBody }),
    forwardedAckCount: () => forwardedAcks,
    close() { closing = true; release(); for (const response of pending) response.destroy(); pending.clear();
      for (const socket of sockets) socket.destroy()
      return new Promise(resolve => server.close(resolve)) } }
}
async function readState() {
  const state = JSON.parse(await readFile(join(root, 'state', 'node-state.json'), 'utf8'))
  assert.equal(state.version, 1)
  return state
}
function openDb() { return new DatabaseSync(join(center.dataDir, 'loom.sqlite3'), { readOnly: true }) }
function publicTicket(detail) {
  return { id: detail.id, status: detail.status, grant_id: detail.grant_id, grant_digest: detail.grant_digest,
    assignments: detail.assignments.map(row => ({ id: row.id, lease_id: row.lease_id, lease_epoch: row.lease_epoch,
      attempt: row.attempt, lease_expires_at: row.lease_expires_at, acknowledged_at: row.acknowledged_at, last_report_at: row.last_report_at })),
    artifacts: detail.artifacts.map(row => ({ id: row.id, assignment_id: row.assignment_id, sha256: row.sha256 })),
    reports: detail.reports.map(row => ({ id: row.id, assignment_id: row.assignment_id, request_id: row.request_id,
      lease_epoch: row.lease_epoch, state: row.state })),
    effects: detail.effects.map(row => ({ id: row.id, assignment_id: row.assignment_id, status: row.status, attempt: row.attempt })) }
}
function counts(db) {
  const count = (sql, ...args) => db.prepare(sql).get(...args).count
  return { tickets: count('SELECT COUNT(*) AS count FROM tickets'),
    assignments: count('SELECT COUNT(*) AS count FROM assignments'),
    artifacts: count('SELECT COUNT(*) AS count FROM artifacts'),
    reports: count('SELECT COUNT(*) AS count FROM reports'),
    effects: count('SELECT COUNT(*) AS count FROM effects'),
    assignment_acknowledged_audits: count("SELECT COUNT(*) AS count FROM audits WHERE action='assignment.acknowledged'") }
}
// The recovering ACK may carry a fresh request id. It uses the released real
// upstream gate, never a synthetic acceptance or direct first-owner fallback.
function startArgs(coordinator, enrollment) {
  return ['start', '--coordinator', coordinator, '--state-dir', join(root, 'state'),
    '--artifact-dir', join(root, 'artifacts'), '--project-root', `${context.projectId}=${context.projectRoot}`,
    '--once', ...(enrollment ? ['--enrollment-code', enrollment] : [])]
}
const context = {}
try {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
  root = await testingRoot()
  evidenceDir = await mkdtemp(join(tmpdir(), 'loom-native-kill-outbox-proof-'))
  await promisify(execFile)('cargo', ['build', '--offline', '--locked', '-p', 'loom-node', '--bin', 'loom-node'], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), timeout: 120000 })
  const token = testingClientToken(); secrets.add(token)
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: token } }); secrets.add(center.clientToken)
  const db = openDb()
  assert.deepEqual(counts(db), { tickets: 0, assignments: 0, artifacts: 0, reports: 0, effects: 0, assignment_acknowledged_audits: 0 })
  context.projectRoot = await prepareProject(root)
  const project = await admin('POST', '/projects', { name: 'Native durable outbox SIGKILL', root: context.projectRoot, mode: 'read_write' })
  context.projectId = project.project.id
  const mapping = `${context.projectId}=${context.projectRoot}`
  const bind = launch('bind', ['bind', '--state-dir', join(root, 'state'), '--project-root', mapping])
  await complete(bind)
  const bound = JSON.parse(bind.stdout.trim())
  assert.match(bound.node_id, /^[a-f0-9]{64}$/)
  const enrollment = await admin('POST', '/enrollment-codes', {})
  const idle = launch('initial-idle-registration', startArgs(center.baseUrl, enrollment.code), enrollment.code)
  await complete(idle)
  const identity = JSON.parse(idle.stdout.trim().split('\n')[0])
  Object.assign(context, { nodeId: identity.node_id, installationId: identity.installation_id })
  assert.equal(context.nodeId, bound.node_id)
  const binding = await admin('POST', '/project-bindings', { project_id: context.projectId, node_id: context.nodeId,
    installation_id: context.installationId, worker_id: 'default', root_scope: context.projectRoot })
  const granted = await admin('POST', '/grants', { project_id: context.projectId, project_binding_id: binding.id,
    node_id: context.nodeId, installation_id: context.installationId, worker_id: 'default', operations: ['read', 'write'] })
  context.grant = granted.grant; assert.deepEqual(context.grant.operations, ['read', 'write'])
  const content = 'SIGKILL-local-outbox-replay\n'
  assert.equal(Buffer.byteLength(content), 28, 'fixture actual target/content SHA covers these bytes')
  const ticket = await admin('POST', '/tickets', { project_id: context.projectId, node_id: context.nodeId,
    worker_id: 'default', grant_id: context.grant.id, kind: 'edit_file', relative_path: 'result.txt', content,
    objective: 'Persist actual edit and local outbox, kill before ACK, then replay originals' })
  Object.assign(context, { ticketId: ticket.id, assignmentId: ticket.assignments[0].id, expectedBytes: Buffer.from(content) })
  assert.equal(ticket.assignments.length, 1); assert.equal(ticket.status, 'running')
  await assert.rejects(readFile(join(context.projectRoot, 'result.txt')), error => error.code === 'ENOENT')
  const originalAssignment = (await admin('GET', `/tickets/${context.ticketId}`)).assignments[0]
  Object.assign(context, { leaseId: originalAssignment.lease_id, leaseEpoch: originalAssignment.lease_epoch })
  proxy = await startProxy(center.baseUrl, context); proxyStopped = false
  first = launch('durable-then-killed', startArgs(proxy.origin))
  await Promise.race([proxy.held, first.exited.then(() => { throw new Error(`first exited before ACK hold: ${JSON.stringify(processPublic(first))}`) }), sleep(20000).then(() => { throw new Error('timed out before exact ordinary ACK was held') })])
  let snapshot, detail
  await bounded((async () => {
    while (!snapshot) {
      if (first.result) throw new Error(`first exited before durable gate: ${JSON.stringify(processPublic(first))}`)
      const candidate = await readState()
      const completion = candidate.completions[context.assignmentId]
      if (completion?.state === 'succeeded' && candidate.outbox.length === 2 && candidate.active_assignment_id === null) snapshot = candidate
      else await sleep(10)
    }
  })(), 10000, 'durable completion gate')
  const assignment = snapshot.assignments[context.assignmentId]
  const completion = snapshot.completions[context.assignmentId]
  assert.equal(completion.digest, sha256(canonical({ assignment_id: context.assignmentId, lease_id: assignment.lease_id,
    lease_epoch: assignment.lease_epoch, grant_digest: assignment.grant_digest, kind: 'edit_file', relative_path: 'result.txt', content })))
  assert.equal(completion.report_enqueued, true); assert.equal(completion.cancel_acknowledged, false)
  assert.equal(completion.artifacts.length, 1); assert.equal(completion.effects.length, 1)
  assert.equal(completion.effects[0].status, 'confirmed'); assert.equal(completion.effects[0].attempt, assignment.attempt)
  assert.equal(assignment.grant_digest, context.grant.digest); assert.equal(assignment.content, content)
  assert.equal(assignment.lease_epoch, 1); assert.equal(assignment.attempt, 1)
  assert.equal(snapshot.last_assignment_id, assignment.id); assert.deepEqual(snapshot.deliveries, [])
  const artifactItem = snapshot.outbox.find(item => item.kind === 'artifact')
  const reportItem = snapshot.outbox.find(item => item.kind === 'report')
  assert.ok(artifactItem && reportItem)
  const originalReportBody = cloneJson(reportItem.body)
  assert.equal(reportItem.body.effects.length, 1)
  assert.ok(Date.parse(reportItem.body.created_at))
  assert.equal(artifactItem.body.artifact_id, artifactItem.body.metadata.artifact_id)
  assert.deepEqual(reportItem.body.artifact_ids, [artifactItem.body.artifact_id])
  assert.equal(reportItem.body.state, 'succeeded'); assert.equal(reportItem.body.requested_state, 'succeeded')
  assert.equal(reportItem.body.assignment_id, assignment.id); assert.equal(reportItem.body.attempt, assignment.attempt)
  assert.equal(reportItem.body.grant_digest, context.grant.digest)
  assert.equal(reportItem.body.effects[0].effect_id, completion.effects[0].effect_id)
  assert.equal(reportItem.body.effects[0].status, 'confirmed')
  assert.equal(reportItem.body.effects[0].input_digest, completion.effects[0].input_digest)
  assert.deepEqual(reportItem.body.evidence, reportItem.body.effects[0].evidence)
  const effect = await readFile(join(root, 'artifacts', `${completion.effects[0].effect_id}.effect.json`), 'utf8')
  const ledger = JSON.parse(effect)
  assert.equal(ledger.status, 'confirmed'); assert.deepEqual(ledger.effect, completion.effects[0])
  assert.deepEqual((await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.bin')), [`${artifactItem.body.artifact_id}.bin`])
  assert.deepEqual((await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.effect.json')), [`${completion.effects[0].effect_id}.effect.json`])
  const artifactBytes = await readFile(join(root, 'artifacts', `${artifactItem.body.artifact_id}.bin`))
  assert.equal(sha256(artifactBytes), artifactItem.body.metadata.sha256)
  assert.deepEqual(JSON.parse(artifactBytes.toString('utf8')), { path: 'result.txt', kind: 'edit_file', operation: 'replaced_project_file', target_hash: sha256(context.expectedBytes) })
  assert.deepEqual(await readFile(join(context.projectRoot, 'result.txt')), context.expectedBytes)
  assert.equal(proxy.count(paths.acknowledge), 1); assert.equal(proxy.heldCount(), 1)
  assert.equal(proxy.upstreamCount(paths.acknowledge), 0, 'the held ordinary ACK never reached the center')
  assert.ok(proxy.count(paths.poll) >= 3, 'primary, pre-spawn and final cancellation polls all progressed')
  assert.equal(proxy.count(paths.artifacts), 0); assert.equal(proxy.count(paths.reports), 0)
  detail = await admin('GET', `/tickets/${context.ticketId}`)
  assert.equal(detail.status, 'running'); assert.equal(detail.assignments[0].acknowledged_at, null)
  assert.deepEqual(detail.artifacts, []); assert.deepEqual(detail.reports, []); assert.deepEqual(detail.effects, [])
  assert.deepEqual(counts(db), { tickets: 1, assignments: 1, artifacts: 0, reports: 0, effects: 0, assignment_acknowledged_audits: 0 })
  assert.equal(db.prepare('SELECT acknowledged_at FROM assignments WHERE id=?').get(assignment.id).acknowledged_at, null)
  assert.deepEqual(publicTicket(detail).reports, []); assert.deepEqual(publicTicket(detail).artifacts, []); assert.deepEqual(publicTicket(detail).effects, [])
  result.firstKilledAfterDurable = false // Set only after the actual awaited signal.
  assert.equal(first.result, null); assert.equal(first.child.kill('SIGKILL'), true)
  await exitWithin(first)
  assert.equal(first.result.signal, 'SIGKILL'); assert.equal(first.result.code, null)
  result.firstKilledAfterDurable = true
  result.beforeKill = { ticket_status: detail.status, lease_id: assignment.lease_id, lease_expires_at: assignment.lease_expires_at,
    attempt: assignment.attempt, lease_epoch: assignment.lease_epoch, grant_digest: assignment.grant_digest,
    central_artifacts: detail.artifacts.length, central_reports: detail.reports.length, central_effects: detail.effects.length,
    ack_http_calls: 1, upstream_ack_calls: 0, local_outbox: snapshot.outbox.length }
  const closedProxy = proxy
  closedProxy.releaseHeldAck()
  const reopen = launch('reopen-original-state', startArgs(closedProxy.origin))
  await complete(reopen)
  result.reopenPublic = reopen.stdout.trim().split('\n').filter(Boolean).map(line => {
    const value = JSON.parse(line)
    return { node_id: value.node_id, installation_id: value.installation_id,
      last_assignment_id: value.last_assignment_id, outbox: value.outbox,
      completions: value.completions, heartbeat: value.heartbeat, active_assignment_id: value.active_assignment_id }
  })
  result.reopenProof = { proxy_counts: Object.fromEntries(closedProxy.counters),
    actual_upstream: Object.fromEntries([...closedProxy.counters].map(([key]) => [key, closedProxy.upstreamCount(key)])),
    before_kill_expiry: assignment.lease_expires_at,
    center_after_reopen: publicTicket(await admin('GET', `/tickets/${context.ticketId}`)) }
  assert.equal(closedProxy.count(paths.acknowledge), 2)
  assert.equal(closedProxy.upstreamCount(paths.acknowledge), 1, 'only the recovering ACK reaches the server')
  const replayAck = closedProxy.acceptedAck()
  assert.equal(replayAck.duplicate, null)
  const finalState = await readState()
  assert.deepEqual(finalState.completions[assignment.id], completion)
  assert.deepEqual(finalState.assignments[assignment.id], assignment)
  assert.equal(finalState.outbox.length, 0); assert.equal(finalState.active_assignment_id, null)
  assert.equal(finalState.deliveries.length, 2)
  for (const delivered of finalState.deliveries) {
    const original = snapshot.outbox.find(item => item.kind === delivered.kind)
    assert.equal(delivered.digest, original.digest); assert.equal(delivered.request_id, original.body.request_id)
  }
  assert.deepEqual(await readFile(join(context.projectRoot, 'result.txt')), context.expectedBytes)
  assert.deepEqual(await readFile(join(root, 'artifacts', `${artifactItem.body.artifact_id}.bin`)), artifactBytes)
  assert.deepEqual(await readFile(join(root, 'artifacts', `${completion.effects[0].effect_id}.effect.json`), 'utf8'), effect)
  const finalDetail = await admin('GET', `/tickets/${context.ticketId}`)
  assert.equal(finalDetail.status, 'succeeded'); assert.equal(finalDetail.assignments.length, 1)
  const finalAssignment = finalDetail.assignments[0]
  for (const field of ['id', 'ticket_id', 'node_id', 'worker_id', 'attempt', 'lease_id', 'lease_epoch', 'created_at'])
    assert.equal(finalAssignment[field], detail.assignments[0][field], field)
  assert.ok(Date.parse(finalAssignment.acknowledged_at) > Date.now() - 20000)
  assert.equal(finalAssignment.acknowledged_at, replayAck.acknowledged_at)
  assert.equal(finalAssignment.cancelled_at, null)
  assert.equal(finalDetail.artifacts.length, 1); assert.equal(finalDetail.reports.length, 1); assert.equal(finalDetail.effects.length, 1)
  const centralArtifact = finalDetail.artifacts[0]
  assert.equal(centralArtifact.id, artifactItem.body.artifact_id); assert.equal(centralArtifact.sha256, artifactItem.body.metadata.sha256)
  assert.equal(centralArtifact.assignment_id, assignment.id)
  const report = finalDetail.reports[0]
  assert.equal(report.request_id, reportItem.body.request_id); assert.equal(report.assignment_id, assignment.id)
  assert.equal(report.state, 'succeeded'); assert.equal(report.lease_epoch, assignment.lease_epoch)
  const receipt = db.prepare("SELECT * FROM requests WHERE route='reports' AND request_id=?").get(reportItem.body.request_id)
  assert.ok(receipt); assert.deepEqual(JSON.parse(receipt.response), { accepted: true, report_id: report.id,
    request_id: reportItem.body.request_id, ticket_status: 'succeeded', disposition: 'accepted', facts_already_existed: false })
  assert.equal(JSON.parse(receipt.response).report_id, report.id)
  assert.notEqual(report.id, reportItem.body.report_id, 'center report UUID is distinct from client report body UUID, both preserved')
  assert.deepEqual(reportItem.body, originalReportBody, 'unchanged in-memory report is transmitted after the kill')
  assert.equal(receipt.payload_digest, sha256(JSON.stringify(originalReportBody)))
  const centralEffect = finalDetail.effects[0]
  assert.equal(centralEffect.id, completion.effects[0].effect_id); assert.equal(centralEffect.status, 'confirmed')
  assert.equal(centralEffect.attempt, assignment.attempt); assert.equal(centralEffect.input_digest, completion.effects[0].input_digest)
  assert.deepEqual(JSON.parse(centralEffect.evidence), reportItem.body.effects[0].evidence)
  assert.deepEqual(centralEffect.artifacts, [centralArtifact.id])
  const downloaded = await admin('GET', `/tickets/${context.ticketId}/artifacts/${centralArtifact.id}?encoding=base64`)
  assert.equal(downloaded.encoding, 'base64'); assert.equal(downloaded.truncated, false)
  assert.deepEqual(Buffer.from(downloaded.content, 'base64'), artifactBytes)
  const ackAudits = db.prepare("SELECT * FROM audits WHERE action='assignment.acknowledged'").all()
  assert.equal(ackAudits.length, 1); assert.equal(ackAudits[0].actor, 'node')
  assert.equal(JSON.parse(ackAudits[0].evidence).evidence.assignment_id, assignment.id)
  assert.equal(JSON.parse(ackAudits[0].evidence).evidence.delivered_is_not_read, true)
  assert.equal(finalAssignment.acknowledged_at, db.prepare('SELECT acknowledged_at FROM assignments WHERE id=?').get(assignment.id).acknowledged_at)
  assert.deepEqual(counts(db), { tickets: 1, assignments: 1, artifacts: 1, reports: 1, effects: 1, assignment_acknowledged_audits: 1 })
  assert.equal((await admin('GET', '/audit/verify')).valid, true); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  const binariesBefore = (await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.bin'))
  const effectsBefore = (await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.effect.json'))
  assert.deepEqual(binariesBefore, [`${centralArtifact.id}.bin`]); assert.deepEqual(effectsBefore, [`${centralEffect.id}.effect.json`])
  await sleep(50)
  assert.deepEqual(await readFile(join(context.projectRoot, 'result.txt')), context.expectedBytes)
  const secondIdle = launch('second-idle-after-delivery', startArgs(closedProxy.origin))
  await complete(secondIdle)
  assert.deepEqual(JSON.parse(secondIdle.stdout.trim().split('\n').at(-1)).outbox, 0)
  assert.deepEqual(await readFile(join(context.projectRoot, 'result.txt')), context.expectedBytes)
  assert.deepEqual((await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.bin')), binariesBefore)
  assert.deepEqual((await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.effect.json')), effectsBefore)
  assert.deepEqual(counts(db), { tickets: 1, assignments: 1, artifacts: 1, reports: 1, effects: 1, assignment_acknowledged_audits: 1 })
  const ticketBeforeDuplicate = await admin('GET', `/tickets/${context.ticketId}`)
  // Reuse the actual Node request and its own credential, not the administrator's
  // client token. The original admission was forwarded once above and committed.
  // This ordinary exact retry must preserve the original timestamp and sole audit.
  const duplicateInput = closedProxy.duplicateAdmission()
  await bounded((async () => {
    const token = duplicateInput.authorization?.split(' ', 2)[1]
    if (token) secrets.add(token)
    const response = await fetch(`${center.baseUrl}/api/v1/nodes/acknowledge`, {
      method: 'POST',
      headers: { authorization: duplicateInput.authorization, 'content-type': 'application/json' },
      body: duplicateInput.body,
      signal: AbortSignal.timeout(10000),
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.length <= cap)
    const repeated = JSON.parse(bytes.toString('utf8'))
    assert.equal(response.status, 200, JSON.stringify(redact(repeated)))
    assert.equal(repeated.accepted, true)
    assert.equal(repeated.duplicate, true)
    assert.equal(repeated.delivered_is_not_read, true)
    assert.equal(repeated.report_or_execution_completed, false)
    assert.equal(repeated.acknowledged_at, finalAssignment.acknowledged_at)
    result.duplicateAdmission = {
      route: 'POST /api/v1/nodes/acknowledge', node_token_from_actual_held_request: true,
      administrator_token_not_used: true,
      original_acknowledged_at_preserved: true, duplicate: repeated.duplicate,
      delivered_is_not_read: repeated.delivered_is_not_read,
      report_or_execution_completed: repeated.report_or_execution_completed,
      acknowledged_audit_count: db.prepare("SELECT COUNT(*) AS count FROM audits WHERE ticket_id=? AND action='assignment.acknowledged'").get(context.ticketId).count,
    }
  })(), 10000, 'worker-own duplicate admission retry')
  assert.equal(result.duplicateAdmission.acknowledged_audit_count, 1)
  assert.deepEqual(counts(db), { tickets: 1, assignments: 1, artifacts: 1, reports: 1, effects: 1, assignment_acknowledged_audits: 1 })
  assert.deepEqual(publicTicket(await admin('GET', `/tickets/${context.ticketId}`)), publicTicket(ticketBeforeDuplicate))
  assert.deepEqual(await readFile(join(context.projectRoot, 'result.txt')), context.expectedBytes)
  const finalCounts = counts(db)
  db.close()
  Object.assign(result, { overall: 'PASS', evidence: join(evidenceDir, 'result.json'),
    child_sequence: ['bind:0', 'initial-idle-registration:0', `durable-then-killed:${first.result.signal}`, 'reopen-original-state:0', 'second-idle-after-delivery:0'],
    node_id: context.nodeId, installation_id: context.installationId, ticket_id: context.ticketId, assignment_id: assignment.id,
    lease_id: assignment.lease_id, attempt: assignment.attempt, lease_epoch: assignment.lease_epoch,
    grant_operations: context.grant.operations, original_grant_digest: context.grant.digest,
    completion_digest: completion.digest, completion_state: completion.state, report_enqueued: completion.report_enqueued,
    local_effect_status: ledger.status, artifact_id: centralArtifact.id, artifact_sha256: centralArtifact.sha256,
    effect_id: centralEffect.id, report_body_id: reportItem.body.report_id, terminal_report_id: report.id,
    terminal_report_request_id: receipt.request_id, terminal_report_receipt: JSON.parse(receipt.response),
    acknowledged_at: finalAssignment.acknowledged_at, no_second_file_effect_or_uuid: true,
    exact_ordinary_ack_held_before_upstream: true, cancellation_polls_all_forwarded: true,
    held_count: closedProxy.heldCount(), forwarded_ack_count: closedProxy.forwardedAckCount(),
    final_counts: finalCounts, private_evidence_whitelist_only: true })
  const stdoutPublic = JSON.parse(reopen.stdout.trim().split('\n').at(-1))
  assert.equal(stdoutPublic.outbox, 0); assert.equal(stdoutPublic.active_assignment_id, null)
  assert.equal(result.proxyFailures, undefined)
} catch (error) {
  result.overall = 'FAIL'; result.error = redact(error.stack || error.message)
  result.process_history = processHistory
  result.in_flight_processes = [...children].map(processPublic)
  if (proxy) {
    result.proxy_counts = Object.fromEntries(proxy.counters)
    result.actual_upstream = Object.fromEntries([...proxy.counters].map(([key]) => [key, proxy.upstreamCount(key)]))
    result.proxy_receipt = proxy.acceptedAck()
  }
  if (center) { try { const db = openDb(); result.counts_at_failure = counts(db); db.close() } catch {} }
} finally {
  for (const entry of [...children]) {
    try { if (!entry.result) entry.child.kill('SIGKILL'); await exitWithin(entry, 5000) }
    catch (error) { (result.cleanupErrors ||= []).push(redact(error.message)) }
  }
  try { if (proxy) { await bounded(proxy.close(), 5000, 'proxy close'); proxyStopped = true } } catch (error) { (result.cleanupErrors ||= []).push(redact(error.message)) }
  if (center) { try { await bounded(center.stop(), 5000, 'center stop'); centerStopped = true } catch (error) { centerStopped = false; (result.cleanupErrors ||= []).push(redact(error.message)) } }
  if (result.cleanupErrors) result.overall = 'FAIL'
  result.cleanup = { owned_children_awaited: children.size === 0, proxy_stopped: proxyStopped, center_stopped: centerStopped }
  result.evidence = evidenceDir ? join(evidenceDir, 'result.json') : undefined
  try { if (evidenceDir) await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }) }
  catch (error) { result.overall = 'FAIL'; result.evidence_write_error = redact(error.message) }
  console.log(JSON.stringify(result, null, 2))
  if (result.overall !== 'PASS') process.exitCode = 1
}
