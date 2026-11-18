#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { prepareProject, startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

// No DSH, outside provider, credential store or additional host is used.
const root = await testingRoot()
const clientToken = 'r'.repeat(48)
let center, runner
// Output goes to stdout; no private Keychain/provider or production Profile is read.
const result = { overall: 'NOT RUN', scope: 'authenticated-current-assignment-revocation-and-audit', native_dsh: 'NOT RUN', external_services: 'NOT RUN', additional_workers: 'NOT RUN' }
try {
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: clientToken } })
  const admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken })
  const projectRoot = await prepareProject(root)
  const project = await admin.post('/api/v1/projects', { name: 'Authenticated revocation and audit fixture', root: projectRoot, mode: 'read_write' })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const stateDir = join(root, 'node-state')
  const artifactDir = join(root, 'artifacts')
  runner = new LocalNodeRunner({ stateDir, artifactDir, baseUrl: center.baseUrl,
    registration: { workerId: 'default', harnessKind: 'deterministic-loopback' }, projectRoots: { [projectId]: projectRoot } })
  await runner.start({ enrollmentCode: enrollment.code })
  const nodes = (await admin.get('/api/v1/nodes')).nodes
  assert.deepEqual(nodes.find(row => row.id === runner.nodeId).inventory.project_roots,
    { [projectId]: projectRoot })
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId,
    node_id: runner.nodeId, installation_id: runner.installationId, worker_id: 'default', root_scope: projectRoot })
  const grant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id,
    node_id: runner.nodeId, worker_id: 'default', operations: ['read', 'write'] })
  assert.ok(grant.grant.id)
  const kind = 'edit_file', relative_path = 'withdraw-check.txt', content = 'No side effect in this fence proof.\n'
  const task = objective => admin.post('/api/v1/tickets', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default',
    grant_id: grant.grant.id, kind, relative_path, content, objective })
  const ticket = await task('Already admitted active file work; never execute in this HTTP protocol proof')
  const assignment = (await runner.client.poll({ waitSeconds: 0 }))
  assert.equal(assignment.id, ticket.assignments[0].id)
  const accepted = await runner.client.acknowledge({ ticketId: ticket.id, assignmentId: assignment.id,
    leaseEpoch: assignment.lease_epoch, accepted: true })
  assert.equal(accepted.response.accepted, true)
  const admitted = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.ok(admitted.assignments[0].acknowledged_at)
  assert.equal(admitted.assignments[0].last_report_at, null)
  const unclaimed = await task('Never acknowledged before Grant revocation')
  assert.equal(unclaimed.assignments.length, 1)
  // Real unclaimed Ticket leases populate the audit API beyond twenty-four rows.
  // They are not execution Requests or acknowledgements; only the original first
  // accepted assignment may subsequently receive the reconciling stop offer.
  for (let index = 0; index < 24; index++) {
    await task(`Unclaimed before Grant revocation, bounded lease candidate ${index}`)
  }
  await admin.post(`/api/v1/grants/${grant.grant.id}/revoke`, {})
  const current = (await admin.get('/api/v1/grants')).grants.find(row => row.id === grant.grant.id)
  assert.equal(current.version, 2)
  assert.ok(current.revoked_at)
  const after = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.equal(after.status, 'reconciling')
  assert.equal(after.cancel_requested, false)
  assert.equal(Number.isFinite(Date.parse(after.assignments[0].lease_expires_at)), true)
  const revokedFrame = await runner.client.poll({ lastAssignmentId: assignment.id, waitSeconds: 0 })
  assert.equal(revokedFrame?.id, assignment.id, 'Only the previously admitted unreported Assignment is offered for reconciling')
  assert.equal(revokedFrame.purpose, 'reconcile')
  assert.equal(revokedFrame.grant_status, false)
  assert.equal(revokedFrame.grant_version, 1)
  assert.equal(revokedFrame.grant.version, 2)
  assert.ok(revokedFrame.grant.revoked_at)
  assert.notEqual(revokedFrame.id, unclaimed.assignments[0].id)

  const deniedArtifact = await runner.client.artifact({ ticketId: ticket.id, assignmentId: assignment.id,
    leaseEpoch: assignment.lease_epoch,
    metadata: { artifact_id: randomUUID(), name: 'not-authorized-after-revoke.txt', media_type: 'text/plain', origin_node_id: runner.nodeId },
    bytes: Buffer.from('a rejected artifact, not a completed file effect\n') })
  const deniedReport = await runner.client.report({ ticketId: ticket.id, assignmentId: assignment.id,
    leaseEpoch: assignment.lease_epoch,
    state: 'succeeded', summary: 'Deliberately invalid normal report; current revoked lease must fence it.',
    effects: [{ effect_id: randomUUID(), status: 'confirmed', input_digest: 'return a + b', artifacts: [] }] })
  const delivery = await runner.client.dispatchOutbox()
  assert.equal(delivery.length, 2)
  assert.ok(delivery.every(row => row.status === 'deferred' && row.error.includes('409 outcome_unknown')), JSON.stringify(delivery))
  const db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'), { readonly: true })
  const counts = Object.fromEntries(['reports', 'artifacts', 'effects'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))
  assert.deepEqual(counts, { reports: 0, artifacts: 0, effects: 0 })
  const chain = db.prepare('SELECT COUNT(*) AS errors FROM audits WHERE action=(\'report.accepted\' OR action=\'artifact.indexed\')').get().errors
  assert.equal(chain, 0)
  const revokedAudit = db.prepare('SELECT action,evidence FROM audits WHERE action=\'grant.revoked\'').get()
  assert.ok(revokedAudit)
  assert.equal(JSON.parse(revokedAudit.evidence).evidence.grant_id, grant.grant.id)
  assert.equal(JSON.parse(revokedAudit.evidence).evidence.fencing, 'old_leases_expired')
  const rawAudit = await new Promise((resolve, reject) => {
    const req = httpGet(new URL('/api/v1/audit', center.baseUrl), {
      agent: false, method: 'GET', headers: { Authorization: `Bearer ${clientToken}` },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => resolve({ headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(10_000, () => req.destroy(new Error('owned loopback audit read timed out')))
    req.once('error', reject)
    req.end()
  })
  const rawBody = JSON.parse(rawAudit.body).audit
  assert.ok(rawBody.some(row => row.action === 'grant.revoked'), 'The live socket response must contain the newest revocation audit')
  console.log(JSON.stringify({ audit_headers: { content_length: rawAudit.headers['content-length'],
    transfer_encoding: rawAudit.headers['transfer-encoding'], connection: rawAudit.headers.connection },
    db_count: db.prepare('SELECT COUNT(*) AS n FROM audits').get().n,
    raw_socket_count: rawBody.length, first_returned_sequence: rawBody[0].sequence }))
  assert.equal(rawBody.length, db.prepare('SELECT COUNT(*) AS n FROM audits').get().n)
  const apiAudit = await admin.get('/api/v1/audit')
  assert.ok(apiAudit.audit.some(row => row.action === 'grant.revoked'))
  const auditVerify = await admin.get('/api/v1/audit/verify')
  assert.equal(auditVerify.valid, true)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  db.close()
  Object.assign(result, { overall: 'PASS', revoked_and_versioned: true,
    only_acknowledged_assignment_stop_offer: true, expired_old_artifact_and_report_fenced: true,
    no_new_centre_report_artifact_or_effect: true, persistent_revoke_audit: true,
    second_unclaimed_assignment_never_executed: true,
    required_source_audit_route_present: true, ...counts, file_bytes_unchanged: true })
  await assert.rejects(() => readFile(join(projectRoot, relative_path)), { code: 'ENOENT' })
  console.log(JSON.stringify(result, null, 2))
} catch (error) { Object.assign(result, { overall: 'FAIL', error: error.message }); console.error(error.stack); console.log(JSON.stringify(result, null, 2)); process.exitCode = 1 }
finally {
  if (runner) { try { await runner.stop() } catch {} }
  if (center) await center.stop()
}
