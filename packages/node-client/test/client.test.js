import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { sha256, canonical } from '../src/util.js'
import { LocalNodeRunner } from '../src/runner.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verify, createPublicKey, randomUUID } from 'node:crypto'
import { CAPABILITIES } from '../src/validation.js'
import { cancellationFence, sameAuthorizedAssignment } from '../src/admission.js'
import { NodeIdentity, NodeState, LoomNodeClient, LoomHttpClient, LoomHttpError, validateAssignment, ControlledFileExecutor, safeRelative, safeProjectRoot, requireIsolatedRoot } from '../src/index.js'

async function fixture() { return mkdtemp(join(tmpdir(), 'loom-node-unit-')) }
function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }
function assignment(root, identity, grant = {}) {
  const g = { id: randomUUID(), project_id: '1234', project_root: root, version: 1, operations: ['read_summary', 'edit_file'], digest: 'opaque-grant-digest', ...grant }
  return { a: { id: randomUUID(), ticket_id: randomUUID(), node_id: identity.node_id, lease_id: randomUUID(), lease_epoch: 1,
    grant_version: 1, grant_digest: g.digest, attempt: 1, kind: 'read_summary', project_id: g.project_id, relative_path: 'input.txt', lease_expires_at: new Date(Date.now() + 60000).toISOString() }, g }
}

test('identity creates persistent Ed25519 keypair, node ID and proof', async () => {
  const root = await fixture(); const one = await NodeIdentity.open(root); const second = await NodeIdentity.open(root)
  assert.equal(one.nodeId, one.public.node_id)
  assert.equal(second.public.node_id, one.public.node_id)
  assert.equal(one.private_key_pkcs8, undefined)
  assert.equal(JSON.stringify(one).includes('token'), false)
  assert.match(one.public.node_id, /^[a-f0-9]{64}$/)
  assert.equal(Buffer.from(one.public.public_key, 'base64url').length, 32)
  const sig = Buffer.from(one.sign('a'.repeat(64)), 'base64url')
  assert.equal(sig.length, 64)
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(one.public.public_key, 'base64url')]), format: 'der', type: 'spki' })
  assert.equal(verify(null, Buffer.from('a'.repeat(64)), key, sig), true)
  assert.equal((await readFile(join(root, 'identity.json'), 'utf8')).includes(one.data.private_key_pkcs8), true)
})

test('challenge/register uses only public challenge then node token, not client token', async () => {
  const root = await fixture(); const identity = await NodeIdentity.open(root); const state = await NodeState.open(root)
  const calls = []; const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : {}; calls.push({ url: String(url), body, headers: options.headers })
    if (String(url).endsWith('/challenge')) return response({ challenge_id: randomUUID(), nonce: 'f'.repeat(64), expires_at: new Date().toISOString() })
    if (String(url).endsWith('/register')) return response({ token: 'node-auth', node_id: identity.public.node_id })
    return response({ ok: true })
  }
  const http = new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535', clientToken: 'different-client-credential', fetch })
  const loom = new LoomNodeClient({ http, identity, state })
  await loom.enroll({ enrollmentCode: 'one-use-code', capabilities: ['read_summary'] })
  await loom.heartbeat({ capabilities: ['read_summary'] })
  assert.equal(calls[0].headers.authorization, undefined)
  assert.equal(calls[1].headers.authorization, undefined)
  assert.equal(calls[1].body.enrollment_code, 'one-use-code')
  assert.equal(calls[2].headers.authorization, 'Bearer node-auth')
  await assert.rejects(() => http.post('/api/v1/nodes/heartbeat', {}, { token: 'different-client-credential' }), /Client credential/)
})

test('PATCH follows the same bounded client route/auth policy without manufacturing work', async () => {
  let request
  const fetch = async (url, options) => { request = { url: String(url), method: options.method, headers: options.headers, body: options.body }; return response({ status: 'pending' }) }
  const http = new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535', clientToken: 'fixture-admin-client', fetch })
  const body = await http.patch('/api/v1/candidates/candidate_fix', { decision: 'later' })
  assert.equal(body.status, 'pending')
  assert.equal(request.method, 'PATCH')
  assert.equal(request.headers.authorization, 'Bearer fixture-admin-client')
  assert.deepEqual(JSON.parse(request.body), { decision: 'later' })
  await assert.rejects(() => http.patch('/api/v1/nodes/credential-authorize', {}, { token: http.clientToken }), /Client credential/)
})

test('already-aborted HTTP never calls fetch, even when the adapter ignores cancellation', async () => {
  let calls = 0
  const http = new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535', clientToken: 'admin-is-not-a-node-token', fetch: async() => { calls++; return response({ assignment: null }) } })
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(() => http.post('/api/v1/nodes/challenge', {}, { noAuth: true, signal: aborted.signal }), error => error.name === 'AbortError')
  assert.equal(calls, 0, 'Pre-cancelled request must not touch the transport, emit a credential or read a body')
})

test('HTTP timeout and cancellation do not accept an assignment as if nothing was happening', async () => {
  const root = await fixture(); const identity = await NodeIdentity.open(root); await identity.setToken({ token: 'fixture-node-token' }); const state = await NodeState.open(root)
  let timedPath
  const timeoutFetch = async (url, options) => new Promise((resolve, reject) => {
    timedPath = String(url)
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
  const timeoutHttp = new LoomHttpClient({ baseUrl: 'http://127.0.0.1:65535', fetch: timeoutFetch })
  await assert.rejects(() => timeoutHttp.post('/api/v1/nodes/heartbeat', { request_id: 'fixture-time-limit' }, { token: identity.token, timeoutMs: 25 }), /timed out/)
  assert.match(timedPath, /nodes\/heartbeat$/)

  const cancel = new AbortController()
  const lateFetch = async (_url, options) => {
    cancel.abort(new Error('Fixture cancelled before the response is consumed'))
    return new Response(JSON.stringify({ assignment: null, ignored_token_probe: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const lateState = await NodeState.open(root)
  const late = new LoomNodeClient({ http: new LoomHttpClient({ baseUrl: 'http://example.invalid', fetch: lateFetch }), identity, state: lateState })
  await assert.rejects(() => late.poll({ waitSeconds: 1, signal: cancel.signal }), /cancel/)
  assert.deepEqual(lateState.data.assignments, {}, 'A cancel raced response must not become a new task or a false idle result')
  assert.deepEqual(lateState.outbox, [], 'Cancellation is not a successful delivery acknowledgement')
})

test('abort during a non-null Assignment response body cannot admit that assignment to the active poll', async () => {
  const directory = await fixture(); const identity = await NodeIdentity.open(directory); const state = await NodeState.open(directory)
  const controller = new AbortController()
  let bodyReads = 0
  const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async() => {
    bodyReads++
    controller.abort(new Error('Cancelled while reading the late response body'))
    return new TextEncoder().encode(JSON.stringify({ assignment: { id: 'asg-must-not-start', ticket_id: 'tkt-must-not-start', lease_epoch: 1 } })).buffer
  } })
  await identity.setToken({ token: 'fixture-node-token' })
  const client = new LoomNodeClient({ http: new LoomHttpClient({ baseUrl: 'http://example.invalid', fetch }), identity, state })
  await assert.rejects(() => client.poll({ waitSeconds: 1, signal: controller.signal }), /Cancelled while reading/)
  assert.equal(bodyReads, 1, 'Must exercise the body-consumption stage, not only an already-cancelled input')
  assert.deepEqual(state.data.assignments, {})
  assert.deepEqual(state.outbox, [])
})

test('outbox dedupes same body, persists exact request ID and requeues after network failure', async () => {
  const root = await fixture(); const identity = await NodeIdentity.open(root); await identity.setToken({ token: 'node-token' }); const state = await NodeState.open(root)
  let online = false; let requests = []
  const fetch = async (url, options) => { requests.push(JSON.parse(options.body)); if (!online) throw Error('offline'); return response({ accepted: true }) }
  const client = new LoomNodeClient({ http: new LoomHttpClient({ baseUrl: 'http://example.invalid', fetch }), identity, state })
  const report = { ticketId: randomUUID(), assignmentId: randomUUID(), leaseEpoch: 2, state: 'unknown', summary: 'unresolved external effect' }
  const original = await client.report(report); const duplicate = await client.report(report)
  assert.equal(original.digest, duplicate.digest)
  assert.equal(state.outbox.length, 1)
  await client.dispatchOutbox()
  assert.equal(state.outbox.length, 1)
  const loaded = await NodeState.open(root); assert.equal(loaded.outbox[0].body.request_id, original.body.request_id)
  const restored = new LoomNodeClient({ http: new LoomHttpClient({ baseUrl: 'http://example.invalid', fetch }), identity, state: loaded })
  online = true
  await loaded.mutate((data) => { data.outbox[0].next_attempt_at = new Date(0).toISOString() })
  await restored.dispatchOutbox()
  assert.equal(loaded.outbox.length, 0)
  assert.equal(requests.at(-1).requested_state, 'unknown')
  assert.equal(loaded.data.deliveries[0].body.request_id, original.body.request_id)
  assert.equal(loaded.outbox.length, 0)
  const duplicateDelivery = await loaded.enqueue('report', loaded.data.deliveries[0].body)
  assert.equal(duplicateDelivery.body.request_id, original.body.request_id, 'Logical callback replay must retain request ID')
  assert.equal(loaded.outbox.length, 1)
  await restored.dispatchOutbox()
  assert.equal(loaded.outbox.length, 0)
  await assert.rejects(() => restored.report({ ...report, state: 'succeeded', artifacts: [{ name: 'id missing' }] }), /non-empty string IDs/)
  assert.equal(requests[0].request_id, requests[1].request_id)
})

async function ackFixture({ fetch = async () => response({ accepted: true, acknowledged_at: '2026-11-19T00:00:00.000Z' }) } = {}) {
  const root = await fixture()
  const identity = await NodeIdentity.open(root)
  await identity.setToken({ token: 'fixture-ack-node-token' })
  const state = await NodeState.open(root)
  const http = new LoomHttpClient({ baseUrl: 'http://example.invalid', fetch })
  return { root, identity, state, client: new LoomNodeClient({ http, identity, state }) }
}

test('ACK persists a nonce-independent logical body before immediate authenticated delivery', async () => {
  const calls = []
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const context = await ackFixture({ fetch: async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url: String(url), headers: options.headers, body })
    await blocked
    return response({ accepted: true, acknowledged_at: '2026-11-19T00:00:00.000Z', request_id: body.request_id })
  } })
  const { client, state } = context
  const args = { ticketId: 'tkt-ack-persist', assignmentId: 'asg-ack-persist', leaseEpoch: 1, accepted: false }
  const call = client.acknowledge(args)
  for (let rounds = 0; rounds < 10 && state.outbox.length === 0; rounds++) await new Promise(resolve => setImmediate(resolve))
  await state.queue
  assert.equal(state.outbox.length, 1)
  assert.equal(state.outbox[0].kind, 'ack')
  assert.deepEqual(Object.keys(state.outbox[0].body).sort(), ['accepted', 'assignment_id', 'cancel_requested', 'cancellation', 'installation_id', 'lease_epoch', 'node_id', 'protocol', 'reason', 'request_id', 'ticket_id'].sort())
  assert.equal(state.outbox[0].body.accepted, false)
  assert.equal(state.outbox[0].body.reason, '')
  assert.equal(state.outbox[0].digest, sha256(canonical({ logical_fields: (({ request_id, ...fields }) => fields)(state.outbox[0].body) })))
  const originalId = state.outbox[0].body.request_id
  const stored = await NodeState.open(context.root)
  assert.equal(stored.outbox[0].body.request_id, originalId)
  release()
  const receipt = await call
  assert.equal(receipt.response.accepted, true)
  assert.equal(client.state.data.deliveries[0].response.acknowledged_at, '2026-11-19T00:00:00.000Z')
  assert.equal(state.outbox.length, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://example.invalid/api/v1/nodes/acknowledge')
  assert.equal(calls[0].headers.authorization, 'Bearer fixture-ack-node-token')
  const duplicate = await client.acknowledge(args)
  assert.equal(duplicate.request.request_id, originalId)
  assert.equal(duplicate.response.acknowledged_at, '2026-11-19T00:00:00.000Z')
  assert.equal(duplicate.response.duplicate, true)
  assert.equal(client.state.data.deliveries[0].response.duplicate, undefined, 'Do not invent a local duplicate receipt field in durable evidence')
  assert.equal(calls[0].body.request_id, duplicate.request.request_id)
  const other = await client.acknowledge({ ...args, leaseEpoch: 2 })
  assert.notEqual(other.request.request_id, originalId)
  assert.notEqual(other.request.assignment_id, undefined)
})


test('ACK deliveries do not conceal corrupt cache evidence and missing identity is reconciled', async () => {
  let calls = 0
  const { root, client, state, identity } = await ackFixture({ fetch: async (_url, options) => {
    calls++
    return response({ accepted: true, acknowledged_at: '2026-11-19T00:00:01.000Z' })
  } })
  const args = { ticketId: 'tkt-cache', assignmentId: 'asg-cache', leaseEpoch: 3, accepted: true, reason: '', cancelRequested: false }
  await client.acknowledge(args)
  assert.equal(calls, 1)
  const duplicate = await client.acknowledge(args)
  assert.equal(duplicate.response.duplicate, true)
  assert.equal(calls, 1)
  await state.mutate(data => { delete data.deliveries[0].body.request_id })
  const repairedState = await NodeState.open(root)
  assert.equal(repairedState.data.deliveries[0].body.request_id, undefined, 'The corrupted identity must actually be persisted for this guard check')
  const repairedClient = new LoomNodeClient({ http: client.http, identity, state: repairedState })
  const repaired = await repairedClient.acknowledge(args)
  assert.equal(calls, 2, 'A changed stored request ID must not claim cached acceptance')
  assert.ok(repaired.request.request_id, 'A valid incoming request ID replaces the missing cached identity instead of being cloned from it')
  assert.equal(repairedClient.state.outbox.length, 0)
})

test('a forged non-date cached ACK timestamp is reconciled over real HTTP, not returned as receipt', async () => {
  let calls = 0
  const { root, client, state, identity } = await ackFixture({ fetch: async () => {
    calls++
    return response({ accepted: true, acknowledged_at: '2026-11-19T00:00:02.000Z', duplicate: false })
  } })
  const args = { ticketId: 'tkt-time', assignmentId: 'asg-time', leaseEpoch: 2, accepted: true }
  await client.acknowledge(args)
  assert.equal(calls, 1)
  await state.mutate(data => { data.deliveries[0].response.acknowledged_at = 'not-an-ack-timestamp' })
  const reopened = await NodeState.open(root)
  assert.equal(reopened.data.deliveries[0].response.acknowledged_at, 'not-an-ack-timestamp', 'The corrupt timestamp must actually reach the reopened ledger')
  const restored = new LoomNodeClient({ http: client.http, identity, state: reopened })
  const recovered = await restored.acknowledge(args)
  assert.equal(calls, 2, 'Malformed time evidence cannot bypass the authenticated reconciliation request')
  assert.equal(recovered.response.acknowledged_at, '2026-11-19T00:00:02.000Z')
  assert.equal(restored.state.outbox.length, 0, 'The reconciled NodeState must remove the delivered pending ACK')
  const reconciled = await NodeState.open(root)
  assert.equal(reconciled.data.deliveries[0].response.acknowledged_at, '2026-11-19T00:00:02.000Z')
  assert.equal(reconciled.data.deliveries[0].response.duplicate, false, 'The server-bearing receipt is retained, not mutated into fabricated replay history')
})

test('ACK pending survives lost responses and causal outbox order is preserved after reopen', async () => {
  let online = false
  const calls = []
  const { root, client, state, identity } = await ackFixture({ fetch: async (url, options) => {
    const body = JSON.parse(options.body); calls.push(new URL(url).pathname)
    if (new URL(url).pathname.endsWith('/acknowledge') && !online) throw new Error('Response was lost; central outcome unknown')
    return response(new URL(url).pathname.endsWith('/acknowledge')
      ? { accepted: true, acknowledged_at: '2026-11-19T00:00:02.000Z' } : { accepted: true })
  } })
  const args = { ticketId: 'tkt-recover', assignmentId: 'asg-recover', leaseEpoch: 1, accepted: true }
  await client.report({ ...args, ticketId: args.ticketId, assignmentId: args.assignmentId, leaseEpoch: args.leaseEpoch, state: 'unknown', summary: 'Effect requires reconciliation' })
  const pending = await client.acknowledge(args)
  assert.equal(pending.response, null)
  assert.equal(pending.acknowledgement_pending, true)
  assert.equal(state.outbox[0].kind, 'report')
  const originalId = state.outbox.find(item => item.kind === 'ack').body.request_id
  const reopened = await NodeState.open(root)
  const restored = new LoomNodeClient({ http: client.http, identity, state: reopened })
  online = true
  const delivered = await restored.dispatchOutbox()
  assert.deepEqual(calls, ['/api/v1/nodes/acknowledge', '/api/v1/nodes/acknowledge', '/api/v1/nodes/reports'])
  assert.deepEqual(delivered.map(item => item.kind), ['ack', 'report'])
  assert.equal(delivered[0].response.acknowledged_at, '2026-11-19T00:00:02.000Z')
  assert.equal(reopened.outbox.length, 0)
  assert.equal(reopened.data.deliveries.find(item => item.kind === 'ack').body.request_id, originalId)
  const after = await restored.acknowledge(args)
  assert.equal(after.request.request_id, originalId)
  assert.equal(after.response.duplicate, true)
})

test('ACK HTTP 200 without a timestamp remains deferred and cannot release dependent reports', async () => {
  const { client, state } = await ackFixture({ fetch: async () => response({ accepted: true }) })
  const args = { ticketId: 'tkt-invalid-receipt', assignmentId: 'asg-invalid-receipt', leaseEpoch: 1, accepted: false }
  const pending = await client.acknowledge(args)
  assert.equal(pending.response, null)
  await client.report({ ...args, state: 'failed', summary: 'Invalid local admission; no remote delivery proven' })
  const results = await client.dispatchOutbox()
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'deferred')
  assert.deepEqual(state.outbox.map(item => item.kind).sort(), ['ack', 'report'])
  assert.equal(state.data.deliveries, undefined)
})

test('same immutable concurrent ACK uses one in-flight HTTP request while distinct epochs remain separate', async () => {
  let calls = 0
  let hold
  const barrier = new Promise(resolve => { hold = resolve })
  const { client } = await ackFixture({ fetch: async (_url, options) => {
    calls++
    await barrier
    return response({ accepted: true, acknowledged_at: '2026-11-19T00:00:03.000Z' })
  } })
  const args = { ticketId: 'tkt-one-flight', assignmentId: 'asg-one-flight', leaseEpoch: 1, accepted: true }
  const first = client.acknowledge(args); const second = client.acknowledge(args)
  for (let rounds = 0; rounds < 25 && calls === 0; rounds++) await new Promise(resolve => setImmediate(resolve))
  await client.state.queue
  assert.equal(calls, 1)
  hold()
  const [one, two] = await Promise.all([first, second])
  assert.equal(one.request.request_id, two.request.request_id)
  assert.equal(calls, 1)
  const epoch = client.acknowledge({ ...args, leaseEpoch: 2 })
  for (let rounds = 0; rounds < 25 && calls < 2; rounds++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  await epoch
})

test('immediate ACK and outbox dispatcher share a single in-flight transport attempt', async () => {
  let calls = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const { client, state } = await ackFixture({ fetch: async () => {
    calls++
    await barrier
    return response({ accepted: true, acknowledged_at: '2026-11-19T00:00:05.000Z' })
  } })
  const args = { ticketId: 'tkt-shared', assignmentId: 'asg-shared', leaseEpoch: 1, accepted: true }
  const immediate = client.acknowledge(args)
  for (let i = 0; i < 20 && state.outbox.length === 0; i++) await new Promise(resolve => setImmediate(resolve))
  await state.queue
  const dispatched = client.dispatchOutbox()
  release()
  const [receipt, delivered] = await Promise.all([immediate, dispatched])
  assert.equal(calls, 1)
  assert.equal(receipt.request.request_id, delivered[0].requestId)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].response.accepted, true)
  assert.equal(state.outbox.length, 0)
})

test('runner preserves actual file artifacts/report when ACK transport fails and dispatches them later in causal order', async () => {
  const root = await fixture()
  const project = join(await realpath(root), 'project')
  await mkdir(project, { recursive: true, mode: 0o700 })
  await writeFile(join(project, 'input.txt'), 'A real controlled input whose effect survives ACK failure.')
  const identity = await NodeIdentity.open(root)
  await identity.setToken({ token: 'runner-node-token' })
  const { a: seed, g } = assignment(project, identity)
  const a = { ...seed, grant: g }
  assert.equal(project, await realpath(project))
  let online = false
  const calls = []
  const http = new LoomHttpClient({ baseUrl: 'http://example.invalid', fetch: async (url, options) => {
    const route = new URL(url).pathname
    calls.push(route)
    if (route.endsWith('/poll')) return response({ assignment: a })
    if (route.endsWith('/acknowledge') && !online) throw new Error('ACK response lost after the real file read')
    if (route.endsWith('/acknowledge')) return response({ accepted: true, acknowledged_at: '2026-11-19T00:00:04.000Z' })
    return response({ accepted: true })
  } })
  const state = await NodeState.open(root)
  const runner = new LocalNodeRunner({ projectRoots: { '1234': project }, artifactDir: join(root, 'artifacts') })
  runner.identity = identity
  runner.state = state
  runner.http = http
  runner.client = new LoomNodeClient({ http, identity, state })
  runner.executor = new ControlledFileExecutor({ artifactDir: join(root, 'artifacts'), projectRoots: { '1234': project } })
  const result = await runner.pollAndRun()
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(result.acknowledgement_pending, true)
  assert.equal(result.acknowledgementPending, true)
  assert.equal(result.kind, 'report')
  assert.deepEqual(state.outbox.map(item => item.kind).sort(), ['ack', 'artifact', 'report'])
  assert.equal(state.data.deliveries, undefined)
  const saved = await NodeState.open(root)
  const savedAck = saved.outbox.find(item => item.kind === 'ack')
  assert.equal(savedAck.body.request_id, state.outbox.find(item => item.kind === 'ack').body.request_id)
  assert.equal(savedAck.body.accepted, true)
  const restart = new LocalNodeRunner({ projectRoots: { '1234': project } })
  restart.identity = identity
  restart.state = saved
  restart.http = http
  restart.client = new LoomNodeClient({ http, identity, state: saved })
  restart.executor = runner.executor
  online = true
  const deliveries = await restart.client.dispatchOutbox()
  assert.deepEqual(deliveries.map(item => item.kind), ['ack', 'artifact', 'report'])
  assert.equal(calls.filter(route => route.endsWith('/reports')).length, 1)
  assert.equal(saved.outbox.length, 0)
  assert.equal(saved.data.deliveries.find(item => item.kind === 'ack').response.accepted, true)
  assert.equal(result.response, undefined, 'The original result stayed pending; no HTTP receipt was invented')
})

test('strict ACK denial throws and records quarantined rejection while leaving the durable ACK', async () => {
  const { client, state } = await ackFixture({ fetch: async () => response({ error: { code: 'lease_mismatch', message: 'Synthetic invalid lease' } }, 403) })
  const args = { ticketId: 'tkt-denied', assignmentId: 'asg-denied', leaseEpoch: 4, accepted: false }
  await assert.rejects(() => client.acknowledge(args), error => error.status === 403 && error.code === 'lease_mismatch')
  const runner = new LocalNodeRunner({})
  runner.client = client
  runner.state = state
  const rejected = await runner.rejectAssignment({ ...assignment(await fixture(), await NodeIdentity.open(await fixture())).a,
    id: args.assignmentId, ticket_id: args.ticketId, lease_epoch: args.leaseEpoch, grant_digest: 'rejected-grant' }, 'Invalid test lease')
  assert.equal(rejected.rejection.acknowledgement.outcome, 'quarantined')
  assert.equal(rejected.rejection.acknowledgement.status, 403)
  assert.equal(state.outbox.length, 2)
  assert.equal(state.outbox.every(item => item.kind === 'ack'), true)
  const deliveries = await client.dispatchOutbox()
  assert.equal(deliveries.every(item => item.status === 'deferred' && item.kind === 'ack'), true)
  assert.equal(state.outbox.length, 2)
})

test('one assignment missing ACK does not block unrelated autonomously admitted work', async () => {
  const calls = []
  const { client, state, root, identity } = await ackFixture({ fetch: async (url) => {
    const route = new URL(url).pathname; calls.push(route)
    if (route.endsWith('/acknowledge')) throw new Error('pending assignment A')
    return response({ accepted: true })
  } })
  await client.acknowledge({ ticketId: 'tkt-a', assignmentId: 'asg-a', leaseEpoch: 1, accepted: false })
  await client.report({ ticketId: 'tkt-a', assignmentId: 'asg-a', leaseEpoch: 1, state: 'failed', summary: 'Must wait on its own ACK' })
  await client.event({ ticketId: 'tkt-b', assignmentId: 'asg-b', leaseEpoch: 1, summary: 'Independent task progress remains deliverable' })
  await state.mutate(data => { for (const item of data.outbox) item.next_attempt_at = new Date(0).toISOString() })
  const first = await client.dispatchOutbox()
  assert.deepEqual(first.map(item => [item.kind, item.status].join(':')), ['ack:deferred', 'event:delivered'])
  assert.equal(state.outbox.some(item => item.kind === 'report'), true)
  const reopened = await NodeState.open(root)
  assert.equal(reopened.data.version, 1)
  await reopened.mutate(data => { data.deliveries = {} })
  await assert.rejects(() => NodeState.open(root), /Invalid local delivery ledger/)
  assert.equal(identity.token, 'fixture-ack-node-token')
})

test('assignment validation rejects stale lease, node mismatch, capability-only access and missing grant', async () => {
  const root = await fixture(); const identity = await NodeIdentity.open(root); const { a, g } = assignment(root, identity)
  assert.equal(validateAssignment(a, g, identity).id, a.id)
  for (const invalid of [
    [{ ...a, lease_expires_at: new Date(Date.now() - 1).toISOString() }, g],
    [{ ...a, node_id: '0'.repeat(64) }, g],
    [{ ...a, kind: 'read_summary' }, { ...g, operations: [] }],
    [{ ...a, grant_version: 2 }, g],
    [a, { ...g, revoked_at: new Date().toISOString() }],
    [{ ...a, grant_digest: 'another-digest' }, g],
    [{ ...a, installation_id: 'wrong' }, g],
    [{ ...a, kind: 'shell' }, { ...g, operations: ['shell'] }],
  ]) assert.throws(() => validateAssignment(invalid[0], invalid[1], identity))
  assert.throws(() => validateAssignment(a, { ...g, digest: undefined }, identity))
})

test('model_descriptor registration is read-only and requires exact model.json without changing existing grants', async () => {
  const root = await fixture(); const identity = await NodeIdentity.open(root); const { a, g } = assignment(root, identity)
  assert.ok(CAPABILITIES.some((capability) => capability.ticket_kind === 'model_descriptor' && capability.permission === 'read'))
  assert.throws(() => validateAssignment({ ...a, kind: 'model_descriptor', relative_path: 'model.json' }, g, identity), /authorize/)
  const read = { ...g, operations: ['read'] }
  assert.equal(validateAssignment({ ...a, kind: 'model_descriptor', relative_path: 'model.json' }, read, identity).kind, 'model_descriptor')
  assert.throws(() => validateAssignment({ ...a, kind: 'model_descriptor', relative_path: 'model.json' }, { ...g, operations: ['invoke_text'] }, identity), /authorize/)
  for (const target of [undefined, '../model.json', 'nested/model.json', 'weights.json']) {
    assert.throws(() => validateAssignment({ ...a, kind: 'model_descriptor', relative_path: target }, g, identity), /model\.json/)
  }
})

test('controlled executor performs read and atomic write only within fixture project', async () => {
  const source = Buffer.from('Real isolated project input.\nNo LLM, DSH host or network model was called.\n')
  const root = await fixture(); const project = await mkdtemp(join(root, 'project-')); await writeFile(join(project, 'input.txt'), source)
  const identity = await NodeIdentity.open(root); const executor = new ControlledFileExecutor({ artifactDir: join(root, 'artifacts') })
  const { a, g } = assignment(project.layout || project, identity)
  const first = await executor.execute(a, g)
  assert.equal(first.state, 'succeeded'); assert.equal(first.effect.status, 'confirmed')
  const summary = JSON.parse(first.artifact.bytes.toString())
  assert.equal(summary.schema, 'loom.synthetic_summary.v1')
  assert.equal(summary.input_sha256, sha256(source))
  assert.notEqual(summary.input_sha256, first.artifact.metadata.sha256)
  assert.equal(first.artifact.metadata.sha256, sha256(first.artifact.bytes))
  assert.equal(summary.byte_length, source.length)
  const edit = await executor.execute({ ...a, kind: 'edit_file', relative_path: 'deep/nested/result.txt', content: 'new fixture content' }, g)
  assert.equal(await readFile(join(project, 'deep/nested/result.txt'), 'utf8'), 'new fixture content')
  assert.equal(edit.state, 'succeeded')
  await symlink(project, join(root, 'escape'), 'dir')
  await symlink(join(root, 'identity.json'), join(project, 'symlink.txt'))
  await assert.rejects(() => executor.execute({ ...a, relative_path: 'symlink.txt' }, g))
  await assert.rejects(() => executor.execute({ ...a, relative_path: '../identity.json' }, g))
  await assert.rejects(() => executor.execute({ ...a, relative_path: '/etc/passwd' }, g))
  assert.throws(() => safeRelative('dir\\secret'))
  assert.throws(() => safeProjectRoot('/'))
  assert.throws(() => requireIsolatedRoot('/'))
  assert.throws(() => requireIsolatedRoot('.'))
  assert.equal(requireIsolatedRoot(join(root, 'state')), join(root, 'state'))
})

test('controlled descendant validates immutable source bytes and blocks tampering', async () => {
  const root = await fixture(); const project = join(root, 'project')
  await mkdir(project, { recursive: true, mode: 0o700 })
  const identity = await NodeIdentity.open(root)
  const { g } = assignment(project, identity)
  const executor = new ControlledFileExecutor({ artifactDir: join(root, 'artifacts'), projectRoots: { '1234': project } })
  const sourceBytes = Buffer.from('alpha  beta\nGamma\n')
  const sourceId = randomUUID()
  const assignmentData = {
    ...assignment(project, identity).a, project_id: '1234', node_id: identity.nodeId,
    kind: 'edit_file', ticket_id: 'derived-ticket', relative_path: 'docs/derived.txt', content: 'derived fixture content',
    artifact_input: {
      artifact_ref: { type: 'artifact_ref', artifact_id: sourceId, ticket_id: 'source-ticket',
        origin_node_id: 'a'.repeat(64), sha256: sha256(sourceBytes), location: `loom://artifact/${sourceId}`, parents: [] },
      bytes_base64: sourceBytes.toString('base64'),
    },
  }
  const result = await executor.execute(assignmentData, g)
  assert.equal(result.state, 'succeeded')
  assert.deepEqual(result.artifact.metadata.parents, [sourceId])
  assert.equal(result.artifact.metadata.artifact_ref.artifact_id, sourceId)
  assert.equal(result.artifact.metadata.origin_node_id, assignmentData.node_id)
  assert.equal(result.artifact.metadata.sha256, sha256(result.artifact.bytes))
  assert.notEqual(result.artifact.metadata.sha256, sha256(sourceBytes))
  assert.equal(await readFile(join(project, 'docs/derived.txt'), 'utf8'), 'derived fixture content')
  for (const mismatch of [
    (value) => { value.artifact_input.artifact_ref.sha256 = '0'.repeat(64); return value },
    (value) => { value.artifact_input.artifact_ref.location = '/etc/passwd'; return value },
    (value) => { value.artifact_input.artifact_ref.ticket_id = assignmentData.ticket_id; return value },
  ]) {
    const bad = structuredClone(assignmentData)
    mismatch(bad)
    bad.relative_path = 'docs/must-not-write.txt'
    await assert.rejects(() => executor.execute(bad, g), /immutable hash|controlled immutable Artifact URI|own descendant/)
    await assert.rejects(() => readFile(join(project, bad.relative_path)), /ENOENT/)
  }
})

test('two fresh isolated NodeState stores never share mutable outbox or identity-bound messages', async () => {
  const root = await fixture()
  const one = await NodeState.open(join(root, 'one'))
  const two = await NodeState.open(join(root, 'two'))
  await one.enqueue('report', { assignment_id: 'other-node-assignment', requested_state: 'cancelled' })
  assert.equal(one.data.outbox.length, 1)
  assert.deepEqual(two.data.outbox, [])
  assert.notEqual(one.data, two.data)
  const restored = await NodeState.open(join(root, 'two'))
  assert.deepEqual(restored.data.outbox, [], 'Another isolated node replayed another node\'s report')
})

test('restart converts pending completion to unknown and never executes duplicate side effect', async () => {
  const root = await fixture(); let operations = 0
  const state = await NodeState.open(root)
  await state.mutate((data) => { data.completions.alpha = { assignment_id: 'alpha', digest: 'a-digest', state: 'running', summary: '', artifacts: [], effects: [] } })
  const recovered = await NodeState.open(root)
  assert.equal(recovered.data.completions.alpha.state, 'unknown')
  assert.equal(recovered.data.completions.alpha.recovered_from_restart, true)
  const duplicate = await recovered.once('alpha', 'a-digest', () => { operations++; return {} })
  assert.equal(duplicate.duplicate, true); assert.equal(operations, 0)
  await assert.rejects(() => recovered.once('alpha', 'different-digest', async () => ({})), /different input/)
})

test('cancel-before-execution preserves its assignment/digest and never invokes the operation after reopen', async () => {
  const root = await fixture()
  const state = await NodeState.open(root)
  await state.mutate((data) => { data.assignments.cancelled = { assignment_id: 'cancelled', lease_epoch: 1, grant_digest: 'fixture-grant', cancel_requested: true } })
  let executions = 0
  const once = await state.once('cancelled', 'known-input-digest', async () => { executions++ })
  assert.equal(once.state, 'cancelled')
  assert.equal(once.digest, 'known-input-digest')
  assert.equal(once.assignment_id, 'cancelled')
  assert.equal(executions, 0)
  const restored = await NodeState.open(root)
  const replay = await restored.once('cancelled', 'known-input-digest', async () => { executions++ })
  assert.equal(replay.state, 'cancelled')
  assert.equal(replay.duplicate, true)
  assert.equal(executions, 0)
  assert.equal(restored.data.completions.cancelled.digest, 'known-input-digest')
})

test('lease timing is not work-input drift, but expired execution remains refused', async () => {
  const root = await fixture()
  const identity = await NodeIdentity.open(root)
  const { a: seed, g } = assignment(root, identity)
  const a = { ...seed, grant: g }
  const shortened = { ...a, lease_expires_at: new Date().toISOString(), grant: { ...a.grant, revoked_at: new Date().toISOString() }, cancel_requested: true }
  assert.equal(sameAuthorizedAssignment(a, shortened), true)
  assert.equal(cancellationFence(a, shortened), null, "an existing stopped task's mutable Grant/time view is not new work")
  assert.throws(() => validateAssignment({ ...a, lease_expires_at: new Date(Date.now() - 1000).toISOString() }, g, identity), /expired/)
  assert.equal(sameAuthorizedAssignment(a, { ...a, relative_path: 'other.txt' }), false)
  assert.equal(cancellationFence(a, { ...a, lease_epoch: 0, cancel_requested: true }), 'stale_lease_epoch')
})
