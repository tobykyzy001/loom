#!/usr/bin/env node
// Real Rust/Node enrollment, no fake registration response or external host/profile.
import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {LoomHttpClient} from '../../packages/node-client/src/http.js'
import {LoomNodeClient} from '../../packages/node-client/src/client.js'
import {NodeIdentity} from '../../packages/node-client/src/identity.js'
import {NodeState} from '../../packages/node-client/src/state.js'
import {startRustConcierge, testingRoot} from '../../scripts/fixtures/rust-server.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await testingRoot()
const evidence = await mkdtemp(join(tmpdir(), 'loom-registration-atomic-proof-'))
let center
const report = {
  overall: 'NOT RUN',
  scope: 'one-process Rust enrollment/signature/node/audit atomicity and existing-Node fencing',
  limits: [
    'single-process immediate SQLite transaction on an owned loopback fixture',
    'not lost-HTTP idempotency, arbitrary concurrent registration, remote/TLS, or a global exactly-once claim',
    'registration is not a Grant, and no worker execution, secret store, model, DSH profile, or mobile OS was involved',
    'no credential/token/private-key bytes are included in the evidence',
  ],
}
const results = {}
let auditTriggerInstalled = false
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function database() {
  if (!center) throw new Error('No owned Rust server is available')
  return new DatabaseSync(join(center.dataDir, 'loom.sqlite3'))
}
function withDatabase(callback) {
  const db = database()
  try {return callback(db)} finally {db.close()}
}
function snapshot(identity, code) {
  return withDatabase(db => ({
    enrollment_exists: db.prepare('SELECT COUNT(*) AS count FROM enrollment_codes WHERE token_hash=?').get(sha256(code)).count,
    unused:(db.prepare('SELECT COUNT(*) AS count FROM enrollment_codes WHERE token_hash=? AND used_at IS NULL').get(sha256(code)).count)===1,
    nodes: db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE id=? AND installation_id=?').get(identity.nodeId, identity.installationId).count,
    registration_audits: db.prepare("SELECT COUNT(*) AS count FROM audits WHERE action='node.registered' AND json_extract(evidence,'$.evidence.node_id')=?").get(identity.nodeId).count,
  }))
}
function challengeUnused(nonce) {
  return withDatabase(db => db.prepare('SELECT COUNT(*) AS count FROM challenges WHERE nonce=? AND used_at IS NULL').get(nonce).count === 1)
}
function tokenHash(identity) {
  return withDatabase(db => db.prepare('SELECT token_hash FROM nodes WHERE id=? AND installation_id=?').get(identity.nodeId, identity.installationId).token_hash)
}
async function http(route, {method = 'POST', token = null, body = null, admin = false} = {}) {
  const headers = {'content-type': 'application/json'}
  if (token) headers.authorization = `Bearer ${token}`
  if (admin) headers.authorization = `Bearer ${center.clientToken}`
  const response = await fetch(`${center.baseUrl}/api/v1${route}`, {method, headers, ...(body === null ? {} : {body: JSON.stringify(body)})})
  const json = await response.json()
  return {status: response.status, body: json}
}
const createCode = async () => (await http('/enrollment-codes', {body: {}, admin: true})).body.code
async function registration(identity, code) {
  const challenge = (await http('/nodes/challenge', {body: identity.public})) .body
  assert.equal(challenge.nonce.length, 64)
  return {
    ...identity.public,
    enrollment_code: code,
    nonce: challenge.nonce,
    signed_challenge: identity.sign(challenge.nonce),
    request_id: randomUUID(),
    capabilities: [{ticket_kind: 'read_summary', permission:'read'}],
    worker_id: 'default', harness_kind: 'local-fixture', profile_id: 'isolated',
  }
}
function heartbeatBody(identity) {
  return {
    ...identity.public,
    request_id: randomUUID(),
    status: 'online',
    capabilities: [{ticket_kind: 'read_summary', permission:'read'}],
    workers: [{
      worker_id: 'default', harness_kind: 'local-fixture', profile_id: 'isolated', status: 'online',
      capabilities: [{ticket_kind: 'read_summary', permission:'read'}], observed_at: new Date().toISOString(),
    }],
    inventory: {source: 'registration-test-fixture'},
  }
}
function outcome(result) {
  return {status: result.status, error_code: result.body.error?.code || null, token_returned: typeof result.body.token === 'string', accepted: result.body.accepted, protocol: result.body.protocol || null}
}
function nodeClient(identity) {
  return new LoomNodeClient({http: new LoomHttpClient({baseUrl:center.baseUrl}),identity, state: new NodeState()})
}
async function live(identity) {
  const durable = await NodeState.open(`${root}/node-state-${identity.nodeId}`)
  const client = new LoomNodeClient({http: new LoomHttpClient({baseUrl: center.baseUrl}), identity, state: durable})
  const {status, capabilities, workers, inventory} = heartbeatBody(identity)
  await client.heartbeat({status, capabilities, workers, inventory})
}
async function clean() {
  if (auditTriggerInstalled && center) {
    try {withDatabase(db => db.exec('DROP TRIGGER IF EXISTS reject_node_registration_audit'))} catch {}
    auditTriggerInstalled = false
  }
  if (center) await center.stop()
  report.cleanup ||= {}
  report.cleanup.server_stopped = true
  const actualRoot = await realpath(root)
  assert.equal(dirname(actualRoot), await realpath(tmpdir()), 'Only an exact test root may be removed')
  await rm(actualRoot, {recursive: true, force: true})
  report.cleanup.owned_profile_and_node_state_removed = true
  report.production_or_DSH_profile_untouched = true
  report.driver_sha256 = sha256(await readFile(fileURLToPath(import.meta.url)))
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600})
}
try {
  report.source = {head:execFileSync('git', ['rev-parse','HEAD'], {cwd:repository, encoding:'utf8'}).trim(), registration_source_sha256:sha256(await readFile(join(repository,'crates/concierge/src/api.rs')))}
  center = await startRustConcierge({root})
  const first = await NodeIdentity.open(join(root, 'identity-first'))
  const firstClient = nodeClient(first)
  const code = await createCode()
  const initialProof = await registration(first, code)
  const invalid = {...initialProof, signed_challenge: Buffer.alloc(64).toString('base64url')}
  const invalidResult = outcome(await http('/nodes/register',{body:invalid}))
  assert.notEqual(invalidResult.status, 200)
  assert.equal(invalidResult.token_returned, false)
  let observed = snapshot(first,code)
  assert.equal(observed.enrollment_exists,1)
  assert.equal(observed.unused,true)
  assert.equal(observed.nodes,0)
  assert.equal(observed.registration_audits,0)
  assert.equal(challengeUnused(invalid.nonce),true)
  const preFailure = structuredClone(observed)
  await firstClient.enroll({enrollmentCode:code,capabilities:[{ticket_kind:'read_summary',permission:'read'}]})
  observed = snapshot(first,code)
  assert.equal(observed.unused,false)
  assert.equal(observed.nodes,1)
  assert.equal(observed.registration_audits,1)
  assert.equal(challengeUnused(invalid.nonce),true)
  assert.equal(typeof first.token,'string')
  assert.ok(first.token)
  await live(first)
  results.invalid_signature = {status:invalidResult.status,before:preFailure,recovery_status:200,valid_code_consumed_only_after_commit:true,first_node_audits:1}

  // Replaying either proof without the existing credential must not mint one.
  const replay = outcome(await http('/nodes/register',{body:initialProof}))
  assert.notEqual(replay.status,200)
  assert.equal(replay.token_returned,false)
  const rotationCode = await createCode()
  const originalTokenHash = tokenHash(first)
  const originalToken = first.token
  await firstClient.enroll({enrollmentCode:rotationCode,capabilities:[{ticket_kind:'read_summary',permission:'read'}]})
  assert.notEqual(first.token,'')
  assert.notEqual(tokenHash(first),originalTokenHash)
  assert.equal(snapshot(first,rotationCode).unused,true,'rotation must not consume fresh enrollment proof')
  await live(first)
  const oldHeartbeat = await http('/nodes/heartbeat',{body:heartbeatBody(first) ,token:originalToken})
  assert.notEqual(oldHeartbeat.status,200)
  results.credential_rotation = {same_public_key:true,new_token_differs:true,rotation_does_not_consume_fresh_code:true,superseded_token_rejected:true,valid_new_credential_works:true}
  results.original_proof_replay = {status:replay.status,no_new_credential:true}

  assert.ok(!snapshot(first,code).unused,'committed first token must not roll back its legitimate enrollment consumption')
  const other = await NodeIdentity.open(join(root,'identity-other'))
  const foreignCode = await createCode()
  const foreign = await registration(other,foreignCode)
  foreign.node_id = first.nodeId
  const foreignResult = outcome(await http('/nodes/register',{body:foreign,token:first.token}))
  assert.notEqual(foreignResult.status,200)
  assert.equal(snapshot(other,foreignCode).unused,true)
  const beforeBadRotation = tokenHash(first)
  const withoutCredential = outcome(await http('/nodes/register',{body:await registration(first,await createCode())}))
  assert.notEqual(withoutCredential.status,200)
  assert.equal(tokenHash(first),beforeBadRotation)
  results.bad_rotation = {wrong_identity_status:foreignResult.status,absent_credential_status:withoutCredential.status,existing_credential_hash_unchanged:true}

  // A genuine audit INSERT failure is injected into this specific server's plan.
  withDatabase(db => db.exec(`CREATE TRIGGER reject_node_registration_audit BEFORE INSERT ON audits WHEN NEW.action='node.registered' BEGIN SELECT RAISE(ABORT,'owned registration audit injection'); END;`))
  auditTriggerInstalled = true
  const auditCode = await createCode()
  const pending = await registration(other,auditCode)
  const rejected = outcome(await http('/nodes/register',{body:pending}))
  assert.ok(rejected.status>=400,rejected.status<600)
  assert.equal(rejected.token_returned,false)
  observed = snapshot(other,auditCode)
  assert.equal(observed.unused,true,'audit rejection must roll back the consumed enrollment')
  assert.equal(observed.nodes,0,'audit rejection must roll back the Node row')
  assert.equal(observed.registration_audits,0)
  assert.equal(challengeUnused(pending.nonce),true,'audit rejection must roll back challenge consumption')
  assert.equal((await http('/audit/verify',{method:'GET',admin:true})).body.valid,true)
  withDatabase(db => db.exec('DROP TRIGGER reject_node_registration_audit'))
  auditTriggerInstalled = false
  const otherClient = nodeClient(other)
  await otherClient.enroll({enrollmentCode:auditCode,capabilities:[{ticket_kind:'read_summary',permission:'read'}]})
  assert.equal(snapshot(other,auditCode).nodes,1)
  assert.equal(snapshot(other,auditCode).registration_audits,1)
  await live(other)
  assert.notEqual(other.nodeId,first.nodeId)
  const cross = await http('/nodes/heartbeat',{token:first.token,body:heartbeatBody(other)})
  assert.notEqual(cross.status,200)
  results.audit_rollback = {status:rejected.status,enrollment_unused:true,challenge_unused:true,node_absent:true,audit_absent:true,audit_chain_valid:true,second_node_recovery_status:200}
  results.independent_node = {different_node_id:true,foreign_credential_cannot_operate:true,no_grants_or_tasks_created:true}

  await http(`/nodes/${first.nodeId}/revoke`,{admin:true})
  const revocationCode = await createCode()
  const revokedNonce = await registration(first,revocationCode)
  const revocation = outcome(await http('/nodes/register',{body:revokedNonce,token:first.token}))
  assert.notEqual(revocation.status,200)
  assert.equal(snapshot(first,revocationCode).unused,true,'revocation must not let a fresh code resurrect the identity')
  assert.equal(challengeUnused(revokedNonce.nonce),true)
  const revokedHeartbeat = await http('/nodes/heartbeat',{token:first.token,body:{...first.public,status:'online',capabilities:[{ticket_kind:'read_summary',permission:'read'}],workers:[{worker_id:'default'}],inventory:{}}})
  assert.notEqual(revokedHeartbeat.status,200)
  await live(other)
  assert.equal(withDatabase(db=>db.prepare('SELECT COUNT(*) AS count FROM grants').get().count),0)
  assert.equal(withDatabase(db=>db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count),0)
  results.revocation = {status:revocation.status,fresh_code_unused:true,new_challenge_unused:true,existing_token_rejected:true,other_node_still_works:true}
  const stableTokenHash = tokenHash(other)
  const expectedRegisteredAudits = snapshot(first,code).registration_audits + snapshot(other,auditCode).registration_audits

  const oldCenter = center
  await oldCenter.stop()
  center = await startRustConcierge({root})
  assert.notEqual(center.baseUrl,oldCenter.baseUrl)
  assert.equal(withDatabase(db=>db.prepare('PRAGMA integrity_check').get().integrity_check),'ok')
  assert.equal((await http('/audit/verify',{method:'GET',admin:true})).body.valid,true)
  assert.equal(withDatabase(db=>db.prepare("SELECT COUNT(*) AS count FROM audits WHERE action='node.registered'").get().count),expectedRegisteredAudits)
  assert.equal(tokenHash(other),stableTokenHash)
  await live(other)
  results.restart = {sqlite_integrity:true,audit_chain_valid:true,node_credential_persisted:true,node_count_with_revoked_and_health:2,registered_actions_are_historical_evidence:expectedRegisteredAudits}
  report.results = results
  report.overall = 'PASS'
} catch(error) {
  report.error = String(error.stack || error)
  report.results = results
  report.overall = 'FAIL'
} finally {
  await clean()
  console.log(JSON.stringify({overall:report.overall,evidence,error:report.error,results:report.results,cleanup:report.cleanup},null,2))
  if(report.overall!=='PASS')process.exitCode=1
}
