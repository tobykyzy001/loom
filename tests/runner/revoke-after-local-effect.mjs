#!/usr/bin/env node
// Real native edit -> durable local outbox with its first ordinary ACK withheld ->
// actual administrator Grant revocation -> real 409 -> same-Node bounded poll.
// Require a scoped unknown reconciliation, never renewed execution authority.
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
const pollPath = '/api/v1/nodes/assignments/poll'
const routes = Object.freeze({
  challenge: 'POST /api/v1/nodes/challenge',
  register: 'POST /api/v1/nodes/register',
  heartbeat: 'POST /api/v1/nodes/heartbeat',
  poll: 'POST /api/v1/nodes/assignments/poll',
  acknowledge: 'POST /api/v1/nodes/acknowledge',
  artifacts: 'POST /api/v1/nodes/artifacts',
  reports: 'POST /api/v1/nodes/reports',
})
const allowed = new Set(Object.values(routes))
const secrets = new Set()
const children = new Set()
const processHistory = []
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const immutableOutbox = value => value.outbox.map(item => ({ kind: item.kind, digest: item.digest, body: item.body }))
const outboxBookkeeping = value => value.outbox.map(item => ({ kind: item.kind,
  attempts: item.attempts, next_attempt_at: item.next_attempt_at,
  ...(item.last_error === null || item.last_error === undefined
    ? { last_error: null } : { last_error: redact(item.last_error) }) }))
const context = {}
const result = {
  schema: 'loom.revoked-after-local-effect.v1', overall: 'NOT RUN',
  designed_expected_state: 'evidence_only_unknown_delivery',
  scope: 'one physical macOS host, one native Installation, one read/write Grant and one fixed edit_file; no DSH/model/profile/other host',
  not_claimed: ['graceful crash recovery', 'multi-host', 'normal ACK revival after revocation', 'global exactly-once'],
}
let root, evidenceDir, center, proxy, first, db
let proxyStopped = null
let centerStopped = null

function redact(value) {
  let text = String(value)
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted-test-secret]')
  return text.replace(/authorization\s*[:=]\s*bearer\s+\S+/gi, 'authorization: [redacted]')
    .replace(/("(?:private_?key|enrollment_?code|token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
}
async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds)
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
    stream.on('data', chunk => {
      if (entry[field].length < cap) entry[field] += String(chunk).slice(0, cap - entry[field].length)
    })
  }
  entry.exited = new Promise(resolve => child.once('exit', (code, signal) => {
    entry.result = { code, signal }
    children.delete(entry)
    processHistory.push({ name, code, signal })
    resolve(entry)
  }))
  return entry
}
function publicOutput(entry) {
  return entry.stdout.trim().split('\n').filter(Boolean).map(line => {
    try {
      const value = JSON.parse(line)
      return {
        ...(value.node_id ? { node_id: value.node_id } : {}),
        ...(value.installation_id ? { installation_id: value.installation_id } : {}),
        ...(value.heartbeat !== undefined ? { heartbeat: value.heartbeat } : {}),
        ...(value.last_assignment_id !== undefined ? { last_assignment_id: value.last_assignment_id } : {}),
        ...(value.outbox !== undefined ? { outbox: value.outbox } : {}),
        ...(value.active_assignment_id !== undefined ? { active_assignment_id: value.active_assignment_id } : {}),
        ...(value.completions ? { completions: value.completions } : {}),
      }
    } catch { return { unrecognised_output: redact(line).slice(0, 1000) } }
  })
}
function processPublic(entry) {
  return { name: entry.name, pid: entry.child.pid, result: entry.result, timed_out: entry.timedOut,
    stdout: publicOutput(entry), stderr: redact(entry.stderr).slice(0, 4096), spawn_error: entry.spawnError }
}
async function waitForExit(entry, milliseconds = 20000) {
  let timer
  try {
    const arrived = await Promise.race([entry.exited.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => { entry.timedOut = true; resolve(false) }, milliseconds)
    })])
    if (!arrived || !entry.result) throw new Error(`${entry.name} did not exit: ${JSON.stringify(processPublic(entry))}`)
  } finally { clearTimeout(timer) }
  return entry
}
async function complete(entry, milliseconds = 20000) {
  await waitForExit(entry, milliseconds)
  assert.equal(entry.result.code, 0, JSON.stringify(processPublic(entry)))
  assert.equal(entry.result.signal, null)
  assert.equal(entry.timedOut, false)
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
    const chunks = []
    let length = 0
    let done = false
    const fail = error => { if (!done) { done = true; request.destroy(); reject(error) } }
    request.on('data', chunk => {
      length += chunk.length
      if (length > cap) fail(new Error('proxy request body exceeds 1 MiB'))
      else chunks.push(chunk)
    })
    request.once('error', fail)
    request.once('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
  })
}
function forward(upstream, incoming, body) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(incoming.url, upstream), {
      path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false,
    }, resolve)
    outgoing.once('error', reject)
    outgoing.setTimeout(35000, () => outgoing.destroy(new Error('upstream timeout')))
    outgoing.end(body)
  })
}
async function responseBytes(response) {
  const chunks = []
  let length = 0
  for await (const chunk of response) {
    length += chunk.length
    assert.ok(length <= cap, 'proxy response body exceeds 1 MiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function startProxy(upstream, expected) {
  const counters = new Map()
  const upstreamCounts = new Map()
  const sockets = new Set()
  const pending = new Set()
  const ackResponses = []
  const deliveryResponses = []
  const authorizedPolls = []
  let heldResolve, deadline
  let heldAckBody
  let heldCount = 0
  let closing = false
  let released = false
  let heldAuthorization
  const held = new Promise(resolve => { heldResolve = resolve })
  let releaseHeld = () => {}
  const release = () => {
    if (released) return
    released = true
    clearTimeout(deadline)
    releaseHeld()
  }
  const server = createServer(async (request, response) => {
    const key = `${request.method} ${request.url.split('?', 1)[0]}`
    counters.set(key, (counters.get(key) || 0) + 1)
    let upstreamResponse
    try {
      assert.ok(allowed.has(key), `unapproved native route ${key}`)
      const bytes = await receive(request)
      if (key === routes.poll) {
        const body = JSON.parse(bytes.toString('utf8'))
        assert.equal(body.protocol, 'loom.node.v1')
        assert.equal(body.node_id, expected.nodeId)
        assert.equal(body.installation_id, expected.installationId)
        assert.ok(body.last_assignment_id === null || body.last_assignment_id === expected.assignmentId)
        assert.ok(body.wait_seconds === 0 || (body.wait_seconds >= 1 && body.wait_seconds <= 15))
        if (body.wait_seconds === 0) {
          assert.equal(body.last_assignment_id, expected.assignmentId)
          assert.match(request.headers.authorization || '', /^Bearer .+/)
          authorizedPolls.push({ node_id: body.node_id, installation_id: body.installationId ?? body.installation_id,
            last_assignment_id: body.last_assignment_id, wait_seconds: body.wait_seconds })
        }
      }
      if (key === routes.acknowledge && heldCount === 0) {
        const body = JSON.parse(bytes.toString('utf8'))
        assert.equal(body.protocol, 'loom.node.v1')
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
        heldCount = 1
        // Block this request's upstream call before publishing the observation.
        // A fast native process can otherwise fail by its 15s ACK deadline while
        // the test's concurrent cancellation polls delay the observation.
        const acknowledgementStillHeld = new Promise(resolve => { releaseHeld = resolve })
        heldAuthorization = request.headers.authorization
        assert.match(heldAuthorization || '', /^Bearer .+/)
        heldAckBody = Buffer.from(bytes)
        const token = heldAuthorization.split(' ', 2)[1]
        secrets.add(token)
        result.held_ack = { protocol: body.protocol, ticket_id: body.ticket_id,
          assignment_id: body.assignment_id, node_id: body.node_id, installation_id: body.installation_id,
          lease_id: body.lease_id, lease_epoch: body.lease_epoch, accepted: body.accepted,
          acknowledgement: body.acknowledgement, cancel_requested: body.cancel_requested ?? null,
          cancellation: body.cancellation ?? null }
        pending.add(response)
        heldResolve(result.held_ack)
        deadline = setTimeout(release, 20000)
        await acknowledgementStillHeld
        pending.delete(response)
        // IncomingMessage.destroyed may be true after a normal fully-read body;
        // release is deliberately a real forward even then. Only test shutdown
        // may abandon the withheld admission before it reaches the owned center.
        if (closing) return
        assert.deepEqual(Buffer.from(bytes), Buffer.from(heldAckBody),
          'the real ordinary ACK must be forwarded byte-for-byte after its hold')
      }
      upstreamCounts.set(key, (upstreamCounts.get(key) || 0) + 1)
      upstreamResponse = await forward(upstream, request, bytes)
      const output = await responseBytes(upstreamResponse)
      if ([routes.acknowledge, routes.artifacts, routes.reports].includes(key)) {
        const value = JSON.parse(output.toString('utf8'))
        const receipt = { status: upstreamResponse.statusCode,
          code: value.error?.code ?? null, accepted: value.accepted ?? null,
          acknowledged_at: value.acknowledged_at ?? null }
        if (key === routes.acknowledge) ackResponses.push(receipt)
        else deliveryResponses.push({ route: key, ...receipt })
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      response.end(output)
    } catch (error) {
      upstreamResponse?.destroy()
      if (closing) { upstreamResponse?.resume(); response?.destroy(); return }
      ;(result.proxy_failures ||= []).push({ route: key, error: redact(error.message) })
      if (!response.headersSent) response.writeHead(504, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify({ error: { code: 'owned_proxy_failure', message: 'forwarding failed' } }))
    }
  })
  server.keepAliveTimeout = 250
  server.headersTimeout = 2000
  server.requestTimeout = 40000
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${server.address().port}`, held, counters, release,
    count: key => counters.get(key) || 0,
    upstreamCount: key => upstreamCounts.get(key) || 0,
    heldCount: () => heldCount,
    ackResponses: () => clone(ackResponses),
    deliveryResponses: () => clone(deliveryResponses),
    authorizedPolls: () => clone(authorizedPolls),
    nodeAuthorization: () => heldAuthorization,
    close() {
      closing = true
      release()
      for (const response of pending) response.destroy()
      pending.clear()
      server.closeAllConnections?.()
      for (const socket of sockets) socket.destroy()
      return new Promise(resolve => server.close(resolve))
    },
  }
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
    artifacts: count('SELECT COUNT(*) AS count FROM artifacts'),
    reports: count('SELECT COUNT(*) AS count FROM reports'),
    effects: count('SELECT COUNT(*) AS count FROM effects'),
    assignment_acknowledged_audits: count("SELECT COUNT(*) AS count FROM audits WHERE action='assignment.acknowledged'"),
    grant_revoked_audits: count("SELECT COUNT(*) AS count FROM audits WHERE action='grant.revoked'"),
  }
}
function grantRow() {
  const row = db.prepare('SELECT version,revoked_at,digest FROM grants WHERE id=?').get(context.grantId)
  return { id: context.grantId, version: row.version, revoked_at: row.revoked_at, digest: row.digest }
}
function assignmentRow() {
  return db.prepare('SELECT acknowledged_at,lease_expires_at,last_report_at FROM assignments WHERE id=?').get(context.assignmentId)
}
function publicTicket(detail) {
  return {
    id: detail.id, status: detail.status, cancel_requested: detail.cancel_requested,
    grant_id: detail.grant_id, grant_digest: detail.grant_digest,
    kind: detail.kind, relative_path: detail.relative_path,
    assignments: detail.assignments.map(row => ({ id: row.id, lease_id: row.lease_id,
      lease_epoch: row.lease_epoch, attempt: row.attempt, lease_expires_at: row.lease_expires_at,
      acknowledged_at: row.acknowledged_at, last_report_at: row.last_report_at })),
    artifacts: detail.artifacts.map(row => ({ id: row.id, assignment_id: row.assignment_id, sha256: row.sha256 })),
    reports: detail.reports.map(row => ({ id: row.id, assignment_id: row.assignment_id, request_id: row.request_id, state: row.state })),
    effects: detail.effects.map(row => ({ id: row.id, assignment_id: row.assignment_id, status: row.status,
      attempt: row.attempt, input_digest: row.input_digest, artifacts: row.artifacts })),
  }
}
function publicPollAssignment(assignment) {
  if (assignment === null) return null
  return {
    id: assignment.id, ticket_id: assignment.ticket_id, project_id: assignment.project_id,
    node_id: assignment.node_id, installation_id: assignment.installation_id,
    worker_id: assignment.worker_id, kind: assignment.kind, relative_path: assignment.relative_path,
    content: assignment.content, lease_id: assignment.lease_id, lease_epoch: assignment.lease_epoch,
    lease_expires_at: assignment.lease_expires_at, purpose: assignment.purpose,
    status: assignment.status, cancel_requested: assignment.cancel_requested,
    grant_status: assignment.grant_status, grant_version: assignment.grant_version,
    grant_digest: assignment.grant_digest,
    current_grant: assignment.grant ? {
      id: assignment.grant.id, version: assignment.grant.version,
      digest: assignment.grant.digest, revoked_at: assignment.grant.revoked_at,
    } : null,
    resource: assignment.resource,
  }
}
async function nodePoll() {
  const body = {
    protocol: 'loom.node.v1', node_id: context.nodeId,
    installation_id: context.installationId, request_id: randomUUID(), sent_at: new Date().toISOString(),
    last_assignment_id: context.assignmentId, wait_seconds: 0,
  }
  const response = await bounded(new Promise((resolve, reject) => {
    const request = httpRequest(new URL(pollPath, proxy.origin), {
      method: 'POST', path: pollPath, agent: false,
      headers: { authorization: proxy.nodeAuthorization(), accept: 'application/json', 'content-type': 'application/json' },
    }, resolve)
    request.once('error', reject)
    const timer = setTimeout(() => request.destroy(new Error('same-Node raw poll exceeded 3000ms')), 3000)
    request.once('close', () => clearTimeout(timer))
    request.end(JSON.stringify(body))
  }), 3000, 'same-Node zero-wait raw poll')
  let bytes
  try {
    bytes = await bounded(responseBytes(response), 3000, 'same-Node zero-wait poll response body')
  } finally { response.resume() }
  assert.ok(bytes.length <= cap)
  const value = JSON.parse(bytes.toString('utf8'))
  assert.equal(response.statusCode, 200, JSON.stringify(redact(value.error)))
  assert.ok(Object.hasOwn(value, 'assignment'))
  return publicPollAssignment(value.assignment)
}
function startArgs(coordinator, enrollment) {
  return ['start', '--coordinator', coordinator, '--state-dir', join(root, 'state'),
    '--artifact-dir', join(root, 'artifacts'), '--project-root', `${context.projectId}=${context.projectRoot}`,
    '--once', ...(enrollment ? ['--enrollment-code', enrollment] : [])]
}

try {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'arm64')
  root = await testingRoot()
  evidenceDir = await mkdtemp(join(tmpdir(), 'loom-revoke-after-local-effect-proof-'))
  await promisify(execFile)('cargo', ['build', '--offline', '--locked', '-p', 'loom-node', '--bin', 'loom-node'], {
    cwd: repository, timeout: 120000,
  })
  const token = testingClientToken()
  secrets.add(token)
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: token } })
  secrets.add(center.clientToken)
  db = openDb()
  context.projectRoot = await prepareProject(root)
  const sourceBytes = await readFile(join(context.projectRoot, 'input.txt'))
  assert.ok(sourceBytes.length > 0)
  const project = await admin('POST', '/projects', {
    name: 'Native completed local effect before revocation', root: context.projectRoot, mode: 'read_write',
  })
  context.projectId = project.project.id
  const mapping = `${context.projectId}=${context.projectRoot}`
  const bind = await complete(launch('bind', ['bind', '--state-dir', join(root, 'state'), '--project-root', mapping]))
  assert.equal(JSON.parse(bind.stdout.trim()).connected_identity, true)
  const enrollment = await admin('POST', '/enrollment-codes', {})
  const idle = await complete(launch('initial-signed-idle-register', startArgs(center.baseUrl, enrollment.code), enrollment.code))
  const identity = JSON.parse(idle.stdout.trim().split('\n')[0])
  Object.assign(context, { nodeId: identity.node_id, installationId: identity.installation_id })
  assert.equal((await admin('GET', '/tickets')).tickets.length, 0)
  const binding = await admin('POST', '/project-bindings', {
    project_id: context.projectId, node_id: context.nodeId, installation_id: context.installationId,
    worker_id: 'default', root_scope: context.projectRoot,
  })
  assert.equal(binding.project_id, context.projectId)
  assert.equal(binding.node_id, context.nodeId)
  assert.equal(binding.installation_id, context.installationId)
  assert.equal(binding.worker_id, 'default')
  assert.equal(db.prepare('SELECT root_scope FROM project_bindings WHERE id=?').get(binding.id).root_scope, context.projectRoot)
  context.bindingId = binding.id
  const nodesBeforeGrant = await admin('GET', '/nodes')
  const currentNode = nodesBeforeGrant.nodes.find(row => row.id === context.nodeId
    && row.installation_id === context.installationId)
  assert.ok(currentNode, 'one actual registered Node installation')
  assert.equal(nodesBeforeGrant.nodes.length, 1)
  const workerRows = currentNode.workers ?? currentNode.inventory?.workers
  assert.ok(Array.isArray(workerRows), 'real Node worker capabilities are inspectable')
  const worker = workerRows.find(row => (row.worker_id ?? row.id) === 'default')
  assert.ok(worker)
  const registeredCapabilities = db.prepare('SELECT capabilities FROM nodes WHERE id=? AND installation_id=?')
    .get(context.nodeId, context.installationId).capabilities
  const capabilities = JSON.parse(registeredCapabilities).map(capability => capability.ticket_kind ?? capability.as_str ?? capability)
  assert.ok(capabilities.some(capability => ['read_summary', 'file:read_summary', 'ReadSummary'].includes(capability)))
  assert.ok(capabilities.some(capability => ['edit_file', 'file:edit_file', 'EditFile'].includes(capability)))
  const granted = await admin('POST', '/grants', {
    project_id: context.projectId, project_binding_id: binding.id, node_id: context.nodeId,
    installation_id: context.installationId, worker_id: 'default', operations: ['read', 'write'],
  })
  context.grantId = granted.grant.id
  context.grantDigest = granted.grant.digest
  assert.equal(granted.grant.version, 1)
  assert.equal(granted.grant.revoked_at, null)
  assert.deepEqual(granted.grant.operations, ['read', 'write'])
  const content = 'permission already changed\n'
  context.content = content
  context.relativePath = 'permission-result.txt'
  assert.equal(Buffer.byteLength(content), 27)
  const ticket = await admin('POST', '/tickets', {
    project_id: context.projectId, node_id: context.nodeId, worker_id: 'default', grant_id: context.grantId,
    kind: 'edit_file', relative_path: context.relativePath, content,
    objective: 'Complete one actual file replacement, revoke before its first ACK, then require bounded unknown reconciliation',
  })
  assert.equal(ticket.assignments.length, 1)
  assert.equal(ticket.status, 'running')
  Object.assign(context, { ticketId: ticket.id, assignmentId: ticket.assignments[0].id,
    leaseId: ticket.assignments[0].lease_id, leaseEpoch: ticket.assignments[0].lease_epoch })
  assert.equal(context.leaseEpoch, 1)
  assert.equal(ticket.grant_digest, context.grantDigest)
  await assert.rejects(readFile(join(context.projectRoot, context.relativePath)), { code: 'ENOENT' })
  const before = {
    counts: counts(), grant: grantRow(), assignment: assignmentRow(),
    source_sha256: sha256(sourceBytes),
  }
  assert.deepEqual(before.counts, { tickets: 1, assignments: 1, artifacts: 0, reports: 0, effects: 0,
    assignment_acknowledged_audits: 0, grant_revoked_audits: 0 })
  assert.equal(before.assignment.acknowledged_at, null)
  result.preconditions = before

  proxy = await startProxy(center.baseUrl, context)
  proxyStopped = false
  first = launch('completed-effect-held-ordinary-ack', startArgs(proxy.origin))
  await bounded(Promise.race([
    proxy.held,
    first.exited.then(() => { throw new Error(`first exited before its ACK was withheld: ${JSON.stringify(processPublic(first))}`) }),
  ]), 20000, 'first ordinary ACK hold')
  const state = await bounded((async () => {
    for (;;) {
      assert.equal(first.result, null, `first process exited before durable gate: ${JSON.stringify(processPublic(first))}`)
      const candidate = await readState()
      if (candidate.completions[context.assignmentId]?.state === 'succeeded'
        && candidate.active_assignment_id === null && candidate.outbox.length === 2) return candidate
      await sleep(10)
    }
  })(), 10000, 'private durable completion and outbox')
  const assignment = state.assignments[context.assignmentId]
  const completion = state.completions[context.assignmentId]
  const artifactItem = state.outbox.find(item => item.kind === 'artifact')
  const reportItem = state.outbox.find(item => item.kind === 'report')
  assert.ok(artifactItem && reportItem)
  assert.equal(state.outbox.length, 2)
  assert.equal(state.active_assignment_id, null)
  assert.equal(state.last_assignment_id, context.assignmentId)
  assert.equal(completion.state, 'succeeded')
  assert.equal(completion.report_enqueued, true)
  assert.equal(completion.artifacts.length, 1)
  assert.equal(completion.effects.length, 1)
  assert.equal(completion.effects[0].status, 'confirmed')
  assert.equal(completion.effects[0].attempt, 1)
  assert.equal(assignment.grant_digest, context.grantDigest)
  assert.equal(assignment.kind, 'edit_file')
  assert.equal(assignment.relative_path, context.relativePath)
  assert.equal(assignment.content, content)
  assert.equal(assignment.purpose, 'execute')
  assert.equal(reportItem.body.report_id.length, 36)
  assert.equal(reportItem.body.state, 'succeeded')
  assert.equal(reportItem.body.requested_state, 'succeeded')
  assert.equal(reportItem.body.grant_digest, context.grantDigest)
  assert.deepEqual(reportItem.body.artifact_ids, [artifactItem.body.artifact_id])
  assert.equal(reportItem.body.effects[0].status, 'confirmed')
  assert.equal(artifactItem.body.artifact_id, artifactItem.body.metadata.artifact_id)
  assert.equal(artifactItem.body.metadata.origin_node_id, context.nodeId)
  const artifactBytes = await readFile(join(root, 'artifacts', `${artifactItem.body.artifact_id}.bin`))
  assert.equal(sha256(artifactBytes), artifactItem.body.metadata.sha256)
  const effectPath = join(root, 'artifacts', `${completion.effects[0].effect_id}.effect.json`)
  const ledger = JSON.parse(await readFile(effectPath, 'utf8'))
  assert.equal(ledger.status, 'confirmed')
  assert.deepEqual(ledger.effect, completion.effects[0])
  assert.deepEqual((await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.bin')), [`${artifactItem.body.artifact_id}.bin`])
  assert.deepEqual((await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.effect.json')), [`${completion.effects[0].effect_id}.effect.json`])
  const fileBytes = await readFile(join(context.projectRoot, context.relativePath))
  assert.deepEqual(fileBytes, Buffer.from(content))
  assert.equal(proxy.count(routes.acknowledge), 1)
  assert.equal(proxy.upstreamCount(routes.acknowledge), 0)
  assert.ok(proxy.count(routes.poll) >= 3)
  assert.equal(proxy.count(routes.artifacts), 0)
  assert.equal(proxy.count(routes.reports), 0)
  const preRevocation = publicTicket(await admin('GET', `/tickets/${context.ticketId}`))
  assert.equal(preRevocation.status, 'running')
  assert.equal(preRevocation.assignments[0].acknowledged_at, null)
  assert.deepEqual(preRevocation.artifacts, [])
  assert.deepEqual(preRevocation.reports, [])
  assert.deepEqual(preRevocation.effects, [])
  assert.deepEqual(counts(), before.counts)
  result.before_revocation = {
    acknowledgement_at: null, admission_audit_count: 0,
    central_artifacts: 0, central_reports: 0, central_effects: 0,
    local_completion: completion.state, local_outbox: 2,
    local_artifact_id: artifactItem.body.artifact_id, local_artifact_sha256: sha256(artifactBytes),
    local_effect_id: completion.effects[0].effect_id, local_effect_status: 'confirmed',
    real_file_sha256: sha256(fileBytes), report_body: clone(reportItem.body),
    completion_digest: completion.digest, original_grant_digest: context.grantDigest,
    first_process_alive: true, cancellation_polls_forwarded: proxy.count(routes.poll),
  }

  const revocation = await admin('POST', `/grants/${context.grantId}/revoke`, {})
  assert.equal(revocation.revoked, true)
  assert.equal(revocation.duplicate, false)
  assert.equal(revocation.grant_id, context.grantId)
  assert.equal(revocation.grant_version, 2)
  assert.ok(revocation.revoked_at)
  const afterRevocationGrant = grantRow()
  assert.equal(afterRevocationGrant.version, 2)
  assert.equal(afterRevocationGrant.revoked_at, revocation.revoked_at)
  assert.equal(afterRevocationGrant.digest, context.grantDigest)
  const afterRevocationTicket = publicTicket(await admin('GET', `/tickets/${context.ticketId}`))
  assert.equal(afterRevocationTicket.status, 'reconciling')
  assert.equal(afterRevocationTicket.cancel_requested, false)
  assert.equal(afterRevocationTicket.assignments[0].acknowledged_at, null)
  assert.equal(afterRevocationTicket.assignments[0].lease_expires_at, revocation.revoked_at)
  assert.deepEqual(afterRevocationTicket.artifacts, [])
  assert.deepEqual(afterRevocationTicket.reports, [])
  assert.deepEqual(afterRevocationTicket.effects, [])
  assert.equal(proxy.upstreamCount(routes.acknowledge), 0, 'revoke precedes every upstream ordinary admission')
  assert.equal(first.result, null, 'native owner remains alive while the ordinary ACK is still withheld')
  assert.deepEqual(counts(), { tickets: 1, assignments: 1, artifacts: 0, reports: 0, effects: 0,
    assignment_acknowledged_audits: 0, grant_revoked_audits: 1 })
  const preConflictPoll = await nodePoll()
  assert.equal(proxy.authorizedPolls().length, 1)
  result.revocation = {
    grant_id: revocation.grant_id,
    grant_version: revocation.grant_version,
    revoked_at: revocation.revoked_at,
    revoked: revocation.revoked,
    duplicate: revocation.duplicate,
    effects: revocation.effects,
  }
  result.immediate_after_revocation = {
    grant_version: afterRevocationGrant.version, revoked_at: revocation.revoked_at,
    ticket: afterRevocationTicket, poll_while_first_ack_still_held: clone(preConflictPoll),
    counts: counts(), outbox: 2,
    immutable_work: { kind: assignment.kind, relative_path: assignment.relative_path,
      content_sha256: sha256(Buffer.from(assignment.content)), grant_digest: assignment.grant_digest },
  }
  result.pre_revocation_observations_passed = true

  // Only after the real administrator revoke and its null-ACK snapshot do we open
  // the one held gate. The proxy returns the Concierge's real DTO/status verbatim.
  proxy.release()
  await complete(first)
  assert.equal(proxy.heldCount(), 1)
  assert.equal(proxy.count(routes.acknowledge), 1)
  assert.equal(proxy.upstreamCount(routes.acknowledge), 1)
  assert.equal(proxy.ackResponses().length, 1)
  const conflict = proxy.ackResponses()[0]
  assert.equal(conflict.status, 409, 'after revoke, first ordinary admission attempt must be 409')
  assert.equal(conflict.code, 'outcome_unknown')
  assert.equal(conflict.accepted, null)
  assert.equal(conflict.acknowledged_at, null)
  assert.equal(proxy.count(routes.artifacts), 0)
  assert.equal(proxy.count(routes.reports), 0)
  assert.deepEqual(proxy.deliveryResponses(), [])
  const conflictTicket = publicTicket(await admin('GET', `/tickets/${context.ticketId}`))
  assert.deepEqual(conflictTicket, afterRevocationTicket)
  assert.deepEqual(counts(), { tickets: 1, assignments: 1, artifacts: 0, reports: 0, effects: 0,
    assignment_acknowledged_audits: 0, grant_revoked_audits: 1 })
  const stateAfterConflict = await readState()
  assert.deepEqual(stateAfterConflict.assignments, state.assignments)
  assert.deepEqual(stateAfterConflict.completions, state.completions)
  assert.deepEqual(immutableOutbox(stateAfterConflict), immutableOutbox(state))
  assert.deepEqual(outboxBookkeeping(stateAfterConflict), outboxBookkeeping(state),
    'the original 409 leaves even transport bookkeeping untouched until a later null poll')
  assert.deepEqual(stateAfterConflict.deliveries, state.deliveries)
  assert.equal(stateAfterConflict.active_assignment_id, null)
  assert.deepEqual(await readFile(join(context.projectRoot, context.relativePath)), Buffer.from(content))
  assert.deepEqual((await admin('GET', '/grants')).grants.find(row => row.id === context.grantId).operations, ['read', 'write'])
  result.first_ack_after_revocation = {
    status: conflict.status, code: conflict.code, forwarded_count: 1,
    ordinary_admission_null: conflictTicket.assignments[0].acknowledged_at,
    artifacts: conflictTicket.artifacts.length, reports: conflictTicket.reports.length, effects: conflictTicket.effects.length,
    immutable_outbox_unchanged: true, file_unchanged: true, first_process: processPublic(first),
  }

  const postConflictPoll = await nodePoll()
  assert.equal(proxy.authorizedPolls().length, 2)
  result.same_node_authorized_polls = proxy.authorizedPolls()
  assert.deepEqual(result.same_node_authorized_polls.map(poll => poll.wait_seconds), [0, 0])
  assert.ok(result.same_node_authorized_polls.every(poll => poll.node_id === context.nodeId
    && poll.installation_id === context.installationId && poll.last_assignment_id === context.assignmentId))
  const expectedImmutable = assignment => {
    assert.equal(assignment.id, context.assignmentId)
    assert.equal(assignment.ticket_id, context.ticketId)
    assert.equal(assignment.kind, 'edit_file')
    assert.equal(assignment.relative_path, context.relativePath)
    assert.equal(assignment.content, content)
    assert.equal(assignment.grant_digest, context.grantDigest)
    assert.equal(assignment.current_grant.id, context.grantId)
    assert.equal(assignment.current_grant.version, 2)
    assert.equal(assignment.current_grant.digest, context.grantDigest)
    assert.ok(assignment.current_grant.revoked_at)
    assert.equal(assignment.grant_status, false)
    assert.equal(assignment.cancel_requested, false)
  }
  if (postConflictPoll === null) {
    result.actual_ineligible = 'no_reconcile_assignment'
    result.stop_frame = { stage: 'poll_after_first_409', assignment: null,
      admission_predicate: 'acknowledged_at IS NULL blocks revoked reconcile selection' }
  } else {
    assert.equal(postConflictPoll.purpose, 'reconcile')
    expectedImmutable(postConflictPoll)
    result.reconcile_offered = true
    result.stop_frame = { stage: 'poll_after_first_409', assignment: clone(postConflictPoll),
      next_native_path: 'only original durable evidence is eligible for unknown reporting; no second execution' }
  }

  // Observe the native process itself through the same loopback fence, not a new
  // authority or an unobserved direct-center shortcut. It may attempt the old
  // Artifact once after the null poll; its actual 409 remains fenced upstream.
  const reopened = await complete(launch('same-identity-after-409', startArgs(proxy.origin)))
  const reopenedPublic = JSON.parse(reopened.stdout.trim().split('\n').at(-1))
  assert.equal(reopenedPublic.node_id, context.nodeId)
  assert.equal(reopenedPublic.installation_id, context.installationId)
  assert.equal(reopenedPublic.last_assignment_id, context.assignmentId)
  assert.equal(reopenedPublic.active_assignment_id, null)
  assert.equal(reopenedPublic.outbox, 1, 'the ordinary artifact remains private/quarantined; only the unknown Report was delivered')
  assert.equal(reopenedPublic.completions[0]?.state, 'unknown')

  const reconciled = await readState()
  assert.equal(reconciled.outbox.length, 1)
  assert.equal(reconciled.outbox[0].kind, 'artifact')
  assert.equal(reconciled.outbox[0].body.artifact_id, artifactItem.body.artifact_id)
  assert.deepEqual(reconciled.outbox[0].body, artifactItem.body)
  assert.equal(reconciled.outbox[0].digest, artifactItem.digest)
  assert.equal(reconciled.outbox[0].next_attempt_at, '+999999999-12-31T23:59:59Z')
  assert.match(reconciled.outbox[0].last_error, /revoked before ordinary admission/)
  const revoked = reconciled.assignments[context.assignmentId]
  assert.equal(revoked.purpose, 'reconcile')
  assert.equal(revoked.grant_status, false)
  assert.equal(revoked.grant_digest, context.grantDigest)
  assert.equal(revoked.grant_version, 1)
  assert.equal(revoked.grant.version, 2)
  assert.equal(revoked.grant.revoked_at, revocation.revoked_at)
  assert.equal(revoked.relative_path, context.relativePath)
  assert.equal(revoked.content, content)
  assert.equal(revoked.lease_id, context.leaseId)
  assert.equal(revoked.lease_epoch, context.leaseEpoch)
  const reconciledCompletion = reconciled.completions[context.assignmentId]
  assert.equal(reconciledCompletion.state, 'unknown')
  assert.equal(reconciledCompletion.digest, completion.digest)
  assert.deepEqual(reconciledCompletion.artifacts, completion.artifacts)
  assert.equal(reconciledCompletion.effects[0].effect_id, completion.effects[0].effect_id)
  assert.equal(reconciledCompletion.effects[0].status, 'unknown')
  assert.deepEqual(reconciledCompletion.effects[0].artifacts, [])
  assert.equal(reconciledCompletion.effects[0].input_digest, completion.effects[0].input_digest)
  assert.deepEqual(reconciled.deliveries, [{ kind: 'report', digest: reconciled.deliveries[0].digest,
    request_id: reportItem.body.request_id, delivered_at: reconciled.deliveries[0].delivered_at }])
  assert.deepEqual(await readFile(join(context.projectRoot, context.relativePath)), Buffer.from(content))
  assert.equal(sha256(await readFile(join(context.projectRoot, context.relativePath))), sha256(fileBytes))
  assert.deepEqual(await readFile(join(root, 'artifacts', `${artifactItem.body.artifact_id}.bin`)), artifactBytes)
  assert.equal(JSON.parse(await readFile(effectPath, 'utf8')).status, ledger.status)
  assert.equal(proxy.count(routes.acknowledge), 1, 'no ordinary admission was refreshed after revocation')
  assert.equal(proxy.count(routes.artifacts), 0, 'the ordinary Artifact cannot be uploaded after revocation')
  assert.equal(proxy.count(routes.reports), 1, 'only the unknown reconciliation Report is delivered')

  const finalTicket = publicTicket(await admin('GET', `/tickets/${context.ticketId}`))
  assert.equal(finalTicket.status, 'reconciling')
  assert.equal(finalTicket.assignments.length, 1)
  assert.equal(finalTicket.assignments[0].acknowledged_at, null)
  assert.equal(finalTicket.assignments[0].lease_epoch, context.leaseEpoch)
  assert.ok(finalTicket.assignments[0].last_report_at)
  assert.deepEqual(finalTicket.artifacts, [])
  assert.equal(finalTicket.reports.length, 1)
  assert.equal(finalTicket.reports[0].assignment_id, context.assignmentId)
  assert.equal(finalTicket.reports[0].request_id, reportItem.body.request_id)
  assert.equal(db.prepare('SELECT lease_epoch FROM reports WHERE request_id=?').get(finalTicket.reports[0].request_id).lease_epoch, context.leaseEpoch)
  assert.equal(finalTicket.reports[0].state, 'unknown')
  assert.equal(finalTicket.effects.length, 1)
  assert.equal(finalTicket.effects[0].id, completion.effects[0].effect_id)
  assert.equal(finalTicket.effects[0].status, 'unknown')
  const storedEffect = db.prepare('SELECT attempt,node_id,assignment_id,ticket_id,input_digest,artifacts FROM effects WHERE id=?').get(finalTicket.effects[0].id)
  assert.deepEqual({ ...storedEffect }, {
    attempt: context.leaseEpoch, node_id: context.nodeId,
    assignment_id: context.assignmentId, ticket_id: context.ticketId,
    input_digest: completion.effects[0].input_digest, artifacts: '[]',
  })
  assert.equal(finalTicket.effects[0].input_digest, completion.effects[0].input_digest)
  assert.deepEqual(finalTicket.effects[0].artifacts, [])
  const accepted = (await admin('GET', `/tickets/${context.ticketId}`)).reports[0]
  assert.match(accepted.summary, /Grant was revoked/)
  assert.equal(accepted.cancel_acknowledged, 0)
  const evidence = Array.isArray(accepted.evidence) ? accepted.evidence : JSON.parse(accepted.evidence)
  assert.equal(evidence[0].kind, 'grant_revoked')
  assert.equal(evidence[0].ordinary_delivery_blocked_by_revocation, true)
  assert.equal(evidence[0].artifact_transport, 'quarantined')
  const nullAfterReport = await nodePoll()
  assert.equal(nullAfterReport, null, 'a recorded unknown Report prevents repeated reconciliation delivery')
  assert.equal(proxy.authorizedPolls().length, 3)
  assert.deepEqual(counts(), { tickets: 1, assignments: 1, artifacts: 0, reports: 1, effects: 1,
    assignment_acknowledged_audits: 0, grant_revoked_audits: 1 })
  assert.equal((await admin('GET', '/audit/verify')).valid, true)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  result.unknown_reconciliation = {
    purpose: postConflictPoll.purpose, report_state: finalTicket.reports[0].state,
    effect_state: finalTicket.effects[0].status, artifact_transport: 'quarantined',
    original_report_request_id: finalTicket.reports[0].request_id, original_effect_id: finalTicket.effects[0].id,
    normal_admission_after_revoke: false, admission_audit_count: 0,
    no_repeated_assignment_after_report: nullAfterReport === null,
    real_file_and_private_ledger_preserved: true, reopen: processPublic(reopened),
  }
  result.same_identity_reopen = {
    native_public_output: reopenedPublic,
    no_new_ordinary_ack_or_execution: true,
    immutable_original_grant_digest: revoked.grant_digest === context.grantDigest,
  }
  result.preconditions_passed = true
  result.overall = 'PASS'
} catch (error) {
  result.overall = 'FAIL'
  result.error = redact(error.stack || error.message)
  result.process_history = processHistory
  result.in_flight_processes = [...children].map(processPublic)
  if (context.assignmentId && root) {
    try { result.failed_reconcile_private_record = await readState() }
    catch (error) { result.failure_private_read_error = redact(error.message) }
  }
  if (proxy) {
    result.proxy_counts = Object.fromEntries(proxy.counters)
    result.actual_upstream = Object.fromEntries([...proxy.counters].map(([key]) => [key, proxy.upstreamCount(key)]))
    result.actual_ack_responses = proxy.ackResponses()
  }
  if (center) {
    try {
      db ||= openDb()
      result.counts_at_failure = counts()
      if (context.grantId) result.grant_at_failure = grantRow()
      if (context.assignmentId) result.assignment_at_failure = assignmentRow()
    } catch (diagnostic) { result.count_diagnostic = redact(diagnostic.message) }
  }
} finally {
  try { proxy?.release() } catch {}
  for (const entry of [...children]) {
    try {
      entry.child.kill('SIGTERM')
      await bounded(entry.exited, 3000, `${entry.name} SIGTERM cleanup`)
    } catch {
      try { if (!entry.result) entry.child.kill('SIGKILL'); await bounded(entry.exited, 3000, `${entry.name} SIGKILL fallback`) }
      catch (error) { (result.cleanup_errors ||= []).push(redact(error.message)) }
    }
  }
  try { if (proxy) { await bounded(proxy.close(), 5000, 'proxy close'); proxyStopped = true } }
  catch (error) { (result.cleanup_errors ||= []).push(redact(error.message)) }
  try { if (center) { await bounded(center.stop(), 5000, 'center stop'); centerStopped = true } }
  catch (error) { (result.cleanup_errors ||= []).push(redact(error.message)) }
  try { db?.close() } catch {}
  if (result.cleanup_errors) result.overall = 'FAIL'
  result.cleanup = { owned_children_awaited: children.size === 0, proxy_stopped: proxyStopped, center_stopped: centerStopped,
    original_process_cleanup_signal: first?.result?.signal ?? null }
  if (!evidenceDir) evidenceDir = await mkdtemp(join(tmpdir(), 'loom-revoke-after-local-effect-proof-'))
  result.evidence = join(evidenceDir, 'result.json')
  try { await writeFile(result.evidence, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }) }
  catch (error) { result.overall = 'FAIL'; result.evidence_write_error = redact(error.message) }
  console.log(JSON.stringify(result, null, 2))
  if (result.overall !== 'PASS') process.exitCode = 1
}
