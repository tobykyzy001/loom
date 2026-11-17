#!/usr/bin/env node
// Real descriptor-only source artifact. No DSH or model service invoked.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { prepareProject, startRustConcierge, testingClientToken, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

let runner
const token = testingClientToken()
const root = await testingRoot()
let center
const auth = value => ({ 'content-type': 'application/json', authorization: `Bearer ${value}` })
const createAdmin = () => new (class {
  constructor() { this.baseUrl = center.baseUrl; this.token = token }
  async request(method, path, body) {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { method, headers: auth(this.token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${response.status} ${value.error?.code || 'unknown'}`), { status: response.status, code: value.error?.code })
    return value
  }
})()
let admin
async function current(ticket) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await admin.request('GET', `/tickets/${ticket}`)
    if (value.status === 'succeeded') return value
    if (['failed', 'cancelled', 'reconciling'].includes(value.status)) throw new Error(`Source did not succeed: ${JSON.stringify({ status: value.status, reports: value.reports?.map(row => row.summary) })}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for genuine descriptor artifact')
}
async function tables() {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'))
  const tables = {}
  for (const name of ['models', 'model_placement_authorizations', 'model_placements']) {
    tables[name] = db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count
  }
  tables.schema = db.prepare('PRAGMA user_version').get().user_version
  tables.grants = db.prepare('SELECT COUNT(*) AS count FROM grants').get().count
  db.close()
  return tables
}
try {
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: token } })
  admin = createAdmin()
  const project = await prepareProject(root)
  const projectId = (await admin.request('POST', '/projects', { name: 'Local model descriptor source', root: project, mode: 'read_write' })).project.id
  const state = join(root, 'worker-state'), artifacts = join(root, 'worker-artifacts')
  const enrollment = await admin.request('POST', '/enrollment-codes', {})
  runner = await LocalNodeRunner.create({ baseUrl: center.baseUrl, stateDir: state, artifactDir: artifacts, enrollmentCode: enrollment.code, projectRoots: { [projectId]: project }, registration: { workerId: 'default' } })
  const identity = { node_id: runner.nodeId, installation_id: runner.installationId }
  await admin.request('POST', '/project-bindings', { project_id: projectId, node_id: identity.node_id, installation_id: identity.installation_id, worker_id: 'default', root_scope: project })
  const bindings = await admin.request('POST', '/grants', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', operations: ['read'] })
  const file = join(project, 'model.json')
  const descriptor = JSON.stringify({ schema: 'loom.model-descriptor.v1', provider: 'fixture-local-text', revision: 'v1', input_modalities: ['text'], local_only: true }) + '\n'
  await writeFile(file, descriptor, { mode: 0o600 })
  const source = await admin.request('POST', '/tickets', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', grant_id: bindings.grant.id, kind: 'model_descriptor', relative_path: 'model.json', objective: 'Collect a read-only descriptor with its source digest; never invoke a model' })
  const outcome = await runner.pollAndRun()
  assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome))
  await runner.client.dispatchOutbox()
  const realized = await current(source.id)
  assert.equal(realized.artifacts.length, 1)
  const artifactId = realized.artifacts[0].id
  const actual = await admin.request('GET', `/tickets/${source.id}/artifacts/${artifactId}`)
  const proof = JSON.parse(actual.content)
  assert.deepEqual(proof, { ...JSON.parse(descriptor), source_kind: 'explicit_local_artifact_descriptor', relative_path: 'model.json', source_sha256: createHash('sha256').update(descriptor).digest('hex'), source_document: descriptor })
  const reviewed_sha256 = createHash('sha256').update(actual.content).digest('hex')
  assert.equal(actual.artifact.sha256, reviewed_sha256)
  assert.notEqual(proof.source_sha256, reviewed_sha256)
  assert.equal(createHash('sha256').update(proof.source_document).digest('hex'), proof.source_sha256)
  assert.equal(await readFile(file, 'utf8'), descriptor)
  const nonTaskGrant = await admin.request('POST', '/grants', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', operations: ['place_model'] })
  await assert.rejects(() => admin.request('POST', '/tickets', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', grant_id: nonTaskGrant.grant.id, kind: 'read_summary', relative_path: 'model.json', objective: 'place_model must never imply a normal ticket operation' }), error => error.code === 'operation_scope')
  const registrationBody = { schema: 'loom.model-registry.v1', source_ticket_id: source.id, source_artifact_id: artifactId, worker_id: 'default', reviewed_sha256 }
  assert.ok(source.id.startsWith('tkt_'), 'normal Coordinator ticket IDs are not UUIDs')
  const created = await admin.request('POST', '/models', registrationBody)
  const modelId = created.model.id
  assert.ok(modelId)
  assert.equal(created.model.status, 'registered')
  assert.equal(created.model.activation, false)
  assert.equal(created.model.executable, false)
  assert.equal(created.model.installed, false)
  assert.equal(created.model.descriptor_sha256, reviewed_sha256)
  assert.equal(created.model.source_ticket_id, source.id)
  assert.equal(created.model.source_artifact_id, artifactId)
  assert.equal(created.model.worker_id, 'default')
  assert.equal(created.model.node_id, identity.node_id)
  assert.equal(created.model.installation_id, identity.installation_id)
  assert.equal(created.model.source_kind, 'explicit_local_artifact_descriptor')
  assert.deepEqual(created.model.descriptor, { ...JSON.parse(descriptor), media_type: 'application/vnd.loom.text-model-descriptor+json' })
  assert.ok(!JSON.stringify(created).includes(project))
  assert.ok(!JSON.stringify(created).includes(token))
  const duplicate = await admin.request('POST', '/models', registrationBody)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.model.id, modelId)
  assert.equal((await tables()).models, 1)
  const permissionBody = { grant_id: bindings.grant.id, worker_id: 'default', node_id: identity.node_id, installation_id: identity.installation_id, reviewed_sha256 }
  for (const operation of ['read', 'invoke_text']) {
    const wrong = await admin.request('POST', '/grants', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', operations: [operation] })
    await assert.rejects(() => admin.request('POST', `/models/${modelId}/placement-approvals`, { ...permissionBody, grant_id: wrong.grant.id }), error => error.code === 'place_model_required')
  }
  await assert.rejects(() => admin.request('POST', `/models/${modelId}/placement-approvals`, permissionBody), error => error.code === 'place_model_required')
  await assert.rejects(() => admin.request('POST', `/models/${modelId}/placement-approvals`, { ...permissionBody, worker_id: 'shadow-worker' }), error => ['model_scope', 'worker_scope', 'binding_scope'].includes(error.code))
  const placementGrant = await admin.request('POST', '/grants', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', operations: ['place_model'] })
  await assert.rejects(() => admin.request('POST', `/models/${modelId}/place`, { ...permissionBody, grant_id: placementGrant.grant.id }), error => error.code === 'placement_approval_required')
  const approvedBody = { ...permissionBody, grant_id: placementGrant.grant.id }
  const approval = await admin.request('POST', `/models/${modelId}/placement-approvals`, approvedBody)
  assert.equal(approval.authorization.current, true)
  assert.equal(approval.authorization.executable, false)
  assert.equal(approval.authorization.reviewed_sha256, reviewed_sha256)
  assert.equal(approval.authorization.grant_id, placementGrant.grant.id)
  const duplicateApproval = await admin.request('POST', `/models/${modelId}/placement-approvals`, approvedBody)
  assert.equal(duplicateApproval.duplicate, true)
  assert.equal((await tables()).model_placement_authorizations, 1)
  const receipt = await admin.request('POST', `/models/${modelId}/place`, approvedBody)
  assert.equal(receipt.placement.status, 'approved_for_placement')
  assert.equal(receipt.placement.description, '批准放置授权（未运行）')
  assert.equal(receipt.placement.grant_model, 'place_model')
  assert.equal(receipt.placement.executable, false)
  assert.equal(receipt.placement.generation_observed, false)
  assert.equal(receipt.placement.was_runtime_executed, false)
  const duplicateReceipt = await admin.request('POST', `/models/${modelId}/place`, approvedBody)
  assert.equal(duplicateReceipt.duplicate, true)
  assert.equal(duplicateReceipt.placement.id, receipt.placement.id)
  assert.equal((await tables()).model_placements, 1)
  await admin.request('POST', `/grants/${placementGrant.grant.id}/revoke`, {})
  await assert.rejects(() => admin.request('POST', `/models/${modelId}/place`, approvedBody), error => error.code === 'placement_grant_scope')
  await admin.request('POST', `/models/${modelId}/retire`, { reviewed_sha256 })
  assert.equal((await admin.request('GET', `/models/${modelId}`)).model.status, 'retired')
  for (const endpoint of ['placement-approvals', 'place']) {
    await assert.rejects(() => admin.request('POST', `/models/${modelId}/${endpoint}`, approvedBody), error => error.code === 'model_not_registered')
  }
  const readSource = await admin.request('POST', '/grants', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', operations: ['place_model'] })
  await admin.request('POST', `/grants/${readSource.grant.id}/revoke`, {})
  await assert.rejects(() => admin.request('POST', `/models/${modelId}/placement-approvals`, { ...approvedBody, grant_id: readSource.grant.id }), error => ['model_not_registered', 'placement_grant_scope'].includes(error.code))
  await center.stop()
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: token } })
  admin = createAdmin()
  const history = await admin.request('GET', `/models/${modelId}`)
  assert.equal(history.model.status, 'retired')
  assert.equal(history.model.descriptor_sha256, reviewed_sha256)
  assert.equal(history.model.placement_authorizations[0].current, false)
  assert.equal(history.model.activation, false)
  assert.equal(history.model.executable, false)
  assert.equal(history.model.source_ticket_id, source.id)
  assert.equal(history.model.source_artifact_id, artifactId)
  assert.equal((await tables()).schema, 9)
  assert.equal((await tables()).model_placement_authorizations, 1)
  assert.equal((await tables()).model_placements, 1)
  assert.equal((await tables()).models, 1)
  assert.equal((await tables()).grants, 6)
  assert.equal((await admin.request('GET', '/audit/verify')).valid, true)
  const restoredArtifact = await admin.request('GET', `/tickets/${source.id}/artifacts/${artifactId}`)
  assert.equal(JSON.parse(restoredArtifact.content).source_document, descriptor)
  assert.equal(restoredArtifact.artifact.sha256, reviewed_sha256)
  assert.equal(await readFile(file, 'utf8'), descriptor)
  await writeFile(join(root, 'local-descriptor-result.json'), JSON.stringify({ overall: 'PASS', model_id: modelId, source_ticket_id: source.id, source_artifact_id: artifactId, descriptor_sha256: reviewed_sha256, schema: 9, source_written_by_real_bare_worker: true, real_bytes_match: true, approval_and_retirement_survived_reopen: true, grant_revocation_current_false: true, runtime_executed: false, model_installed: false, activation: false }, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ overall: 'PASS', real_descriptor_artifact: true, exact_bytes_verified: true,
    duplicate_persistence: true, separate_placement_grant: true,
    revoked_and_retired_blocked: true, reopen_history_preserved: true,
    schema: 9, no_model_execution: true, test_root: root }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: String(error.stack || error).replaceAll(token, '[redacted]'), test_root: root }, null, 2))
  process.exitCode = 1
} finally {
  const _completedRunner = runner
  if (center) await center.stop().catch(() => {})
}
