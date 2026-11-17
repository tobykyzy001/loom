import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureRoot, installBundles, isolatedEnv, installation, redact, sleep } from '../harness/environment.mjs'
import { FixtureHost } from '../harness/runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

/** Real isolated DSH SDK adapter inspection → actual node heartbeat; zero model call and no Ticket/Grant. */
const root = await fixtureRoot(process.env.LOOM_MODEL_INVENTORY_ROOT)
const checks = []; const secrets = []
let host, server, admin
const log = (name, evidence) => { checks.push({ name, status: 'PASS', evidence }); console.log(`PASS model_inventory: ${name}`) }
try {
  secrets.push('client-token-is-never-included-in-traces')
  const { executable, cli } = installation()
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  server = await startRustConcierge({ root: join(root, 'rust') })
  secrets.push(server.clientToken)
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const { code: enrollment } = await admin.post('/api/v1/enrollment-codes', {})
  // The patch consumes only this temporary opt-in. No selected real provider/credential/Profile.
  const env = isolatedEnv(root, { LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl,
    LOOM_FIXTURE_ENROLLMENT_CODE: enrollment, LOOM_FIXTURE_MODEL_TEXT_TASKS: 'true' })
  const isolatedInstall = await installBundles({ env, root, cli, executable,
    bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
  host = new FixtureHost(root, env, secrets)
  await host.start()
  const deadline = Date.now() + 45_000
  let node, firstCatalog, model
  while (!model && Date.now() < deadline) {
    const nodes = (await admin.get('/api/v1/nodes')).nodes
    node = nodes.find((entry) => entry.status === 'online')
    if (node) {
      const response = await admin.get('/api/v1/model-inventory')
      firstCatalog = response.observations.find((entry) => entry.node_id === node.id
        && entry.installation_id === node.installation_id && entry.schema === 'loom.model-inventory.v1'
        && entry.models.length === 1 && entry.controller_matches === true)
      model = response.models.find((entry) => entry.node_id === node.id && entry.installation_id === node.installation_id
        && entry.provider === 'loom-stub' && entry.model === 'loom-stub-v1')
    }
    if (!model) await sleep(150)
  }
  assert.ok(node && firstCatalog && model, 'Real Node or validated Controller raw observation was not produced')
  const worker = node.workers.find((entry) => entry.worker_id === model.worker_id)
  assert.ok(worker, 'The model catalog worker must be the authenticated enrolled Worker')
  assert.equal(firstCatalog.schema, 'loom.model-inventory.v1')
  assert.equal(firstCatalog.revision, 1)
  assert.equal(model.worker_id, 'default')
  assert.equal(firstCatalog.lookup_source, 'ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall')
  assert.equal(model.source, 'host_reported')
  assert.ok(Number.isFinite(Date.parse(model.observed_at)))
  for (const field of ['provider', 'model', 'source', 'observed_at', 'resource_state', 'prepared_call_observed',
    'generation_observed', 'input_modalities', 'context_window']) assert.ok(Object.hasOwn(model, field))
  assert.equal(model.provider, 'loom-stub'); assert.equal(model.model, 'loom-stub-v1')
  assert.equal(model.resource_state, 'adapter_observed')
  assert.equal(model.prepared_call_observed, true); assert.equal(model.generation_observed, false)
  assert.deepEqual(model.input_modalities, ['text']); assert.equal(model.context_window, 131072)
  assert.ok(firstCatalog.findings.some((finding) => finding.state === 'prepared_call_ready'
    && finding.provider === 'loom-stub' && finding.model === 'loom-stub-v1'))
  assert.deepEqual(node.inventory.project_roots, {}, 'must retain the original registered project mapping without inference')
  assert.equal(firstCatalog.permission_granted, false)
  for (const operation of ['install', 'download', 'activation', 'generation']) assert.equal(firstCatalog.policy[operation], false)
  log('real current-DSH adapter is reported inside the authenticated Node worker scope', { node_id: node.id,
    installation_id: node.installation_id, worker_id: model.worker_id, model, findings: firstCatalog.findings })
  const control = () => readFile(join(root, 'private', 'fixture-control.jsonl'), 'utf8')
    .then(text => text.split('\n').filter(Boolean).map(JSON.parse))
  const firstCalls = await control()
  assert.equal(firstCalls.filter((entry) => entry.type === 'model-prepared').length, 1)
  assert.ok(firstCalls.some((entry) => entry.type === 'models-listed'))
  assert.ok(firstCalls.some((entry) => entry.type === 'model-resolved'))
  assert.equal(firstCalls.filter((entry) => entry.type === 'request').length, 0)
  while (Date.now() < deadline && firstCalls.length < 3) await sleep(100)
  await sleep(2300)
  const laterModels = (await admin.get('/api/v1/model-inventory')).models.filter((entry) => entry.node_id === node.id
    && entry.installation_id === node.installation_id && entry.model === 'loom-stub-v1')
  assert.deepEqual(laterModels, [model], 'cached metadata is never refreshed by repeated prepare/model calls')
  assert.equal((await control()).filter((entry) => entry.type === 'model-prepared').length, 1)
  assert.equal((await control()).filter((entry) => entry.type === 'request').length, 0)
  log('multiple authenticated heartbeats do not trigger generation or repeated prepare lookup', {
    prepare_calls: 1, generation_requests: 0, raw_observed_at_reused: model.observed_at,
    no_new_ticket_created: true, no_grant_created: true, fixture_sdk_controlled: true,
  })
  const projection = await admin.get('/api/v1/model-inventory').then((value) => ({ available: true, value }))
    .catch((error) => ({ available: false, status: error.status || 'NOT AVAILABLE' }))
  if (projection.available) {
    const projected = projection.value.models.find((entry) => entry.node_id === node.id && entry.installation_id === node.installation_id
      && entry.worker_id === model.worker_id && entry.provider === 'loom-stub' && entry.model === 'loom-stub-v1')
    assert.ok(projected, `Expected a projection from the authenticated Node: ${JSON.stringify(projection.value)}`)
    assert.equal(projected.worker_id, model.worker_id)
    assert.equal(projected.provider, 'loom-stub')
    assert.equal(projected.source, 'host_reported')
    assert.equal(projected.read_source, 'authenticated_node_heartbeat')
    assert.equal(projected.catalogued, true)
    assert.equal(projected.prepared_call_observed, true)
    assert.equal(projected.generation_observed, false)
    assert.equal(projected.controller_matches, true)
    assert.equal(projected.freshness, 'fresh')
    assert.equal(projected.context_window, 131072)
    assert.equal(projected.activated, false)
    assert.equal(projected.allowed, false)
    assert.equal(projected.executable, false)
    assert.equal(projection.value.observations.find((entry) => entry.node_id === node.id)?.permission_granted, false)
    assert.equal(projection.value.policy.generation, false)
    log('controller read-only projection consumed the same raw fact', { model: projected,
      permission_granted: false, not_an_activation_or_generation_grant: true })
  } else {
    throw Object.assign(new Error(`Controller model-inventory read projection is required but unavailable: ${projection.status}`), { projection })
  }
  const proof = { overall: 'PASS', checks, facts: {
    real_dsh_sdk: true, isolated_fixture_profile: 'loom-local-fixture', isolated_install: true,
    actual_node_id: node.id, actual_worker_id: model.worker_id, observation: firstCatalog, model,
    prepare_call_observations: 1, generation_requests: 0, ticket_requests: 0, grant_requests: 0,
    real_paid_llm: 'NOT RUN', live_model_registry: 'NOT IMPLEMENTED', downloads: 'NOT RUN', activation: 'NOT RUN',
    non_stub_provider_support: 'NOT IMPLEMENTED', node_credentials_persisted: 'isolated temporary state only',
  }, root }
  await writeFile(join(root, 'private', 'model-inventory-result.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: redact(error.stack, secrets), host: redact(host?.diagnostics() || '', secrets), checks, root }, null, 2))
  process.exitCode = 1
} finally {
  if (host) await host.stop().catch(() => {})
  if (server) await server.stop().catch(() => {})
}
