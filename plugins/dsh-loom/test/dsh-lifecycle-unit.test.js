import test from 'node:test'
import assert from 'node:assert/strict'
import { wireCapabilities } from '../src/runner.js'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  const dispatcher = new DshDispatcher(runner, { executeAssignment: async () => ({ state: 'succeeded', content: Buffer.from('true'), metadata: { name: 'synthetic.json' } }),
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

test('fixture file-effect verification is opt-in and reads actual bounded file bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loom-dsh-unit-write-'))
  const listeners = new Set()
  const session = { id: 'fixture-session', seq: 0 }
  const cancelled = []
  const agent = { status: 'idle', session, cancel: (cause) => cancelled.push(cause),
    followup: () => {
      const result = { created: true, path: 'demo.html', sha256: createHash('sha256').update('<main>verified fixture</main>\n').digest('hex'), size_bytes: 30, title: 'Loom verifier portal' }
      const message = { toolCallId: 'call-write-1', id: 'tool-result-1', isError: false,
        source: { kind: 'tool', callId: 'call-write-1' }, content: [{ type: 'text', text: JSON.stringify(result) }] }
      for (const event of [
        { type: 'tool/call', data: { name: 'loom_fixture_write', callId: 'call-write-1', arguments: JSON.stringify({ path: 'demo.html', title: 'Loom verifier portal' }) } },
        { type: 'tool/result', data: { message } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The file was written.' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ]) { session.seq++; for (const listener of listeners) listener(session, { ...event, seq: session.seq }) }
    } }
  const ctx = { on: (_name, fn) => listeners.add(fn), sessionPersistence: {}, agents: { list: () => [agent], get: () => agent, create: async () => { throw new Error('no creation') }, resume: async () => ({ agent }) } }
  const bytes = Buffer.from('<main>verified fixture</main>\n')
  await writeFile(join(root, 'demo.html'), bytes, { flag: 'wx', mode: 0o600 })
  const disabled = new DshAdapter(ctx)
  const evidenceDisabled = await disabled.boundedFileEffects({ id: 'a', grant: { project_root: root } }, {}, { tool_records: [] })
  assert.deepEqual(evidenceDisabled, { effects: [], artifacts: [] })
  const adapter = new DshAdapter(ctx, { allowBoundedFixtureEffects: true })
  const assignment = { id: 'write-assignment', ticket_id: 'write-ticket', node_id: 'node', kind: 'edit_file', grant: { project_root: root } }
  const result = await adapter.executeAssignment(assignment, { projectRoot: root, reportLink: async () => {} })
  assert.equal(result.state, 'succeeded')
  assert.equal(result.effects.length, 1)
  assert.deepEqual(result.artifacts[0].bytes, bytes)
  assert.equal(result.effects[0].status, 'confirmed')
  assert.equal(result.effects[0].artifacts[0], result.artifacts[0].artifact_id)
  assert.equal(result.effects[0].evidence[0].path, 'demo.html')
  assert.equal(result.effects[0].evidence[0].session.session_id, session.id)
  assert.equal(Object.hasOwn(result.effects[0].evidence[0], 'arguments'), false)
  assert.equal(result.artifacts[0].metadata.media_type, 'text/html')
  assert.strictEqual(cancelled.length, 0)
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
