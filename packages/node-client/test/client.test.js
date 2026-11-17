import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { sha256 } from '../src/util.js'
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
    grant_version: 1, grant_digest: g.digest, attempt: 1, kind: 'read_summary', relative_path: 'input.txt', lease_expires_at: new Date(Date.now() + 60000).toISOString() }, g }
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
