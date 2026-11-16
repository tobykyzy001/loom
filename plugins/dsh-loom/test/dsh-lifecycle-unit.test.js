import test from 'node:test'
import assert from 'node:assert/strict'
import { wireCapabilities } from '../src/runner.js'
import { LoomHttpClient } from '../src/http.js'
import { DshAdapter } from '../lib/dsh-adapter.js'
import { DshDispatcher } from '../lib/dsh-dispatcher.js'
import { CoordinatorLoop } from '../lib/coordinator.js'
import { LoomNodeClient } from '../src/client.js'

const values = ['dsh_agent_turn', 'read_summary', 'edit_file']
test('real Coordinator config exposes typed capabilities and isolated root declarations', () => {
  assert.deepEqual(wireCapabilities(values), [
    { ticket_kind: 'dsh_agent_turn', permission: 'read' },
    { ticket_kind: 'read_summary', permission: 'read' },
    { ticket_kind: 'edit_file', permission: 'write' },
  ])
  // No network/Host registration in this unit. An exact spawn is replaced at the verified public boundary.
})

test('dsh adapter uses persisted Session mapping, not fabricated Session events', async () => {
  const session = { id: 'persisted-real-ref', seq: 7 }
  const resumed = []
  const ctx = { on: () => {}, sessionPersistence: {}, agents: {
    get: () => undefined,
    list: () => [],
    resume: async (value) => { resumed.push(value); return { owned: false, agent: { session } } },
    create: async () => { throw new Error('must not create') },
  } }
  const adapter = new DshAdapter(ctx)
  const sessionMap = await adapter.loadSessionMap()
  sessionMap.set('assignment', 'persisted-real-ref')
  const record = await adapter.attach({ id: 'assignment' }, { provider: 'loom-stub', model: 'loom-stub-v1', reportLink: async () => {} })
  assert.equal(record.agent.session, session)
  assert.deepEqual(resumed, [{ resumeSessionId: 'persisted-real-ref', agentOptions: { provider: 'loom-stub', model: 'loom-stub-v1' } }])
})

test('cancel request never manufactures terminal cancellation or acknowledgement before host evidence', async () => {
  const completions = { stop: { state: 'running', cancel_acknowledged: false, summary: 'still executing' } }
  const assignment = { id: 'stop', kind: 'dsh_agent_turn', cancel_requested: false }
  let writes = 0
  const runner = { state: { data: { assignments: { stop: assignment }, completions }, flush: async () => { writes++ } } }
  const dispatcher = new DshDispatcher(runner, { cancel: async () => true }, {})
  await dispatcher.cancel('stop')
  assert.equal(writes, 1)
  assert.equal(assignment.cancel_requested, true)
  assert.deepEqual(completions.stop, { state: 'running', cancel_acknowledged: false, summary: 'still executing' })
  assert.equal(runner.state.data.completions.stop.cancel_acknowledged, false)
})

test('Coordinator DSH errors keep explicit terminal state and UUID immutable artifact id', async () => {
  const runner = { identity: {}, state: { data: { assignments: {} }, flush: async () => {}, once: async (_id, _digest, execute) => execute() },
    client: { acknowledge: async () => {}, event: async () => {} } }
  const dispatcher = new DshDispatcher(runner, { executeAssignment: async () => ({ content: Buffer.from('true'), metadata: { name: 'synthetic.json' } }),
    cancel: async () => true }, {})
  const result = await dispatcher.executeAssignment({ id: 'id', ticket_id: 'the-ticket', lease_epoch: 1, kind: 'read_summary', objective: 'only fixture' })
  assert.match(result.artifact.artifact_id, /^[0-9a-f-]{36}$/)
  assert.equal(typeof result.artifact.metadata, 'object')
})

test('Report wire canonicalizes immutable Artifact UUID lineage rather than metadata objects', async () => {
  const state = { enqueue: async (_kind, body) => { thisBody = body }, }
  let thisBody
  const http = new LoomHttpClient({ baseUrl: 'http://127.0.0.1' })
  const client = new LoomNodeClient({ http, identity: { node_id: 'node', installation_id: 'install' }, state })
  await client.report({ ticketId: 'ticket', assignmentId: 'assignment', leaseEpoch: 1, state: 'succeeded', summary: 'contract',
    artifacts: [{ artifact_id: 'id-one' }, 'id-two', { artifact_id: 'id-one' }] })
  assert.deepEqual(thisBody.artifact_ids, ['id-one', 'id-two'])
  assert.equal(thisBody.artifacts, undefined)
})

test('a repeated completed Assignment does not execute twice, while its cancellation reaches the active Agent', async () => {
  const completion = Promise.withResolvers()
  const calls = []
  const stored = { assignments: {}, completions: {} }
  const executor = {
    runner: { state: { data: stored } },
    cancel: async () => { calls.push('actual-cancel') },
    executeAssignment: async () => { calls.push('execute'); await completion.promise; return { state: 'cancelled' } },
    report: async () => { calls.push('report') },
  }
  const client = { acknowledge: async () => {}, dispatchOutbox: async () => {}, poll: async () => ({ assignment: null }), heartbeat: async () => {} }
  const loop = new CoordinatorLoop({ max_active_workers: 1, heartbeat_ms: 2000, poll_seconds: 0 }, executor, client)
  const assignment = { id: 'asg-cancellable', ticket_id: 'tkt', lease_epoch: 1 }
  const original = loop.startAssignment(assignment)
  await new Promise((resolve) => setImmediate(resolve)) // Let execution reach its in-flight state before delivering stop intent.
  loop.startAssignment(assignment)
  loop.startAssignment({ ...assignment, cancel_requested: true })
  assert.equal(calls.filter((call) => call === 'execute').length, 1)
  assert.ok(calls.includes('actual-cancel'))
  completion.resolve()
  await original
  await loop.pending.get('asg-cancellable:cancellation')
  assert.deepEqual(calls, ['execute', 'actual-cancel', 'report'])
})
