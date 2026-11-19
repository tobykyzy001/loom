#!/usr/bin/env node
import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises'
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
const evidence = await mkdtemp(join(tmpdir(), 'loom-installation-binding-proof-'))
let center
const report = {
  overall: 'NOT RUN',
  phase: 'startup',
  limits: [
    'two logical installations intentionally share one legitimate public key, not two physical hosts',
    'a host/project declaration is needed for binding and is not certification of a real DSH Profile or hardware',
    'only project binding and its audit are made transactional; other grant/assignment atomicity is unchanged',
    'the current Vue binding dialog does not yet expose this explicit installation selector',
    'tokens/private keys are not included in this report',
  ],
  results: {},
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function database(callback) {
  const db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'))
  try { return callback(db) } finally { db.close() }
}
function auditChain(db) {
  let previous = 'GENESIS'
  for (const row of db.prepare('SELECT actor,action,ticket_id,evidence,previous_hash,hash,created_at FROM audits ORDER BY sequence').all()) {
    const expected = hash(`${previous}\n${row.created_at}\n${row.actor}\n${row.action}\n${row.ticket_id || ''}\n${row.evidence}`)
    if (row.previous_hash !== previous || row.hash !== expected) return false
    previous = row.hash
  }
  return true
}
async function post(path, body, { token, expectedStatus } = {}) {
  const response = await fetch(`${center.baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${token ?? center.clientToken}`},
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch (_) { throw new Error(`Expected JSON from ${path} (${response.status}), not raw body`) }
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, `${path}: ${text}`)
  return { status: response.status, body: payload }
}
async function heartbeat(identity, project, rootPath, index) {
  const client = new LoomNodeClient({http: new LoomHttpClient({baseUrl: center.baseUrl}), identity, state: new NodeState()})
  const redemption = await post('/enrollment-codes', {})
  assert.ok(redemption.status >= 200 && redemption.status < 300,
    `Enrollment code creation must succeed, got ${redemption.status}`)
  await client.enroll({
    enrollmentCode: redemption.body.code,
    capabilities: [{ticket_kind: 'read_summary', permission: 'read'}],
    profileId: `installed-${index}`,
  })
  await client.heartbeat({
    ...identity.public, request_id: randomUUID(), status: 'online',
    capabilities: [{ticket_kind: 'read_summary', permission: 'read'}],
    workers: [{
      worker_id: 'default', harness_kind: 'bare-rust-deterministic', profile_id: `installed-${index}`,
      status: 'online', capabilities: [{ticket_kind: 'read_summary', permission: 'read'}],
      observed_at: new Date().toISOString(),
    }],
    inventory: { project_roots: { [project]: rootPath } },
  })
}
function count(table) {
  assert.ok(['project_bindings', 'grants', 'tickets', 'assignments', 'reports', 'artifacts', 'effects'].includes(table))
  return database(db => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)
}
function bindingCount() { return count('project_bindings') }
function bindingAudits() { return database(db => db.prepare("SELECT count(*) AS count FROM audits WHERE action='project.binding.approved'").get().count) }

async function main() {
  const rootAPath = join(root, 'project-a')
  const rootBPath = join(root, 'project-b')
  await mkdir(rootAPath, {mode: 0o700})
  await mkdir(rootBPath, {mode: 0o700})
  const rootA = await realpath(rootAPath)
  const rootB = await realpath(rootBPath)
  await writeFile(join(rootB, 'source.txt'), 'owned binding fixture\n')
  const created = await post('/projects', { name: 'Owned two-installation binding fixture', root: rootB, mode: 'read_write' })
  const project = created.body.project.id
  const first = await NodeIdentity.open(join(root, 'identity-a'))
  const second = new NodeIdentity(join(root, 'identity-b', 'identity.json'), {
    ...first.data, installation_id: `${randomUUID()}-second`,
  })
  assert.equal(first.nodeId, second.nodeId)
  for (const [index, pair] of [[0, [first, rootA]], [1, [second, rootB]]]) {
    report.phase = `authenticated registration and heartbeat declaration ${index}`
    await heartbeat(pair[0], project, pair[1], index)
  }
  assert.equal(count('grants'), 0)
  assert.equal(count('tickets'), 0)
  report.results.registration_only = { two_distinct_installations: true, grants_created: 0 }

  const target = { project_id: project, node_id: first.nodeId, worker_id: 'default', root_scope: rootB }
  report.phase = 'multiple active installations require an explicit choice'
  const initial = await post('/project-bindings', target)
  const baseStatus = initial.status
  report.before_repair = {status: baseStatus, code: initial.body.error?.code}
  assert.equal(bindingCount(), 0)
  assert.equal(baseStatus, 409)
  assert.equal(initial.body.error?.code, 'exact_installation_required')
  report.results.multiple_active_choice = { status: baseStatus, no_binding_or_audit: bindingAudits() === 0 }

  report.phase = 'a Node credential cannot masquerade as a client administrator'
  const nodeTokenResponse = await post('/project-bindings', target, { token: first.token })
  assert.ok(nodeTokenResponse.status === 401 || nodeTokenResponse.status === 403,
    `Node token must not exercise the administrative route: ${nodeTokenResponse.status}`)
  assert.equal(bindingCount(), 0)
  report.results.node_token_negative = { status: nodeTokenResponse.status, binding_count: 0 }

  report.phase = 'invalid optional installation identifiers preserve the resource'
  for (const invalid of [17, '', null]) {
    await post('/project-bindings', { ...target, installation_id: invalid }, { expectedStatus: 400 })
    assert.equal(bindingCount(), 0)
  }
  const unknown = await post('/project-bindings', { ...target, installation_id: randomUUID() }, { expectedStatus: 404 })
  assert.equal(bindingCount(), 0)
  report.results.invalid_selectors = { unknown_status: unknown.status, invalid_shapes_rejected: 3, binding_count: 0, audit_count: bindingAudits() }

  report.phase = 'audit failure rolls back a valid exact-installation binding'
  database(db => db.exec(`CREATE TRIGGER reject_binding_approval_audit BEFORE INSERT ON audits WHEN NEW.action='project.binding.approved' BEGIN SELECT RAISE(ABORT,'owned binding audit failure'); END;`))
  const faultBefore = bindingCount()
  const failed = await post('/project-bindings', { ...target, installation_id: second.installationId })
  assert.equal(failed.status, 400)
  assert.equal(failed.body.error?.code, 'invalid_request')
  assert.equal(failed.body.error?.message, 'owned binding audit failure',
    'The failure must be this server-visible trigger, not a different binding validation error')
  assert.equal(bindingCount(), faultBefore)
  assert.equal(bindingAudits(), 0)
  report.results.audit_rollback = {
    http_status: failed.status, bindings_unchanged: true, binding_audit_count: 0,
    audit_chain_intact: database(auditChain),
  }
  database(db => db.exec('DROP TRIGGER reject_binding_approval_audit'))

  report.phase = 'selected second installation can bind and receive the matching read Grant'
  const approved = await post('/project-bindings', { ...target, installation_id: second.installationId })
  assert.ok(approved.status >= 200 && approved.status < 300, JSON.stringify(approved.body))
  assert.equal(bindingCount(), 1)
  const persisted = database(db => db.prepare(
    'SELECT id,node_id,installation_id,worker_id,root_scope,binding_digest FROM project_bindings WHERE id=?',
  ).get(approved.body.id))
  // DatabaseSync returns null-prototype rows; compare all selected data fields,
  // not an Object.prototype mismatch in the Node SDK.
  assert.deepEqual({...persisted}, {
    id: approved.body.id, node_id: first.nodeId, installation_id: second.installationId,
    worker_id: 'default', root_scope: rootB, binding_digest: approved.body.binding_digest,
  })
  const auditRows = database(db => db.prepare(
    "SELECT evidence FROM audits WHERE action='project.binding.approved'",
  ).all())
  assert.equal(auditRows.length, 1)
  assert.equal(JSON.parse(auditRows[0].evidence).evidence.binding_id, approved.body.id)
  const inventories = database(db => db.prepare(
    'SELECT installation_id,inventory FROM nodes WHERE id=?',
  ).all(first.nodeId))
  assert.equal(inventories.length, 2)
  for (const [identity, desiredRoot] of [[first, rootA], [second, rootB]]) {
    const row = inventories.find(value => value.installation_id === identity.installationId)
    assert.ok(row, 'Keep the exact second Installation record, not just the first Node ID row')
    assert.equal(JSON.parse(row.inventory).project_roots[project], desiredRoot,
      'A sibling installation declaration must not be replaced by the accepted binding')
  }
  report.results.selected = {
    exact_installation_and_worker: true,
    distinct_second_root_not_replaced: true,
    single_matching_binding_audit: true,
  }

  report.phase = 'wrong installation cannot claim a different root binding'
  const unknownRoot = await post('/project-bindings', {
    ...target, installation_id: second.installationId, root_scope: rootA,
  })
  assert.equal(unknownRoot.status, 403)
  assert.equal(bindingCount(), 1)
  assert.equal(bindingAudits(), 1)
  report.results.root_scope_negative = { status: unknownRoot.status, unchanged_selected_binding: true }

  const granted = await post('/grants', {
    project_id: project, node_id: first.nodeId, worker_id: 'default',
    project_binding_id: approved.body.id, operations: ['read'],
  })
  const grant = granted.body.grant
  assert.equal(grant.node_id, first.nodeId)
  assert.equal(grant.installation_id, second.installationId)
  assert.equal(grant.worker_id, 'default')
  assert.equal(grant.project_binding_id, approved.body.id)
  assert.deepEqual(grant.operations, ['read'])
  for (const table of ['tickets', 'assignments', 'reports', 'artifacts', 'effects']) assert.equal(count(table), 0)
  report.results.read_grant = {
    same_installation: true,
    same_binding_and_worker: true,
    only_read_permission: true,
    no_ticket_assignment_report_artifact_or_effect: true,
  }

  report.phase = 'revoked target cannot acquire a new binding'
  const beforeRevoked = bindingCount()
  const grantsBeforeRevoked = count('grants')
  database(db => db.prepare("UPDATE nodes SET revoked_at=?,status='revoked' WHERE id=? AND installation_id=?").run(
    new Date().toISOString(), first.nodeId, first.installationId,
  ))
  const revoked = await post('/project-bindings', {
    project_id: project, node_id: first.nodeId, installation_id: first.installationId,
    worker_id: 'default', root_scope: rootA,
  })
  assert.equal(revoked.status, 403)
  assert.equal(bindingCount(), beforeRevoked)
  assert.equal(count('grants'), grantsBeforeRevoked)
  report.results.revoked_fixture = {
    status: revoked.status,
    purpose: 'manual negative state, not a new per-installation revoke API',
    no_new_binding_or_grant: true,
  }

  report.phase = 'restart preserves SQLite, exact binding, Grant, and audit chain'
  await center.stop()
  center = await startRustConcierge({root})
  assert.equal(database(db => db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok')
  assert.ok(database(auditChain))
  const reopened = database(db => db.prepare(
    'SELECT installation_id,worker_id,root_scope,binding_digest FROM project_bindings WHERE id=?',
  ).get(approved.body.id))
  assert.deepEqual({...reopened}, {
    installation_id: second.installationId, worker_id: 'default', root_scope: rootB,
    binding_digest: approved.body.binding_digest,
  })
  const reopenedGrant = database(db => db.prepare(
    'SELECT installation_id,worker_id,project_binding_id,operations FROM grants WHERE id=?',
  ).get(grant.id))
  assert.equal(reopenedGrant.installation_id, second.installationId)
  assert.equal(reopenedGrant.worker_id, 'default')
  assert.equal(reopenedGrant.project_binding_id, approved.body.id)
  assert.deepEqual(JSON.parse(reopenedGrant.operations), ['read'])
  for (const table of ['tickets', 'assignments', 'reports', 'artifacts', 'effects']) assert.equal(count(table), 0)
  report.results.restart = { integrity: true, exact_binding_and_grant_preserved: true, audit_chain_valid: true }
}

try {
  center = await startRustConcierge({root})
  await main()
  report.overall = 'PASS'
} catch (error) {
  report.overall = 'FAIL'
  report.error = String(error.stack || error)
} finally {
  if (center) await center.stop()
  const actual = await realpath(root)
  assert.equal(dirname(actual), await realpath(tmpdir()))
  await rm(actual, { recursive: true, force: true })
  report.phase = 'cleanup'
  report.cleanup = { server_stopped: true, owned_root_removed: true, production_or_DSH_profile_untouched: true }
  report.source_sha256 = hash(await readFile(join(repository, 'crates/concierge/src/api.rs')))
  report.driver_sha256 = hash(await readFile(fileURLToPath(import.meta.url)))
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ overall: report.overall, phase: report.phase, evidence, error: report.error, results: report.results, cleanup: report.cleanup }, null, 2))
}
