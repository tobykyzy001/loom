import assert from 'node:assert/strict'
import test from 'node:test'
import { DshDispatcher } from '../lib/dsh-dispatcher.js'
import { DshAdapter } from '../lib/dsh-adapter.js'
import { exactTextRoute, validTextGrant, inspectTextRoute } from '../lib/model-policy.js'

const nodeId = 'a'.repeat(64)
const digest = 'b'.repeat(64)
function assignment(operations = ['invoke_text'], model = 'loom-stub-v1') {
  return {
    id: 'asg_text_test', ticket_id: 'tkt_text_test', lease_id: 'lease_text_test',
    node_id: nodeId, installation_id: 'install-text-test', attempt: 1, lease_epoch: 1,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(), grant_digest: digest,
    kind: 'model_text', provider: 'loom-stub', model,
    grant: { id: 'grant_text_test', version: 1, node_id: nodeId, project_id: 'project-test',
      operations, digest },
  }
}
function publicSurface() {
  const prepared = { provider: 'loom-stub', id: 'loom-stub-v1', name: 'Bounded deterministic model text', inputModalities: ['text'], context: { contextWindow: 131072 } }
  const stream = () => { throw new Error('canExecute must only inspect model preparation, never dispatch') }
  return {
    async listProviders() { return [{ id: 'loom-stub', name: 'Local zero-network fixture adapter' }] },
    async listModels(provider) { assert.equal(provider, 'loom-stub'); return [prepared] },
    async resolveModelInfo(provider, model) { assert.equal(model, 'loom-stub-v1'); return prepared },
    async prepareCall(config) { assert.deepEqual(config, { provider: 'loom-stub', model: 'loom-stub-v1' }); return { config, inputModalities: ['text'], stream } },
  }
}
function subject(config = {}, llm = publicSurface()) {
  const runner = { identity: { node_id: nodeId }, state: { data: { assignments: {} }, flush: async () => {} },
    client: { acknowledge: async () => {} } }
  return new DshDispatcher(runner, new DshAdapter({ on: () => {}, llm }), config)
}
const future = { note: 'unit fakes model metadata; they do not execute SDK stream or a real provider' }
test('model_text defaults unsupported even with registered providers', async () => {
  assert.equal(await subject().canExecute(assignment()), false)
  assert.equal(future.note.includes('unit'), true)
})
test('model_text refuses read/write Grant and unknown selector without creating an Agent', async () => {
  const conf = { model_text_tasks: true, provider: 'loom-stub', model: 'loom-stub-v1' }
  assert.equal(await subject(conf).canExecute(assignment(['read'])), false)
  assert.equal(await subject(conf).canExecute(assignment(['write'])), false)
  assert.equal(await subject(conf).canExecute(assignment(['invoke_text'], 'some-other-model')), false)
  assert.equal(await subject(conf).canExecute({ ...assignment(), node_id: 'c'.repeat(64) }), false)
})
test('explicit exact provider and text modalities return bounded public observations, never stream during inspection', async () => {
  const dispatcher = subject({ model_text_tasks: true, provider: 'loom-stub', model: 'loom-stub-v1' })
  assert.equal(await dispatcher.canExecute(assignment()), true)
  const observation = dispatcher.active.get(assignment().id).modelObservation
  assert.equal(observation.model.id, 'loom-stub-v1')
  assert.equal(observation.provider.id, 'loom-stub')
  assert.deepEqual(observation.model.input_modalities, ['text'])
  assert.equal(observation.source, 'host_reported')
  assert.equal(dispatcher.active.get(assignment().id).textRoute.model, 'loom-stub-v1')
})
test('missing public adapter and photograph/image deduction are explicit non-capabilities', async () => {
  const config = { model_text_tasks: true, provider: 'loom-stub', model: 'loom-stub-v1' }
  const llm = publicSurface()
  assert.equal(await subject(config, {}).canExecute(assignment()), false)
  llm.listModels = async () => [{ provider: 'loom-stub', id: 'loom-stub-v1', inputModalities: ['image'] }]
  await assert.rejects(() => inspectTextRoute({ llm }, { provider: 'loom-stub', model: 'loom-stub-v1' }), /text modality/)
  assert.equal(validTextGrant({ grant: { operations: ['invoke_text'] } }), true)
  assert.equal(exactTextRoute({ provider: 'loom-stub', model: 'loom-stub-v1' }, {}).model, 'loom-stub-v1')
})
