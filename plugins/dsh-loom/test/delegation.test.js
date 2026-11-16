import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshAdapter } from '../lib/dsh-adapter.js'
import { DshDispatcher } from '../lib/dsh-dispatcher.js'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function sourceRef() {
  return { type: 'artifact_ref', artifact_id: randomUUID(), ticket_id: 'tkt_parent_fixture',
    origin_node_id: 'a'.repeat(64), sha256: 'b'.repeat(64), location: '', parents: [] }
}
test('default DSH refuses SourceArtifact input without the dedicated validator', async () => {
  const dispatcher = new DshDispatcher({}, {}, {})
  assert.equal(await dispatcher.canExecute({ id: 'a', kind: 'edit_file', artifact_input: {} }), false)
})
test('delegate ToolResult source fields survive normalization and match real file evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loom-child-source-test-'))
  await mkdir(join(root, 'docs'))
  const bytes = Buffer.from('<html><main>fully verified child bytes</main></html>')
  await writeFile(join(root, 'docs/delegated.html'), bytes, { flag: 'wx' })
  const ref = sourceRef(); ref.location = `loom://artifact/${ref.artifact_id}`
  const parentSession = randomUUID(); const childSession = randomUUID()
  const listeners = []; const agent = { session: { id: childSession, seq: 0 } }
  const ctx = { on: (_name, fn) => listeners.push(fn), agents: { get: () => agent } }
  const adapter = new DshAdapter(ctx, { allowBoundedFixtureEffects: true })
  adapter.sessionOwners.set(childSession, 'child')
  adapter.sequence.set('child', { agent, tool_records: [] })
  const event = (seq, type, data) => {
    agent.session.seq = seq
    for (const listener of listeners) listener(agent.session, { type, seq, data })
  }
  event(1, 'tool/call', { callId: 'delegate-call', name: 'loom_fixture_delegate_write', arguments: '{}' })
  event(2, 'tool/result', { message: { toolCallId: 'delegate-call',
    id: 'delegate-result', isError: false, content: [{ type: 'text', text: JSON.stringify({ created: true,
      path: 'docs/delegated.html', title: 'Verified delegated Agent', source: ref,
      source_session_id: parentSession, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length }) }] } })
  const stored = adapter.sequence.get('child').tool_records[0].result
  assert.equal(stored.source.artifact_id, ref.artifact_id)
  assert.equal(stored.source_session_id, parentSession)
  const result = await adapter.boundedFileEffects({ id: 'child', kind: 'edit_file', node_id: 'b'.repeat(64), grant: { project_root: root } },
    { projectRoot: root, provenance: { ref, parent_session: { session_id: parentSession } } }, adapter.sequence.get('child'))
  assert.equal(result.artifacts.length, 1); assert.equal(result.effects.length, 1)
  assert.deepEqual(result.artifacts[0].metadata.parents, [ref.artifact_id])
  assert.equal(result.artifacts[0].metadata.artifact_ref.ticket_id, ref.ticket_id)
  assert.equal(result.artifacts[0].metadata.delegated_from.session.session_id, parentSession)
  assert.equal(result.artifacts[0].metadata.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.ok(UUID.test(parentSession))
})
test('a claimed file effect with incomplete immutable evidence is unknown, not failure or success', async () => {
  const adapter = new DshAdapter({ on: () => {} }, { allowBoundedFixtureEffects: true })
  const session = { id: randomUUID(), seq: 10 }
  const result = await adapter.boundedFileEffects({}, {}, { agent: { session }, tool_records: [{
    call: { name: 'loom_fixture_write', args: { path: 'demo.html', title: 'Loom verifier portal' } },
    result_id: 't-result', call_id: 't-call', is_error: true, possible_effect: true, invalid_error: 'source evidence incomplete',
  }] })
  assert.equal(result.state, 'unknown')
  assert.deepEqual(result.artifacts, [])
  assert.match(result.summary, /outside the authorized operation kind/)
})
