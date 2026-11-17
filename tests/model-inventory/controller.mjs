import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LoomNodeClient } from '../../packages/node-client/src/client.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'

const root = await testingRoot()
let server
const secret = 'SYNTHETIC_MUST_NOT_ECHO_47'
try {
  await mkdir(join(root, 'node'), { recursive: true, mode: 0o700 })
  server = await startRustConcierge({ root: join(root, 'rust') })
  let admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const identity = await NodeIdentity.open(join(root, 'node'))
  const node = new LoomNodeClient({ http: admin, identity, state: {} })
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  await assert.rejects(() => admin.get('/api/v1/model-inventory', { noAuth: true }), error => error.status === 401)
  await node.enroll({ enrollmentCode: enrollment.code, capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], harnessKind: 'dsh-loom', workerId: 'default' })
  const timestamp = new Date().toISOString()
  const catalog = {
    schema: 'loom.model-inventory.v1', revision: 1, worker_id: 'default',
    lookup_source: 'ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall',
    source: 'host_reported', observed_at: timestamp,
    models: [{ provider: 'loom-stub', model: 'loom-stub-v1', source: 'host_reported', observed_at: timestamp,
      resource_state: 'adapter_observed', prepared_call_observed: true, generation_observed: false, input_modalities: ['text'], context_window: 131072 }],
    findings: [{ state: 'prepared_call_ready', provider: 'loom-stub', model: 'loom-stub-v1', source: 'host_reported', observed_at: timestamp }],
    policy: { install: false, download: false, activation: false, generation: false },
  }
  const worker = { worker_id: 'default', harness_kind: 'dsh-loom', profile_id: 'isolated', status: 'online', capabilities: [] }
  const inventory = { project_roots: {}, resources: [], model_catalog: catalog }
  await node.heartbeat({ capabilities: [], workers: [worker], inventory })
  const expected = await admin.get('/api/v1/model-inventory')
  assert.equal(expected.schema, 'loom.model-inventory.v1')
  assert.equal(expected.models.length, 1)
  const model = expected.models[0]
  for (const property of ['activated', 'allowed', 'executable', 'generation_observed']) assert.equal(model[property], false)
  assert.equal(model.catalogued, true)
  assert.equal(model.prepared_call_observed, true)
  assert.equal(model.source, 'host_reported')
  assert.equal(model.freshness, 'fresh')
  assert.equal(model.controller_matches, true)
  assert.equal(model.worker_id, 'default')
  assert.equal(model.node_id, identity.nodeId)
  assert.equal(model.installation_id, identity.installationId)
  assert.equal(model.context_window, 131072)
  assert.equal(model.observed_at, timestamp)
  assert.equal(expected.policy.activation, false)
  assert.equal(expected.policy.remote_delivery, false)
  assert.equal(expected.policy.install_support, 'NOT_IMPLEMENTED')
  assert.equal(expected.policy_code, 'observed_only_not_activation')
  const exact = await admin.get(`/api/v1/model-inventory?node_id=${identity.nodeId}&installation_id=${encodeURIComponent(identity.installationId)}&worker_id=default`)
  assert.equal(exact.models.length, 1)
  assert.equal(exact.confidence, 'fresh_observation')
  assert.equal(exact.read_source, 'authenticated_node_heartbeat')
  assert.equal(exact.findings[0].state, 'prepared_call_ready')
  assert.equal(exact.findings[0].observed_at, timestamp)
  assert.equal(exact.permission_granted, false)
  assert.equal(exact.policy.supported_operations[0], 'read_catalog_only')
  assert.deepEqual(exact.findings[0].provider, 'loom-stub')
  await assert.rejects(() => admin.get('/api/v1/models'), error => error.status === 501)
  const firstId = model.id
  await node.heartbeat({ capabilities: [], workers: [worker], inventory })
  assert.equal((await admin.get('/api/v1/model-inventory')).models[0].id, firstId)

  const disabled = structuredClone(catalog)
  disabled.models = []
  disabled.findings = [{ state: 'requested_disabled', source: 'host_reported', observed_at: timestamp }]
  await node.heartbeat({ capabilities: [], workers: [worker], inventory: { model_catalog: disabled } })
  const inactive = await admin.get('/api/v1/model-inventory')
  assert.equal(inactive.models.length, 0)
  assert.equal(inactive.observations[0].confidence, 'fresh_observation')
  assert.equal(inactive.observations[0].findings[0].state, 'requested_disabled')
  assert.equal(inactive.observations[0].permission_granted, false)
  assert.equal(inactive.observations[0].policy.activation_support, 'NOT_IMPLEMENTED')

  const negatives = []
  const change = (mutate, expectedReason) => negatives.push({ mutate, expectedReason })
  change(raw => { raw.worker_id = 'shadow-worker' }, 'worker_mismatch')
  change(raw => { raw.models[0].source = 'controller_probed' }, 'not_granted')
  change(raw => { raw.models[0].generation_observed = true }, 'not_granted')
  change(raw => { raw.models[0].prepared_call_observed = false }, 'not_granted')
  change(raw => { raw.models[0].provider = 'deepseek' }, 'not_granted')
  change(raw => { raw.models[0].input_modalities = ['image'] }, 'not_granted')
  change(raw => { raw.revision = 2 }, 'source_invalid')
  change(raw => { raw.policy.activation = true }, 'source_invalid')
  change(raw => { raw.models[0].api_key = secret }, 'source_invalid')
  change(raw => { raw.models[0].endpoint = `https://${secret}.invalid` }, 'source_invalid')
  for (const [index, { mutate, expectedReason }] of negatives.entries()) {
    const raw = structuredClone(catalog)
    mutate(raw)
    // Stable cases (no raw provider payload or untrusted field values logged).
    // No raw provider payloads or untrusted values are logged.
    await node.heartbeat({ capabilities: [], workers: [worker], inventory: { model_catalog: raw } })
    const response = await admin.get('/api/v1/model-inventory')
    assert.equal(response.models.length, 0, `invalid observation ${index} became executable`)
    assert.equal(response.observations[0].confidence, index === 0 ? 'invalid_observation'
      : expectedReason === 'source_invalid' ? 'invalid_observation' : 'fresh_observation', JSON.stringify(response))
    assert.ok(response.observations[0].findings.some(finding => finding.state === expectedReason), JSON.stringify(response))
    assert.ok(!JSON.stringify(response).includes(secret), 'secret-shaped material was reflected')
    const wrongWorker = await admin.get(`/api/v1/model-inventory?node_id=${identity.nodeId}&installation_id=${encodeURIComponent(identity.installationId)}&worker_id=shadow-worker`)
    assert.equal(wrongWorker.findings[0].state, 'worker_mismatch')
    assert.equal(wrongWorker.models.length, 0)
  }
  // Missing data must not retain an earlier healthy model row.
  await node.heartbeat({ capabilities: [], workers: [worker], inventory: { project_roots: {}, resources: [] } })
  const missing = await admin.get('/api/v1/model-inventory')
  assert.equal(missing.models.length, 0)
  assert.equal(missing.observations[0].confidence, 'missing_unknown')
  assert.equal(missing.observations[0].findings[0].state, 'model_catalog_missing')
  await node.heartbeat({ capabilities: [], workers: [worker], inventory: { model_catalog: catalog } })
  const validAgain = await admin.get('/api/v1/model-inventory')
  assert.equal(validAgain.models.length, 1)
  assert.equal(validAgain.models[0].allowed, false)
  await server.stop()
  // The replacement listens on another port; never reuse the stale URL.
  server = await startRustConcierge({ root: join(root, 'rust'), env: { ...process.env, LOOM_CLIENT_TOKEN: server.clientToken } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const restored = await admin.get('/api/v1/model-inventory')
  assert.deepEqual(restored, validAgain)
  const records = await sqliteReadonly(server.dataDir)
  assert.equal(records.model_tables.includes('model_registry'), false)
  await writeFile(join(root, 'controller-result.json'), JSON.stringify({
    status: 'PASS', source: 'signed_real_node_http', expected_node: identity.nodeId,
    restore_same_observation: true, admin_client_auth_required: true,
    latest_bad_or_missing_never_retains_fresh_model: true,
    valid_models: 1, negatives: negatives.length, activation_or_execution_granted: false,
    model_registry: 'NOT_IMPLEMENTED', model_api_readonly: true,
  }, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ overall: 'PASS', actual_signed_node_http: true, negative_cases: negatives.length,
    read_only: true, exact_node_and_worker: true, same_after_restart: true,
    no_registry_or_invocation: true, test_root: root }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: String(error.stack || error).replaceAll(server?.clientToken || '', '[test-token]').replaceAll(secret, '[redacted]'), cause: String(error.cause?.message || error.cause || 'none'), test_root: root }, null, 2))
  process.exitCode = 1
} finally {
  if (server) await server.stop().catch(() => {})
}

async function sqliteReadonly(dataDir) {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(join(dataDir, 'loom.sqlite3'))
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%model%'").all().map(row => row.name)
  database.close()
  return { model_tables: tables }
}
