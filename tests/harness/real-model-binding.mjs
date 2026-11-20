#!/usr/bin/env node
// Genuine isolated DSH worker + real local read proof + public SDK stream.
// No current Profile, paid provider, Credential Store, discovery or deployed model.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installation } from './environment.mjs'
import { startIsolatedHost, prepareScenario } from './binding-scenario.mjs'
import { LoomNodeClient } from '../../packages/node-client/src/client.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { DatabaseSync } from 'node:sqlite'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const secret = []
let host, server, root
try {
  const scenario = await prepareScenario({ envPrefix: 'MODEL_BINDING' })
  root = scenario.root
  server = scenario.server
  const admin = scenario.admin
  const projectRoot = scenario.projectRoot
  const projectId = scenario.projectId
  secret.push(server.clientToken)
  const source = JSON.stringify({ schema: 'loom.model-descriptor.v1', provider: 'fixture-local-text', revision: 'v1', input_modalities: ['text'], local_only: true }) + '\n'
  await writeFile(join(projectRoot, 'model.json'), source, { mode: 0o600 })
  const initial = await scenario.env
  host = await startIsolatedHost(root, initial, secret)
  const deadline = Date.now() + 45_000
  let node
  while (!node && Date.now() < deadline) {
    const inventory = await admin.get('/api/v1/nodes')
    node = inventory.nodes.find(entry => entry.status === 'online' && entry.inventory?.project_roots?.[projectId])
    if (!node) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(node, 'A real DSH node with this temporary project and live adapter observation must enroll')
  const inventory = await admin.get(`/api/v1/model-inventory?node_id=${node.id}&installation_id=${encodeURIComponent(node.installation_id)}&worker_id=default`)
  assert.equal(inventory.models.some(model => model.provider === 'loom-stub' && model.model === 'loom-stub-v1' && model.prepared_call_observed && model.freshness === 'fresh'), true)
  await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: projectRoot })
  const grant = async (operations) => (await admin.post('/api/v1/grants', { project_id: projectId, node_id: node.id, worker_id: 'default', operations })).grant
  const read = await grant(['read'])
  const readTicket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: node.id, worker_id: 'default', grant_id: read.id,
    kind: 'model_descriptor', relative_path: 'model.json', objective: 'Read only the explicit local metadata; never call a model.' })
  const readResult = await waitTerminal(admin, readTicket.id, 'Proof file read by real DSH-controlled file executor')
  assert.equal(readResult.status, 'succeeded', JSON.stringify(readResult.reports))
  assert.equal(readResult.assignments.length, 1)
  assert.equal(readResult.artifacts.length, 1)
  const sourceArtifact = readResult.artifacts[0]
  const sourceAssignment = readResult.assignments[0]
  const sourceBytes = await admin.get(`/api/v1/tickets/${readTicket.id}/artifacts/${sourceArtifact.id}`)
  const proof = JSON.parse(sourceBytes.content)
  const sourceSha = sha(source)
  const sourceAssignmentDigest = sha(JSON.stringify({ assignment_id: sourceAssignment.id, kind: 'model_descriptor', path: 'model.json', content: null }))
  assert.equal(proof.source_document, source)
  assert.equal(proof.source_sha256, sourceSha)
  assert.equal(sourceArtifact.sha256, sha(sourceBytes.content))
  assert.notEqual(sourceArtifact.sha256, sourceSha)
  assert.equal(await readFile(join(projectRoot, 'model.json'), 'utf8'), source)
  console.log('SOURCE_ASSIGNMENT_EVIDENCE', JSON.stringify({ source_assignment_id: sourceAssignment.id,
    source_effects: readResult.effects?.map(effect => ({ assignment_id: effect.assignment_id, status: effect.status, input_digest: effect.input_digest })),
    source_reports: readResult.reports?.map(report => ({ state: report.state, summary: report.summary })) }))
  const registerInput = { schema: 'loom.model-registry.v1', source_ticket_id: readTicket.id, source_artifact_id: sourceArtifact.id, worker_id: 'default', reviewed_sha256: sourceArtifact.sha256 }
  const beforeRegistryCalls = await calls(root)
  assert.equal(requestCount(beforeRegistryCalls), 0, 'A file descriptor read is not text generation')
  const { model } = await admin.post('/api/v1/models', registerInput)
  assert.equal(model.status, 'registered')
  assert.equal(model.installed || model.executable || model.activation || model.generation_observed, false)
  assert.equal(model.descriptor_sha256, sourceArtifact.sha256)
  assert.equal(model.source_assignment_id, sourceAssignment.id)
  assert.equal(model.source_assignment_digest, sourceAssignmentDigest)
  const place = await grant(['place_model'])
  const authority = { grant_id: place.id, worker_id: 'default', node_id: node.id, installation_id: node.installation_id, reviewed_sha256: sourceArtifact.sha256 }
  const authorized = await admin.post(`/api/v1/models/${model.id}/placement-approvals`, authority)
  assert.equal(authorized.authorization.current, true)
  const placed = await admin.post(`/api/v1/models/${model.id}/place`, { grant_id: place.id, worker_id: 'default', reviewed_sha256: sourceArtifact.sha256 })
  const placement = placed.placement
  assert.equal(placement.status, 'approved_for_placement')
  assert.equal(placement.activated || placement.executable, false)
  const invoke = await grant(['invoke_text'])
  const request = (grantId = invoke.id, changes = {}) => admin.post('/api/v1/tickets', {
    project_id: projectId, node_id: node.id, worker_id: 'default', grant_id: grantId,
    kind: 'model_text', provider: 'loom-stub', model: 'loom-stub-v1', model_id: model.id, placement_id: placement.id,
    objective: 'Invoke this particular provenance-bound-approved model_adapter text fixture.', ...changes,
  })
  for (const [grantId, label] of [[read.id, 'read'], [place.id, 'place_model']]) {
    await expectDenied(request(grantId), `A ${label} Grant cannot perform invoke_text`)
  }
  await expectDenied(request(invoke.id, { placement_id: 'mpl-not-the-authorized-placement' }), 'An unapproved placement cannot select an invoke')
  await expectDenied(request(invoke.id, { node_id: 'not-this-node' }), 'The source worker and current Node cannot be exchanged')
  const revokedInvoke = await grant(['invoke_text'])
  await admin.post(`/api/v1/grants/${revokedInvoke.id}/revoke`, {})
  await expectDenied(request(revokedInvoke.id), 'Revoked invoke_text Grant cannot call an adapter')
  const textTicket = await request()
  assert.equal(textTicket.kind, 'model_text')
  const textContent = JSON.parse(textTicket.content)
  assert.equal(textContent.model_binding.model_id, model.id)
  assert.equal(textContent.model_binding.placement_id, placement.id)
  assert.equal(textContent.model_binding.source_ticket_id, readTicket.id)
  assert.equal(textContent.model_binding.source_artifact_id, sourceArtifact.id)
  assert.equal(textContent.model_binding.source_assignment_digest, sourceAssignmentDigest)
  assert.equal(textContent.model_binding.placement_grant_id, place.id)
  assert.notEqual(textContent.model_binding.source_ticket_id, textTicket.id)
  const text = await waitTerminal(admin, textTicket.id, 'SDK model call with current separate invoke')
  assert.equal(text.status, 'succeeded', JSON.stringify(text.reports))
  assert.equal(text.assignments.length, 1)
  assert.equal(text.artifacts.length, 1)
  assert.notEqual(text.assignments[0].id, sourceAssignment.id)
  const resultArtifact = text.artifacts[0]
  const result = await admin.get(`/api/v1/tickets/${textTicket.id}/artifacts/${resultArtifact.id}`)
  const resultBody = JSON.parse(result.content)
  assert.equal(resultBody.schema, 'loom.model-text-result.v1')
  assert.equal(resultBody.source, 'dsh_llm_stream')
  assert.match(resultBody.text, /Loom real DSH isolated Stub turn/)
  assert.equal(text.model_observation?.execution_observed, true)
  assert.equal(text.model_observation?.output_observed, true)
  assert.equal(text.model_observation?.grant_id, invoke.id)
  const finalCalls = await calls(root)
  assert.ok(requestCount(finalCalls) > requestCount(beforeRegistryCalls), 'An actual SDK stream produced a new observation')
  const sessionMap = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
  const boundSession = sessionMap.assignments.find(entry => entry.assignment_id === text.assignments[0].id)
  assert.ok(boundSession?.session_id, 'True DSH Agent session linked to the new Assignment, not source Task')
  assert.equal(sessionMap.assignments.some(entry => entry.assignment_id === sourceAssignment.id), false, 'Descriptor file reading never creates an LLM Agent session')
  const callsAfterExecution = requestCount(finalCalls)
  const ticketsBeforeOffline = (await admin.get('/api/v1/tickets')).tickets
  const grantsBeforeOffline = (await admin.get('/api/v1/grants')).grants
  const nodeBeforeOffline = (await admin.get('/api/v1/nodes')).nodes.find(entry => entry.id === node.id && entry.installation_id === node.installation_id)
  assert.ok(nodeBeforeOffline, 'The successful invocation still belongs to the same Node and Installation')
  const identity = await NodeIdentity.open(join(root, 'node-state'))
  assert.ok(identity.token, "The fixture's authenticated Node credential was actually registered")
  secret.push(identity.token)
  const nodeClient = new LoomNodeClient({ http: new LoomHttpClient({ baseUrl: server.baseUrl }), identity, state: {} })
  const db = new DatabaseSync(join(server.dataDir, 'loom.sqlite3'))
  let beforeHeartbeat
  try {
    beforeHeartbeat = db.prepare('SELECT inventory FROM nodes WHERE id=? AND installation_id=?').get(node.id, node.installation_id)
  } finally { db.close() }
  assert.ok(beforeHeartbeat, 'Preserve the actual catalog for this registered Node and Installation')
  const inventoryBeforeOffline = JSON.parse(beforeHeartbeat.inventory)
  assert.ok(inventoryBeforeOffline.model_catalog?.source, 'Do not accidentally erase the SDK catalog by replaying only the public Node projection')
  await nodeClient.heartbeat({
    status: 'online', capabilities: [],
    workers: nodeBeforeOffline.workers.map(worker => (worker.worker_id ?? worker.id) === 'default'
      ? { ...worker, status: 'offline' } : worker),
    inventory: inventoryBeforeOffline,
  })
  const workerOffline = await admin.get(`/api/v1/model-inventory?node_id=${node.id}&installation_id=${encodeURIComponent(node.installation_id)}&worker_id=default`)
  assert.equal(workerOffline.confidence, 'worker_offline')
  assert.equal(workerOffline.models.length, 1, 'The historical descriptor remains visible without turning it available')
  assert.equal(workerOffline.models[0].resource_state, 'unavailable')
  assert.equal(workerOffline.models[0].freshness, 'stale')
  assert.equal(workerOffline.models[0].source, 'host_reported')
  assert.equal(workerOffline.models[0].read_source, 'authenticated_node_heartbeat')
  const rejectedOffline = await request().catch(error => error)
  assert.equal(rejectedOffline.status, 403, `An offline exact Worker must not create a new invocation: ${JSON.stringify({ id: rejectedOffline.id, status: rejectedOffline.status, code: rejectedOffline.code, message: rejectedOffline.message })}`)
  assert.equal(rejectedOffline.code, 'source_node_unavailable', 'Current physical matching must report the offline Worker before an invocation can be created')
  assert.deepEqual((await admin.get('/api/v1/tickets')).tickets, ticketsBeforeOffline, 'Rejected offline Worker creates no model ticket')
  assert.deepEqual((await admin.get('/api/v1/grants')).grants, grantsBeforeOffline, 'Worker offline does not revoke or mint any authorization')
  assert.equal(requestCount(await calls(root)), callsAfterExecution, 'No additional real SDK request occurs after the exact Worker goes offline')
  const workersBeforeOffline = nodeBeforeOffline.workers
  await nodeClient.heartbeat({ status: 'online', capabilities: [], workers: workersBeforeOffline, inventory: inventoryBeforeOffline })
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, ticketsBeforeOffline.length, 'Restoring fixture availability also creates no model ticket')

  await admin.post(`/api/v1/models/${model.id}/retire`, { reviewed_sha256: sourceArtifact.sha256 })
  await expectDenied(request(), 'A retired model cannot enter a new invocation')
  assert.equal(requestCount(await calls(root)), callsAfterExecution, 'Retirement does not create a new request')
  const report = { overall: 'PASS', modelDescriptor_read: true, exact_source_document_and_sha: true,
    model_registration: true, separate_place_and_invoke_grants: true,
    actual_isolated_dsh_text_invocation: true, source_assignment_id: sourceAssignment.id,
    invocation_assignment_id: text.assignments[0].id,
    logical_source_assignment_digest: sourceAssignmentDigest, source_document_sha256: sourceSha,
    proof_artifact_sha256: sourceArtifact.sha256,
    model_text_artifact_sha256: resultArtifact.sha256, model_id: model.id, placement_id: placement.id,
    source_ticket_id: readTicket.id, invoke_ticket_id: textTicket.id,
    revoke_wrong_scope_and_retire_refused: true, offline_worker_blocked_new_invocation: true,
    no_sdk_request_after_worker_offline: true, actual_adapter: 'loom-stub/loom-stub-v1',
    not_a_real_provider_model_or_weight_runtime: true, root }
  await writeFile(join(root, 'model-binding-result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: secret.reduce((str, key) => str.replaceAll(key, '[redacted]'), String(error.stack || error)), root }, null, 2))
  process.exitCode = 1
  if (host) console.error(host.diagnostics())
} finally {
  if (host) await host.stop().catch(() => {})
  if (server) await server.stop().catch(() => {})
}
async function calls(testRoot) {
  return (await readFile(join(testRoot, 'private', 'fixture-control.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
}
function requestCount(entries) { return entries.filter(entry => entry.type === 'request').length }
async function expectDenied(promise, label) {
  await assert.rejects(() => promise, error => error.status >= 400, label)
}
async function waitTerminal(admin, ticket, intent) {
  for (let count = 0; count < 750; count++) {
    const ticketValue = await admin.get(`/api/v1/tickets/${ticket}`)
    if (['succeeded', 'failed', 'cancelled', 'reconciling'].includes(ticketValue.status)) return ticketValue
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`${intent}: Ticket did not reach terminal state: ${JSON.stringify(await admin.get(`/api/v1/tickets/${ticket}`))}`)
}
