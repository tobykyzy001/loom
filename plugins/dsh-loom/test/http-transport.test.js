import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LoomHttpClient, LoomNodeClient, NodeIdentity, NodeState } from '../src/index.js'

const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

test('vendored Node transport fails closed before an admin credential can be substituted', async () => {
  let calls = 0
  const http = new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535', clientToken: 'fixture-admin-token',
    fetch: async () => { calls++; return json({ ok: true }) } })
  for (const token of ['', ' \t']) {
    await assert.rejects(() => http.post('/api/v1/nodes/heartbeat', {}, { token }), /nonblank|credential/)
  }
  await assert.rejects(() => http.post('/api/v1/nodes/reports', {}, { noAuth: true }), /Anonymous node access/)
  await assert.rejects(() => http.post('/api/v1/nodes/reports', {}, { token: http.clientToken }), /Client credential/)
  assert.equal(calls, 0)
  const anonymous = await http.post('/api/v1/nodes/challenge', { protocol: 'loom.node.v1' }, { noAuth: true })
  assert.deepEqual(anonymous, { ok: true })
  assert.equal(calls, 1)
})

test('vendored outbox preserves pending requests during caller shutdown and allows later ordinary delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-plugin-transport-'))
  const identity = await NodeIdentity.open(dir)
  const state = await NodeState.open(dir)
  await identity.setToken({ token: 'fixture-node-only' })
  await assert.rejects(() => identity.setToken({ token: '  ' }), /no node token/)
  assert.equal(identity.token, 'fixture-node-only', 'An invalid registration cannot blank the live Node credential')
  assert.equal(JSON.parse(await readFile(identity.file, 'utf8')).token, 'fixture-node-only')
  const previousAuthorization = await new LoomNodeClient({ identity, state, http: new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535', fetch: async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-node-only')
    return json({ accepted: true })
  } }) }).heartbeat({ capabilities: [] })
  assert.ok(previousAuthorization.accepted)
  let calls = 0
  const client = new LoomNodeClient({ identity, state, http: new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535',
    fetch: async () => { calls++; throw new Error('offline') } }) })
  await client.event({ ticketId: 'tkt-plugin-shutdown', assignmentId: 'asg-plugin-shutdown', leaseEpoch: 1, summary: 'Preserve outbox during own caller shutdown' })
  await client.event({ ticketId: 'tkt-plugin-second', assignmentId: 'asg-plugin-second', leaseEpoch: 1, summary: 'Do not drain later entries on cancellation' })
  await state.mutate(data => { for (const item of data.outbox) item.next_attempt_at = new Date(0).toISOString() })
  const before = state.outbox.map(item => ({ attempts: item.attempts, next_attempt_at: item.next_attempt_at, last_error: item.last_error, body: item.body }))
  const controller = new AbortController()
  const timeout = client.dispatchOutbox({ signal: controller.signal })
  controller.abort(new Error('Fixture shutdown event'))
  await assert.rejects(timeout, /shutdown/)
  assert.deepEqual(state.outbox.map(item => ({ attempts: item.attempts, next_attempt_at: item.next_attempt_at, last_error: item.last_error, body: item.body })), before)
  assert.equal(calls, 1, 'Only the currently active attempt can settle; next event was not started')
  assert.equal(state.data.deliveries, undefined)
  const reopened = await NodeState.open(dir)
  assert.deepEqual(reopened.outbox.map(item => item.body.request_id), before.map(item => item.body.request_id))
  const deliver = new LoomNodeClient({ identity, state: reopened, http: new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535',
    fetch: async () => json({ accepted: true }) }) })
  const results = await deliver.dispatchOutbox()
  assert.deepEqual(results.map(result => result.status), ['delivered', 'delivered'])
  assert.equal(reopened.outbox.length, 0)
  assert.deepEqual(reopened.data.deliveries.map(item => item.body.request_id), before.map(item => item.body.request_id))
})
