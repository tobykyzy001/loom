#!/usr/bin/env node
// Exact public DSH records, temporary project and isolated profile only.
// A project/credential reference is NOT a secret and NOT a use or clone grant.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareScenario, startIsolatedHost } from './binding-scenario.mjs'
import { stableArtifactId } from '../../plugins/dsh-loom/lib/ids.js'

const serverSecrets = []
let root, host, scenario
try {
  scenario = await prepareScenario({ envPrefix: 'CREDENTIAL_TEST', credentialRecords: true })
  root = scenario.root
  const { admin, projectId, projectRoot, env, server } = scenario
  serverSecrets.push(server.clientToken)
  host = await startIsolatedHost(root, env, serverSecrets)
  const deadline = Date.now() + 45_000
  let node
  while (!node && Date.now() < deadline) {
    const list = await admin.get('/api/v1/nodes')
    node = list.nodes.find(entry => entry.status === 'online' && entry.inventory?.project_roots?.[projectId])
    if (!node) await pause(150)
  }
  assert.ok(node, 'Real isolated DSH worker with the declared broker capability is required')
  assert.ok(node.capabilities.some(entry => entry === 'credential_ref' || entry?.ticket_kind === 'credential_ref'))
  await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: projectRoot })
  const grant = async operations => (await admin.post('/api/v1/grants', { project_id: projectId, node_id: node.id, worker_id: 'default', operations })).grant
  const inspectGrant = await grant(['credential_inspect'])
  const revokeGrant = await grant(['credential_revoke'])
  const plainRead = await grant(['read'])
  const plainInvoke = await grant(['invoke_text'])
  const action = async (actionName, grantId, extra = {}) => (await admin.post(`/api/v1/projects/${projectId}/credential-action`, { action: actionName, grant_id: grantId, ...extra })).ticket
  for (const granted of [plainRead, plainInvoke, revokeGrant]) {
    await assert.rejects(() => action('inspect', granted.id), error => error.code === 'credential_scope')
  }
  for (const granted of [inspectGrant, plainRead, plainInvoke]) {
    await assert.rejects(() => action('revoke', granted.id), error => error.code === 'credential_scope')
  }
  const createdInspect = await action('inspect', inspectGrant.id)
  assert.equal(createdInspect.kind, 'credential_ref')
  const ref = JSON.parse(createdInspect.content).credential_ref
  assert.equal(ref.owner, 'loom-local-node')
  assert.equal(ref.scope.node_id, node.id)
  assert.equal(ref.scope.worker_id, 'default')
  assert.equal(ref.scope.project_id, projectId)
  assert.ok(ref.record_key.startsWith('refid-'))
  env.LOOM_FIXTURE_CREDENTIAL_RECORD_KEY = ref.record_key
  env.LOOM_FIXTURE_CREDENTIAL_SEED = 'true'
  await host.stop(); host = null
  // A test-only installed seed writes the actual record through the public API.
  host = await startIsolatedHost(root, env, serverSecrets)
  // Seed activation and authorized Worker registration precede any verdict on
  // a newly seeded inspection; an old acknowledgement is not completion.
  await host.waitFor(async () => {
    const list = await admin.get('/api/v1/nodes')
    return list.nodes.some(entry => entry.status === 'online' && entry.installation_id === node.installation_id)
  }, 15_000, 'seeded worker becomes online before inspection completion')
  let inspected = await waitTerminal(admin, createdInspect.id, 'Inspect exact present credential metadata')
  assert.equal(inspected.status, 'succeeded', JSON.stringify(inspected.reports))
  let present = await artifact(admin, inspected)
  const beforeSeedState = present.state
  if (present.state === 'missing') {
    // If the first legitimate inspection happened before the fixture seed,
    // preserve that missing observation and issue a new inspection instead of
    // relabelling its completed outcome as present.
    const nextInspectTicket = await action('inspect', inspectGrant.id)
    inspected = await waitTerminal(admin, nextInspectTicket.id, 'Inspect after actual seeded record is present')
    present = await artifact(admin, inspected)
  }
  assert.equal(present.schema, 'loom.credential-reference-result.v1')
  assert.equal(present.action, 'inspect')
  assert.equal(present.state, 'present')
  assert.equal(present.configured, true)
  assert.equal(present.source, 'host_dsh_credentials')
  assert.equal(present.value_exposed, false)
  assert.equal(present.grant_created, false)
  assert.equal(present.permission_granted, false)
  assert.equal(present.kind, 'grant')
  assert.notEqual(present.reference_id, 'secret')
  const snapshot = JSON.stringify(present)
  assert.equal(snapshot.includes('synthetic-record-never-a-real-credential'), false)

  assert.equal(beforeSeedState === 'missing' || beforeSeedState === 'present', true)
  const proofArtifactInfo = await admin.get(`/api/v1/tickets/${inspected.id}/artifacts/${inspected.artifacts[0].id}`)
  const proofLocation = join(server.dataDir, 'artifacts', proofArtifactInfo.artifact.storage_name)
  const originalProof = await readFile(proofLocation)
  assert.equal(createHash('sha256').update(originalProof).digest('hex'), proofArtifactInfo.artifact.sha256)
  await writeFile(proofLocation, '{"tampered_without_secret":true}', { mode: 0o600 })
  try {
    await assert.rejects(() => action('revoke', revokeGrant.id, { inspection_ticket_id: inspected.id }), error => error.code === 'inspection_proof_required')
  } finally { await writeFile(proofLocation, originalProof, { mode: 0o600 }) }
  const unknownTicketId = await proveUnknownReport({ admin, action, grant, node, projectId, inspected, ref })
  const revokedTicket = await action('revoke', revokeGrant.id, { inspection_ticket_id: inspected.id })
  const revoked = await waitTerminal(admin, revokedTicket.id, 'Independently consented exact record revocation')
  assert.equal(revoked.status, 'succeeded', JSON.stringify(revoked.reports))
  const deleteArtifact = await artifact(admin, revoked)
  assert.equal(deleteArtifact.state, 'revoked')
  assert.equal(deleteArtifact.configured, false)
  assert.equal(deleteArtifact.value_exposed, false)
  assert.equal(deleteArtifact.action, 'revoke')
  assert.equal(deleteArtifact.grant_created, false)
  assert.equal(JSON.stringify(revoked.effects).includes('synthetic-record-never-a-real-credential'), false)
  const blockedRequests = [
    admin.post(`/api/v1/projects/${projectId}/credential-action`, { action: 'revoke', grant_id: revokeGrant.id, binding_id: 'binding_other' }),
    admin.post(`/api/v1/projects/${projectId}/credential-action`, { action: 'revoke', grant_id: revokeGrant.id }),
    admin.post(`/api/v1/projects/${projectId}/credential-action`, { action: 'revoke', grant_id: revokeGrant.id, inspection_ticket_id: 'tkt_not_an_inspection' }),
  ]
  for (const request of blockedRequests) await assert.rejects(() => request, error => ['inspection_proof_required', 'credential_binding'].includes(error.code))
  assert.equal(revoked.effects.length, 1)
  assert.match(revoked.effects[0].input_digest, /^[a-f0-9]{64}$/)
  assert.equal(revoked.effects[0].status, 'confirmed')
  const currentReference = JSON.parse(revokedTicket.content).credential_ref
  assert.equal(revoked.effects[0].input_digest, expectedRevokeDigest(revokeGrant, currentReference, node, projectId))
  assert.notEqual(revoked.effects[0].id, (await admin.get(`/api/v1/tickets/${unknownTicketId}`)).effects[0].id,
    'Independent Grant/Assignments must not overwrite an unknown Effect with a later successful one')
  const effectEvidence = JSON.parse(revoked.effects[0].evidence)
  assert.equal(effectEvidence.grant_digest, revokedTicket.grant_digest)
  assert.equal(effectEvidence.grant_digest, revokeGrant.digest)
  assert.equal(effectEvidence.grant_version, revokeGrant.version)
  assert.equal(effectEvidence.input_sha256, revoked.effects[0].input_digest)
  assert.equal(effectEvidence.reference_id, currentReference.reference_id)
  assert.equal(effectEvidence.binding_id, currentReference.binding_id)

  // Restart WITHOUT seeding the test value. A persisted remove is not a label.
  await host.stop(); host = null
  env.LOOM_FIXTURE_CREDENTIAL_SEED = 'false'
  env.LOOM_FIXTURE_ENROLLMENT_CODE = ''
  host = await startIsolatedHost(root, env, serverSecrets)
  const missingTicket = await action('inspect', inspectGrant.id)
  const missing = await waitTerminal(admin, missingTicket.id, 'Real restarted missing-record observation')
  assert.equal(missing.status, 'succeeded', JSON.stringify(missing.reports))
  const missingArtifact = await artifact(admin, missing)
  assert.equal(missingArtifact.state, 'missing')
  assert.equal(missingArtifact.configured, false)
  assert.equal(missingArtifact.value_exposed, false)

  const { NodeIdentity } = await import('../../packages/node-client/src/identity.js')
  const { LoomNodeClient } = await import('../../packages/node-client/src/client.js')
  const { LoomHttpClient } = await import('../../packages/node-client/src/http.js')
  const nodeIdentity = await NodeIdentity.open(join(root, 'node-state'))
  const nodeClient = new LoomNodeClient({ http: new LoomHttpClient({ baseUrl: server.baseUrl }), identity: nodeIdentity, state: {} })

  await admin.post(`/api/v1/grants/${inspectGrant.id}/revoke`, {})
  await assert.rejects(() => action('inspect', inspectGrant.id), error => error.code === 'credential_scope')
  const foreignTicket = await action('inspect', (await grant(['credential_inspect'])).id)
  const foreignObject = JSON.parse(foreignTicket.content).credential_ref
  assert.notEqual(foreignObject.reference_id, ref.reference_id)
  assert.equal(foreignObject.record_key, ref.record_key)
  await admin.post(`/api/v1/grants/${revokeGrant.id}/revoke`, {})
  await assert.rejects(() => nodeClient.authorizeCredential({ ticketId: revokedTicket.id,
    assignmentId: revokedTicket.assignments[0].id, leaseEpoch: revokedTicket.assignments[0].lease_epoch, snapshot: {} }), error => error.status === 409 && error.code === 'outcome_unknown')
  await assert.rejects(() => action('revoke', revokeGrant.id), error => error.code === 'credential_scope')
  await assert.rejects(() => action('revoke', revokeGrant.id, { inspection_ticket_id: inspected.id }), error => error.code === 'credential_scope')

  const result = { overall: 'PASS', genuine_dsh_credential_records: true, owner_and_record_scope: true,
    output_metadata_only: true, present_before_revoke: true, revoked_and_restart_missing: true,
    secret_sent_to_controller: false, value_in_result_or_effects: false, secret_exposed: false,
    independent_inspect_and_revoke_grants: true, wrong_scope_rejected: true,
    records_api: 'ctx.credentials describeRecord/deleteRecord, with real keyed target',
    not_system_keychain_or_remote_authentication: true, no_real_credentials_used: true, inspect_ticket: createdInspect.id,
    revoke_ticket: revokedTicket.id, restart_missing_ticket: missingTicket.id, fixture_root: root }
  await writeFile(join(root, 'credential-broker-result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: serverSecrets.reduce((text, key) => text.replaceAll(key, '[redacted]'), String(error.stack || error)), host: host?.diagnostics(), controller: scenario?.server?.diagnostics?.(), fixture_root: root }, null, 2))
  process.exitCode = 1
} finally {
  if (host) await host.stop().catch(() => {})
  if (scenario?.server) await scenario.server.stop().catch(() => {})
}
async function artifact(admin, task) {
  assert.equal(task.artifacts.length, 1)
  const value = await admin.get(`/api/v1/tickets/${task.id}/artifacts/${task.artifacts[0].id}`)
  assert.equal(value.artifact.sha256.length, 64)
  return JSON.parse(value.content)
}
async function waitTerminal(admin, ticket, message) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const snapshot = await admin.get(`/api/v1/tickets/${ticket}`)
    if (['succeeded', 'failed', 'cancelled', 'reconciling'].includes(snapshot.status)) return snapshot
    await pause(150)
  }
  throw new Error(`${message}: ${JSON.stringify(await admin.get(`/api/v1/tickets/${ticket}`))}`)
}
function expectedRevokeDigest(_grant, reference, node, projectId) {
  const body = { asset_action: 'revoke', binding_id: reference.binding_id,
    ref_recordkey: reference.record_key, installation_id: node.installation_id,
    node_id: node.id, project_id: projectId, worker_id: reference.worker_id }
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')
}
async function proveUnknownReport({ admin, action, grant, node, projectId, inspected, ref }) {
  const file = join(root, 'node-state', 'credential-store', 'records.yaml')
  const original = await readFile(file)
  await writeFile(file, Buffer.concat([original, Buffer.from(`\nrecords:\n  loom-local-node/${ref.record_key}:\n    kind: grant\n    payload: {}\n`)]), { mode: 0o600 })
  let unknownTicket
  try {
    const otherGrant = await grant(['credential_revoke'])
    unknownTicket = await action('revoke', otherGrant.id, { inspection_ticket_id: inspected.id })
    const terminal = await waitTerminal(admin, unknownTicket.id, 'Unknown write Effect must be accepted as evidence')
    assert.equal(terminal.status, 'reconciling', JSON.stringify(terminal.reports))
    assert.equal(terminal.reports.length, 1)
    assert.equal(terminal.reports[0].state, 'unknown')
    assert.equal(terminal.effects.length, 1)
    assert.equal(terminal.effects[0].status, 'unknown')
    const body = await artifact(admin, terminal)
    assert.equal(body.state, 'unknown')
    assert.equal(body.configured, true)
    assert.equal(body.configured_state, 'present_metadata')
    assert.equal(body.value_exposed, false)
    const effect = terminal.effects[0]
    assert.deepEqual(effect.artifacts, [terminal.artifacts[0].id])
    assert.equal(effect.input_digest, expectedRevokeDigest(otherGrant, JSON.parse(unknownTicket.content).credential_ref, node, projectId))
    assert.equal(effect.id, stableArtifactId(`${effect.input_digest}:credential-revoke:v1:${unknownTicket.assignments[0].id}`))
    assert.equal(JSON.parse(effect.evidence).value_exposed, false)
    assert.deepEqual(body.record_subject.grant_credential_ref.scope, ref.scope)
    const identity = await (await import('../../packages/node-client/src/identity.js')).NodeIdentity.open(join(root, 'node-state'))
    const state = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
    assert.equal(state.outbox.length, 0)
    const delivery = state.deliveries?.find(entry => entry.kind === 'report' && entry.body.ticket_id === unknownTicket.id)
    assert.ok(delivery, 'Unknown evidence drained through the real node outbox')
    const http = new (await import('../../packages/node-client/src/http.js')).LoomHttpClient({ baseUrl: scenario.server.baseUrl })
    const replay = await http.post('/api/v1/nodes/reports', delivery.body, { token: identity.token })
    assert.equal(replay.duplicate, true)
    await assert.rejects(() => admin.post(`/api/v1/tickets/${unknownTicket.id}/retry`, {}), error => error.status === 400 && error.code === 'invalid_request')
    return unknownTicket.id
  } finally {
    await writeFile(file, original, { mode: 0o600 })
  }
}
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
