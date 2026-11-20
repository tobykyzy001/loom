import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { startRustConcierge, testingClientToken, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const checks = []
const pass = (name, evidence = {}) => checks.push({ name, status: 'PASS', ...evidence })
const expectReject = async (request, predicate) => {
  await assert.rejects(request, error => predicate(error))
}
const component = {
  kind: 'bare_host', version: '0.1.0',
  sha256: '1c9dc260a2d689602a6e133b9017561d9b69c30136834e08f51aaa05de3542c5',
  source: 'local_package_candidate',
}
const target = name => ({ host_key: name, os: 'darwin', arch: 'arm64', baseline_version: '0.0.0', requested_version: '0.1.0', selected: true })
const manifest = targets => ({ schema: 'loom.install-plan.v1', source: 'explicit_admin_inventory_manifest', component, targets })
const locate = (view, id) => view.plan.targets.find(t => t.id === id)
let server
try {
  const root = await testingRoot()
  const clientToken = testingClientToken()
  const build = await promisify(execFile)('cargo', ['build', '--locked', '-p', 'loom-concierge', '--bin', 'loom'], { timeout: 120000 })
  assert.equal(build.stderr.includes('error['), false)
  const binary = `${process.cwd()}/target/debug/loom`
  server = await startRustConcierge({ root, env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: clientToken, LOOM_INSTALL_SIMULATION: 'synthetic_inventory', LOOM_TARGET_BINARY: binary } })
  let client = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const beforeTickets = (await client.get('/api/v1/tickets')).tickets.length
  const beforeGrants = (await client.get('/api/v1/grants')).grants.length
  await expectReject(client.post('/api/v1/install-plans', manifest([target('fixture-a'), target('fixture-a')])), e => e.status === 400)
  const malformed = await fetch(`${server.baseUrl}/api/v1/install-plans`, { method: 'POST', headers: { authorization: `Bearer ${server.clientToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...manifest([target('fixture-a')]), ssh_private_key: 'never accepted' }) })
  assert.equal(malformed.status, 422)
  await expectReject(client.post('/api/v1/install-plans', manifest([{ ...target('physical-host'), os: 'linux' }])), e => e.status === 400)
  await expectReject(client.post('/api/v1/install-plans', { ...manifest([target('fixture-version')]), component: { ...component, version: '0.2.0' } }), e => e.status === 400)
  assert.equal((await client.get('/api/v1/install-plans')).plans.length, 0)
  pass('duplicate, unknown secret field, physical host and incompatible version create no plan')

  const created = await client.post('/api/v1/install-plans', manifest([
    target('fixture-healthy'), target('fixture-health-failure'), target('fixture-unknown'),
    { ...target('fixture-not-selected'), selected: false },
  ]))
  const id = created.plan.id
  assert.equal(id === created.plan.plan_digest, false)
  assert.equal(created.plan.schema, 'loom.install-plan.v1')
  assert.equal(created.policy.remote_execution, false)
  assert.equal(created.policy.fixture_reporting, true)
  const ids = Object.fromEntries(created.plan.targets.map(t => [t.host_key, t.id]))
  assert.equal(created.plan.targets[3].status, 'not_selected')
  const before = await client.get(`/api/v1/install-plans/${id}`)
  const badApproval = client.post(`/api/v1/install-plans/${id}/approve`, { target_id: ids['fixture-healthy'], reviewed_plan_digest: '0'.repeat(64) })
  await expectReject(badApproval, e => e.status === 400)
  for (const host of ['fixture-not-selected']) {
    await expectReject(client.post(`/api/v1/install-plans/${id}/approve`, { target_id: ids[host], reviewed_plan_digest: created.plan.plan_digest }), e => e.status === 400)
  }
  assert.deepEqual((await client.get(`/api/v1/install-plans/${id}`)).plan, before.plan)
  pass('admin approval binds immutable manifest; rejected inputs do not mutate plan')

  const approve = async host => {
    const result = await client.post(`/api/v1/install-plans/${id}/approve`, { target_id: ids[host], reviewed_plan_digest: created.plan.plan_digest })
    const row = locate(result, ids[host])
    assert.equal(row.status, 'approved')
    assert.ok(row.current_operation_id)
    return row.current_operation_id
  }
  const observe = async (host, operation, outcome) => client.post(`/api/v1/install-plans/${id}/observe`, { target_id: ids[host], operation, outcome })
  const expectBadOperation = async () => {
    await expectReject(client.post(`/api/v1/install-plans/${id}/observe`, { target_id: ids['fixture-healthy'], operation: 'rollback', outcome: 'healthy' }), e => e.status === 400)
  }
  const healthyOperation = await approve('fixture-healthy')
  await expectBadOperation()
  await observe('fixture-healthy', 'apply', 'healthy')
  assert.equal((await client.get(`/api/v1/install-plans/${id}`)).plan.targets.find(t => t.id === ids['fixture-healthy']).current_version, '0.1.0')
  const healthyRollback = await client.post(`/api/v1/install-plans/${id}/rollback-approve`, { target_id: ids['fixture-healthy'], operation_id: healthyOperation })
  assert.equal(locate(healthyRollback, ids['fixture-healthy']).status, 'rollback_approved')
  await observe('fixture-healthy', 'rollback', 'healthy')
  assert.equal((await client.get(`/api/v1/install-plans/${id}`)).plan.targets.find(t => t.id === ids['fixture-healthy']).current_version, '0.0.0')
  pass('healthy apply and explicitly approved rollback retain observed current versions', { host_execution: false })

  const failedOperation = await approve('fixture-health-failure')
  const failed = await observe('fixture-health-failure', 'apply', 'health_failed')
  assert.equal(locate(failed, ids['fixture-health-failure']).current_version, '0.0.0')
  const badRollback = client.post(`/api/v1/install-plans/${id}/rollback-approve`, { target_id: ids['fixture-health-failure'], operation_id: 'installop_wrong' })
  await expectReject(badRollback, e => e.status === 400)
  await client.post(`/api/v1/install-plans/${id}/rollback-approve`, { target_id: ids['fixture-health-failure'], operation_id: failedOperation })
  await observe('fixture-health-failure', 'rollback', 'healthy')
  pass('health failure cannot report healthy or bind another operation before rollback')

  await approve('fixture-unknown')
  const unknown = await observe('fixture-unknown', 'apply', 'connection_lost')
  assert.equal(locate(unknown, ids['fixture-unknown']).status, 'unknown')
  const original = (await client.get(`/api/v1/install-plans/${id}`)).plan
  const repeat = await observe('fixture-unknown', 'apply', 'connection_lost')
  assert.equal(repeat.duplicate, true)
  assert.deepEqual(repeat.plan, original)
  await expectReject(observe('fixture-unknown', 'apply', 'healthy'), e => e.status === 400)
  await expectReject(client.post(`/api/v1/install-plans/${id}/rollback-approve`, { target_id: ids['fixture-unknown'], operation_id: original.targets.find(t => t.id === ids['fixture-unknown']).current_operation_id }), e => e.status === 400)
  assert.equal((await client.get('/api/v1/tickets')).tickets.length, beforeTickets)
  assert.equal((await client.get('/api/v1/grants')).grants.length, beforeGrants)
  pass('unknown stays unknown, identical receipt is read-only, no Task/Grant created')

  const stateDir = server.dataDir
  await server.stop()
  server = await startRustConcierge({ root: dirname(stateDir), env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: clientToken, LOOM_TARGET_BINARY: binary } })
  client = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const recovered = await client.get(`/api/v1/install-plans/${id}`)
  assert.deepEqual(recovered.plan, original)
  assert.equal(recovered.policy.fixture_reporting, false)
  await expectReject(observe('fixture-healthy', 'rollback', 'healthy'), e => e.status === 501)
  const doctor = await promisify(execFile)('cargo', ['run', '-q', '-p', 'loom-concierge', '--bin', 'loom', '--', '--data-dir', server.dataDir, 'doctor'], { env: { ...process.env, LOOM_CLIENT_TOKEN: server.clientToken }, timeout: 120000 })
  const persistence = JSON.parse(doctor.stdout)
  assert.equal(persistence.schema_version, 16)
  assert.equal(persistence.integrity[0].integrity_check, 'ok')
  assert.equal(persistence.audit_valid, true)
  assert.equal((await client.get('/api/v1/audit/verify')).valid, true)
  pass('real restart preserves exact plan; disabled observe fails closed with current storage schema 16 and valid audit', { storage_schema: persistence.schema_version })

  const incompatible = await client.post('/api/v1/install-plans', manifest([{ ...target('fixture-linux'), os: 'linux' }]))
  assert.equal(incompatible.plan.targets[0].status, 'incompatible')
  await expectReject(client.post(`/api/v1/install-plans/${incompatible.plan.id}/approve`, { target_id: incompatible.plan.targets[0].id, reviewed_plan_digest: incompatible.plan.plan_digest }), e => e.status === 400)
  pass('incompatible fixture never receives approval')

  console.log(JSON.stringify({ overall: 'PASS', schema: persistence.schema_version, protocol_schema: 'loom.install-plan.v1', proof_kind: 'synthetic_plan_only', host_execution: false, checks }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: error.stack, cause: error.cause, checks }, null, 2))
  process.exitCode = 1
} finally {
  if (server) await server.stop()
}
