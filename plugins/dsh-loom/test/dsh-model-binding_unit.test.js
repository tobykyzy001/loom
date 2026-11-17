import test from 'node:test'
import assert from 'node:assert/strict'
import { validateModelBinding, loadTextRequest } from '../lib/model-binding.js'
import { DshDispatcher } from '../lib/dsh-dispatcher.js'

const identity = { node_id: 'a'.repeat(64), installation_id: 'install-actual' }
const invokeDigest = 'b'.repeat(64)
const placeDigest = 'c'.repeat(64)
const config = { model_text_tasks: true, provider: 'loom-stub', model: 'loom-stub-v1' }
function fixture() {
  const scope = { node_id: identity.node_id, installation_id: identity.installation_id, worker_id: 'dsh-worker-a', project_id: 'project-a' }
  const invoke = { id: 'grant-invoke', version: 1, revoked_at: null, digest: invokeDigest, operations: ['invoke_text'], ...scope }
  const place = { id: 'grant-place', version: 2, revoked_at: null, digest: placeDigest, operations: ['place_model'], ...scope, active: false }
  const binding = {
    schema: 'loom.model-binding.v1', model_id: 'model-source-v1', placement_id: 'placement-a',
    placement_sha256: 'd'.repeat(64), source_artifact_id: 'artifact-source', source_ticket_id: 'ticket-source',
    source_assignment_digest: 'e'.repeat(64), placement_grant_id: place.id, placement_grant_digest: placeDigest,
    ...scope,
  }
  const objective = 'Return bounded fixture text.'
  return {
    id: 'assignment-text', ticket_id: 'ticket-text', lease_id: 'lease-text', lease_epoch: 1, attempt: 1,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(), grant_digest: invokeDigest,
    kind: 'model_text', provider: 'loom-stub', model: 'loom-stub-v1', objective,
    grant: invoke, grants: [invoke, place],
    content: JSON.stringify({ schema: 'loom.model-text.v1', objective, provider: 'loom-stub', model: 'loom-stub-v1', model_binding: binding }),
    ...scope,
  }
}
function patched(change) {
  const assignment = fixture()
  const request = JSON.parse(assignment.content)
  change({ assignment, request, binding: request.model_binding, invoke: assignment.grant, place: assignment.grants[1] })
  assignment.content = JSON.stringify(request)
  if (assignment.model_binding) assignment.model_binding = request.model_binding
  return assignment
}
async function rejected(assignment, pattern) {
  await assert.rejects(() => validateModelBinding(assignment, identity), pattern)
}

test('strict model binding returns only pinned public source facts', async () => {
  const assignment = fixture()
  assert.deepEqual(await validateModelBinding(assignment, identity), {
    model_id: 'model-source-v1', placement_id: 'placement-a', placement_sha256: 'd'.repeat(64),
    source_artifact_id: 'artifact-source', source_ticket_id: 'ticket-source', source_assignment_digest: 'e'.repeat(64),
    placement_grant_id: 'grant-place', placement_grant_digest: placeDigest, provider: 'loom-stub', model: 'loom-stub-v1',
  })
  assert.equal(loadTextRequest(assignment).provider, 'loom-stub')
  assert.equal('grant' in loadTextRequest(assignment), false)
})

test('poll-enriched invocation Grant equals its stored row except derived ProjectRoot', async () => {
  const assignment = fixture()
  const stored = { ...assignment.grant, created_at: '2026-01-01T00:00:00.000Z', project_binding_id: 'binding-a' }
  assignment.grant = { ...stored, project_root: '/isolated/fixture/project' }
  assignment.grants = [stored, assignment.grants[1]]
  assignment.resource = { root_scope: '/isolated/fixture/project', project_id: assignment.project_id }
  await validateModelBinding(assignment, identity)
  await rejected({ ...assignment, grant: { ...assignment.grant, operations: ['invoke_text', 'place_model'] } }, /dedicated/)
  await rejected({ ...assignment, grant: { ...assignment.grant, project_binding_id: 'another-binding' } }, /exact invocation/)
  await rejected({ ...assignment, resource: { ...assignment.resource, root_scope: '/different/root' } }, /ProjectRoot/)
  await rejected({ ...assignment, resource: undefined }, /ProjectRoot/)
})

test('binding rejects missing/extra/unknown fields, aliases and fallback request state', async () => {
  for (const mutate of [
    ({ binding }) => { delete binding.source_assignment_digest },
    ({ binding }) => { binding.source_descriptor_sha256 = 'f'.repeat(64) },
    ({ binding }) => { binding.assignment_digest = binding.source_assignment_digest; delete binding.source_assignment_digest },
    ({ binding }) => { binding.worker_id = 'auto' },
    ({ binding }) => { binding.placement_sha256 = 'not-a-proof' },
    ({ binding }) => { binding.placement_grant_digest = 'f'.repeat(64) },
    ({ binding }) => { binding.model_id = '../other-model' },
    ({ request }) => { request.objective = 'New instructions' },
    ({ request }) => { request.provider = 'other-provider' },
    ({ request }) => { delete request.objective },
  ]) await rejected(patched(mutate))
  await rejected({ ...fixture(), model_binding: { schema: 'loom.model-binding.v1' } }, /Conflicting/)
  await assert.rejects(() => validateModelBinding({ ...fixture(), content: undefined }, identity), /bounded immutable content/)
})

test('placement proof requires the separate exact, explicitly current Grant in all scopes', async () => {
  for (const mutate of [
    ({ assignment }) => { assignment.grants = [assignment.grant] },
    ({ place }) => { place.operations = ['read'] },
    ({ place }) => { delete place.revoked_at; place.active = true },
    ({ place }) => { place.revoked_at = new Date().toISOString() },
    ({ place }) => { place.id = 'wrong-id' },
    ({ place }) => { place.digest = 'f'.repeat(64) },
    ({ place }) => { place.worker_id = 'other-worker' },
    ({ place }) => { place.node_id = 'f'.repeat(64) },
    ({ place }) => { place.project_id = 'other-project' },
    ({ place }) => { place.installation_id = 'other-installation' },
    ({ place }) => { delete place.digest; place.grant_digest = placeDigest },
    ({ place }) => { place.active = true; delete place.revoked_at },
  ]) await rejected(patched(mutate))
})

test('invoke and placement authorities cannot be substituted or share a Grant', async () => {
  await rejected(patched(({ assignment, binding }) => { binding.placement_grant_id = assignment.grant.id }), /separate/)
  await rejected(patched(({ invoke }) => { invoke.operations = ['invoke_text', 'place_model'] }), /dedicated/)
  await rejected(patched(({ assignment, place }) => { assignment.grants = [assignment.grant, place, { ...place }] }))
  await rejected(patched(({ assignment }) => { assignment.grants[0] = { ...assignment.grant, worker_id: 'another' } }), /exact invocation/)
  await rejected(patched(({ invoke }) => { invoke.revoked_at = new Date().toISOString() }), /not explicitly current/)
})

test('identity and exact request metadata are fenced to actual enrolled host', async () => {
  await assert.rejects(() => validateModelBinding(fixture(), { node_id: 'f'.repeat(64), installation_id: identity.installation_id }), /enrolled installation/)
  await assert.rejects(() => validateModelBinding(fixture(), { node_id: identity.node_id, installation_id: 'wrong-install' }), /enrolled installation/)
  for (const [key, value] of [['node_id', 'f'.repeat(64)], ['installation_id', 'another-install'], ['worker_id', 'another-worker'], ['project_id', 'another-project']]) {
    await rejected(patched(({ assignment }) => { assignment[key] = value }))
  }
  await rejected({ ...fixture(), worker_id: 'auto' }, /actual assigned Worker/)
  await validateModelBinding(fixture(), { node_id: identity.node_id, installation_id: identity.installation_id })
})

function dispatcher(prepareCall = async () => { throw new Error('SDK must not be touched') }) {
  const adapter = {
    ctx: { llm: {
      listProviders: async () => [{ id: 'loom-stub' }], listModels: async () => [],
      resolveModelInfo: async () => { throw new Error('SDK must not be touched') }, prepareCall,
    } },
    executeAssignment: async () => { throw new Error('No Agent inference is allowed') },
  }
  const runner = {
    identity, state: { data: { assignments: {} }, flush: async () => {} },
    client: { acknowledge: async () => {} },
  }
  return new DshDispatcher(runner, adapter, config)
}

test('every canExecute binding failure precedes all model SDK observations', async () => {
  for (const mutate of [
    ({ binding }) => { binding.placement_sha256 = 'f'.repeat(63) },
    ({ place }) => { place.revoked_at = 'retired' },
    ({ assignment }) => { assignment.provider = 'other-provider' },
    ({ request }) => { request.model = 'another-model' },
    ({ binding }) => { binding.source_ticket_id = '../wrong-ticket' },
    ({ assignment }) => { assignment.grants = [] },
  ]) {
    let sdkCalls = 0
    const subject = dispatcher(async () => { sdkCalls++ })
    for (const method of ['listProviders', 'listModels', 'resolveModelInfo']) {
      subject.adapter.ctx.llm[method] = async () => { sdkCalls++; throw new Error('not called') }
    }
    assert.equal(await subject.canExecute(patched(mutate)), false)
    assert.equal(sdkCalls, 0)
  }
})

test('valid preflight stores a frozen snapshot; execute revalidates without a second prepareCall', async () => {
  let prepares = 0
  const subject = dispatcher(async ({ provider, model }) => {
    prepares++
    return { config: { provider, model }, inputModalities: ['text'], stream: async () => { throw new Error('No stream in unit test') } }
  })
  subject.adapter.ctx.llm.listModels = async () => [{ id: 'loom-stub-v1', provider: 'loom-stub', inputModalities: ['text'] }]
  subject.adapter.ctx.llm.resolveModelInfo = async () => ({ id: 'loom-stub-v1', provider: 'loom-stub', inputModalities: ['text'] })
  const assignment = fixture()
  const stored = { ...assignment.grant, project_binding_id: 'binding-a' }
  assignment.grant = { ...stored, project_root: '/isolated/fixture/project' }
  assignment.grants = [stored, assignment.grants[1]]
  assignment.resource = { root_scope: '/isolated/fixture/project', project_id: assignment.project_id }
  assert.equal(await subject.canExecute(assignment), true)
  assert.equal(prepares, 1)
  assert.ok(Object.isFrozen(subject.active.get(assignment.id).binding))
  assert.equal('placement_grant' in subject.active.get(assignment.id).binding, false)
  const revoked = patched(({ place }) => { place.revoked_at = 'revoked' })
  revoked.grant_version = revoked.grant.version = 2
  await assert.rejects(() => subject.executeAssignment(revoked), /not explicitly current/)
  assert.equal(prepares, 1)
  assert.equal(subject.active.size, 0)
})

test('descriptor route is separately opt-in and uses only the existing local file dispatcher', async () => {
  const assignment = { id: 'descriptor-task', kind: 'model_descriptor' }
  let sdkCalls = 0
  const subject = dispatcher(async () => { sdkCalls++ })
  for (const method of ['listProviders', 'listModels', 'resolveModelInfo']) {
    subject.adapter.ctx.llm[method] = async () => { sdkCalls++; throw new Error('not called') }
  }
  const calls = []
  const artifact = { artifact_id: 'descriptor-artifact', bytes: Buffer.from('proof'), metadata: { raw_source: true } }
  const local = {
    canExecute: async (value) => { calls.push(['check', value]); return value.grant_valid === true },
    executeAssignment: async (value) => { calls.push(['execute', value]); return { state: 'succeeded', artifact } },
  }
  const enabled = new DshDispatcher(subject.runner, subject.adapter, { ...config, model_text_tasks: false, model_descriptor_tasks: true }, local)
  assert.deepEqual(enabled.capabilities.filter((kind) => kind === 'model_descriptor'), ['model_descriptor'])
  assert.equal(await enabled.canExecute(assignment), false)
  Object.assign(assignment, { grant_valid: true })
  assert.equal(await enabled.canExecute(assignment), true)
  assert.equal((await enabled.executeAssignment(assignment)).artifact, artifact)
  assert.deepEqual(calls.map(([name]) => name), ['check', 'check', 'check', 'execute'])
  assert.equal(sdkCalls, 0)
  const missing = new DshDispatcher(subject.runner, subject.adapter, { model_descriptor_tasks: true })
  assert.equal(missing.capabilities.includes('model_descriptor'), false)
  await assert.rejects(() => missing.executeAssignment(assignment), /explicitly enabled local file dispatcher/)
  const disabled = new DshDispatcher(subject.runner, subject.adapter, {}, local)
  assert.equal(await disabled.canExecute(assignment), false)
  await assert.rejects(() => disabled.executeAssignment(assignment), /explicitly enabled local file dispatcher/)
  const refused = new DshDispatcher(subject.runner, subject.adapter, { model_descriptor_tasks: true }, local)
  const invalid = { ...assignment, grant_valid: false }
  await assert.rejects(() => refused.executeAssignment(invalid), /Grant\/root validation failed/)
  assert.equal(sdkCalls, 0)
})

test('changing a binding after canExecute rejects execution before Agent/SDK work', async () => {
  let prepares = 0
  const subject = dispatcher(async ({ provider, model }) => {
    prepares++
    return { config: { provider, model }, inputModalities: ['text'], stream: async () => {} }
  })
  subject.adapter.ctx.llm.listModels = async () => [{ id: 'loom-stub-v1', provider: 'loom-stub', inputModalities: ['text'] }]
  subject.adapter.ctx.llm.resolveModelInfo = async () => ({ id: 'loom-stub-v1', provider: 'loom-stub', inputModalities: ['text'] })
  const assignment = fixture()
  assert.equal(await subject.canExecute(assignment), true)
  assignment.model_binding = { ...JSON.parse(assignment.content).model_binding, model_id: 'different-model' }
  await assert.rejects(() => subject.executeAssignment(assignment), /Conflicting immutable model bindings|changed after preflight/i)
  assert.equal(prepares, 1)
})
