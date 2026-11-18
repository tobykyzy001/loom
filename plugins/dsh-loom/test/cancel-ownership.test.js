import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshAdapter } from '../lib/dsh-adapter.js'

// Public Session/Agent shapes only. Real SDK evidence remains separate from this
// public-event adapter regression; no private transcript methods are used.
const event = (type, seq, data = {}) => ({ type, seq, data })
const abort = kind => ({ kind: 'aborted', reason: { kind } })
const completed = { kind: 'completed' }
function consumer(agent) {
  const listeners = new Set()
  const ctx = { on: (_name, handler) => listeners.add(handler), agents: { get: () => agent, list: () => [agent], resume: async () => { throw new Error('This fixture only creates owned Agents') } } }
  return { ctx, emit: (session, event) => { for (const handler of listeners) handler(session, event) } }
}

test('different wrappers or stale turns cannot overwrite or settle the bound source operation', () => {
  const attached = { id: 'attached-session', seq: 8 }
  const agent = { session: attached, status: 'idle' }
  const { ctx, emit } = consumer(agent)
  const adapter = new DshAdapter(ctx)
  const record = { agent, last_seq: 8, request_seq: 8, code_task: { assignment_id: 'already-attached' }, abort_stage: { phase: 'before-test-subprocess' }, cancel_requested: true }
  adapter.sequence.set('asg-owned', record)
  adapter.sessionOwners.set(attached.id, 'asg-owned')
  let resolves = 0, rejections = 0
  adapter.waiters.set('asg-owned', { resolve: () => { resolves++ }, reject: () => { rejections++ } })
  const foreign = { id: attached.id, seq: 100 }

  emit(foreign, event('turn/end', 100, { reason: abort('user') }))
  assert.equal(resolves + rejections, 0)
  assert.strictEqual(adapter.sequence.get('asg-owned'), record)
  assert.equal(adapter.waiters.has('asg-owned'), true)
  emit(foreign, event('tool/call', 101, { name: 'loom_fixture_code_edit', callId: 'other', arguments: '{}' }))
  assert.equal(record.code_tool_records, undefined, 'Foreign wrappers cannot become Tool evidence')
  assert.strictEqual(adapter.sequence.get('asg-owned'), record)

  emit(attached, event('turn/end', 9, { turn: 7, reason: completed }))
  assert.equal(resolves, 0, 'A different active turn cannot complete this claim')
  emit(attached, event('turn/start', 10, { turn: 7 }))
  emit(attached, event('turn/end', 11, { turn: 6, reason: completed }))
  assert.equal(resolves, 0, 'A previous turn is stale after a later turn started')
  emit(attached, event('turn/end', 12, { turn: 7, reason: completed }))
  assert.equal(resolves, 1)
  emit(attached, event('turn/end', 13, { turn: 7, reason: abort('user') }))
  assert.equal(rejections, 0, 'A consumed terminal may not be cancelled again')
  assert.equal(record.abort_reason, undefined)

  adapter.sequence.delete('asg-owned')
  emit(attached, event('turn/end', 99, { turn: 7, reason: completed }))
  assert.equal(adapter.sequence.has('asg-owned'), false, 'Terminal events cannot manufacture a resumed execution record')
})

test('same Assignment cannot open two execution claims', async () => {
  const gate = Promise.withResolvers()
  const createStarted = Promise.withResolvers()
  const session = { id: 'single-owner', seq: 0 }
  let created = 0, followups = 0
  const agent = { session, status: 'idle', followup: () => { followups++ }, cancel: () => { throw new Error('Idle pre-stop needs no Agent cancel') } }
  const { ctx } = consumer(agent)
  const registry = new Map()
  ctx.agents.get = sessionId => registry.get(sessionId)
  ctx.agents.list = () => [...registry.values()]
  ctx.agents.create = async ({ sessionId }) => { created++; createStarted.resolve(); await gate.promise; agent.session.id = sessionId; registry.set(sessionId, agent); return { agent, owned: true, dispose: async () => {} } }
  ctx.sessionPersistence = {}
  const adapter = new DshAdapter(ctx, { allowCreation: true })
  const assignment = { id: 'single-claim', ticket_id: 'one-ticket', node_id: 'n', kind: 'read_summary', objective: 'single operation' }
  const executing = adapter.executeAssignment(assignment, { reportLink: async () => {} })
  await createStarted.promise
  await assert.rejects(() => adapter.executeAssignment(assignment, { reportLink: async () => {} }), /concurrent execution claims/)
  await adapter.cancel(assignment.id)
  gate.resolve()
  const result = await executing
  assert.equal(created, 1)
  assert.equal(followups, 0, 'Pending cancellation must suppress the first followup')
  assert.equal(adapter.cancellationDeadlines.size, 0, 'Idle pre-start cancellation does not arm a deadline')
  assert.equal(result.state, 'cancelled')
  assert.equal(result.cancel_acknowledged, true)
  assert.equal(result.effects.length, 0)
  assert.equal(result.artifacts.length, 0)
  assert.equal(result.session_ref.session_id, session.id)
  assert.equal(adapter.pendingCancellations.has(assignment.id), false)
  assert.equal(adapter.waiters.has(assignment.id), false)
  const replay = await adapter.executeAssignment(assignment, { reportLink: async () => {} })
  assert.deepEqual(replay, result, 'The same pre-start result is replay-only, not another followup')
  assert.equal(followups, 0)
})

test('pending cancellation cannot steal somebody else’s active running turn', async () => {
  const gate = Promise.withResolvers()
  const creationStarted = Promise.withResolvers()
  const session = { id: 'cancel-during-create', seq: 0 }
  const { ctx } = consumer(undefined)
  const cancels = []
  let followups = 0
  const agent = { session, status: 'running', followup: () => { followups++ }, cancel: cause => { cancels.push(cause) } }
  const registry = new Map()
  ctx.agents.create = async ({ sessionId }) => { creationStarted.resolve(); await gate.promise; agent.session.id = sessionId; registry.set(sessionId, agent); return { agent, owned: true, dispose: async () => {} } }
  ctx.agents.get = sessionId => registry.get(sessionId)
  ctx.agents.list = () => [...registry.values()]
  ctx.sessionPersistence = {}
  const adapter = new DshAdapter(ctx, { allowCreation: true })
  const assignment = { id: 'stop-while-creating', ticket_id: 'ticket-create-stop', node_id: 'n', kind: 'read_summary' }
  const executing = adapter.executeAssignment(assignment, { reportLink: async  () => {} })
  await creationStarted.promise
  await adapter.cancel(assignment.id)
  gate.resolve()
  const result = await executing
  assert.equal(result.state, 'unknown')
  assert.equal(result.cancel_acknowledged, false)
  assert.equal(result.effects.length, 0)
  assert.equal(result.artifacts.length, 0)
  assert.equal(cancels.length, 0, 'A different running turn cannot be cancelled to synthesize our acknowledgement')
  assert.equal(followups, 0)
})

test('an actually issued followup can be cancelled only on its bound Agent and matching turn', async () => {
  const requested = Promise.withResolvers()
  const session = { id: 'owned-started-followup', seq: 0 }
  const { ctx, emit } = consumer(undefined)
  const cancels = []
  const registry = new Map()
  let followups = 0
  const agent = { session, status: 'idle', followup: () => {
    followups++
    agent.status = 'running'
    emit(session, event('turn/start', 1, { turn: 1 }))
    requested.resolve()
  }, cancel: cause => {
    cancels.push(cause)
    agent.status = 'idle'
    emit(session, event('turn/end', 18, { turn: 1, reason: abort('user') }))
  } }
  ctx.agents.create = async () => ({ agent, owned: true, dispose: async () => {} })
  ctx.agents.get = () => registry.get(session.id) || registry.set(session.id, agent).get(session.id)
  ctx.agents.list = () => [...registry.values()]
  registry.set(session.id, agent)
  ctx.sessionPersistence = {}
  const adapter = new DshAdapter(ctx, { allowCreation: true })
  const assignment = { id: 'stop-after-followup', ticket_id: 'ticket-after-followup', node_id: 'n', kind: 'read_summary' }
  const executing = adapter.executeAssignment(assignment, { reportLink: async () => {} })
  await requested.promise
  let replacementCancels = 0
  const replacement = { session: { id: session.id, seq: 99 }, status: 'running', cancel: () => { replacementCancels++ } }
  ctx.agents.get = () => replacement
  await adapter.cancel(assignment.id)
  assert.equal(replacementCancels, 0, 'A same-ID replacement cannot be cancelled in place of the bound Agent')
  await assert.rejects(executing, error => error.state === 'cancelled'
    && error.cancel_acknowledged === true && error.reason.reason.kind === 'user')
  assert.deepEqual(cancels, [{ kind: 'user' }])
  assert.equal(followups, 1)
})

test('aborted user event from a different turn cannot steal the operation acknowledgement', async () => {
  const requested = Promise.withResolvers()
  const session = { id: 'wrong-user-turn', seq: 0 }
  const { ctx, emit } = consumer(undefined)
  const agent = { session, status: 'idle', followup: () => {
    agent.status = 'running'
    emit(session, event('turn/start', 1, { turn: 1 }))
    requested.resolve()
  }, cancel: () => { emit(session, event('turn/end', 18, { turn: 2, reason: abort('user') })) } }
  ctx.agents.create = async () => ({ agent, owned: true, dispose: async () => {} })
  ctx.sessionPersistence = {}
  const adapter = new DshAdapter(ctx, { allowCreation: true })
  const assignment = { id: 'counterfeit-other-turn', ticket_id: 'ticket-counterfeit', node_id: 'n', kind: 'read_summary' }
  const executing = adapter.executeAssignment(assignment, { reportLink: async () => {} })
  await requested.promise
  await adapter.cancel(assignment.id)
  assert.equal(adapter.sequence.get(assignment.id).abort_reason, undefined)
  assert.equal(adapter.waiters.has(assignment.id), true)
  emit(session, event('turn/end', 19, { turn: 1, reason: abort('user') }))
  await assert.rejects(executing, error => error.state === 'cancelled'
    && error.cancel_acknowledged === true && error.reason.reason.kind === 'user')
})

test('absence of an actual SDK terminal is unknown and unacknowledged, not cancellation by release', async () => {
  const originalTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => originalTimeout(fn, 0)
  try {
    const requested = Promise.withResolvers()
    const session = { id: 'no-native-terminal', seq: 0 }
    const { ctx, emit } = consumer(undefined)
    let followups = 0
    const agent = { session, status: 'idle', followup: () => { followups++; agent.status = 'running'; requested.resolve() }, cancel: () => {} }
    ctx.agents.create = async () => ({ agent, owned: true, dispose: async () => {} })
    ctx.sessionPersistence = {}
    const adapter = new DshAdapter(ctx, { allowCreation: true })
    const assignment = { id: 'cancel-without-terminal', ticket_id: 'ticket-without-terminal', node_id: 'n', kind: 'read_summary' }
    const executing = adapter.executeAssignment(assignment, { reportLink: async () => {} })
    await requested.promise
    // The operation has really started; cancel supplies no terminal of its own.
    await adapter.cancel(assignment.id)
    // The wait is bounded by the test timer, not any fabricated terminal acknowledgement.
    await assert.rejects(executing, error => error.state === 'unknown' && error.cancel_acknowledged === false)
    assert.equal(adapter.waiters.has(assignment.id), false)
    // A delayed SDK abort may arrive for history only; it cannot rename expiry.
    emit(session, event('turn/end', 18, { turn: 1, reason: abort('user') }))
    assert.equal(adapter.sequence.get(assignment.id).abort_reason, undefined)
    assert.equal(adapter.sequence.get(assignment.id).abort_seq, undefined)
    assert.equal(adapter.expiredClaims.has(assignment.id), true)
    assert.equal(adapter.cancellationDeadlines.has(assignment.id), false)
    const replay = await adapter.executeAssignment(assignment, { reportLink: async () => {} })
    assert.equal(replay.state, 'unknown')
    assert.equal(replay.cancel_acknowledged, false)
    assert.equal(followups, 1, 'Expired cancellation is replay-only, not a second execution')
  } finally { globalThis.setTimeout = originalTimeout }
})
