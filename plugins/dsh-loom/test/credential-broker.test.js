import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { DshDispatcher } from '../lib/dsh-dispatcher.js'
import { HostCredentialBroker, loadCredentialKey } from '../lib/credential-broker.js'
import { canonical, sha256 } from '../src/util.js'

const nodeId = 'a'.repeat(64)
const scope = { node_id: nodeId, installation_id: 'install-credential-fixture', worker_id: 'worker-credential', project_id: 'project-credential' }
const secret = 'token-not-share'
function credentialKey(owner, id) {
  if (!/^[a-z][a-z0-9-]*$/.test(owner) || !/^[a-z][a-z0-9-]*$/.test(id)) throw new TypeError('not a public DSH record segment')
  return `${owner}/${id}`
}
function assignment(action = 'inspect', operations = ['credential_inspect']) {
  const grant = { id: `grant-credential-${action}`, version: 4, operations, revoked_at: null,
    digest: 'b'.repeat(64), ...scope }
  const credential_ref = { schema: 'loom.credential-reference.v1', id: 'record-ref-host-doc',
    reference_id: 'cref_host-doc', owner: 'loom-local-node', record_key: 'refid-doc-ref-fixture',
    scope: { ...scope }, binding_id: 'binding-host-doc', binding_digest: 'e'.repeat(64), expect_present: action === 'revoke',
    action, value_exposed: false,
    ...(action === 'revoke' ? { inspection_proof: {
      source_ticket_id: 'tkt-source-inspect', source_artifact_id: '5f67cd79-c766-43d3-9a99-d92b60d72e53',
      copy_sha256: 'd'.repeat(64), state: 'present', source: 'host_dsh_credentials', verified_current_binding: true,
      present_proof: { schema: 'loom.credential-reference.v1', id: 'record-source-inspect',
        reference_id: 'cref_source-inspect', owner: 'loom-local-node', record_key: 'refid-doc-ref-fixture',
        action: 'inspect', expect_present: false, scope: { ...scope }, binding_id: 'binding-host-doc',
        binding_digest: 'e'.repeat(64) },
    }} : {}) }
  return { id: `asg-credential-${action}`, ticket_id: 'tkt-credential', lease_id: 'lease-credential',
    lease_epoch: 2, attempt: 2, lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    grant_digest: grant.digest, kind: 'credential_ref', credential_action: action, credential_ref, grant,
    grant_credential_ref: { id: credential_ref.id, name_scope: 'source', record_key: credential_ref.record_key,
      binding_id: credential_ref.binding_id, scope: { ...scope } },
    ...(action === 'revoke' ? { credential_revoke_expected: {
      expect_present: true, source_ticket_id: 'tkt-source-inspect',
      source_artifact_id: '5f67cd79-c766-43d3-9a99-d92b60d72e53',
      source_sha256: 'd'.repeat(64), source_reference_id: 'cref_source-inspect', scope: { ...scope },
    }} : {}),
    ...scope }
}
function fixtureHost(configured = true) {
  const calls = []
  const records = new Map()
  if (configured) records.set('loom-local-node/refid-doc-ref-fixture', { configured: true, writable: true,
    kind: 'grant', masked: secret, description: secret, payload: { token: secret } })
  return { calls, records,
    async describeRecord(key) { calls.push(['describeRecord', key]); return records.get(key) || { configured: false, writable: true } },
    async deleteRecord(key) { calls.push(['deleteRecord', key]); records.delete(key) },
    async readRecord() { throw new Error('readRecord forbidden') },
    async resolve() { throw new Error('resolve forbidden') },
    async listRecords() { throw new Error('listRecords forbidden') },
    async modifyRecord() { throw new Error('modifyRecord must never be called by the plugin') } }
}
function subject(host = fixtureHost(), config = { credential_broker_tasks: 'dsh_records' }) {
  const calls = []; let authorizedRequest; let forcedAuthorization
  let completion
  const runner = { identity: { ...scope }, state: { data: { assignments: {}, completions: {} }, flush: async () => {},
    async once(id, digest, execute) { if (completion) return { ...completion, artifact: completion.artifact ? { ...completion.artifact } : completion.artifact,
      ...(completion.artifacts ? { artifacts: completion.artifacts.map((item) => ({ ...item })) } : {}) }; calls.push(['once', id, digest]); completion = await execute(); return completion } },
    client: { acknowledge: async (body) => calls.push(['ack', body.accepted]),
      async authorizeCredential({ ticketId, assignmentId, leaseEpoch }) {
        calls.push(['authorize', assignmentId, leaseEpoch]); const request = forcedAuthorization || authorizedRequest
        if (!request) { const error = new Error('No current controller Grant or assignment was selected'); error.code = 'credential_wrong_scope'; throw error }
        if (request.grant.revoked_at !== null) { const error = new Error('Grant revoked by live authority before side effects'); error.code = 'credential_wrong_scope'; throw error }
        return { authorization: { protocol: 'loom.node.v1', action: request.credential_action,
          assignment_id: assignmentId, ticket_id: ticketId, lease_epoch: leaseEpoch,
          grant: request.grant, credential_ref: request.credential_ref,
          grant_credential_ref: request.grant_credential_ref,
          credential_revoke_expected: request.credential_revoke_expected ?? null } }
      } } }
  runner.authorizeCredential = async (request) => {
    authorizedRequest = structuredClone(request)
    await runner.client.acknowledge({ ticketId: request.ticket_id, assignmentId: request.id, leaseEpoch: request.lease_epoch, accepted: true })
  }
  const adapter = { ctx: { credentials: host }, executeAssignment: async () => { throw new Error('Agent Session forbidden') } }
  const dispatcher = new DshDispatcher(runner, adapter, config, null, { broker: new HostCredentialBroker(host, credentialKey) })
  const preflight = dispatcher.canExecute.bind(dispatcher)
  const execute = dispatcher.executeAssignment.bind(dispatcher)
  dispatcher.canExecute = async (request) => {
    const allowed = await preflight(request)
    if (allowed) authorizedRequest = structuredClone(request)
    return allowed
  }
  dispatcher.executeAssignment = async (request) => {
    // Match CoordinatorLoop: preflight happens first, but execution still
    // performs the optional local once replay check and new live authorization.
    if (request.kind === 'credential_ref' && !dispatcher.active.has(request.id)) await dispatcher.canExecute(request)
    return execute(request)
  }
  return { host, runner, calls, setAuthorizedRequest: (request) => { authorizedRequest = request },
    forceNextAuthorization: (request) => { forcedAuthorization = request; if (forcedAuthorization) {
      runner.client.authorizeCredential = async () => ({ authorization: { protocol: 'loom.node.v1', action: request.credential_action,
        assignment_id: request.id, ticket_id: request.ticket_id, lease_epoch: request.lease_epoch,
        grant: request.grant, credential_ref: request.credential_ref, grant_credential_ref: request.grant_credential_ref,
        credential_revoke_expected: request.credential_revoke_expected ?? null } })
    } }, dispatcher }
}
function artifact(result) { return JSON.parse(result.artifact.bytes.toString('utf8')) }
function jsonSecretFree(result) { assert.equal(JSON.stringify(result).includes(secret), false) }

test('credential dispatch is disabled by default, without touching ambient Host credentials', async () => {
  const { dispatcher, host, runner } = subject()
  const disabled = new DshDispatcher(runner, { ctx: { credentials: host } }, {}, null)
  assert.equal(disabled.capabilities.includes('credential_ref'), false)
  assert.equal(disabled.broker, null)
  assert.equal(await disabled.canExecute(assignment()), false)
  const direct = new DshDispatcher(runner, { credentials: host }, { credential_broker_tasks: true }, null)
  assert.equal(await direct.canExecute(assignment()), false)
  assert.deepEqual(host.calls, [])
})

test('every valid digit-leading Reference and DSH namespace suffix is accepted', async () => {
  const { dispatcher, host } = subject(fixtureHost(false))
  const numeric = assignment()
  numeric.credential_ref.id = 'cref_0123456789abcdef0123456789abcdef'
  numeric.credential_ref.reference_id = numeric.credential_ref.id
  numeric.credential_ref.record_key = 'refid-0123456789abcdef01234567'
  numeric.grant_credential_ref.id = numeric.credential_ref.id
  numeric.grant_credential_ref.record_key = numeric.credential_ref.record_key
  assert.equal(await dispatcher.canExecute(numeric), true)
  const result = await dispatcher.executeAssignment(numeric)
  assert.equal(artifact(result).state, 'missing')
  assert.deepEqual(host.calls, [['describeRecord', 'loom-local-node/refid-0123456789abcdef01234567']])
})

test('inspect observes exact owned key, emits bounded present metadata, and never enumerates or extracts', async () => {
  const { dispatcher, host } = subject()
  const request = assignment()
  assert.equal(await dispatcher.canExecute(request), true)
  const result = await dispatcher.executeAssignment(request)
  const body = artifact(result)
  assert.equal(result.state, 'succeeded')
  assert.equal(result.effects.length, 0)
  assert.deepEqual(host.calls, [['describeRecord', 'loom-local-node/refid-doc-ref-fixture']])
  assert.deepEqual(body, { schema: 'loom.credential-reference-result.v1', record_id: 'record-ref-host-doc',
    record_subject: { reference_id: 'cref_host-doc', binding_id: 'binding-host-doc', grant_credential_ref: request.grant_credential_ref },
    record_key: 'refid-doc-ref-fixture', action: 'inspect', state: 'present', configured: true, writable: true, kind: 'grant', credential_owner: 'loom-local-node',
    source: 'host_dsh_credentials', configured_state: 'present_metadata', value_exposed: false, grant_created: false,
    permission_granted: false, matching_scope_only: true })
  assert.equal(result.summary, 'Credential reference observed without exposing value')
  jsonSecretFree(result)
})

test('missing inspection is explicit, and public arbitrary safe record kinds remain metadata-only', async () => {
  const absent = subject(fixtureHost(false))
  const result = await absent.dispatcher.executeAssignment(assignment())
  assert.equal(artifact(result).state, 'missing')
  assert.equal(artifact(result).configured, false)
  assert.equal(artifact(result).configured_state, 'missing')
  assert.equal(artifact(result).kind, null)
  const present = fixtureHost(); present.records.get('loom-local-node/refid-doc-ref-fixture').kind = 'opaque-current-kind'
  const other = await subject(present).dispatcher.executeAssignment(assignment())
  assert.equal(artifact(other).kind, 'opaque-current-kind')
})

test('wrong Grant, foreign namespace, malformed key, wildcard binding, or scope mismatch pre-empt all Host access', async () => {
  const { dispatcher, host } = subject()
  const mutations = [
    assignment('inspect', ['read']), assignment('inspect', ['credential_revoke']), assignment('inspect', ['invoke_text']),
    { ...assignment(), credential_ref: { ...assignment().credential_ref, owner: 'other_owner' } },
    { ...assignment(), credential_ref: { ...assignment().credential_ref, record_key: 'other/namespace' } },
    { ...assignment(), credential_ref: { ...assignment().credential_ref, record_key: '../parent' } },
    { ...assignment(), credential_ref: { ...assignment().credential_ref, binding_id: 'binding*' } },
    { ...assignment(), credential_ref: { ...assignment().credential_ref, scope: { ...scope, project_id: 'different-project' } } },
    { ...assignment(), grant: { ...assignment().grant, revoked_at: new Date().toISOString() } },
    { ...assignment(), grant_credential_ref: { ...assignment().grant_credential_ref, record_key: 'refid-different' } },
  ]
  assert.equal(mutations.length, 10)
  for (const request of mutations) assert.equal(await dispatcher.canExecute(request), false)
  assert.deepEqual(host.calls, [])
})

test('mutation after preflight and invalid execution Grant never become Agent or credential actions', async () => {
  const { dispatcher, host } = subject()
  const request = assignment('revoke', ['credential_revoke'])
  assert.equal(await dispatcher.canExecute(request), true)
  const changed = structuredClone(request); changed.credential_ref.record_key = 'refid-another-record'
  await assert.rejects(() => dispatcher.executeAssignment(changed), (error) => error.code === 'credential_wrong_scope')
  const unapproved = assignment('revoke', ['credential_revoke'])
  unapproved.grant.operations = ['read']
  await assert.rejects(() => dispatcher.executeAssignment(unapproved), (error) => error.code === 'credential_wrong_scope')
  assert.deepEqual(host.calls, [])
})

test('revoke checks presence, deletes the same key once, rechecks, and produces the exact effect digest', async () => {
  const { dispatcher, host } = subject()
  const request = assignment('revoke', ['credential_revoke'])
  assert.equal(await dispatcher.canExecute(request), true)
  const result = await dispatcher.executeAssignment(request)
  const body = artifact(result)
  assert.equal(result.state, 'succeeded')
  assert.equal(body.state, 'revoked'); assert.equal(body.configured, false)
  assert.deepEqual(host.calls, [['describeRecord', 'loom-local-node/refid-doc-ref-fixture'],
    ['deleteRecord', 'loom-local-node/refid-doc-ref-fixture'], ['describeRecord', 'loom-local-node/refid-doc-ref-fixture']])
  const expected = sha256(canonical({ asset_action: 'revoke', binding_id: request.credential_ref.binding_id,
    ref_recordkey: request.credential_ref.record_key, ...scope }))
  assert.equal(result.effects.length, 1)
  assert.equal(result.effects[0].status, 'confirmed')
  assert.equal(result.effects[0].input_digest, expected)
  assert.equal(result.effects[0].evidence.grant_version, 4)
  assert.equal(result.effects[0].evidence.grant_digest, request.grant.digest)
  assert.equal(result.effects[0].artifacts[0], result.artifact.artifact_id)
  jsonSecretFree(result)
  assert.equal(await dispatcher.canExecute(request), true)
  const repeated = await dispatcher.executeAssignment(request)
  assert.equal(host.calls.length, 3)
  assert.equal(artifact(repeated).artifact_id, undefined)
  assert.equal(repeated.artifact.artifact_id, result.artifact.artifact_id)
})

test('live controller must reauthorize before every credential call; stale cache has no fallback', async () => {
  const { dispatcher, host, runner, setAuthorizedRequest } = subject()
  setAuthorizedRequest(null)
  const request = assignment('revoke', ['credential_revoke'])
  assert.equal(await dispatcher.canExecute(request), true)
  setAuthorizedRequest(null)
  assert.equal(host.calls.length, 0)
  await assert.rejects(() => dispatcher.executeAssignment(request),
    error => error.code === 'credential_wrong_scope')
  assert.deepEqual(host.calls, [], 'No host metadata/delete calls may occur without live controller authorization')
  assert.equal(runner.state.data.completions[request.id], undefined)
  const revoked = subject(); const cached = assignment('revoke', ['credential_revoke'])
  assert.equal(await revoked.dispatcher.canExecute(cached), true)
  revoked.forceNextAuthorization({ ...cached, grant: { ...cached.grant, revoked_at: new Date().toISOString(), version: 5 } })
  await assert.rejects(() => revoked.dispatcher.executeAssignment(cached), error => error.code === 'credential_wrong_scope')
  assert.deepEqual(revoked.host.calls, [])
  const wrong = subject(); wrong.forceNextAuthorization({ ...cached, ticket_id: 'tkt-another-ticket' })
  await assert.rejects(() => wrong.dispatcher.executeAssignment(cached), error => error.code === 'credential_wrong_scope')
  assert.deepEqual(wrong.host.calls, [])
})

test('second authorization refusal at delete boundary cannot call deleteRecord', async () => {
  const { dispatcher, host, runner } = subject()
  const request = assignment('revoke', ['credential_revoke'])
  assert.equal(await dispatcher.canExecute(request), true)
  const first = runner.client.authorizeCredential
  let calls = 0
  runner.client.authorizeCredential = async (...args) => {
    if (++calls === 2) { const error = new Error('revoked after present metadata before side effect'); error.code = 'credential_wrong_scope'; throw error }
    return first(...args)
  }
  await assert.rejects(() => dispatcher.executeAssignment(request), error => error.code === 'credential_wrong_scope' && error.state === 'failed')
  assert.deepEqual(host.calls, [['describeRecord', 'loom-local-node/refid-doc-ref-fixture']])
})

test('proof fields are self consistent with the exact Reference and immutable Binding', async () => {
  const { dispatcher, host } = subject()
  for (const mutate of [
    proof => { proof.present_proof.binding_digest = 'f'.repeat(64) },
    proof => { proof.present_proof.expect_present = true },
    proof => { proof.present_proof.scope.project_id = 'project-foreign' },
    proof => { proof.present_proof.schema = 'loom.not-reference.v1' },
  ]) {
    const request = assignment('revoke', ['credential_revoke'])
    mutate(request.credential_ref.inspection_proof)
    assert.equal(await dispatcher.canExecute(request), false)
  }
  assert.deepEqual(host.calls, [])
})

test('revoke missing requires prior presence and never issues delete or success', async () => {
  const { dispatcher, host } = subject(fixtureHost(false))
  const request = assignment('revoke', ['credential_revoke'])
  await assert.rejects(() => dispatcher.executeAssignment(request), (error) => error.code === 'credential_missing' && error.state === 'failed')
  assert.deepEqual(host.calls, [['describeRecord', 'loom-local-node/refid-doc-ref-fixture']])
  const absentExpectation = assignment(); absentExpectation.credential_action = 'revoke'; absentExpectation.grant.operations = ['credential_revoke']
  assert.equal(await dispatcher.canExecute(absentExpectation), false)
})

test('delete failure, persistence, or verification failure is unknown with an actual uncertainty effect', async () => {
  const { dispatcher: failedDelete, host } = subject()
  host.deleteRecord = async (key) => { host.calls.push(['deleteRecord', key]); throw new Error('private provider failure') }
  const failure = await failedDelete.executeAssignment(assignment('revoke', ['credential_revoke']))
  assert.equal(failure.state, 'unknown'); assert.equal(artifact(failure).state, 'unknown')
  assert.equal(failure.effects[0].status, 'unknown'); jsonSecretFree(failure)
  const retain = subject()
  retain.host.deleteRecord = async (key) => retain.host.calls.push(['deleteRecord', key])
  const remains = await retain.dispatcher.executeAssignment(assignment('revoke', ['credential_revoke']))
  assert.equal(remains.state, 'unknown'); assert.equal(artifact(remains).configured, true)
  const unverifiable = subject()
  const original = unverifiable.host.describeRecord
  unverifiable.host.describeRecord = async (key) => { if (unverifiable.host.calls.some(([method]) => method === 'deleteRecord')) throw new Error('unavailable after delete'); return original(key) }
  const unknown = await unverifiable.dispatcher.executeAssignment(assignment('revoke', ['credential_revoke']))
  assert.equal(unknown.state, 'unknown'); assert.equal(artifact(unknown).state, 'unknown')
  assert.equal(unknown.effects[0].status, 'unknown')
})

test('unavailable public API fails closed without a configured dummy result', async () => {
  const { dispatcher, host } = subject(fixtureHost())
  dispatcher.broker = new HostCredentialBroker(host, null)
  assert.equal(await dispatcher.canExecute(assignment()), false)
  dispatcher.broker = {}
  await assert.rejects(() => dispatcher.executeAssignment(assignment()), (error) => error.code === 'credential_unavailable' && error.state === 'unknown')
  assert.deepEqual(host.calls, [])
  const keyFn = await loadCredentialKey()
  assert.throws(() => keyFn('INVALID_OWNER', 'refid-x'))
  if (process.env.DSH_NODE_EXECUTABLE && process.env.DSH_INSTALL_DIR) {
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire(process.env.DSH_INSTALL_DIR + '/package.json');
      console.log(require('@deepseek-ai/dsh-credentials').credentialKey('loom-local-node', 'refid-doc-ref-fixture'));
    `
    const { stdout } = await promisify(execFile)(process.env.DSH_NODE_EXECUTABLE, ['--input-type=module', '-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    const sdkKey = stdout.trim()
    assert.equal(sdkKey, 'loom-local-node/refid-doc-ref-fixture')
    assert.equal((await loadCredentialKey())('loom-local-node', 'refid-doc-ref-fixture'), sdkKey)
  }
})

test('default Config value is the actual unsupported enum, not a truthy capability flag', { skip: !process.env.DSH_NODE_EXECUTABLE || !process.env.DSH_INSTALL_DIR }, async () => {
  const script = `
    import { createRequire } from 'node:module';
    const require = createRequire(process.env.DSH_INSTALL_DIR + '/package.json');
    const z = require('@deepseek-ai/schemastery');
    const schema = z.object({ credential_broker_tasks: z.union(['unsupported', 'dsh_records']).default('unsupported') });
    console.log(JSON.stringify(schema({})));
  `
  const { stdout } = await promisify(execFile)(process.env.DSH_NODE_EXECUTABLE, ['--input-type=module', '-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  assert.deepEqual(JSON.parse(stdout), { credential_broker_tasks: 'unsupported' })
})
