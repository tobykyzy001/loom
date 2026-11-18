#!/usr/bin/env node
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareProject, startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'

// A real registered LocalNode/HTTP/SQLite proof, not a DSH producer/cancellation
// claim. Every audit fault and its cleanup belongs only to this temporary center.
const root = await testingRoot()
const token = 'a'.repeat(48)
let center, runner, db
const result = { overall: 'NOT RUN', scope: 'atomic-acknowledgement-and-corresponding-audit' }
try {
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: token } })
  const admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken: token })
  const project = await admin.post('/api/v1/projects', { name: 'Acknowledgement consistency fixture', root: await prepareProject(root), mode: 'read_write' })
  const projectId = project.project.id
  const projectRoot = project.project.root
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  runner = new LocalNodeRunner({ stateDir: join(root, 'node-state'), artifactDir: join(root, 'artifacts'), baseUrl: center.baseUrl,
    registration: { workerId: 'default', harnessKind: 'deterministic-loopback' }, projectRoots: { [projectId]: projectRoot } })
  await runner.start({ enrollmentCode: enrollment.code })
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId,
    node_id: runner.nodeId, installation_id: runner.installationId, worker_id: 'default', root_scope: projectRoot })
  const grant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id,
    node_id: runner.nodeId, worker_id: 'default', operations: ['read', 'write'] })
  const ticket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: runner.nodeId,
    worker_id: 'default', grant_id: grant.grant.id, kind: 'edit_file', relative_path: 'ack-only.txt',
    objective: 'Exercise one exact acknowledgement and its audit atomically without invoking an executor',
    content: 'The probe does not invoke an executor.\n' })
  const assignment = await runner.client.poll({ waitSeconds: 0 })
  assert.equal(assignment.id, ticket.assignments[0].id)
  db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'))
  db.exec(`CREATE TRIGGER deny_acknowledgement_audit BEFORE INSERT ON audits
    WHEN NEW.action='assignment.acknowledged' BEGIN SELECT RAISE(ABORT,'owned acknowledgement audit fault'); END;`)
  const before = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.equal(before.assignments[0].acknowledged_at, null)
  await assert.rejects(() => runner.client.acknowledge({ ticketId: ticket.id, assignmentId: assignment.id,
    leaseEpoch: assignment.lease_epoch, accepted: true }))
  const deniedRow = db.prepare('SELECT acknowledged_at FROM assignments WHERE id=?').get(assignment.id)
  assert.equal(deniedRow.acknowledged_at, null, 'A failed audit must not leave a committed acknowledgement timestamp')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audits WHERE action='assignment.acknowledged'").get().n, 0,
    'No partially accepted acknowledgement audit may exist after its sequence fails')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effects').get().n, 0)
  db.exec('DROP TRIGGER deny_acknowledgement_audit')

  const accepted = await runner.client.acknowledge({ ticketId: ticket.id, assignmentId: assignment.id,
    leaseEpoch: assignment.lease_epoch, accepted: true })
  assert.equal(accepted.response.accepted, true)
  const detail = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.equal(detail.assignments.length, 1)
  assert.ok(detail.assignments[0].acknowledged_at)
  const auditRow = db.prepare("SELECT evidence FROM audits WHERE action='assignment.acknowledged'").get()
  assert.ok(auditRow)
  const evidence = JSON.parse(auditRow.evidence).evidence
  assert.equal(evidence.assignment_id, assignment.id)
  assert.equal(evidence.delivered_is_not_read, true)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audits WHERE action='assignment.acknowledged'").get().n, 1)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  Object.assign(result, { overall: 'PASS', assignment_id: assignment.id, lease_id: assignment.lease_id,
    audit_rejected_leaves_no_acknowledgement: true, later_valid_ack_hits_exact_assignment: true,
    denied_then_accepted_counts: { reports: 0, artifacts: 0, effects: 0 },
    cancellation_or_effect_created_by_ack: false, registered_local_node_http_sqlite: true })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  Object.assign(result, { overall: 'FAIL', error: error.message })
  console.error(error.stack)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = 1
} finally {
  if (db) db.close()
  if (runner) { try { await runner.stop() } catch {} }
  if (center) await center.stop()
}
