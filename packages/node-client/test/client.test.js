import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verify, createPublicKey, randomUUID } from 'node:crypto'
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

test('controlled executor performs read and atomic write only within fixture project', async () => {
  const root = await fixture(); const project = await mkdtemp(join(root, 'project-')); await writeFile(join(project, 'input.txt'), 'Synthetic line\nSecond line\n')
  const identity = await NodeIdentity.open(root); const executor = new ControlledFileExecutor({ artifactDir: join(root, 'artifacts') })
  const { a, g } = assignment(project.layout || project, identity)
  const first = await executor.execute(a, g)
  assert.equal(first.state, 'succeeded'); assert.equal(first.effect.status, 'confirmed')
  assert.equal(JSON.parse(first.artifact.bytes.toString()).schema, 'loom.synthetic_summary.v1')
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
