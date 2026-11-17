import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectModelCatalog, mergeModelCatalogFacts } from '../lib/model-inventory.js'
import { DshDispatcher } from '../lib/dsh-dispatcher.js'
import { CoordinatorLoop, runLocalDshPlugin } from '../lib/coordinator.js'

const observedAt = '2026-11-17T00:00:00.000Z'
const readyModel = { provider: 'loom-stub', id: 'loom-stub-v1', name: 'Controlled fixture', inputModalities: ['text'], context: { contextWindow: 131072 } }
function llm(overrides = {}) {
  const called = { providers: 0, models: 0, resolution: 0, prepare: 0, stream: 0, request: 0 }
  return { called,
    listProviders: async () => { called.providers++; return [{ id: 'loom-stub', name: 'Fixture adapter' }] },
    listModels: async () => { called.models++; return [readyModel] },
    resolveModelInfo: async () => { called.resolution++; return readyModel },
    prepareCall: async ({ provider, model }) => {
      called.prepare++; assert.deepEqual({ provider, model }, { provider: 'loom-stub', model: 'loom-stub-v1' })
      return { config: { provider, model }, inputModalities: ['text'],
        stream: async function * () { called.stream++; yield { type: 'must-not-run-during-lookup' } } }
    }, ...overrides }
}
const config = { model_text_tasks: true, provider: 'loom-stub', model: 'loom-stub-v1' }
function dispatcher(adapter = { ctx: { llm: llm() } }, worker_id = 'default') {
  return new DshDispatcher({
    registrationFacts: () => ({ workers: [{ worker_id, profile_id: 'loom-local-fixture', harness_kind: 'dsh-host' }],
      inventory: { project_roots: { 'project-fixture': '/synthetic/explicit-root' }, harness_kind: 'dsh-host' } }),
  }, adapter, { ...config, provider: 'loom-stub', model: 'loom-stub-v1' })
}

test('catalog carries exactly the validated public adapter observation; never calls stream', async () => {
  const sdk = llm(); const catalog = await inspectModelCatalog({ llm: sdk }, config, () => observedAt)
  assert.deepEqual(catalog, {
    schema: 'loom.model-inventory.v1', revision: 1, worker_id: undefined,
    lookup_source: 'ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall', source: 'host_reported', observed_at: observedAt,
    models: [{ provider: 'loom-stub', model: 'loom-stub-v1', source: 'host_reported', observed_at: observedAt,
      resource_state: 'adapter_observed', prepared_call_observed: true, generation_observed: false,
      input_modalities: ['text'], context_window: 131072 }],
    findings: [{ state: 'prepared_call_ready', provider: 'loom-stub', model: 'loom-stub-v1', source: 'host_reported', observed_at: observedAt }],
    policy: { install: false, download: false, activation: false, generation: false },
  })
  assert.equal(sdk.called.prepare, 1); assert.equal(sdk.called.stream, 0); assert.equal(sdk.called.request, 0)
})

test('disable, selector ellipsis/foreign provider and missing SDK never scan or fabricate an entry', async () => {
  for (const [conf, expected] of [
    [{ ...config, model_text_tasks: false }, 'requested_disabled'],
    [{ ...config, provider: '*' }, 'unsupported_route'],
    [{ ...config, provider: '../../.ssh/credentials' }, 'unsupported_route'],
    [{ ...config, provider: 'foreign-provider' }, 'unsupported_route'],
    [{ ...config, model: 'not-an-observed-model' }, 'unsupported_route'],
  ]) {
    const sdk = llm(); const observation = await inspectModelCatalog({ llm: sdk }, conf, () => observedAt)
    assert.equal(observation.findings[0].state, expected)
    assert.deepEqual(observation.models, [])
    assert.equal(sdk.called.stream + sdk.called.prepare + sdk.called.providers + sdk.called.models + sdk.called.resolution, 0)
  }
  for (const sdk of [{}, llm({ listProviders: async () => [] }), llm({ listModels: async () => [{ ...readyModel, inputModalities: ['text', 'image'] }] }),
    llm({ prepareCall: async () => ({ config: { provider: 'loom-stub', model: 'other' }, inputModalities: ['text'], stream: () => {} }) })]) {
    const observation = await inspectModelCatalog({ llm: sdk }, { ...config, actual_worker_id: 'default' }, () => observedAt)
    assert.equal(observation.models.length, 0)
    assert.notEqual(observation.findings[0].state, 'prepared_call_ready')
    assert.equal(observation.worker_id, 'default')
    assert.equal(Object.hasOwn(observation.findings[0], 'message'), false)
  }
})

test('single cached initialization preserves exact worker and project scopes on subsequent heartbeats', async () => {
  const sdk = llm(); const exec = dispatcher({ ctx: { llm: sdk } }, 'actual-default-worker')
  await exec.initializeModelCatalog()
  let first = exec.registrationFacts(['model_text']); const second = exec.registrationFacts(['model_text'])
  assert.deepEqual(first, second)
  assert.equal(sdk.called.prepare, 1)
  assert.equal(first.workers[0].worker_id, 'actual-default-worker')
  assert.equal(first.inventory.model_catalog.worker_id, 'actual-default-worker')
  assert.equal(first.inventory.project_roots['project-fixture'], '/synthetic/explicit-root')
  assert.equal(first.inventory.harness_kind, 'dsh-host')
  assert.equal('grant' in first.inventory.model_catalog, false)
  assert.equal('node_id' in first.inventory.model_catalog, false)
  assert.equal('installation_id' in first.inventory.model_catalog, false)
  assert.throws(() => mergeModelCatalogFacts(exec.registrationFacts(), { ...first.inventory.model_catalog, worker_id: 'other' }))
  const before = sdk.called.prepare
  assert.throws(() => { first.inventory.model_catalog.models[0].generation_observed = true }, /read only/)
  assert.equal(first.inventory.model_catalog.models[0].generation_observed, false, 'cached proof is not caller-mutable')
  const heartbeats = []
  const loop = new CoordinatorLoop({ model_text_tasks: true, poll_seconds: 0, heartbeat_ms: 5000 }, exec, {
    heartbeat: async (body) => heartbeats.push(body), dispatchOutbox: async () => [], poll: async () => null,
  })
  loop.capabilities = ['model_text']
  await loop.pollCycle(); await loop.pollCycle()
  assert.equal(sdk.called.prepare, before)
  assert.equal(heartbeats.every((body) => body.inventory.model_catalog.models[0].generation_observed === false), true)
})

test('failed real lookup leaves explicit empty cached finding; no last-known-good re-promotion', async () => {
  const sdkUnavailable = llm()
  const execution = dispatcher({ ctx: { llm: Object.assign(sdkUnavailable, { prepareCall: async () => { sdkUnavailable.called.prepare++; throw new Error('synthetic adapter unavailable') } }) } })
  await execution.initializeModelCatalog()
  const observation = execution.registrationFacts().inventory.model_catalog
  assert.equal(observation.findings[0].state, 'lookup_failed')
  assert.deepEqual(observation.models, [])
  assert.equal(Object.hasOwn(observation.findings[0], 'prepared_call_observed'), false)
  assert.equal(execution.adapter.ctx.llm.called.prepare, 1)
})

test('invalid observation timestamp cannot certify a prepared model', async () => {
  const result = await inspectModelCatalog({ llm: llm() }, { ...config, actual_worker_id: 'default' }, () => '2026-11-17')
  assert.deepEqual(result.models, [])
  assert.equal(result.findings[0].state, 'lookup_failed')
})

test('expired lookup stays unknown when later SDK metadata arrives', async () => {
  const sdk = llm(); const pendingAdapter = Promise.withResolvers()
  sdk.prepareCall = () => { sdk.called.prepare++; return pendingAdapter.promise }
  const execution = dispatcher({ ctx: { llm: sdk } }, 'default')
  const initialization = execution.initializeModelCatalog()
  await new Promise((resolve) => setImmediate(resolve))
  execution.modelCatalogLookupExpired()
  pendingAdapter.resolve({ config: { provider: 'loom-stub', model: 'loom-stub-v1' }, inputModalities: ['text'], stream: () => {} })
  await initialization
  await new Promise((resolve) => setImmediate(resolve))
  const facts = execution.registrationFacts().inventory.model_catalog
  assert.deepEqual(facts.models, [])
  assert.equal(facts.findings[0].state, 'lookup_unavailable')
  assert.equal(sdk.called.prepare, 1)
})

test('plugin coordinator preserves disabled/unavailable observation in actual outgoing heartbeat envelope', async () => {
  const runner = { registrationFacts: () => ({ workers: [{ worker_id: 'default' }], inventory: { project_roots: {}, harness_kind: 'dsh-host' } }) }
  const execution = new DshDispatcher(runner, { ctx: new Proxy({}, { get: () => { throw new Error('disabled config must not read ctx.llm') } }), dispose: async () => {} }, { ...config, model_text_tasks: false })
  const sent = []
  const loop = await runLocalDshPlugin({ ...config, model_text_tasks: false }, {
    createClient: async () => ({ runner, capabilities: execution.capabilities,
      client: { heartbeat: async (body) => sent.push(JSON.parse(JSON.stringify(body))), dispatchOutbox: async () => [], poll: async () => null } }),
    localDispatcher: () => execution,
  })
  await loop.pollCycle()
  assert.equal(sent.at(-1).inventory.model_catalog.findings[0].state, 'requested_disabled')
  assert.deepEqual(sent.at(-1).inventory.model_catalog.models, [])
  assert.throws(() => execution.modelCatalog.models.push({ provider: 'malicious', model: 'not-real' }), /not extensible/)
  await loop.pollCycle()
  assert.deepEqual(loop.lastError, null)
  await loop.dispose()
})
