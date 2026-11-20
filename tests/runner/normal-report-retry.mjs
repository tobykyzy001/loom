#!/usr/bin/env node
// Real native read -> real ACK + Artifact -> first Report 503 -> same-state reopen.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareProject, startRustConcierge, testingClientToken, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const binary = join(repository, 'target/debug/loom-node')
const cap = 1024 * 1024
const routes = Object.freeze({
  challenge: 'POST /api/v1/nodes/challenge', register: 'POST /api/v1/nodes/register',
  heartbeat: 'POST /api/v1/nodes/heartbeat', poll: 'POST /api/v1/nodes/assignments/poll',
  acknowledge: 'POST /api/v1/nodes/acknowledge', artifacts: 'POST /api/v1/nodes/artifacts',
  reports: 'POST /api/v1/nodes/reports',
})
const allowed = new Set(Object.values(routes))
const secrets = new Set()
const children = new Set()
const context = {}
const result = {
  schema: 'loom.normal-report-retry.v1', overall: 'NOT RUN',
  scope: 'one physical macOS host, one native Installation, one read Grant and one fixed read_summary; no DSH/model/profile/other host',
  design_question: 'Does an empty poll after ACK + Artifact still dispatch the persisted Report?',
  natural_resume_passed: false, actual_missing_resume: null,
}
let root, evidenceDir, center, proxy, first, db
let proxyStopped = null, centerStopped = null, reopenedAttempted = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clone = value => JSON.parse(JSON.stringify(value))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function redact(value) {
  let text = String(value)
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted-test-secret]')
  return text.replace(/authorization\s*[:=]\s*bearer\s+\S+/gi, 'authorization: [redacted]')
    .replace(/("(?:private_?key|enrollment_?code|token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
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
  for (const [field, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', chunk => { if (entry[field].length < cap) entry[field] += String(chunk).slice(0, cap - entry[field].length) })
  }
  entry.exited = new Promise(resolve => child.once('exit', (code, signal) => {
    entry.result = { code, signal }; children.delete(entry); resolve(entry)
  }))
  return entry
}
function publicOutput(entry) {
  return entry.stdout.trim().split('\n').filter(Boolean).map(line => {
    try {
      const value = JSON.parse(line)
      return Object.fromEntries(['node_id', 'installation_id', 'heartbeat', 'last_assignment_id', 'outbox',
        'active_assignment_id', 'completions'].filter(key => value[key] !== undefined).map(key => [key, value[key]]))
    } catch { return { unrecognised_output: redact(line).slice(0, 1000) } }
  })
}
function processPublic(entry) {
  return { name: entry.name, pid: entry.child.pid, result: entry.result, timed_out: entry.timedOut,
    stdout: publicOutput(entry), stderr: redact(entry.stderr).slice(0, 4096), spawn_error: entry.spawnError }
}
async function complete(entry, ms = 30000) {
  let timer
  try {
    const arrived = await Promise.race([entry.exited.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => { entry.timedOut = true; resolve(false) }, ms)
    })])
    assert.ok(arrived && entry.result && !entry.timedOut, `${entry.name} did not exit: ${JSON.stringify(processPublic(entry))}`)
    assert.equal(entry.result.code, 0, JSON.stringify(processPublic(entry)))
    assert.equal(entry.result.signal, null)
  } finally { clearTimeout(timer) }
  return entry
}
async function admin(method, route, body) {
  const response = await fetch(`${center.baseUrl}/api/v1${route}`, {
    method, headers: { authorization: `Bearer ${center.clientToken}`, accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.length <= cap)
  const value = JSON.parse(bytes.toString('utf8'))
  assert.ok(response.ok, `${method} ${route}: ${response.status}: ${JSON.stringify(value.error)}`)
  return value
}
function receive(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false
    const fail = error => { if (!done) { done = true; request.destroy(); reject(error) } }
    request.on('data', chunk => { size += chunk.length; if (size > cap) fail(new Error('proxy request exceeds 1 MiB')); else chunks.push(chunk) })
    request.once('error', fail)
    request.once('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
  })
}
async function responseBytes(response) {
  const chunks = []; let size = 0
  for await (const chunk of response) { size += chunk.length; assert.ok(size <= cap); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
function forward(upstream, incoming, body) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(incoming.url, upstream), {
      path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false }, resolve)
    outgoing.once('error', reject); outgoing.setTimeout(35000, () => outgoing.destroy(new Error('upstream timeout'))); outgoing.end(body)
  })
}
async function startProxy() {
  const server = createServer(async (request, response) => {
    const key = `${request.method} ${request.url.split('?', 1)[0]}`
    let upstreamResponse
    try {
      assert.ok(allowed.has(key), `unapproved native route ${key}`)
      proxy.counts.set(key, (proxy.counts.get(key) || 0) + 1)
      const body = await receive(request)
      if (key === routes.reports && proxy.counts.get(routes.reports) === 1) {
        // The actual ACK and Artifact were forwarded before this controlled response.
        assert.ok(proxy.acknowledged && proxy.artifactAccepted)
        const value = JSON.parse(body.toString('utf8'))
        assert.equal(value.ticket_id, context.ticketId)
        assert.equal(value.assignment_id, context.assignmentId)
        assert.equal(value.node_id, context.nodeId)
        assert.equal(value.installation_id, context.installationId)
        assert.equal(value.lease_epoch, 1)
        assert.equal(value.state, 'succeeded')
        assert.equal(value.requested_state, 'succeeded')
        assert.deepEqual(value.artifact_ids, [proxy.artifactId])
        proxy.withheldReport = clone(value)
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'owned_transient_report_unavailable', message: 'retry later' } }))
        return
      }
      proxy.upstream.set(key, (proxy.upstream.get(key) || 0) + 1)
      upstreamResponse = await forward(center.baseUrl, request, body)
      const bytes = await responseBytes(upstreamResponse)
      const value = JSON.parse(bytes.toString('utf8'))
      if (key === routes.acknowledge) {
        assert.equal(proxy.counts.get(routes.acknowledge), 1)
        assert.equal(value.accepted, true)
        assert.ok(Date.parse(value.acknowledged_at))
        proxy.acknowledged = value.acknowledged_at
        proxy.nodeAuthorization = request.headers.authorization
        secrets.add(proxy.nodeAuthorization.split(' ', 2)[1] || '')
      } else if (key === routes.artifacts) {
        assert.equal(proxy.counts.get(routes.artifacts), 1)
        assert.equal(value.artifact_id, JSON.parse(body.toString('utf8')).artifact_id)
        proxy.artifactAccepted = true
        proxy.artifactId = value.artifact_id
      } else if (key === routes.reports) {
        assert.equal(value.accepted, true)
        proxy.acceptedReport = clone(value)
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      response.end(bytes)
    } catch (error) {
      upstreamResponse?.destroy()
      if (!response.headersSent) response.writeHead(504, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify({ error: { code: 'owned_proxy_failure', message: 'forwarding failed' } }))
      ;(result.proxy_failures ||= []).push({ route: key, error: redact(error.message) })
    }
  })
  const sockets = new Set()
  server.keepAliveTimeout = 250; server.headersTimeout = 2000; server.requestTimeout = 40000
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  proxy = {
    origin: `http://127.0.0.1:${server.address().port}`, counts: new Map(), upstream: new Map(),
    count(key) { return this.counts.get(key) || 0 }, upstreamCount(key) { return this.upstream.get(key) || 0 },
    close() { server.closeAllConnections?.(); for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)) },
  }
}
function startArgs(coordinator, enrollment) {
  return ['start', '--coordinator', coordinator, '--state-dir', join(root, 'state'),
    '--artifact-dir', join(root, 'artifacts'), '--project-root', `${context.projectId}=${context.projectRoot}`,
    '--once', ...(enrollment ? ['--enrollment-code', enrollment] : [])]
}
async function readState() {
  const state = JSON.parse(await readFile(join(root, 'state', 'node-state.json'), 'utf8'))
  assert.equal(state.version, 1)
  return state
}
function openDb() { return new DatabaseSync(join(center.dataDir, 'loom.sqlite3'), { readOnly: true }) }
function counts() {
  const count = (sql, ...args) => db.prepare(sql).get(...args).count
  return {
    tickets: count('SELECT COUNT(*) AS count FROM tickets'),
    assignments: count('SELECT COUNT(*) AS count FROM assignments'),
    artifacts: count('SELECT COUNT(*) AS count FROM artifacts'), reports: count('SELECT COUNT(*) AS count FROM reports'),
    effects: count('SELECT COUNT(*) AS count FROM effects'),
    assignment_acknowledged_audits: count("SELECT COUNT(*) AS count FROM audits WHERE action='assignment.acknowledged'"),
    report_receipts: count("SELECT COUNT(*) AS count FROM requests WHERE route='reports'"),
  }
}
function expectedCounts(reports, effects) {
  return { tickets: 1, assignments: 1, artifacts: 1, reports, effects, assignment_acknowledged_audits: 1, report_receipts: reports }
}
async function sameNodePoll() {
  const body = { protocol: 'loom.node.v1', node_id: context.nodeId, installation_id: context.installationId,
    request_id: randomUUID(), sent_at: new Date().toISOString(), last_assignment_id: context.assignmentId, wait_seconds: 0 }
  const response = await bounded(new Promise((resolve, reject) => {
    const request = httpRequest(new URL(routes.poll.slice(5), proxy.origin), {
      method: 'POST', path: routes.poll.slice(5), agent: false,
      headers: { authorization: proxy.nodeAuthorization, accept: 'application/json', 'content-type': 'application/json' },
    }, resolve)
    request.once('error', reject); request.setTimeout(3000, () => request.destroy(new Error('same-Node poll timed out'))); request.end(JSON.stringify(body))
  }), 4000, 'same-Node raw poll')
  const bytes = await bounded(responseBytes(response), 3000, 'same-Node raw poll response')
  const value = JSON.parse(bytes.toString('utf8'))
  assert.equal(response.statusCode, 200, JSON.stringify(redact(value.error)))
  result.raw_poll_shape = Object.keys(body)
  return clone(value.assignment)
}
function publicTicket(detail) {
  return { id: detail.id, status: detail.status, cancel_requested: detail.cancel_requested,
    grant_id: detail.grant_id, grant_digest: detail.grant_digest,
    assignments: detail.assignments.map(row => ({ id: row.id, lease_id: row.lease_id, lease_epoch: row.lease_epoch,
      acknowledged_at: row.acknowledged_at, last_report_at: row.last_report_at })),
    artifacts: detail.artifacts.map(row => ({ id: row.id, assignment_id: row.assignment_id, sha256: row.sha256 })),
    reports: detail.reports.map(row => ({ id: row.id, assignment_id: row.assignment_id, request_id: row.request_id, state: row.state })),
    effects: detail.effects.map(row => ({ id: row.id, assignment_id: row.assignment_id, status: row.status,
      attempt: row.attempt, input_digest: row.input_digest, artifacts: row.artifacts })) }
}

try {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
  root = await testingRoot(); evidenceDir = await mkdtemp(join(tmpdir(), 'loom-normal-report-retry-proof-'))
  const built = await promisify(execFile)('cargo', ['build', '--offline', '--locked', '-p', 'loom-node', '--bin', 'loom-node'], {
    cwd: repository, timeout: 120000, encoding: 'utf8' })
  result.build = { command: 'cargo build --offline --locked -p loom-node --bin loom-node', stderr: redact(built.stderr).slice(-2000) }
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: testingClientToken(), CARGO_NET_OFFLINE: 'true' } })
  secrets.add(center.clientToken); db = openDb()
  context.projectRoot = await prepareProject(root)
  const sourceBytes = await readFile(join(context.projectRoot, 'input.txt'))
  const sourceSha256 = sha256(sourceBytes)
  const project = await admin('POST', '/projects', { name: 'Native ordinary report retry', root: context.projectRoot, mode: 'read_only' })
  context.projectId = project.project.id
  const mapping = `${context.projectId}=${context.projectRoot}`
  const bind = await complete(launch('bind', ['bind', '--state-dir', join(root, 'state'), '--project-root', mapping]))
  assert.equal(JSON.parse(bind.stdout.trim()).connected_identity, true)
  const enrollment = await admin('POST', '/enrollment-codes', {})
  const idle = await complete(launch('initial-signed-idle', startArgs(center.baseUrl, enrollment.code), enrollment.code))
  const identity = JSON.parse(idle.stdout.trim().split('\n')[0])
  Object.assign(context, { nodeId: identity.node_id, installationId: identity.installation_id })
  assert.equal((await admin('GET', '/tickets')).tickets.length, 0)
  const binding = await admin('POST', '/project-bindings', { project_id: context.projectId, node_id: context.nodeId,
    installation_id: context.installationId, worker_id: 'default', root_scope: context.projectRoot })
  const granted = await admin('POST', '/grants', { project_id: context.projectId, project_binding_id: binding.id,
    node_id: context.nodeId, installation_id: context.installationId, worker_id: 'default', operations: ['read'] })
  context.grantId = granted.grant.id; context.grantDigest = granted.grant.digest
  assert.deepEqual(granted.grant.operations, ['read']); assert.equal(granted.grant.revoked_at, null)
  const ticket = await admin('POST', '/tickets', { project_id: context.projectId, node_id: context.nodeId,
    worker_id: 'default', grant_id: context.grantId, kind: 'read_summary', relative_path: 'input.txt',
    objective: 'Finish one ordinary local source read and recover its Report' })
  Object.assign(context, { ticketId: ticket.id, assignmentId: ticket.assignments[0].id,
    leaseId: ticket.assignments[0].lease_id, leaseEpoch: ticket.assignments[0].lease_epoch })
  assert.equal(ticket.status, 'running'); assert.equal(ticket.assignments.length, 1); assert.equal(context.leaseEpoch, 1)
  await startProxy(); proxyStopped = false
  first = await complete(launch('ack-artifact-then-report-503', startArgs(proxy.origin)))
  const firstPublic = JSON.parse(first.stdout.trim().split('\n').at(-1))
  assert.equal(firstPublic.outbox, 1); assert.equal(firstPublic.completions[0]?.state, 'succeeded')
  const baseline = await readState()
  assert.equal(baseline.outbox.length, 1); assert.equal(baseline.outbox[0].kind, 'report')
  const item = baseline.outbox[0]
  const originalBody = clone(item.body)
  const artifactId = originalBody.artifact_ids[0]
  const effectId = originalBody.effects[0].effect_id
  const artifactPath = join(root, 'artifacts', `${artifactId}.bin`)
  const ledgerPath = join(root, 'artifacts', `${effectId}.effect.json`)
  const artifactBytes = await readFile(artifactPath); const ledgerBefore = await readFile(ledgerPath)
  const summary = JSON.parse(artifactBytes.toString('utf8'))
  const publicReport = clone(originalBody); delete publicReport.request_id
  assert.deepEqual(item.body, proxy.withheldReport)
  assert.equal(originalBody.ticket_id, context.ticketId); assert.equal(originalBody.assignment_id, context.assignmentId)
  assert.equal(originalBody.node_id, context.nodeId); assert.equal(originalBody.installation_id, context.installationId)
  assert.equal(originalBody.lease_id, context.leaseId); assert.equal(originalBody.lease_epoch, 1)
  assert.equal(originalBody.grant_digest, context.grantDigest); assert.equal(originalBody.state, 'succeeded')
  assert.equal(originalBody.requested_state, 'succeeded'); assert.deepEqual(originalBody.artifact_ids, [artifactId])
  assert.equal(artifactId, proxy.artifactId); assert.equal(sha256(artifactBytes), originalBody.artifacts[0].sha256)
  assert.equal(originalBody.artifacts[0].sha256, originalBody.effects[0].evidence[0].digest)
  assert.equal(originalBody.effects[0].status, 'confirmed'); assert.equal(originalBody.effects[0].effect_id, effectId)
  assert.equal(summary.schema, 'loom.synthetic_summary.v1'); assert.equal(summary.input_sha256, sourceSha256)
  assert.equal(summary.byte_length, sourceBytes.length)
  assert.deepEqual(summary.lines, ['Real isolated project input.', 'No LLM, DSH host or network model was called.'])
  assert.equal(item.attempts, 1); assert.ok(Date.parse(item.next_attempt_at) > Date.now())
  assert.match(item.last_error, /503|owned_transient_report_unavailable/)
  assert.deepEqual((await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.bin')).sort(), [`${artifactId}.bin`])
  assert.deepEqual((await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.effect.json')).sort(), [`${effectId}.effect.json`])
  assert.equal(proxy.count(routes.acknowledge), 1); assert.equal(proxy.upstreamCount(routes.acknowledge), 1)
  assert.equal(proxy.count(routes.artifacts), 1); assert.equal(proxy.upstreamCount(routes.artifacts), 1)
  assert.equal(proxy.count(routes.reports), 1); assert.equal(proxy.upstreamCount(routes.reports), 0)
  const before = publicTicket(await admin('GET', `/tickets/${context.ticketId}`))
  assert.equal(before.status, 'running'); assert.equal(before.cancel_requested, false)
  assert.ok(before.assignments[0].acknowledged_at); assert.equal(before.assignments[0].last_report_at, null)
  assert.equal(before.assignments[0].acknowledged_at, proxy.acknowledged)
  assert.equal(before.artifacts[0].id, artifactId); assert.equal(before.artifacts[0].sha256, sha256(artifactBytes))
  assert.deepEqual(before.reports, []); assert.deepEqual(before.effects, [])
  assert.deepEqual(counts(), expectedCounts(0, 0))
  const rawPollBeforeReopen = await sameNodePoll()
  assert.equal(rawPollBeforeReopen, null)
  assert.deepEqual(counts(), expectedCounts(0, 0))
  result.alien_prior_admission = { acknowledged: true, artifact_stored: true, report_before_reopen: 0, outbox_reports: 1,
    artifact_id: artifactId, artifact_sha256: sha256(artifactBytes), effect_id: effectId, source_sha256: sourceSha256,
    original_report_body_without_request_id: publicReport, report_attempts: 1, first_report_http: 503,
    first_report_upstream: false, first_process: processPublic(first), raw_same_node_poll_before_reopen: rawPollBeforeReopen }
  await bounded((async () => {
    while (Date.parse((await readState()).outbox[0].next_attempt_at) > Date.now()) await sleep(10)
  })(), 5000, 'persisted retry schedule')
  const due = await readState()
  assert.deepEqual(due.outbox[0].body, originalBody); assert.deepEqual(due.outbox[0].digest, item.digest)
  assert.deepEqual(due.completions, baseline.completions); assert.deepEqual(due.assignments, baseline.assignments)
  assert.deepEqual(counts(), expectedCounts(0, 0))
  result.before_reopen = { due: true, report_body_unchanged: true, counts: counts(), raw_same_node_poll: rawPollBeforeReopen }

  reopenedAttempted = true
  const reopened = await complete(launch('same-state-normal-reopen', startArgs(proxy.origin)))
  const reopenedPublic = JSON.parse(reopened.stdout.trim().split('\n').at(-1))
  const afterCounts = counts()
  result.natural_resume = { acknowledged: true, artifact_stored: true, report_before_reopen: 0, report_after_reopen: afterCounts.reports,
    raw_same_node_poll_after_reopen: rawPollBeforeReopen, reopened_process: processPublic(reopened) }
  assert.equal(reopenedPublic.last_assignment_id, context.assignmentId); assert.equal(reopenedPublic.active_assignment_id, null)
  assert.equal(reopenedPublic.outbox, 0)
  const final = publicTicket(await admin('GET', `/tickets/${context.ticketId}`))
  assert.equal(final.status, 'succeeded'); assert.equal(final.cancel_requested, false)
  assert.equal(final.assignments.length, 1); assert.equal(final.assignments[0].acknowledged_at, proxy.acknowledged)
  assert.ok(final.assignments[0].last_report_at); assert.deepEqual(final.artifacts, before.artifacts)
  assert.equal(final.reports.length, 1); assert.equal(final.reports[0].request_id, originalBody.request_id)
  assert.equal(final.reports[0].state, 'succeeded'); assert.equal(final.reports[0].assignment_id, context.assignmentId)
  assert.equal(final.effects.length, 1); assert.equal(final.effects[0].id, effectId); assert.equal(final.effects[0].status, 'confirmed')
  assert.equal(final.effects[0].input_digest, originalBody.effects[0].input_digest)
  assert.deepEqual(final.effects[0].artifacts, [artifactId]); assert.deepEqual(counts(), expectedCounts(1, 1))
  assert.equal(proxy.count(routes.acknowledge), 1); assert.equal(proxy.upstreamCount(routes.acknowledge), 1)
  assert.equal(proxy.count(routes.artifacts), 1); assert.equal(proxy.upstreamCount(routes.artifacts), 1)
  assert.equal(proxy.count(routes.reports), 2); assert.equal(proxy.upstreamCount(routes.reports), 1)
  assert.equal(proxy.acceptedReport.request_id, originalBody.request_id)
  const receipt = db.prepare("SELECT response,payload_digest FROM requests WHERE route='reports' AND request_id=?").get(originalBody.request_id)
  assert.deepEqual(JSON.parse(receipt.response), { accepted: true, report_id: final.reports[0].id,
    request_id: originalBody.request_id, ticket_status: 'succeeded', disposition: 'accepted', facts_already_existed: false })
  assert.equal(receipt.payload_digest, sha256(JSON.stringify(originalBody)))
  const delivered = await readState()
  assert.equal(delivered.outbox.length, 0); assert.equal(delivered.deliveries.length, 2)
  assert.deepEqual(delivered.completions, baseline.completions); assert.deepEqual(delivered.assignments, baseline.assignments)
  assert.deepEqual(delivered.deliveries.map(row => ({ kind: row.kind, digest: row.digest, request_id: row.request_id })),
    [{ kind: 'artifact', digest: baseline.deliveries[0].digest, request_id: baseline.deliveries[0].body?.request_id ?? baseline.deliveries[0].request_id },
      { kind: 'report', digest: item.digest, request_id: originalBody.request_id }])
  assert.deepEqual(await readFile(join(context.projectRoot, 'input.txt')), sourceBytes)
  assert.deepEqual(await readFile(artifactPath), artifactBytes); assert.deepEqual(await readFile(ledgerPath), ledgerBefore)
  assert.equal((await admin('GET', '/nodes')).nodes.length, 1)
  assert.equal((await admin('GET', '/audit/verify')).valid, true); assert.deepEqual(counts(), expectedCounts(1, 1))
  const afterReopenPoll = await sameNodePoll()
  assert.equal(afterReopenPoll, null)
  result.natural_resume.raw_same_node_poll_after_reopen = afterReopenPoll
  assert.equal((await admin('GET', '/audit/verify')).valid, true); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(result.proxy_failures, undefined)
  result.final = { counts: afterCounts, ticket: final, first_cli_natural_exit: first.result, reopen_natural_exit: reopened.result,
    http_sequence: 'real ACK=200 -> real Artifact=200 -> Report=503 withheld -> empty same-Node poll -> real Report=200 on reopen',
    original_artifact_and_effect_files_unchanged: true, source_unchanged: true, only_one_ack_and_artifact_request: true }
  result.natural_resume_passed = true; result.overall = 'PASS'
} catch (error) {
  result.overall = 'FAIL'; result.error = redact(error.stack || error.message)
  if (proxy) result.http_counts = { incoming: Object.fromEntries(proxy.counts), upstream: Object.fromEntries(proxy.upstream) }
  if (center && root) {
    try {
      db ||= openDb(); result.counts_at_failure = counts()
      if (reopenedAttempted && context.assignmentId) {
        result.report_before_reopen = 0; result.report_after_reopen = result.counts_at_failure.reports
        if (result.counts_at_failure.reports === 0) result.actual_missing_resume = 'no_admitted_report_retry_after_reopen'
      }
    } catch (diagnostic) { result.failure_diagnostics = redact(diagnostic.message) }
  }
  result.in_flight_processes = [...children].map(processPublic)
} finally {
  for (const entry of [...children]) {
    try { entry.child.kill('SIGTERM'); await bounded(entry.exited, 3000, `${entry.name} cleanup`) }
    catch {
      try { if (!entry.result) entry.child.kill('SIGKILL'); await bounded(entry.exited, 3000, `${entry.name} cleanup fallback`) }
      catch (error) { (result.cleanup_errors ||= []).push(redact(error.message)) }
    }
  }
  try { if (proxy) { await bounded(proxy.close(), 5000, 'proxy close'); proxyStopped = true } }
  catch (error) { (result.cleanup_errors ||= []).push(redact(error.message)) }
  try { if (center) { await bounded(center.stop(), 5000, 'center stop'); centerStopped = true } }
  catch (error) { (result.cleanup_errors ||= []).push(error.message) }
  try { db?.close() } catch {}
  if (result.cleanup_errors) result.overall = 'FAIL'
  result.cleanup = { owned_children_awaited: children.size === 0, proxy_stopped: proxyStopped, center_stopped: centerStopped,
    first_cli_cleanup_signal: first?.result?.signal ?? null }
  if (!evidenceDir) evidenceDir = await mkdtemp(join(tmpdir(), 'loom-normal-report-retry-proof-'))
  result.evidence = join(evidenceDir, 'result.json')
  try { await writeFile(result.evidence, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }) }
  catch (error) { result.overall = 'FAIL'; result.evidence_write_error = redact(error.message) }
  console.log(JSON.stringify(result, null, 2))
  if (result.overall !== 'PASS') process.exitCode = 1
}
