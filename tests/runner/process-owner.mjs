#!/usr/bin/env node
// Same real Node identity/state/artifacts opened by independent native OS processes.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareProject, startRustConcierge, testingClientToken, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bareBinary = join(repository, 'target/debug/loom-node')
const byteCap = 1024 * 1024
const heartbeatPath = 'POST /api/v1/nodes/heartbeat'
const pollPath = 'POST /api/v1/nodes/assignments/poll'
const registerPath = 'POST /api/v1/nodes/register'
const acknowledgePath = 'POST /api/v1/nodes/acknowledge'
const artifactPath = 'POST /api/v1/nodes/artifacts'
const reportPath = 'POST /api/v1/nodes/reports'
const secrets = new Set()
const children = new Set()
const commandsUnderway = new Set()
let center
let proxy
let root
let evidence
const result = {
  schema: 'loom.native-process-owner.v1', overall: 'NOT RUN',
  runner: 'actual loom-node bind/start --once OS processes, real Rust Concierge and bounded loopback proxy; no in-process LocalNodeRunner reference',
  limits: [
    'macOS arm64 only; one physical host, one Installation, two concurrent OS processes and one later sequential reopen',
    'controlled loopback deferred poll, not physical network loss or SIGKILL',
    'cooperative same-state-directory ownership only; not noncooperating writers, other Roots or Profiles, remote Hosts or global exactly-once',
    'ordinary accepted ACK/report/artifact/audit fencing; no physical ACK loss is simulated or claimed',
  ],
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function boundedAwait(promise, milliseconds, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${milliseconds}ms shutdown limit`)), milliseconds)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}
function redact(value) {
  let text = String(value)
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted-test-secret]')
  return text.replace(/authorization\s*[:=]\s*bearer\s+\S+/gi, 'authorization: [redacted]')
    .replace(/("(?:private_?key|enrollment_?code|token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
}
function publicProcess(entry) {
  const stdout = entry.stdout.trim().split('\n').filter(Boolean).map(line => {
    try {
      const value = JSON.parse(line)
      if ('last_assignment_id' in value) return {
        node_id: value.node_id, installation_id: value.installation_id,
        last_assignment_id: value.last_assignment_id, outbox: value.outbox,
        active_assignment_id: value.active_assignment_id,
        completions: value.completions?.map(item => ({
          assignment_id: item.assignment_id, state: item.state,
          artifact_ids: item.artifact_ids, report_enqueued: item.report_enqueued,
          recovered_from_restart: item.recovered_from_restart,
        })),
      }
      return {
        node_id: value.node_id, installation_id: value.installation_id,
        heartbeat: value.heartbeat, connected_identity: value.connected_identity,
      }
    } catch { return { unrecognised_output: redact(line).slice(0, 1000) } }
  })
  return {
    pid: entry.child.pid, code: entry.result?.code ?? null, signal: entry.result?.signal ?? null,
    before_explicit_deadline: Boolean(entry.result) && !entry.timedOut, timed_out: entry.timedOut,
    stdout, stderr: redact(entry.stderr).slice(0, 8192),
    ...(entry.spawnError ? { spawn_error: entry.spawnError } : {}),
  }
}
function processDescription(entry) { return JSON.stringify(publicProcess(entry)) }
function launch(name, args, { code = null } = {}) {
  const entry = {
    name, args: [...args], stdout: '', stderr: '', result: null, timedOut: false,
    child: spawn(bareBinary, args, {
      cwd: root, env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    }),
  }
  if (code) secrets.add(code)
  children.add(entry)
  commandsUnderway.add(name)
  entry.child.once('error', error => { entry.spawnError = redact(error.stack || error.message) })
  for (const [field, stream] of [['stdout', entry.child.stdout], ['stderr', entry.child.stderr]]) {
    stream.on('data', chunk => {
      if (entry[field].length < byteCap) entry[field] += String(chunk).slice(0, byteCap - entry[field].length)
    })
  }
  entry.exited = new Promise(resolve => {
    entry.child.once('exit', (exitCode, signal) => {
      entry.result = { code: exitCode, signal }
      children.delete(entry)
      commandsUnderway.delete(name)
      resolve(entry)
    })
  })
  entry.wait = async milliseconds => {
    let timer
    const expired = new Promise(resolve => {
      timer = setTimeout(() => { entry.timedOut = true; resolve(null) }, milliseconds)
    })
    try {
      const arrival = await Promise.race([entry.exited, expired])
      if (!arrival) {
        // End the one deadline race here. The outer owner completes and checks
        // this timeout; cleanup kills/native closes any remaining test process.
        await proxy?.release()
      }
      return arrival || entry
    } finally { clearTimeout(timer) }
  }
  return entry
}
async function complete(entry, expectedCode, timeoutMs = 20000) {
  await entry.wait(timeoutMs)
  assert.ok(entry.result, `${entry.name} did not finish inside its explicit ${timeoutMs}ms bound: ${processDescription(entry)}`)
  assert.equal(entry.timedOut, false, `${entry.name} used its timeout, not a normal return: ${processDescription(entry)}`)
  assert.equal(entry.result.code, expectedCode, `${entry.name} has an unexpected exit: ${processDescription(entry)}`)
  return entry
}
async function admin(method, route, body) {
  const response = await fetch(`${center.baseUrl}/api/v1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${center.clientToken}`, accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.byteLength <= byteCap, `${method} ${route} exceeded the 1 MiB admin read cap`)
  const value = JSON.parse(bytes.toString('utf8'))
  if (!response.ok) {
    const error = new Error(`${method} ${route}: ${response.status}: ${JSON.stringify(value.error)}`)
    error.status = response.status
    error.code = value.error?.code
    throw error
  }
  return value
}
function receiveBody(request) {
  return new Promise((resolve, reject) => {
    let length = 0
    let done = false
    const chunks = []
    const fail = error => {
      if (done) return
      done = true
      request.destroy()
      reject(error)
    }
    request.on('data', chunk => {
      length += chunk.length
      if (length > byteCap) return fail(new Error('test loopback body exceeds 1 MiB'))
      chunks.push(chunk)
    })
    request.once('error', fail)
    request.once('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
  })
}
function forwardRequest(upstream, incoming, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(incoming.url, upstream), {
      // The HTTP library consumes the verbatim raw path+query after the base
      // origin. No coordinator replacement, bearer bearing, body rewrite or retry occurs.
      path: incoming.url, method: incoming.method, headers: incoming.headers, agent: false,
    }, resolve)
    request.once('error', reject)
    request.setTimeout(30000, () => request.destroy(new Error('bounded loopback upstream request timed out')))
    request.end(body)
  })
}
async function receiveResponse(response) {
  const chunks = []
  let length = 0
  for await (const chunk of response) {
    length += chunk.length
    assert.ok(length <= byteCap, 'test loopback response exceeds 1 MiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function startProxy(upstream, assignmentId) {
  const counters = new Map()
  let holdEnabled = false
  let heldCount = 0
  let released = false
  let release
  let releaseInitialized
  let pollSeenResolve
  let firstBodyPublic
  let deadline
  const pollHeld = new Promise(resolve => { pollSeenResolve = resolve })
  const server = createServer(async (request, response) => {
    let upstreamResponse
    const pathname = request.url.split('?', 1)[0]
    const key = `${request.method} ${pathname}`
    try {
      if (![pollPath, heartbeatPath, registerPath, acknowledgePath, artifactPath, reportPath, 'POST /api/v1/nodes/challenge'].includes(key)) {
        response.writeHead(404).end()
        return
      }
      counters.set(key, (counters.get(key) || 0) + 1)
      const bytes = await receiveBody(request)
      const target = holdEnabled && key === pollPath && heldCount === 0
      if (target) {
        ++heldCount
        const body = JSON.parse(bytes.toString('utf8'))
        firstBodyPublic = {
          protocol: body.protocol, node_id: body.node_id, installation_id: body.installation_id,
          last_assignment_id: body.last_assignment_id, wait_seconds: body.wait_seconds,
        }
        assert.deepEqual(firstBodyPublic.last_assignment_id, null)
        assert.equal(firstBodyPublic.wait_seconds, 10)
        // This is the authentic BSD runner poll: no upstream call yet, so the
        // centre remains unacknowledged with zero artifacts until explicitly resumed.
        // Existing native request timeout is wait_seconds + 20. Do not cut off
        // a real post-auth read with a shorter invented coordinator deadline.
        deadline = setTimeout(() => releaseInitialized?.(), 45000)
        pollSeenResolve(firstBodyPublic)
        await new Promise(resolve => { release = resolve; releaseInitialized = resolve })
      } else if (key === pollPath) {
        // The subsequent cancellation observation polls of a completed Rust
        // attempt are real requests. They are not extra held assignment requests.
        const body = JSON.parse(bytes.toString('utf8'))
        assert.equal(body.last_assignment_id, assignmentId, 'only the ordinary assignment observation may follow the originally held poll')
        assert.equal(body.wait_seconds, 1)
      }
      upstreamResponse = await forwardRequest(upstream, request, bytes)
      const body = await receiveResponse(upstreamResponse)
      // Relay the real status, headers and complete bytes. Only the scheduling
      // of that one request was under test; no denial, Ticket or receipt is manufactured.
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      response.end(body)
    } catch (error) {
      upstreamResponse?.destroy()
      result.proxyFailures ||= []
      result.proxyFailures.push({ key, message: redact(error.stack || error.message) })
      if (!response.headersSent) response.writeHead(504, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify({ error: { code: 'test_proxy_failure', message: 'test forwarding failed' } }))
    }
  })
  server.keepAliveTimeout = 250
  server.headersTimeout = 2000
  server.requestTimeout = 40000
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  assert.equal(server.address().address, '127.0.0.1')
  const releaseHeld = () => {
    if (released) return
    released = true
    clearTimeout(deadline)
    const callback = release || releaseInitialized
    releaseInitialized = undefined
    callback?.()
  }
  return {
    origin: `http://127.0.0.1:${server.address().port}`, counters, pollHeld, release: releaseHeld,
    count(path) { return counters.get(path) || 0 },
    enableHold() { holdEnabled = true },
    firstBody() { return firstBodyPublic },
    heldCount() { return heldCount },
    async close() {
      releaseHeld()
      if (!server.listening) return
      server.closeAllConnections?.()
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
async function lockMetadata() {
  const metadata = await lstat(join(root, 'state', 'runner.lock'))
  assert.equal(metadata.isFile(), true)
  assert.equal(metadata.isSymbolicLink(), false)
  assert.equal(metadata.nlink, 1)
  assert.equal(metadata.mode & 0o777, 0o600)
  return { regular: true, nonlink: true, single_link: true, mode: '0600', inode: metadata.ino.toString() }
}
async function binarySnapshots() {
  const names = (await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.bin')).sort()
  for (const name of names) {
    assert.match(name, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin$/)
    assert.equal((await lstat(join(root, 'artifacts', name))).isFile(), true)
  }
  return Object.fromEntries(await Promise.all(names.map(async name => [name, sha256(await readFile(join(root, 'artifacts', name)))])))
}
function openDb() { return new DatabaseSync(join(center.dataDir, 'loom.sqlite3'), { readOnly: true }) }
function counts(db, ticketId) {
  const sql = (text, ...args) => db.prepare(text).get(...args)
  return {
    tickets: sql('SELECT COUNT(*) AS count FROM tickets').count,
    assignments: sql('SELECT COUNT(*) AS count FROM assignments').count,
    artifacts: sql('SELECT COUNT(*) AS count FROM artifacts').count,
    reports: sql('SELECT COUNT(*) AS count FROM reports').count,
    effects: sql('SELECT COUNT(*) AS count FROM effects').count,
    assignmentAcknowledgedAudits: sql("SELECT COUNT(*) AS count FROM audits WHERE action='assignment.acknowledged'").count,
  }
}

try {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'arm64')
  root = await testingRoot()
  evidence = await mkdtemp(join(tmpdir(), 'loom-native-process-owner-proof-'))
  await promisify(execFile)('cargo', ['build', '--offline', '--locked', '-p', 'loom-node', '--bin', 'loom-node'], {
    cwd: repository, timeout: 120000,
  })
  const clientToken = testingClientToken()
  secrets.add(clientToken)
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: clientToken } })
  secrets.add(center.clientToken)
  const projectRoot = await prepareProject(root)
  const sourceBytes = await readFile(join(projectRoot, 'input.txt'))
  const sourceSha256 = sha256(sourceBytes)
  const created = await admin('POST', '/projects', {
    name: 'actual native process-owner one-ticket fixture', root: projectRoot, mode: 'read_only',
  })
  const projectId = created.project.id
  const projectMapping = `${projectId}=${projectRoot}`
  const bound = await complete(launch('bind', ['bind', '--state-dir', join(root, 'state'), '--project-root', projectMapping]), 0)
  const bindPublic = JSON.parse(bound.stdout.trim().split('\n')[0])
  assert.match(bindPublic.node_id, /^[a-f0-9]{64}$/)
  assert.equal(bindPublic.connected_identity, true)
  const enrollment = await admin('POST', '/enrollment-codes', {})
  const enrollmentArgs = ['start', '--coordinator', center.baseUrl,
    '--state-dir', join(root, 'state'), '--artifact-dir', join(root, 'artifacts'),
    '--project-root', projectMapping, '--once', '--enrollment-code', enrollment.code]
  const initial = await complete(launch('first-registered-idle', enrollmentArgs, { code: enrollment.code }), 0)
  const initialLines = initial.stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(initialLines.length, 2)
  const publicIdentity = { nodeId: initialLines[0].node_id, installationId: initialLines[0].installation_id }
  assert.equal(publicIdentity.nodeId, bindPublic.node_id)
  assert.equal(initialLines[0].heartbeat, true)
  assert.equal(initialLines[1].last_assignment_id, null, 'bare first registration precedes every actual assignment')
  assert.equal(initialLines[1].outbox, 0)
  const lock = await lockMetadata()
  const nodes = await admin('GET', '/nodes')
  const registered = nodes.nodes.find(node => node.id === publicIdentity.nodeId && node.installation_id === publicIdentity.installationId)
  assert.ok(registered, 'same public local Node installation appears over real coordinator registration')
  assert.equal(publicIdentity.nodeId, bindPublic.node_id)
  assert.equal((await admin('GET', '/tickets')).tickets.length, 0, 'no earlier ticket may exist under this isolated fixture')
  const binding = await admin('POST', '/project-bindings', {
    project_id: projectId, node_id: publicIdentity.nodeId, installation_id: publicIdentity.installationId,
    worker_id: 'default', root_scope: projectRoot,
  })
  const granted = await admin('POST', '/grants', {
    project_id: projectId, project_binding_id: binding.id, node_id: publicIdentity.nodeId,
    installation_id: publicIdentity.installationId, worker_id: 'default', operations: ['read'],
  })
  const grants = (await admin('GET', '/grants')).grants
  assert.equal(grants.length, 1)
  assert.deepEqual(grants[0].operations, ['read'])
  const grantDigest = grants[0].digest
  const ticket = await admin('POST', '/tickets', {
    project_id: projectId, node_id: publicIdentity.nodeId,
    worker_id: 'default', grant_id: grants[0].id, kind: 'read_summary', relative_path: 'input.txt',
    objective: 'one actual read of the sole input file, while a real owner process keeps its poll open',
  })
  const ticketId = ticket.id
  assert.equal(ticket.project_id, projectId)
  assert.equal(ticket.node_id, publicIdentity.nodeId)
  assert.equal(ticket.installation_id, publicIdentity.installationId)
  assert.equal(ticket.grant_id, grants[0].id)
  assert.equal(ticket.grant_digest, grantDigest)
  assert.equal(ticket.assignments[0].node_id, publicIdentity.nodeId)
  assert.equal(ticket.kind, 'read_summary')
  assert.equal(ticket.assignments.length, 1)
  const assignmentId = ticket.assignments[0].id
  assert.equal(ticket.assignments[0].id, assignmentId)
  const pendingAssignment = await admin('GET', `/tickets/${ticketId}`)
  assert.equal(pendingAssignment.installation_id, publicIdentity.installationId)
  assert.equal(pendingAssignment.grant_digest, grantDigest)
  assert.equal(pendingAssignment.assignments[0].node_id, publicIdentity.nodeId)
  assert.equal((await admin('GET', '/tickets')).tickets.length, 1)

  proxy = await startProxy(center.baseUrl, assignmentId)
  proxy.enableHold()
  const normalArgs = coordinator => ['start', '--coordinator', coordinator,
    '--state-dir', join(root, 'state'), '--artifact-dir', join(root, 'artifacts'),
    '--project-root', projectMapping, '--once']
  const owner = launch('first-owned-held-poll', [...normalArgs(proxy.origin), '--wait-seconds', '10'])
  const seen = await Promise.race([
    proxy.pollHeld,
    owner.exited.then(() => null),
    sleep(20000).then(() => null),
  ])
  assert.ok(seen, `first real poll was not observed before owner exit/deadline: ${processDescription(owner)}`)
  assert.equal(owner.result, null, 'known behavior before peer process: first CLI is still waiting for HTTP, not a synthetic acceptance')
  assert.deepEqual(proxy.firstBody(), { protocol: 'loom.node.v1', node_id: publicIdentity.nodeId, installation_id: publicIdentity.installationId, last_assignment_id: null, wait_seconds: 10 })
  assert.equal(proxy.heldCount(), 1)
  assert.equal(proxy.count(pollPath), 1)
  assert.equal(proxy.count(registerPath), 0)
  const pendingDetail = await admin('GET', `/tickets/${ticketId}`)
  assert.equal(pendingDetail.assignments[0].acknowledged_at, null)
  assert.deepEqual(pendingDetail.artifacts, [])
  assert.deepEqual(pendingDetail.reports, [])
  assert.deepEqual(pendingDetail.effects, [])
  assert.deepEqual(await binarySnapshots(), {})
  const beforeContenderPublicDetail = await admin('GET', `/tickets/${ticketId}`)
  const beforeContenderNodePublic = await admin('GET', '/nodes')
  const beforePeerAt = Date.now()
  const contender = launch('second-contending-process', normalArgs(center.baseUrl))
  await contender.wait(20000)
  result.contenderObservedMs = Date.now() - beforePeerAt
  assert.ok(contender.result, `second process has not arrived; no instance result is claimed: ${processDescription(contender)}`)
  assert.notEqual(contender.result.code, 0, `second process unexpectedly succeeded; real owner conflict absent: ${processDescription(contender)}`)
  assert.equal(contender.result.signal, null)
  assert.equal(contender.timedOut, false)
  assert.ok(contender.stderr.includes('another LocalNodeRunner already owns this node state directory'), `actual second-process stderr: ${processDescription(contender)}`)
  assert.equal(owner.result, null, 'the first process is alive while the peer cannot acquire runner.lock')
  assert.ok(commandsUnderway.has('first-owned-held-poll'))
  assert.deepEqual(commandsUnderway, new Set(['first-owned-held-poll']))
  assert.equal(proxy.count(registerPath), 0)
  assert.equal(proxy.count(heartbeatPath), 1, 'second acquisition stops before its second registration/heartbeat')
  assert.equal(proxy.count(pollPath), 1)
  assert.equal(proxy.count(artifactPath), 0)
  assert.equal(proxy.count(reportPath), 0)
  assert.equal(proxy.count(acknowledgePath), 0)
  assert.deepEqual(await binarySnapshots(), {})
  const contendedDetails = await admin('GET', `/tickets/${ticketId}`)
  assert.deepEqual(contendedDetails, beforeContenderPublicDetail, 'contender cannot change ticket identity or public work projection')
  assert.deepEqual(await admin('GET', '/nodes'), beforeContenderNodePublic, 'no challenged register or heartbeat changes should have reached Coordinator')
  assert.equal(contendedDetails.assignments[0].acknowledged_at, null)
  assert.deepEqual(contendedDetails.artifacts, [])
  assert.deepEqual(contendedDetails.reports, [])
  assert.deepEqual(contendedDetails.effects, [])
  result.ownerRejected = true
  result.ownerErrorClass = 'another LocalNodeRunner already owns this node state directory'
  result.secondIsFailureKnown = true
  result.firstProcessAliveAtContention = true
  result.commandsUnderwayAtContention = [...commandsUnderway]
  result.contender = publicProcess(contender)

  // This is intentionally before any failure exit or cleanup branch. Neither the
  // real first poll nor its pending owner is converted into a fabricated failed receipt.
  proxy.release()
  await complete(owner, 0)
  result.firstCompleted = true
  assert.deepEqual(result.proxyFailures, undefined)
  assert.ok(proxy.count(pollPath) >= 2, 'the ordinary attempt has real subsequent cancellation observations that are individually scoped by last_assignment_id and wait_seconds, and is not one redundant admission')
  assert.equal(proxy.count(registerPath), 0)
  assert.equal(proxy.count(artifactPath), 1)
  assert.equal(proxy.count(reportPath), 1)
  assert.equal(proxy.count(acknowledgePath), 1)
  const beforeReopen = await admin('GET', `/tickets/${ticketId}`)
  assert.equal(beforeReopen.status, 'succeeded')
  assert.equal(beforeReopen.assignments.length, 1)
  assert.equal(beforeReopen.artifacts.length, 1)
  assert.equal(beforeReopen.reports.length, 1)
  assert.equal(beforeReopen.effects.length, 1)
  const originalAck = beforeReopen.assignments[0].acknowledged_at
  assert.ok(originalAck)
  assert.equal(beforeReopen.grant_digest, grantDigest)
  assert.equal(beforeReopen.grant_id, grants[0].id)
  const artifact = beforeReopen.artifacts[0]
  assert.equal(artifact.assignment_id, assignmentId)
  const expectedBinary = `${artifact.id}.bin`
  const binariesBefore = await binarySnapshots()
  assert.deepEqual(Object.keys(binariesBefore), [expectedBinary])
  assert.equal(binariesBefore[expectedBinary], artifact.sha256)
  assert.equal(artifact.origin_node_id, publicIdentity.nodeId)
  const beforeDownload = await admin('GET', `/tickets/${ticketId}/artifacts/${artifact.id}?encoding=base64`)
  assert.equal(beforeDownload.encoding, 'base64')
  assert.equal(beforeDownload.truncated, false)
  const bytes = Buffer.from(beforeDownload.content, 'base64')
  assert.equal(bytes.toString('base64'), beforeDownload.content)
  assert.equal(sha256(bytes), artifact.sha256)
  const actualSummary = JSON.parse(bytes.toString('utf8'))
  assert.equal(actualSummary.schema, 'loom.synthetic_summary.v1')
  assert.equal(actualSummary.relative_path ?? actualSummary.path, 'input.txt')
  assert.equal(actualSummary.input_sha256, sourceSha256)
  assert.equal(actualSummary.byte_length, sourceBytes.length)
  assert.deepEqual(actualSummary.lines, ['Real isolated project input.', 'No LLM, DSH host or network model was called.'])
  assert.deepEqual(await readFile(join(projectRoot, 'input.txt')), sourceBytes)
  assert.equal((await lockMetadata()).inode, lock.inode)
  const db = openDb()
  const persistedBefore = counts(db, ticketId)
  const ackAuditsBefore = db.prepare("SELECT actor,evidence FROM audits WHERE ticket_id=? AND action='assignment.acknowledged'").all(ticketId)
  assert.equal(ackAuditsBefore.length, 1)
  assert.equal(JSON.parse(ackAuditsBefore[0].evidence).evidence.assignment_id, assignmentId)
  const assignmentAuditsBefore = db.prepare('SELECT * FROM audits WHERE ticket_id=?').all(ticketId)
  assert.deepEqual(persistedBefore, { tickets: 1, assignments: 1, artifacts: 1, reports: 1, effects: 1, assignmentAcknowledgedAudits: 1 })
  assert.equal((await admin('GET', '/audit/verify')).valid, true)
  const firstProxyCounts = Object.fromEntries(proxy.counters)
  const firstGrant = (await admin('GET', '/grants')).grants.find(row => row.id === grants[0].id)
  assert.deepEqual(firstGrant.operations, ['read'])
  assert.equal(firstGrant.digest, grantDigest)
  assert.equal(firstGrant.revoked_at, null)

  // No proxy and no artificial new work are necessary: drop of the first process
  // has released the real owned fd and the identical third process may now run idle.
  const reopened = await complete(launch('sequential-reopen-no-new-work', normalArgs(center.baseUrl)), 0)
  const finalDetail = await admin('GET', `/tickets/${ticketId}`)
  assert.deepEqual(finalDetail, beforeReopen, 'the actual completed ticket projection is unchanged byte-for-byte as JSON')
  const afterDownload = await admin('GET', `/tickets/${ticketId}/artifacts/${artifact.id}?encoding=base64`)
  assert.deepEqual(afterDownload, beforeDownload)
  const binariesAfter = await binarySnapshots()
  assert.deepEqual(binariesAfter, binariesBefore)
  assert.deepEqual(counts(db, ticketId), persistedBefore)
  assert.deepEqual(db.prepare("SELECT actor,evidence FROM audits WHERE ticket_id=? AND action='assignment.acknowledged'").all(ticketId), ackAuditsBefore)
  assert.deepEqual(db.prepare('SELECT * FROM audits WHERE ticket_id=?').all(ticketId), assignmentAuditsBefore)
  assert.deepEqual((await admin('GET', '/grants')).grants, [firstGrant])
  assert.equal(finalDetail.assignments[0].acknowledged_at, originalAck)
  assert.equal((await admin('GET', '/audit/verify')).valid, true)
  assert.equal((await admin('GET', '/tickets')).tickets.length, 1)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.equal(proxy.count(registerPath), 0, 'contender and sequential reopen reach the true center outside proxy; no second native registration through the proxy')
  assert.deepEqual(Object.fromEntries(proxy.counters), firstProxyCounts, 'sequential same-identity reopen did not produce extra proxy forwards or work')
  assert.deepEqual(await readFile(join(projectRoot, 'input.txt')), sourceBytes)
  assert.equal(commandsUnderway.size, 0)
  db.close()
  Object.assign(result, {
    overall: 'PASS',
    public_identity: { node_id: publicIdentity.nodeId, installation_id: publicIdentity.installationId },
    runner_lock: lock,
    ticket_id: ticketId, assignment_id: assignmentId,
    tickets: 1, assignments: 1, artifacts: 1, reports: 1, effects: 1,
    only_read_grant_operations: grants[0].operations,
    original_grant_digest: grantDigest, grant_digest_unchanged: true,
    original_acknowledged_at: originalAck, original_ack_timestamp_unchanged: true,
    artifact_id: artifact.id, artifact_sha256: artifact.sha256,
    input_sha256: sourceSha256,
    actual_summary: { path: actualSummary.path, line_count: actualSummary.line_count, byte_length: actualSummary.byte_length },
    artifact_files_before: Object.keys(binariesBefore), artifact_files_after: Object.keys(binariesAfter),
    artifact_bytes_unchanged: true,
    source_bytes_unchanged: true,
    reopenedNoNewEffects: true, no_new_ticket: true, no_new_ack: true,
    assignment_acknowledged_audits: 1, audit_valid: true, sqlite_integrity: 'ok',
    proxy: {
      exact_path_only: pollPath,
      deferred_inbound_before_upstream: true,
      first_body_public: proxy.firstBody(), held_count: proxy.heldCount(),
      forwarded_incoming_headers_method_path_and_body_without_fixture_rewriting: true,
      ordinary_assignment_polls: proxy.count(pollPath),
      do_not_change_forwards_or_receipts: true,
      all_first_process_routes: firstProxyCounts,
      network_forward_failures: 0,
    },
    heldOwner: publicProcess(owner), contender: publicProcess(contender), reopened: publicProcess(reopened),
    commands_underway: [...commandsUnderway],
    public_command_shapes: {
      bind: ['bind', '--state-dir', '<private-state>', '--project-root', '<project-id=approved-root>'],
      start: ['start', '--coordinator', '<loopback>', '--state-dir', '<private-state>', '--artifact-dir', '<private-artifacts>', '--project-root', '<project-id=approved-root>', '--once'],
      concurrent_processes: 2, sequential_processes: 1, no_bindings_file_or_shell: true,
    },
  })
} catch (error) {
  result.overall = 'FAIL'
  result.error = redact(error.stack || error.message)
  result.commands_underway = [...commandsUnderway].sort()
  result.in_flight_processes = [...children].map(publicProcess)
  if (proxy) result.proxyPathCounts = Object.fromEntries(proxy.counters)
  if (root && center) {
    try {
      const db = openDb()
      result.actualFailureCounts = counts(db)
      db.close()
    } catch (diagnosticError) {
      result.failure_count_diagnostic = redact(diagnosticError.message)
    }
  }
  if (root) {
    try { result.localBinariesAtFailure = Object.keys(await binarySnapshots()) }
    catch (diagnosticError) { result.local_binary_diagnostic = redact(diagnosticError.message) }
  }
} finally {
  // Release before fail/cleanup, then await all active native children. A
  // self-imposed liveness timeout closes the deferred gate without a closed socket.
  await proxy?.release()
  for (const entry of [...children]) {
    try {
      const timeout = setTimeout(() => {
        if (!entry.result) entry.child.kill('SIGKILL')
      }, 3000)
      // Once released, a healthy owner completes this real validated read in
      // milliseconds; retain its successful output even if an earlier fixture
      // assertion failed and we are collecting a non-PASS failure Witness.
      if (!entry.result) {
        await Promise.race([entry.exited, sleep(2000)])
        if (!entry.result) entry.child.kill('SIGTERM')
      }
      await entry.wait(5000)
      clearTimeout(timeout)
      if (!entry.result) {
        result.cleanupErrors ||= []
        result.cleanupErrors.push(`${entry.name} did not exit within the cleanup grace period`)
      }
    } catch (cleanupError) {
      result.cleanupErrors ||= []
      result.cleanupErrors.push(redact(cleanupError.message))
    }
  }
  let proxyClosed = proxy ? false : null
  let centerStopped = center ? false : null
  try {
    if (proxy) await boundedAwait(proxy.close(), 5000, 'loopback proxy shutdown')
    proxyClosed = true
  } catch (error) {
    result.cleanupErrors ||= []
    result.cleanupErrors.push(redact(error.message))
  }
  try {
    if (center) await boundedAwait(center.stop(), 5000, 'Concierge shutdown')
    centerStopped = true
  } catch (error) {
    result.cleanupErrors ||= []
    result.cleanupErrors.push(redact(error.message))
  }
  commandsUnderway.clear()
  if (result.cleanupErrors) result.overall = 'FAIL'
  result.cleanup = { proxy_closed: proxyClosed, all_children_awaited: children.size === 0 && [...commandsUnderway].length === 0, center_stopped: centerStopped }
  if (evidence) {
    try { await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }) }
    catch (error) {
      result.evidence_write_error = redact(error.message)
      result.cleanupErrors ||= []
      result.cleanupErrors.push(`result evidence was not written: ${result.evidence_write_error}`)
      result.overall = 'FAIL'
    }
  }
  result.evidence = evidence ? join(evidence, 'result.json') : undefined
  console.log(JSON.stringify(result, null, 2))
  if (result.overall !== 'PASS') process.exitCode = 1
}
