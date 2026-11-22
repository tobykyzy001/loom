import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import http from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { LoopbackArtifactOfferServer, sourceOfferQuestion } from '../../packages/node-client/src/direct.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { canonical, sha256 } from '../../packages/node-client/src/util.js'
import { envelope } from '../../packages/node-client/src/validation.js'
import { startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const binary = join(repo, 'target/debug/loom-node')
const exec = promisify(execFile)
const owned = { servers: new Set(), controllers: new Set() }
const report = { overall: 'FAIL', phase: 'start', checks: [], cases: [], commands: [], cleanup: [] }
const check = (name, evidence = {}) => report.checks.push({ name, ...evidence })
async function bounded(promise, label, timeout = 20000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), timeout) })]) }
  finally { clearTimeout(timer) }
}
async function stopServer(owner) {
  if (!owner || owner.closed) return
  owner.closed = true
  owner.server.closeIdleConnections?.()
  owner.server.closeAllConnections?.()
  for (const socket of owner.sockets) socket.destroy()
  await bounded(new Promise((resolve, reject) => owner.server.close(error => error ? reject(error) : resolve())), 'listener close', 8000)
  owned.servers.delete(owner)
}
function trackServer(server, name) {
  const owner = { server, name, sockets: new Set(), closed: false }
  owner.close = () => stopServer(owner)
  server.on('connection', socket => { owner.sockets.add(socket); socket.once('close', () => owner.sockets.delete(socket)) })
  owned.servers.add(owner)
  return owner
}
async function listen(server, name) {
  const owner = trackServer(server, name)
  await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }), `listen ${name}`)
  return { owner, url: `http://127.0.0.1:${server.address().port}` }
}
async function directRequest(url, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }))
    })
    request.once('error', reject)
    request.setTimeout(6000, () => request.destroy(new Error('direct request deadline')))
    request.end(bytes)
  })
}

let root, controller, admin, receiver, receiverPost, bindingFile, bIdentity
let sourceRoot, destinationRoot, producer, project, readGrant, writeGrant, state, artifactDir, peers
let nonceCounter = 0
const resultFile = () => join(root, 'direct-native-result.json')
async function native(enrollmentCode = undefined, { outbox = 0, label = 'native', exitCode = 0, diagnostic } = {}) {
  const args = ['start', '--coordinator', controller.baseUrl, '--state-dir', state, '--artifact-dir', artifactDir, '--bindings-file', bindingFile, '--direct-peers-file', peers, '--wait-seconds', '1', '--once']
  const child = spawn(binary, args, { cwd: repo, env: { ...process.env, ...(enrollmentCode ? { LOOM_ENROLLMENT_CODE: enrollmentCode } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  const resultOrTimeout = Promise.race([result, new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'SIGKILL' }) }, 25000))])
  const outcome = await bounded(resultOrTimeout, `${label} exit`, 30000)
  report.commands.push({ command: `${binary} ${args.join(' ')}`, exit_code: outcome.code, signal: outcome.signal, stderr })
  assert.equal(outcome.code, exitCode, stderr)
  assert.equal(outcome.signal, null, stderr)
  if (exitCode === 0) assert.equal(stderr, '', 'successful native execution must have zero error output')
  else if (diagnostic) assert.match(stderr, diagnostic)
  else assert.equal(stderr, '', 'native execution must have zero error output')
  const rows = stdout.split(/\r?\n/).filter(Boolean).map(JSON.parse)
  assert.equal(rows[0]?.heartbeat, true)
  assert.equal(rows.length, exitCode === 0 ? 2 : 1, 'Deferred CLI still preserves the exact evidence on disk instead of printing success')
  const publicState = rows.at(-1)
  assert.equal((await saved()).outbox.length, outbox)
  if (exitCode === 0) assert.equal(publicState.outbox, outbox)
  return publicState
}
const saved = async () => JSON.parse(await readFile(join(state, 'node-state.json'), 'utf8'))
const ticket = doc => admin.get(`/api/v1/tickets/${doc.childTicket}`)
async function issue(doc) {
  return (await receiverPost('/api/v1/nodes/direct-offers', { ...envelope(receiver, randomUUID()), ticket_id: doc.childTicket, assignment_id: doc.assignment.id,
    lease_id: doc.assignment.lease_id, lease_epoch: doc.assignment.lease_epoch, artifact_id: doc.parent.id })).direct_offer
}
async function createPipeline() {
  const suffix = ++nonceCounter
  const id = randomUUID()
  await admin.post('/api/v1/pipelines', { schema: 'loom.document-pipeline.v1', version: 1, pipeline_id: id, project_id: project.id,
    read: { stage_id: 'source', kind: 'read_summary', grant_id: readGrant.id, relative_path: 'docs/input.txt', output_id: 'source', depends_on: [], worker_id: 'worker-a' },
    edit: { stage_id: 'target', kind: 'edit_file', grant_id: writeGrant.id, relative_path: `docs/output-${suffix}.txt`, output_id: 'target', depends_on: ['source'], worker_id: 'default', transform: 'trim', direct: true } })
  assert.equal((await producer.pollAndRun()).status, 'succeeded')
  await producer.client.dispatchOutbox()
  const response = await receiverPost('/api/v1/nodes/assignments/poll', { ...envelope(receiver, randomUUID()), last_assignment_id: null, wait_seconds: 0 })
  assert.ok(response.assignment)
  const pipeline = (await admin.get(`/api/v1/pipelines/${id}`)).pipeline
  const parentTicket = pipeline.stages[0].ticket_id
  const parent = (await admin.get(`/api/v1/tickets/${parentTicket}`)).artifacts[0]
  const bytes = await readFile(join(producer.options.artifactDir, `${parent.id}.bin`))
  assert.equal(sha256(bytes), parent.sha256)
  const assignment = response.assignment
  assert.equal(assignment.content, null)
  assert.deepEqual(Object.keys(assignment.artifact_input).sort(), ['artifact_ref', 'direct_offer', 'offer_scope', 'transform'])
  return { id, assignment, childTicket: pipeline.stages[1].ticket_id, parentTicket, parent, bytes, target: join(destinationRoot, 'docs', `output-${suffix}.txt`) }
}
async function startPeer(doc, offer = undefined) {
  offer ||= await issue(doc)
  const owner = new LoopbackArtifactOfferServer({ identity: producer.identity, offer, bytes: doc.bytes, root: producer.options.artifactDir,
    nonceFile: join(producer.options.stateDir, 'a-direct-used-nonces.json'),
    sourceGrantCurrent: async () => (await sourceOfferQuestion({ node: producer, http: producer.http, offer })).direct_offer })
  const address = await owner.start()
  return { ...trackServer(owner.server, `source-peer-${doc.assignment.id}`), owner, address, offer }
}
async function setPeers(value) { await writeFile(peers, JSON.stringify(value), { mode: 0o600 }) }
async function verifyUnknown(doc) {
  const result = await ticket(doc)
  assert.equal(result.status, 'reconciling')
  assert.equal(result.reports.length, 1)
  assert.equal(result.reports[0].state, 'unknown')
  assert.equal(result.effects.length, 1)
  assert.equal(result.effects[0].status, 'unknown')
  assert.deepEqual(result.artifacts, [])
  await assert.rejects(stat(doc.target), { code: 'ENOENT' })
  const completion = (await saved()).completions[doc.assignment.id]
  assert.equal(completion.state, 'unknown')
  assert.equal(completion.report_enqueued, true)
  assert.equal(completion.evidence[0].kind, 'direct_handoff_unverified')
  assert.deepEqual(completion.artifacts, [])
  assert.equal((await saved()).assignments[doc.assignment.id].id, doc.assignment.id)
  return result
}
async function unknownCase(name, setup) {
  report.phase = name
  const doc = await createPipeline()
  await setup(doc)
  if (doc.cleanup) {
    await doc.cleanup()
    delete doc.cleanup
  }
  await native(undefined, { label: name })
  const original = await verifyUnknown(doc)
  const stateBefore = await saved()
  const completionBefore = stateBefore.completions[doc.assignment.id]
  await native(undefined, { label: `${name}-persistent-replay` })
  assert.deepEqual((await saved()).completions[doc.assignment.id], completionBefore, 'durable original completion/evidence IDs are unchanged')
  assert.deepEqual(await ticket(doc), original)
  report.cases.push({ name, ticket: doc.childTicket, assignment: doc.assignment.id, report: original.reports[0].id, effect: original.effects[0].id, status: original.status, artifacts: 0, target: 'absent' })
  check(name, { original_assignment: doc.assignment.id, original_report: original.reports[0].id, restart: 'same_unknown_no_new_effect' })
  return doc
}

try {
  report.phase = 'build'
  await bounded(exec('cargo', ['build', '--locked', '-p', 'loom-node', '--bin', 'loom-node'], { cwd: repo, timeout: 120000, maxBuffer: 1048576 }), 'build', 130000)
  report.commands.push({ command: 'cargo build --locked -p loom-node --bin loom-node', exit_code: 0 })
  root = await testingRoot()
  await mkdir(join(root, 'source', 'docs'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'destination', 'docs'), { recursive: true, mode: 0o700 })
  sourceRoot = await realpath(join(root, 'source'))
  destinationRoot = await realpath(join(root, 'destination'))
  await writeFile(join(sourceRoot, 'docs', 'input.txt'), '\uFEFF  direct native; keep  internal spacing. \uFEFF', { mode: 0o600 })
  controller = await startRustConcierge({ root })
  owned.controllers.add({ controller, stopped: false })
  admin = new LoomHttpClient({ baseUrl: controller.baseUrl, clientToken: controller.clientToken })
  project = (await admin.post('/api/v1/projects', { name: 'Native direct fixture', root: sourceRoot, mode: 'read_write' })).project
  producer = await LocalNodeRunner.create({ baseUrl: controller.baseUrl, stateDir: join(root, 'a-state'), artifactDir: join(root, 'a-artifacts'), projectRoots: { [project.id]: sourceRoot },
    enrollmentCode: (await admin.post('/api/v1/enrollment-codes', {})).code, registration: { workerId: 'worker-a', harnessKind: 'bounded-handoff-fixture', profileId: 'bare-source' } })
  const sourceBinding = (await admin.post('/api/v1/project-bindings', { project_id: project.id, node_id: producer.nodeId, worker_id: 'worker-a', root_scope: sourceRoot })).id
  readGrant = (await admin.post('/api/v1/grants', { project_id: project.id, node_id: producer.nodeId, worker_id: 'worker-a', project_binding_id: sourceBinding, operations: ['read'] })).grant
  state = join(root, 'b-state'); artifactDir = join(root, 'b-artifacts'); peers = join(root, 'b-peers.json')
  await mkdir(state, { mode: 0o700 }); await mkdir(artifactDir, { mode: 0o700 })
  const bound = await exec(binary, ['bind', '--state-dir', state, '--project-root', `${project.id}=${destinationRoot}`], { cwd: repo })
  assert.equal(bound.stderr, '')
  bindingFile = JSON.parse(bound.stdout).binding_file
  await setPeers({})
  await native((await admin.post('/api/v1/enrollment-codes', {})).code, { label: 'register-receiver' })
  bIdentity = JSON.parse(await readFile(join(state, 'identity.json'), 'utf8'))
  receiver = { node_id: bIdentity.node_id, installation_id: bIdentity.installation_id, public_key: bIdentity.public_key }
  const bClient = new LoomHttpClient({ baseUrl: controller.baseUrl, clientToken: '' })
  receiverPost = (path, body) => bClient.post(path, body, { token: bIdentity.token })
  const binding = (await admin.post('/api/v1/project-bindings', { project_id: project.id, node_id: receiver.node_id, worker_id: 'default', root_scope: destinationRoot })).id
  writeGrant = (await admin.post('/api/v1/grants', { project_id: project.id, node_id: receiver.node_id, worker_id: 'default', project_binding_id: binding, operations: ['write'] })).grant

  report.phase = 'positive'
  const good = await createPipeline(), goodPeer = await startPeer(good)
  const signed = []
  const proxy = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      signed.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const upstream = await directRequest(`${goodPeer.address}${req.url}`, signed.at(-1))
      res.writeHead(upstream.status, upstream.headers); res.end(upstream.bytes)
    } catch { res.writeHead(500); res.end(); process.exitCode = 1 }
  })
  const proxyListener = await listen(proxy, 'positive-capture-proxy')
  await setPeers({ [producer.nodeId]: proxyListener.url })
  await native(undefined, { label: 'positive' })
  await proxyListener.owner.close()
  assert.equal(signed.length, 1)
  assert.equal(goodPeer.owner.requests.length, 1)
  assert.equal(goodPeer.owner.requests[0].signature_valid, true)
  assert.equal((await ticket(good)).status, 'succeeded')
  const child = await ticket(good)
  assert.equal(child.artifacts.length, 1)
  assert.equal(child.reports.length, 1)
  const output = await readFile(good.target)
  assert.equal(output.toString('utf8'), good.bytes.toString('utf8').trim())
  const proof = JSON.parse((await admin.get(`/api/v1/tickets/${good.childTicket}/artifacts/${child.artifacts[0].id}`)).content)
  assert.equal(proof.target_hash, sha256(output))
  assert.equal(child.artifacts[0].lineage[0].artifact_id, good.parent.id)
  assert.equal(child.artifacts[0].lineage[0].source_ticket_id, good.parentTicket)
  const consumed = (await saved()).completions[good.assignment.id]
  await native(undefined, { label: 'positive-replay' })
  assert.deepEqual((await saved()).completions[good.assignment.id], consumed)
  assert.deepEqual(await ticket(good), child)
  assert.equal(goodPeer.owner.requests.length, 1)
  // Reuse the exact captured bytes against a *restarted* TS server, which reads A's nonce ledger.
  await goodPeer.close()
  const replayPeer = await startPeer(good, goodPeer.offer)
  const replay = await directRequest(`${replayPeer.address}/api/v1/direct/artifacts/${good.parent.id}`, signed[0])
  assert.equal(replay.status, 409)
  assert.equal(JSON.parse(replay.bytes).error.code, 'offer_nonce_consumed')
  await replayPeer.close()
  check('positive_signed_two_nodes_and_nonce_restart', { parent: good.parent.id, child: child.artifacts[0].id, target_sha256: proof.target_hash, replay_nonce_status: replay.status })

  // One real stopped transfer retains its immutable outbox Report before the controller sees it.
  report.phase = 'missing_peer_durable_outbox_replay'
  const missing = await createPipeline()
  await setPeers({})
  let reportCalls = 0
  const reportProxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    if (req.url === '/api/v1/nodes/reports') reportCalls++
    try {
      const forwarded = await fetch(`${controller.baseUrl}${req.url}`, { method: 'POST', headers: { authorization: req.headers.authorization, 'content-type': 'application/json', accept: 'application/json' }, body: Buffer.concat(chunks) })
      const body = Buffer.from(await forwarded.arrayBuffer())
      if (req.url === '/api/v1/nodes/reports' && reportCalls === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'fixture_pre_receipt_hold' } })) }
      else { res.writeHead(forwarded.status, { 'content-type': 'application/json' }); res.end(body) }
    } catch (error) { res.writeHead(503); res.end(JSON.stringify({ error: { code: 'owned_proxy_forwarding_failed', message: `${error.message} ${error.cause?.message || ''} ${controller.baseUrl} ${req.url} ${req.headers['content-length']}` } })); process.exitCode = 1 }
  })
  const held = await listen(reportProxy, 'one-unknown-report-preceipt-hold')
  const realController = controller
  const authorityBaseUrl = realController.baseUrl
  controller = { ...realController, baseUrl: held.url }
  reportProxy.removeAllListeners('request')
  reportProxy.on('request', async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    if (req.url === '/api/v1/nodes/reports') reportCalls++
    try {
      const forwarded = await fetch(`${authorityBaseUrl}${req.url}`, { method: 'POST', headers: { authorization: req.headers.authorization, 'content-type': 'application/json', accept: 'application/json' }, body: Buffer.concat(chunks) })
      const body = Buffer.from(await forwarded.arrayBuffer())
      if (req.url === '/api/v1/nodes/reports' && reportCalls === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'fixture_pre_receipt_hold' } })) }
      else { res.writeHead(forwarded.status, { 'content-type': 'application/json' }); res.end(body) }
    } catch (error) { res.writeHead(503); res.end(JSON.stringify({ error: { code: 'owned_proxy_forwarding_failed', message: error.message } })); process.exitCode = 1 }
  })
  await native(undefined, { outbox: 1, label: 'missing-peer-original-outbox', exitCode: 1, diagnostic: /single bounded cycle retained undelivered evidence/ })
  controller = realController
  const durableBefore = await saved()
  const itemBefore = durableBefore.outbox.find(entry => entry.body.assignment_id === missing.assignment.id)
  assert.ok(itemBefore)
  const originalIDs = { request: itemBefore.body.request_id, report: itemBefore.body.report_id, effect: itemBefore.body.effects[0].effect_id }
  assert.equal(itemBefore.body.state, 'unknown')
  assert.equal(itemBefore.attempts, 1)
  assert.equal(itemBefore.digest, createHash('sha256').update(canonical({ ...itemBefore.body, sent_at: null })).digest('hex'))
  const assignedBefore = durableBefore.assignments[missing.assignment.id]
  assert.equal(assignedBefore.id, missing.assignment.id)
  assert.equal(assignedBefore.ticket_id, missing.assignment.ticket_id)
  assert.equal(assignedBefore.lease_epoch, missing.assignment.lease_epoch)
  assert.equal(assignedBefore.grant_digest, missing.assignment.grant_digest)
  assert.deepEqual(assignedBefore.artifact_input, missing.assignment.artifact_input)
  assert.equal(assignedBefore.content, null)
  assert.equal(assignedBefore.grant.id, writeGrant.id)
  assert.deepEqual(itemBefore.body.artifacts, [])
  assert.equal(itemBefore.body.effects[0].status, 'unknown')
  assert.equal(itemBefore.digest, createHash('sha256').update(canonical({ ...itemBefore.body, sent_at: null })).digest('hex'))
  assert.equal(await stat(missing.target).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error }), true)
  const sameDigest = body => createHash('sha256').update(canonical({ ...body, sent_at: null })).digest('hex')
  assert.equal(itemBefore.digest, sameDigest(itemBefore.body))
  await held.owner.close()
  await native(undefined, { label: 'missing-peer-original-outbox-delivery' })
  const deliveredUnknown = await verifyUnknown(missing)
  const receiptDb = new DatabaseSync(join(realController.dataDir, 'loom.sqlite3'), { readOnly: true })
  try {
    const receipt = receiptDb.prepare('SELECT response FROM requests WHERE route=? AND request_id=?').get('reports', originalIDs.request)
    assert.ok(receipt)
    const parsed = JSON.parse(receipt.response)
    assert.equal(parsed.accepted, true)
    assert.equal(parsed.request_id, originalIDs.request)
    assert.equal(parsed.ticket_status, 'reconciling')
    assert.equal(deliveredUnknown.reports[0].id, parsed.report_id)
    assert.equal(deliveredUnknown.reports[0].request_id, originalIDs.request)
    assert.equal(deliveredUnknown.effects[0].id, originalIDs.effect)
  } finally { receiptDb.close() }
  const afterDelivery = await saved()
  assert.deepEqual(afterDelivery.assignments[missing.assignment.id], durableBefore.assignments[missing.assignment.id])
  assert.deepEqual(afterDelivery.completions[missing.assignment.id], durableBefore.completions[missing.assignment.id])
  const deliveredReport = deliveredUnknown.reports[0]
  assert.equal(deliveredReport.state, 'unknown')
  // Duplicate replay uses the same Report receipt and original persisted completion, never the source.
  const duplicateNative = await native(undefined, { label: 'missing-peer-post-delivery-restart' })
  assert.deepEqual((await saved()).completions[missing.assignment.id], durableBefore.completions[missing.assignment.id])
  assert.deepEqual(await ticket(missing), deliveredUnknown)
  assert.equal(duplicateNative.completions.find(c => c.assignment_id === missing.assignment.id).report_enqueued, true)
  check('missing_peer_exact_original_outbox_and_restart', { ...originalIDs, original_outbox_digest: itemBefore.digest, delivery_requests: reportCalls, second_effect: false })

  await unknownCase('stopped_peer', async doc => {
    const peer = await startPeer(doc)
    await setPeers({ [producer.nodeId]: peer.address })
    await peer.close()
    await assert.rejects(directRequest(`${peer.address}/api/v1/direct/artifacts/${doc.parent.id}`, {}), { code: 'ECONNREFUSED' })
  })
  const stopIntent = await createPipeline()
  const stopPeer = await startPeer(stopIntent)
  await setPeers({ [producer.nodeId]: stopPeer.address })
  await admin.post(`/api/v1/tickets/${stopIntent.childTicket}/cancel`, {})
  await stopPeer.close()
  await native(undefined, { label: 'explicit-cancel-before-direct-resolution' })
  const cancelled = await ticket(stopIntent)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.reports.length, 1)
  assert.equal(cancelled.reports[0].state, 'cancelled')
  assert.ok([true, 1].includes(cancelled.reports[0].cancel_acknowledged))
  assert.ok([true, 1].includes(cancelled.cancel_requested))
  assert.deepEqual(cancelled.artifacts, [])
  assert.equal(cancelled.effects.length, 1)
  assert.equal(cancelled.effects[0].status, 'unknown')
  assert.match(cancelled.effects[0].evidence, /cancel_before_execution/)
  await assert.rejects(stat(stopIntent.target), { code: 'ENOENT' })
  const cancelledCompletion = (await saved()).completions[stopIntent.assignment.id]
  await native(undefined, { label: 'explicit-cancel-no-duplicate-report' })
  assert.deepEqual(await ticket(stopIntent), cancelled)
  assert.deepEqual((await saved()).completions[stopIntent.assignment.id], cancelledCompletion)
  check('explicit_cancel_precedes_source_and_never_executes', { ticket: stopIntent.childTicket, status: 'cancelled', effects: 'unstarted-only', peer_requests: stopPeer.owner.requests.length })
  await unknownCase('bad_bytes', async doc => {
    const peer = await startPeer(doc)
    const corruption = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const upstream = await directRequest(`${peer.address}${req.url}`, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const corrupted = Buffer.from(upstream.bytes); corrupted[corrupted.length - 1] ^= 1
      res.writeHead(upstream.status, { ...upstream.headers, 'content-length': corrupted.length }); res.end(corrupted)
    })
    const corrupt = await listen(corruption, 'bad-byte-proxy')
    await setPeers({ [producer.nodeId]: corrupt.url })
    doc.cleanup = async () => { await corrupt.owner.close(); await peer.close() }
  })
  await unknownCase('revoked_source', async doc => {
    const peer = await startPeer(doc)
    await setPeers({ [producer.nodeId]: peer.address })
    await admin.post(`/api/v1/grants/${readGrant.id}/revoke`, {})
    await peer.close()
  })
  await setPeers({})
  const grantsBeforeDestination = (await admin.get('/api/v1/grants')).grants.map(grant => ({ id: grant.id, version: grant.version, revoked_at: grant.revoked_at }))
  const revokedDestination = await admin.post(`/api/v1/grants/${writeGrant.id}/revoke`, {})
  assert.equal(revokedDestination.grant_version, 2)
  await assert.rejects(createPipeline(), error => error.status === 400 && error.code === 'invalid_request' && /grant is revoked/i.test(error.message))
  const cancellationAfterRevocation = await admin.get(`/api/v1/tickets/${stopIntent.childTicket}`)
  assert.equal(cancellationAfterRevocation.status, 'cancelled')
  assert.deepEqual(cancellationAfterRevocation.reports, cancelled.reports)
  assert.deepEqual(cancellationAfterRevocation.effects, cancelled.effects)
  assert.deepEqual(cancellationAfterRevocation.artifacts, cancelled.artifacts)
  assert.deepEqual(cancellationAfterRevocation.assignments.map(assignment => assignment.id), cancelled.assignments.map(assignment => assignment.id))
  const grantsAfterDestination = (await admin.get('/api/v1/grants')).grants
  for (const original of grantsBeforeDestination) {
    const current = grantsAfterDestination.find(grant => grant.id === original.id)
    assert.ok(current)
    if (original.id === readGrant.id || original.id === writeGrant.id) {
      assert.equal(current.version, 2)
      assert.ok(current.revoked_at)
    } else assert.equal(current.revoked_at, null)
  }
  check('destination_revocation_blocks_descendant_creation_without_execution', { status: 400, grant_version: 2, new_ticket: false })
  const persistedIntent = await admin.get(`/api/v1/tickets/${stopIntent.childTicket}`)
  assert.ok([true, 1].includes(persistedIntent.cancel_requested))
  const independentFailures = await Promise.all(report.cases.map(entry => admin.get(`/api/v1/tickets/${entry.ticket}`)))
  assert.ok(report.cases.every(entry => ['stopped_peer', 'bad_bytes', 'revoked_source'].includes(entry.name)))
  for (let index = 0; index < report.cases.length; index++) {
    const expected = report.cases[index]
    const actual = independentFailures[index]
    assert.equal(actual.status, 'reconciling')
    assert.equal(actual.assignments[0].id, expected.assignment)
    if (expected.report) assert.equal(actual.reports[0].id, expected.report)
    if (expected.effect) assert.equal(actual.effects[0].id, expected.effect)
    assert.equal(actual.effects[0].status, 'unknown')
    assert.deepEqual(actual.artifacts, [])
  }
  check('all_failure_classes_persisted_without_blind_execution', { case_count: report.cases.length })

  report.phase = 'controller_restart_and_final_replay'
  const oldController = controller
  await oldController.stop()
  owned.controllers.forEach(entry => { if (entry.controller === oldController) entry.stopped = true })
  controller = await startRustConcierge({ root, dataDir: oldController.dataDir, baseUrl: oldController.baseUrl })
  owned.controllers.add({ controller, stopped: false })
  admin = new LoomHttpClient({ baseUrl: controller.baseUrl, clientToken: controller.clientToken })
  const reopenedMissing = await ticket(missing)
  assert.equal(reopenedMissing.status, 'reconciling')
  const withoutLeaseExpiry = value => {
    const normalized = structuredClone(value)
    for (const assignment of normalized.assignments || []) delete assignment.lease_expires_at
    return normalized
  }
  assert.deepEqual(withoutLeaseExpiry(await ticket(good)), withoutLeaseExpiry(child))
  await setPeers({})
  await native(undefined, { label: 'center-restart-evidence-only' })
  assert.deepEqual(await ticket(missing), reopenedMissing)
  assert.deepEqual((await saved()).completions[missing.assignment.id], durableBefore.completions[missing.assignment.id])
  assert.deepEqual((await saved()).completions[good.assignment.id], consumed)
  check('center_restart_preserves_origin_assignment_unknown_and_success', { retained: true })
  assert.equal(process.exitCode, undefined, 'proxy handling may not silently mark a pass failed')
  report.overall = 'PASS'
  report.phase = 'cleanup'
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 6000)
  process.exitCode = 1
} finally {
  for (const server of [...owned.servers]) {
    try { await stopServer(server); report.cleanup.push(`${server.name}:stopped`) }
    catch (error) { report.cleanup.push(`${server.name}:FAILED ${error.message}`); process.exitCode = 1 }
  }
  for (const entry of owned.controllers) {
    if (entry.stopped) continue
    try { await bounded(entry.controller.stop(), 'Concierge stop', 8000); entry.stopped = true; report.cleanup.push('Concierge:stopped') }
    catch (error) { report.cleanup.push(`Concierge:FAILED ${error.message}`); process.exitCode = 1 }
  }
  if (process.exitCode) report.overall = 'FAIL'
  try {
    if (root) {
      await writeFile(resultFile(), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      assert.deepEqual(JSON.parse(await readFile(resultFile(), 'utf8')), report)
      report.evidence_path = resultFile()
      report.evidence_readback_verified = true
      await writeFile(resultFile(), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      assert.deepEqual(JSON.parse(await readFile(resultFile(), 'utf8')), report)
    }
  } catch (error) { process.exitCode = 1; console.error(String(error?.stack || error)) }
  console.log(JSON.stringify(report, null, 2))
}
