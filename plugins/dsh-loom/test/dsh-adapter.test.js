import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshAdapter } from '../lib/dsh-adapter.js'
import { CoordinatorLoop } from '../lib/coordinator.js'

function host() {
  const listeners = new Set(); const cancelled = []; const disposed = []
  const session = { id: 'session-host-fixture', seq: 0 }
  const agent = { status: 'idle', session, cancel: (cause) => { cancelled.push(cause); agent.status = 'idle' },
    followup: (message) => {
      assert.equal(message.source.kind, 'loom')
      session.seq++
      for (const listener of listeners) listener(session, { type: 'assistant/message', seq: session.seq, data: { content: [{ type: 'text', text: 'Synthetic DSH channel output; no model called.' }] } })
      session.seq++
      for (const listener of listeners) listener(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'completed' } } })
    } }
  const ctx = { on: (name, fn) => { assert.equal(name, 'session/event'); listeners.add(fn); return () => listeners.delete(fn) },
    agents: { get: () => agent, list: () => [agent], create: async () => { throw Error('creation disabled') }, resume: async () => ({ agent, dispose: async () => disposed.push(true) }) } }
  return { ctx, agent, session, cancelled, disposed, listeners, emit: (event) => { session.seq++; for (const listener of listeners) listener(session, event) } }
}

test('verified public DSH adapter captures ordinary Session events with SessionRef', async () => {
  const h = host(); const adapter = new DshAdapter(h.ctx, { agentSessionId: 'session-host-fixture', snapshotDir: await mkdtemp(join(tmpdir(), 'loom-dsh-adapter-')) })
  const links = []; const assignment = { id: randomUUID(), ticket_id: randomUUID(), node_id: 'node', kind: 'read_summary' }
  const result = await adapter.executeAssignment(assignment, { reportLink: async (ref) => links.push(ref) })
  assert.equal(result.state, 'succeeded'); assert.equal(links[0].session_id, 'session-host-fixture')
  assert.match(JSON.parse(result.content).text, /no model called/)
  assert.equal(result.metadata.sha256.length, 64)
  await adapter.dispose(); assert.equal(h.disposed.length, 0, 'never disposes caller-owned existing Agent')
})

test('failed DSH turn rejects outcome and cancel does not invent success', async () => {
  const h = host(); h.agent.followup = () => {
    h.session.seq++
    h.emit({ type: 'turn/end', data: { reason: { kind: 'failed', error: { message: 'synthetic failure' } } } })
  }
  const adapter = new DshAdapter(h.ctx, { agentSessionId: 'session-host-fixture' })
  await assert.rejects(() => adapter.executeAssignment({ id: randomUUID(), kind: 'read_summary' }, { reportLink: async () => {} }), /creation disabled|without normal completion/)
  await adapter.dispose()
})

test('unsupported cfg has no scheduled worker or fake DSH response from coordinator', async () => {
  let tasks = 0
  const loop = new CoordinatorLoop({ max_active_workers: 1, poll_seconds: 1, heartbeat_ms: 2000 }, {
    canExecute: async () => false,
    executeAssignment: async () => { tasks++ },
  }, {
    acknowledge: async (body) => { assert.equal(body.accepted, false) },
  })
  await loop.handle({ id: randomUUID(), ticket_id: randomUUID(), lease_epoch: 1 })
  assert.equal(tasks, 0)
  await loop.dispose()
  assert.equal(loop.disposed, true)
})
