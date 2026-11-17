import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeIdentity, NodeState, LoomNodeClient, LoomHttpClient } from '../src/index.js'

const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const root = () => mkdtemp(join(tmpdir(), 'loom-http-boundary-'))

test('node credentials never silently fall back to the client token; anonymous allowlist is narrow', async () => {
  const directory = await root()
  const identity = await NodeIdentity.open(directory)
  const state = await NodeState.open(directory)
  const calls = []
  const http = new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535', clientToken: 'synthetic-admin',
    fetch: async (url, options) => { calls.push({ path: String(new URL(url).pathname), options }); return json({ accepted: true }) } })
  const client = new LoomNodeClient({ http, identity, state })
  for (const token of ['', ' \t']) {
    identity.data.token = token
    await assert.rejects(() => client.heartbeat({ capabilities: [] }), /nonblank|credential/)
    await assert.rejects(() => client.poll({ waitSeconds: 0 }), /nonblank|credential/)
  }
  assert.equal(calls.length, 0, 'A missing/whitespace transport token must fail before any HTTP request')
  await assert.rejects(() => http.post('/api/v1/nodes/reports', {}, { noAuth: true }), /Anonymous node access/)
  await assert.rejects(() => http.post('/api/v1/nodes/reports', {}, { token: http.clientToken }), /Client credential/)
  assert.equal(calls.length, 0)
  await http.post('/api/v1/nodes/challenge', identity.public, { noAuth: true })
  assert.equal(calls.at(-1).options.headers.authorization, undefined, 'Public challenge may be anonymous, not ordinary node routes')
  await identity.setToken({ token: 'fixture-old-node-token' })

  const registrationFetch = async (_url, options) => {
    if (String(_url).endsWith('/challenge')) return json({ nonce: 'f'.repeat(64) })
    calls.push({ path: String(new URL(_url).pathname), options })
    return json({ node_id: identity.public.node_id, token: 'fresh-node-token-from-enrollment', accepted: true })
  }
  const registrationClient = new LoomHttpClient({ baseUrl: 'http://example.invalid', fetch: registrationFetch })
  const oldNode = new NodeIdentity(identity.file, identity.data)
  const clientWithOldKey = new LoomNodeClient({ http: registrationClient, identity: oldNode, state })
  await clientWithOldKey.enroll({ enrollmentCode: 'one-use-fixture-code', capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }] })
  assert.equal(identity.token, 'fresh-node-token-from-enrollment')
  await identity.setToken({ token: 'fixture-old-node-token' })
  await clientWithOldKey.heartbeat({ capabilities: [] })
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer fixture-old-node-token')
  await http.post('/api/v1/projects', { name: 'An admin route retains its independent principal' })
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer synthetic-admin')
  await assert.rejects(() => identity.setToken({ token: '  ' }), /no node token/)
  assert.equal(identity.token, 'fixture-old-node-token', 'An invalid new registration must preserve the live valid credential, not blank it first')
  await client.heartbeat({ capabilities: [] })
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer fixture-old-node-token', 'The original live Node token still works after failed enrollment')
  const stored = JSON.parse(await readFile(identity.file, 'utf8'))
  assert.equal(stored.token, 'fixture-old-node-token', 'Invalid enrollment responses are never used as a fallback credential')
})

test('outbox shutdown keeps pending records and attempt/backoff state, and does not process the next entry', async () => {
  const directory = await root()
  const identity = await NodeIdentity.open(directory)
  const state = await NodeState.open(directory)
  await identity.setToken({ token: 'fixture-node-only' })
  let calls = 0
  const client = new LoomNodeClient({ http: new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535',
    fetch: async () => { calls++; throw new Error('ordinary transport unavailable') } }), identity, state })
  await client.event({ ticketId: 'tkt-transport-1', assignmentId: 'asg-transport-1', leaseEpoch: 1, summary: 'First bounded fixture event' })
  await client.event({ ticketId: 'tkt-transport-2', assignmentId: 'asg-transport-2', leaseEpoch: 1, summary: 'Second bounded fixture event' })
  const results = await client.dispatchOutbox()
  assert.deepEqual(results.map(result => result.status), ['deferred', 'deferred'])
  assert.equal(state.outbox.length, 2)
  await state.mutate(data => { for (const item of data.outbox) item.next_attempt_at = new Date(0).toISOString() })
  const before = state.outbox.map(item => ({ attempts: item.attempts, next_attempt_at: item.next_attempt_at, last_error: item.last_error }))
  const requestIds = state.outbox.map(item => item.body.request_id)
  const beforeCalls = calls
  const controller = new AbortController()
  const dispatched = client.dispatchOutbox({ signal: controller.signal })
  controller.abort(new Error('Fixture host shutdown requested'))
  await assert.rejects(dispatched, /host shutdown/)
  assert.equal(calls, beforeCalls + 1, 'Only the already-started outbound attempt can complete; no next entry may begin')
  assert.deepEqual(state.outbox.map(item => ({ attempts: item.attempts, next_attempt_at: item.next_attempt_at, last_error: item.last_error })), before,
    'Caller cancellation must not become an ordinary retry error or advance backoff/attempts')
  assert.deepEqual(state.outbox.map(item => item.body.request_id), requestIds)
  const reopened = await NodeState.open(directory)
  assert.equal(reopened.data.deliveries, undefined, 'Cancellation did not create a delivery acknowledgement')
})

test('configured timeout remains an ordinary deferred delivery, not a false cancellation acknowledgement', async () => {
  const directory = await root()
  const identity = await NodeIdentity.open(directory)
  const state = await NodeState.open(directory)
  await identity.setToken({ token: 'fixture-node-token' })
  const http = new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535', timeoutMs: 25,
    fetch: async(_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }) })
  const client = new LoomNodeClient({ http, identity, state })
  await client.event({ ticketId: 'tkt-timeout-boundary', assignmentId: 'asg-timeout-boundary', leaseEpoch: 1, summary: 'Bounded transport timeout fixture' })
  const results = await client.dispatchOutbox()
  assert.equal(results[0].status, 'deferred')
  assert.match(results[0].error, /timed out/)
  assert.equal(state.outbox[0].attempts, 1)
  assert.ok(Date.parse(state.outbox[0].next_attempt_at) > Date.now())
  assert.equal(state.data.deliveries, undefined)
})

test('ordinary network failure can retry after due without changing the exact request ID or losing unknown evidence', async () => {
  const directory = await root()
  const identity = await NodeIdentity.open(directory)
  const state = await NodeState.open(directory)
  await identity.setToken({ token: 'fixture-node-token' })
  let online = false
  const ids = []
  const http = new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535',
    fetch: async (_url, options) => {
      if (!online) throw new Error('offline')
      ids.push(JSON.parse(options.body).request_id)
      return json({ accepted: true })
    } })
  const client = new LoomNodeClient({ http, identity, state })
  const queued = await client.report({ ticketId: 'tkt-timeout', assignmentId: 'asg-timeout', leaseEpoch: 1, state: 'unknown', summary: 'Information not yet known' })
  const first = await client.dispatchOutbox()
  assert.equal(first[0].status, 'deferred')
  assert.equal(state.outbox.length, 1)
  assert.equal(state.outbox[0].attempts, 1)
  await state.mutate(data => { data.outbox[0].next_attempt_at = new Date(0).toISOString() })
  const restored = await NodeState.open(directory)
  const restoredClient = new LoomNodeClient({ http, identity, state: restored })
  online = true
  const retried = await restoredClient.dispatchOutbox()
  assert.equal(retried[0].status, 'replay_delivered')
  assert.deepEqual(ids, [queued.body.request_id])
  assert.equal(restored.outbox.length, 0)
  assert.deepEqual(restored.data.deliveries[0].body, queued.body, 'The exact original unknown evidence must be replayed')
})
