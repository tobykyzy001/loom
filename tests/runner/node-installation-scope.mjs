#!/usr/bin/env node
// Real same-Node-key distinct Installation heartbeats; no claim about physical multi-Host.
import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {NodeIdentity} from '../../packages/node-client/src/identity.js'
import {NodeState} from '../../packages/node-client/src/state.js'
import {LoomHttpClient} from '../../packages/node-client/src/http.js'
import {LoomNodeClient} from '../../packages/node-client/src/client.js'
import {startRustConcierge, testingRoot} from '../../scripts/fixtures/rust-server.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await testingRoot()
const evidence = await mkdtemp(join(tmpdir(), 'loom-node-installation-scope-proof-'))
let center
const report = {
  overall: 'NOT RUN',
  scope: 'exact authenticated Node/Installation heartbeat storage, keeping otherwise legitimate independent installations distinct',
  limits: [
    'one public key intentionally reused by two logical local installations; this is not two physical nodes',
    'self-reported inventory/workers are observations, not new worker rights, Grant or execution proof',
    'does not define a new per-Installation revocation or DSH Profile protocol, OS platform, remote network, or global exactly-once',
    'private keys, node tokens and Authorization values are excluded from the evidence',
  ],
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const results = {}
const sql = center => new DatabaseSync(join(center.dataDir, 'loom.sqlite3'))
// Report named verification groups; no token/private-key or credential blob content.
async function heartbeatBody(identity, {status = 'online', marker = 'marker'} = {}) {
  return {
    ...identity.public, request_id: randomUUID(), status,
    capabilities: [{ticket_kind: 'read_summary', permission: 'read'}],
    workers: [{worker_id: 'default', harness_kind: 'local-fixture', profile_id: marker, status, capabilities: [{ticket_kind:'read_summary',permission:'read'}], observed_at: new Date().toISOString()}],
    inventory: {marker},
  }
}
async function scenario() {
  const first = await NodeIdentity.open(join(root, 'identity-first'))
  const firstData = first.data
  const second = new NodeIdentity(join(root,'identity-second','identity.json'),{...firstData, installation_id:`${randomUUID()}-installation-second`})
  const deployments = [first, second]
  assert.equal(first.nodeId, second.nodeId)
  assert.notEqual(first.installationId, second.installationId)
  const admin = new LoomHttpClient({baseUrl:center.baseUrl,clientToken:center.clientToken})
  const clients = new Map()
  for(const identity of deployments){
    const client = new LoomNodeClient({http:new LoomHttpClient({baseUrl:center.baseUrl}),identity,state:new NodeState()})
    const issued = await admin.post('/api/v1/enrollment-codes',{})
    await client.enroll({enrollmentCode:issued.code,capabilities:[{ticket_kind:'read_summary',permission:'read'}],profileId:`installed-${identity.installationId}`})
    clients.set(identity.installationId, client)
  }
  return {first,second,clients}
}
async function main() {
  const {first,second,clients} = await scenario()
  const db = sql(center)
  const name = first.nodeId
  const read = installation => db.prepare('SELECT inventory,workers,capabilities,status,last_heartbeat,revoked_at FROM nodes WHERE id=? AND installation_id=?').get(name,installation)
  const baselineSecond = read(second.installationId)
  assert.notEqual(JSON.stringify(read(first.installationId).inventory),JSON.stringify(baselineSecond.inventory))
  await clients.get(first.installationId).heartbeat(await heartbeatBody(first,{status:'busy',marker:'first-inventory'}))
  let left = read(first.installationId)
  let right = read(second.installationId)
  assert.equal(JSON.parse(left.inventory).marker,'first-inventory')
  assert.equal(left.status,'busy')
  assert.deepEqual(right,baselineSecond,'A first Installation heartbeat must not change the other row at all')
  results.keep_workers_and_inventory_after_first = {first_is_only_changed:true,second_untouched:true}
  const beforeSecondHeartbeat = read(first.installationId)
  await clients.get(second.installationId).heartbeat(await heartbeatBody(second,{marker:'second-inventory'}))
  left = read(first.installationId)
  right = read(second.installationId)
  assert.equal(JSON.parse(right.inventory).marker,'second-inventory')
  assert.equal(JSON.parse(right.workers)[0].profile_id,'second-inventory')
  assert.deepEqual(left,beforeSecondHeartbeat,'The second heartbeat must not overwrite the first row')
  results.distinct_state_after_both = {independent_inventory_and_worker_identity:true,last_heartbeat_fields_preserved:true}

  const directHttp = async (identity,token) => fetch(`${center.baseUrl}/api/v1/nodes/heartbeat`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(await heartbeatBody(identity,{marker:identity.installationId}))})
  const wrong = await directHttp(first,second.token)
  assert.notEqual(wrong.status,200)
  assert.equal(JSON.parse(read(first.installationId).inventory).marker,'first-inventory')
  results.foreign_token = {status:wrong.status,body_cannot_update_other_installation:true}
  // Exercise currently revoked identity state through the actual controller path.
  db.prepare('UPDATE nodes SET revoked_at=?,status=\'revoked\' WHERE id=? AND installation_id=?').run(new Date().toISOString(),name,first.installationId)
  const revoked = await directHttp(first,first.token)
  assert.notEqual(revoked.status,200)
  assert.equal(read(first.installationId).status,'revoked')
  const surviving = await directHttp(second,second.token)
  assert.equal(surviving.status,200)
  assert.equal(JSON.parse(read(first.installationId).inventory).marker,'first-inventory')
  assert.equal(JSON.parse(read(second.installationId).inventory).marker,second.installationId)
  results.revoked_fixture = {heartbeat_cannot_override_revoked:true,unrelated_installation_still_accepts:true,raw_fixture_marks_state_for_negative_only:true}

  db.close()
  await center.stop()
  center = await startRustConcierge({root})
  const reopened = sql(center)
  assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  const restored = reopened.prepare('SELECT inventory,workers FROM nodes WHERE id=? AND installation_id=?').get(second.nodeId,second.installationId)
  assert.equal(JSON.parse(restored.inventory).marker,second.installationId)
  reopened.close()
  const continuing = new LoomNodeClient({http:new LoomHttpClient({baseUrl:center.baseUrl}),identity:second,state:new NodeState()})
  await continuing.heartbeat(await heartbeatBody(second,{marker:'after-restart'}))
  results.restart = {sqlite_integrity:true,surviving_independent_installation_recovers:true}
  report.results = results
  report.overall = 'PASS'
}
async function cleanup() {
  if(center)await center.stop()
  const actual = await realpath(root)
  assert.equal(dirname(actual),await realpath(tmpdir()))
  await rm(actual,{recursive:true,force:true})
  report.cleanup = {server_stopped:true,owned_root_removed:true,production_or_DSH_profile_untouched:true}
  report.source_sha256=hash(await readFile(join(repository,'crates/concierge/src/api.rs')))
  report.driver_sha256=hash(await readFile(fileURLToPath(import.meta.url)))
  await writeFile(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
}
try {
  center = await startRustConcierge({root})
  await main()
} catch(error) {
  report.error=String(error.stack||error)
  report.overall='FAIL'
} finally {
  await cleanup()
  console.log(JSON.stringify({overall:report.overall,evidence,error:report.error,results:report.results,cleanup:report.cleanup},null,2))
  if(report.overall!=='PASS')process.exitCode=1
}
