#!/usr/bin/env node
// Owned-local Rust Concierge recovery regression. No DSH host/profile, credentials,
// model, discovery, remote/TLS transport, or compose fixture is involved.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { NodeState } from '../../packages/node-client/src/state.js'
import { canonical } from '../../packages/node-client/src/util.js'
import { prepareProject, startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const root = await testingRoot()
const clientToken = ''.padStart(48, 'R') // Synthetic only; never read from a profile or credential store.
let center
let runner
const fileName = 'receipt-replay.txt'
const fileText = 'One actual controlled file effect before either lost HTTP response.\n'
const fileSha256 = createHash('sha256').update(fileText).digest('hex')
const durable = value => JSON.parse(JSON.stringify(value))
const sha256 = value => createHash('sha256').update(value).digest('hex')
let executorCalls = 0

// This is driver scaffolding only. The real request and real Rust response both finish
// before the response is hidden from the client. It does not emulate a controller result.
function loseResponses() {
  const pending = new Map()
  const drops = []
  const paths = { artifact: '/api/v1/nodes/artifacts', report: '/api/v1/nodes/reports' }
  const fetcher = async (input, init = {}) => {
    const response = await globalThis.fetch(input, init)
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
    const kind = Object.keys(paths).find(name => paths[name] === pathname)
    if (!kind || !pending.has(kind)) return response
    assert.equal(init.method, 'POST')
    const requestText = String(init.body)
    const body = JSON.parse(requestText)
    assert.equal(body.request_id, pending.get(kind), `${kind}: fault must target the real durable request`)
    const responseBytes = Buffer.from(await response.clone().arrayBuffer())
    const responseText = responseBytes.toString('utf8')
    const responseBody = JSON.parse(responseText)
    assert.equal(response.ok, true, `${kind}: do not turn a real rejection into lost-response recovery`)
    assert.equal(responseBody.duplicate, undefined, `${kind}: first HTTP request must be the genuine first controller commit`)
    const record = { kind, path: pathname, requestText, requestBody: body,
      httpStatus: response.status, responseText, responseBody, responseSha256: sha256(responseBytes) }
    drops.push(record)
    pending.delete(kind)
    throw Object.assign(new Error(`Owned test scaffolding lost the already-committed ${kind} HTTP response`), {
      code: 'LOOM_TEST_LOST_RESPONSE_AFTER_COMMIT', responseStatus: response.status,
    })
  }
  return { fetcher, drops,
    loseOnce: (kind, requestId) => {
      assert.ok(paths[kind]); assert.equal(typeof requestId, 'string'); assert.ok(!pending.has(kind))
      assert.equal(drops.some(item => item.kind === kind), false, `${kind}: exactly one deliberately dropped response`)
      pending.set(kind, requestId)
    },
    disable: () => pending.clear(),
    pendingCount: () => pending.size,
  }
}
function sqlite(sql, ...parameters) {
  const db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'), { readOnly: true })
  try { return db.prepare(sql).all(...parameters).map(row => ({ ...row })) } finally { db.close() }
}
function one(rows, description) { assert.equal(rows.length, 1, description); return rows[0] }
async function fileSnapshot(file) {
  const bytes = await readFile(file)
  const info = await stat(file)
  return { bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
    size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, ino: info.ino }
}
async function countExecutor(run) {
  const execute = run.executor.execute.bind(run.executor)
  run.executor.execute = async (...args) => { executorCalls++; return execute(...args) }
}
function selectOutbox(state, kind) {
  return one(state.outbox.filter(item => item.kind === kind), `${kind}: one durable deferred message`)
}
function assertMatchingIdentity(body, run, ticket, assignment) {
  assert.equal(body.protocol, 'loom.node.v1')
  assert.equal(body.node_id, run.nodeId)
  assert.equal(body.installation_id, run.installationId)
  assert.equal(body.ticket_id, ticket.id)
  assert.equal(body.assignment_id, assignment.id)
  assert.equal(body.lease_epoch, assignment.lease_epoch)
}
function realReceipts(drops, kind) {
  return one(drops.filter(item => item.kind === kind), `${kind}: one real response dropped after success`)
}

try {
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: clientToken } })
  const admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken, timeoutMs: 10_000 })
  assert.equal((await admin.get('/api/v1/health')).status, 'ok')
  const projectRoot = await prepareProject(root)
  const project = await admin.post('/api/v1/projects', {
    name: 'Owned-local real receipt replay', root: projectRoot, mode: 'read_write',
  })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const stateDir = join(root, 'owned-node-state')
  const artifactDir = join(root, 'owned-node-artifacts')
  const projectRoots = { [projectId]: projectRoot }
  const fault = loseResponses()
  runner = new LocalNodeRunner({ stateDir, artifactDir, baseUrl: center.baseUrl,
    projectRoots, fetch: fault.fetcher, registration: { workerId: 'default', harnessKind: 'deterministic-local-http', profileId: 'not-a-dsh-profile' } })
  await runner.start({ enrollmentCode: enrollment.code })
  await countExecutor(runner)
  const binding = await admin.post('/api/v1/project-bindings', {
    project_id: projectId, node_id: runner.nodeId, installation_id: runner.installationId,
    worker_id: 'default', root_scope: projectRoot,
  })
  const granted = await admin.post('/api/v1/grants', {
    project_id: projectId, node_id: runner.nodeId, installation_id: runner.installationId,
    worker_id: 'default', operations: ['read', 'write'],
  })
  assert.ok(binding.id && granted.grant.id)
  const ticket = await admin.post('/api/v1/tickets', {
    project_id: projectId, node_id: runner.nodeId, installation_id: runner.installationId,
    worker_id: 'default', grant_id: granted.grant.id, kind: 'edit_file', relative_path: fileName,
    content: fileText, objective: 'At-least-once recovery after real committed HTTP responses are lost locally',
  })
  const assignment = one(ticket.assignments, 'one actual registered assignment')
  const execution = await runner.pollAndRun()
  assert.equal(execution.status, 'succeeded', JSON.stringify(execution))
  assert.equal(execution.duplicate, undefined)
  assert.equal(executorCalls, 1)
  const artifact = selectOutbox(runner.state, 'artifact')
  const report = selectOutbox(runner.state, 'report')
  assertMatchingIdentity(artifact.body, runner, ticket, assignment)
  assertMatchingIdentity(report.body, runner, ticket, assignment)
  assert.equal(artifact.body.artifact_id, artifact.body.metadata.artifact_id)
  assert.equal(artifact.body.bytes_base64, Buffer.from(artifact.body.bytes_base64, 'base64').toString('base64'))
  assert.equal(Buffer.from(artifact.body.bytes_base64, 'base64').byteLength, artifact.body.metadata.size_bytes)
  assert.equal(sha256(Buffer.from(artifact.body.bytes_base64, 'base64')), artifact.body.metadata.sha256)
  assert.deepEqual(report.body.artifact_ids, [artifact.body.artifact_id])
  assert.deepEqual(report.body.artifacts, [{ ...artifact.body.metadata, artifact_id: artifact.body.artifact_id }])
  assert.equal(report.body.effects.length, 1)
  assert.deepEqual(report.body.effects[0].artifacts, [artifact.body.artifact_id])
  assert.deepEqual(report.body.evidence, [report.body.effects[0].evidence])
  assert.equal(report.body.effects[0].evidence.target_sha256, fileSha256)
  assert.equal(report.body.requested_state, 'succeeded')
  const originalArtifactBodyText = JSON.stringify(artifact.body)
  const originalReportBodyText = JSON.stringify(report.body)
  const originalReportCanonicalBody = canonical(report.body)
  const originalCompletion = durable(runner.state.data.completions[assignment.id])
  assert.equal(typeof originalCompletion.digest, 'string')
  assert.ok(originalCompletion.digest.length > 0)
  assert.equal(originalCompletion.assignment_id, assignment.id)
  assert.equal(artifact.digest, artifact.body.request_id)
  assert.equal(report.digest, report.body.request_id)

  fault.loseOnce('artifact', artifact.body.request_id)
  fault.loseOnce('report', report.body.request_id)
  const lostDeliveries = await runner.client.dispatchOutbox()
  assert.equal(lostDeliveries.length, 2)
  const lostArtifact = lostDeliveries.find(item => item.kind === 'artifact')
  const lostReport = lostDeliveries.find(item => item.kind === 'report')
  assert.equal(lostArtifact.status, 'deferred')
  assert.equal(lostArtifact.requestId, artifact.body.request_id)
  assert.equal(lostArtifact.error, 'Owned test scaffolding lost the already-committed artifact HTTP response')
  assert.equal(lostReport.status, 'deferred')
  assert.equal(lostReport.requestId, report.body.request_id)
  assert.equal(lostReport.error, 'Owned test scaffolding lost the already-committed report HTTP response')

  // Independent controller evidence, before any replay: both original HTTP requests really
  // committed even though this client could not observe either successful response.
  const artifactAfterLoss = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifact.body.artifact_id}`)
  assert.equal(artifactAfterLoss.artifact.id, artifact.body.artifact_id)
  assert.equal(artifactAfterLoss.artifact.sha256, artifact.body.metadata.sha256)
  assert.equal(artifactAfterLoss.content, Buffer.from(artifact.body.bytes_base64, 'base64').toString('utf8'))
  assert.equal(one(sqlite('SELECT * FROM artifacts WHERE id=?', artifact.body.artifact_id), 'first artifact committed').sha256,
    artifact.body.metadata.sha256)
  assert.equal(realReceipts(fault.drops, 'artifact').responseBody.artifact_id,
    artifact.body.artifact_id)
  const committedBeforeReplay = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.equal(committedBeforeReplay.status, 'succeeded')
  assert.equal(committedBeforeReplay.reports.length, 1)
  assert.equal(committedBeforeReplay.reports[0].request_id, report.body.request_id)
  assert.equal(committedBeforeReplay.artifacts.length, 1)
  assert.equal(committedBeforeReplay.effects.length, 1)
  const lostReportResponse = realReceipts(fault.drops, 'report').responseBody
  const firstReceipt = one(sqlite(`SELECT * FROM requests
    WHERE node_id=? AND route='reports' AND request_id=?`, runner.nodeId, report.body.request_id), 'first report receipt committed')
  assert.equal(firstReceipt.payload_digest, sha256(originalReportCanonicalBody))
  assert.equal(firstReceipt.response, realReceipts(fault.drops, 'report').responseText)
  assert.deepEqual(JSON.parse(firstReceipt.response), lostReportResponse)
  assert.equal(lostReportResponse.request_id, report.body.request_id)
  assert.equal(lostReportResponse.facts_already_existed, false)
  assert.equal(lostReportResponse.duplicate, undefined)
  assert.equal(lostReportResponse.report_id, committedBeforeReplay.reports[0].id)
  assert.equal(fault.pendingCount(), 0)
  assert.equal(fault.drops.length, 2)
  assert.equal(runner.state.outbox.filter(item => ['artifact', 'report'].includes(item.kind)).length, 2)
  assert.equal(runner.state.data.deliveries?.length || 0, 0, 'the client genuinely did not observe either success response')
  fault.disable()

  // Reopen the genuine disk state and identity rather than constructing a new result.
  // Startup performs a real authenticated heartbeat using the restored node token.
  const reopened = await LocalNodeRunner.create({ stateDir, artifactDir, baseUrl: center.baseUrl, projectRoots })
  runner = reopened
  await countExecutor(reopened)
  assert.equal(reopened.nodeId, fault.drops[0].requestBody.node_id)
  const independentlyOpenedIdentity = await NodeIdentity.open(stateDir)
  const independentlyOpenedState = await NodeState.open(stateDir)
  assert.equal(independentlyOpenedIdentity.nodeId, reopened.nodeId)
  assert.equal(independentlyOpenedIdentity.installationId, reopened.installationId)
  const artifactBefore = selectOutbox(independentlyOpenedState, 'artifact')
  const reportBefore = selectOutbox(independentlyOpenedState, 'report')
  assert.equal(JSON.stringify(artifactBefore.body), originalArtifactBodyText)
  assert.equal(JSON.stringify(reportBefore.body), originalReportBodyText)
  assert.equal(artifactBefore.digest, artifact.digest)
  assert.equal(reportBefore.digest, report.digest)
  assert.equal(artifactBefore.attempts, 1)
  assert.equal(reportBefore.attempts, 1)
  assert.match(artifactBefore.last_error, /lost.*artifact HTTP response/)
  assert.match(reportBefore.last_error, /lost.*report HTTP response/)
  const retryAt = Math.max(Date.parse(artifactBefore.next_attempt_at), Date.parse(reportBefore.next_attempt_at))
  const retryDelay = retryAt - Date.now()
  assert.ok(Number.isFinite(retryDelay) && retryDelay >= 0 && retryDelay <= 10_000,
    'public retry deadlines must be the persisted first-attempt backoff')
  assert.deepEqual(durable(independentlyOpenedState.data.completions[assignment.id]), originalCompletion)
  const initialEffectPaths = (await readdir(artifactDir)).filter(name => name.endsWith('.effect.json')).sort()
  assert.equal(initialEffectPaths.length, 1)
  const initialLocalArtifacts = (await readdir(artifactDir)).filter(name => name.endsWith('.bin')).sort()
  assert.deepEqual(initialLocalArtifacts, [`${artifact.body.artifact_id}.bin`])
  const target = join(projectRoot, fileName)
  const beforeReplayFile = await fileSnapshot(target)
  assert.equal(beforeReplayFile.sha256, fileSha256)
  const beforeLocalArtifact = await fileSnapshot(join(artifactDir, `${artifact.body.artifact_id}.bin`))
  assert.equal(beforeLocalArtifact.sha256, artifact.body.metadata.sha256)

  if (retryDelay > 0) await new Promise(resolve => setTimeout(resolve, retryDelay + 25))
  const deliveries = await reopened.client.dispatchOutbox()
  assert.equal(deliveries.length, 2)
  assert.deepEqual(deliveries.map(item => item.kind).sort(), ['artifact', 'report'])
  assert.equal(deliveries.every(item => item.status === 'delivered' || item.status === 'replay_delivered'), true)
  const artifactDelivery = deliveries.find(item => item.kind === 'artifact')
  const reportDelivery = deliveries.find(item => item.kind === 'report')
  assert.equal(artifactDelivery.response.duplicate, true)
  assert.equal(artifactDelivery.response.request_id, undefined)
  assert.deepEqual(artifactDelivery.response, {
    artifact_id: artifactAfterLoss.artifact.id, ticket_id: ticket.id, assignment_id: assignment.id,
    duplicate: true, origin_node_id: reopened.nodeId, name: artifact.body.metadata.name,
    media_type: artifact.body.metadata.media_type, size_bytes: artifact.body.metadata.size_bytes,
    sha256: artifact.body.metadata.sha256, location: `loom://artifact/${artifact.body.artifact_id}`,
  })
  assert.deepEqual(reportDelivery.response, {
    duplicate: true, request_id: report.body.request_id, receipt: lostReportResponse,
  })
  assert.equal(executorCalls, 1)
  assert.deepEqual(await fileSnapshot(target), beforeReplayFile)
  assert.deepEqual(await fileSnapshot(join(artifactDir, `${artifact.body.artifact_id}.bin`)), beforeLocalArtifact)
  assert.deepEqual((await readdir(artifactDir)).sort(), [...initialEffectPaths, ...initialLocalArtifacts].sort())
  assert.equal(reopened.state.outbox.length, 0)
  assert.equal(reopened.state.data.deliveries.filter(item => item.kind === 'artifact').length, 1)
  assert.equal(reopened.state.data.deliveries.filter(item => item.kind === 'report').length, 1)
  for (const delivery of reopened.state.data.deliveries) {
    assert.equal(delivery.digest, delivery.body.request_id)
    assert.equal(JSON.stringify(delivery.body), delivery.kind === 'artifact' ? originalArtifactBodyText : originalReportBodyText)
  }
  assert.deepEqual(durable(reopened.state.data.completions), durable(independentlyOpenedState.data.completions))

  // The controller data and immutable bytes remain singular after late replay.
  const settled = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.deepEqual(durable(settled), durable(committedBeforeReplay))
  const downloadedAgain = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifact.body.artifact_id}`)
  assert.deepEqual(durable(downloadedAgain), durable(artifactAfterLoss))
  assert.equal(sha256(Buffer.from(downloadedAgain.content)), downloadedAgain.artifact.sha256)
  assert.equal(downloadedAgain.size_bytes, Buffer.byteLength(downloadedAgain.content))
  const soleArtifact = one(sqlite('SELECT * FROM artifacts WHERE ticket_id=?', ticket.id), 'replay did not create a second artifact row')
  assert.equal(soleArtifact.assignment_id, assignment.id)
  assert.equal(soleArtifact.origin_node_id, reopened.nodeId)
  assert.equal(soleArtifact.name, artifact.body.metadata.name)
  assert.equal(soleArtifact.media_type, artifact.body.metadata.media_type)
  assert.equal(soleArtifact.size_bytes, artifact.body.metadata.size_bytes)
  assert.equal(soleArtifact.sha256, artifact.body.metadata.sha256)
  const storedArtifactBytes = await readFile(join(center.dataDir, 'artifacts', soleArtifact.storage_name))
  assert.equal(storedArtifactBytes.toString('base64'), artifact.body.bytes_base64)
  assert.equal(sha256(storedArtifactBytes), soleArtifact.sha256)
  const soleReport = one(sqlite('SELECT * FROM reports WHERE ticket_id=?', ticket.id), 'replay did not create a second report')
  assert.equal(soleReport.id, lostReportResponse.report_id)
  assert.equal(soleReport.request_id, report.body.request_id)
  assert.equal(soleReport.assignment_id, assignment.id)
  assert.equal(soleReport.node_id, reopened.nodeId)
  assert.equal(soleReport.lease_epoch, assignment.lease_epoch)
  assert.deepEqual(JSON.parse(soleReport.evidence), report.body.evidence)
  const soleEffect = one(sqlite('SELECT * FROM effects WHERE ticket_id=?', ticket.id), 'replay did not create a second effect')
  const originalEffect = report.body.effects[0]
  assert.equal(soleEffect.id, originalEffect.effect_id)
  assert.equal(soleEffect.assignment_id, assignment.id)
  assert.equal(soleEffect.node_id, reopened.nodeId)
  assert.equal(soleEffect.attempt, assignment.lease_epoch)
  assert.equal(soleEffect.input_digest, originalEffect.input_digest)
  assert.deepEqual(JSON.parse(soleEffect.evidence), originalEffect.evidence)
  assert.deepEqual(JSON.parse(soleEffect.artifacts), [artifact.body.artifact_id])
  assert.equal(one(sqlite(`SELECT * FROM requests WHERE node_id=? AND route='reports' AND request_id=?`,
    reopened.nodeId, report.body.request_id), 'still exactly one controller request receipt').response, firstReceipt.response)
  assert.equal(one(sqlite(`SELECT COUNT(*) AS count FROM audits WHERE ticket_id=? AND action='report.accepted'`, ticket.id),
    'one committed report audit').count, 1)
  assert.equal(one(sqlite(`SELECT COUNT(*) AS count FROM audits WHERE ticket_id=? AND action='artifact.indexed'`, ticket.id),
    'one committed artifact audit').count, 1)
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  assert.deepEqual(await reopened.pollAndRun(), { status: 'idle' })
  assert.equal(executorCalls, 1)
  assert.deepEqual(await fileSnapshot(target), beforeReplayFile)
  assert.deepEqual((await readdir(artifactDir)).sort(), [...initialEffectPaths, ...initialLocalArtifacts].sort())

  console.log(JSON.stringify({
    overall: 'PASS', schema: 'loom.real-receipt-replay.v1', real_rust_concierge: true,
    one_registered_node: true, reopened_real_node_identity_and_state: true,
    controlled_file_executor_invocations: executorCalls,
    lost_after_real_successful_controller_processing: fault.drops.map(item => ({
      kind: item.kind, http_status: item.httpStatus, request_id: item.requestBody.request_id,
      request_body_sha256: sha256(item.requestText), response_sha256: item.responseSha256,
    })),
    first_report_receipt: { request_id: report.body.request_id, payload_digest: firstReceipt.payload_digest,
      report_id: lostReportResponse.report_id, response_persisted_byte_exact: true },
    replay: { artifact_duplicate: true, report_duplicate: true, exact_body_id_and_digest: true,
      controller_reports: 1, controller_report_receipts: 1, controller_artifacts: 1,
      controller_effects: 1, no_second_file_effect: true, artifact_bytes_and_sha256: soleArtifact.sha256 },
    intentionally_not_claimed: ['exactly-once delivery', 'DSH SDK or DSH profile execution', 'TLS/physical remote', 'network discovery', 'compose'],
    test_root: root,
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: String(error.stack || error)
    .replaceAll(clientToken, '[redacted-test-token]'), test_root: root,
    concierge_diagnostics: center?.diagnostics?.() || null }, null, 2))
  process.exitCode = 1
} finally {
  if (center) await center.stop().catch(() => {})
}
