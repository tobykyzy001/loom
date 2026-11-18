import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { startRustConcierge, prepareProject, testingClientToken } from '../../scripts/fixtures/rust-server.mjs'

const root = await mkdtemp(join(tmpdir(), 'loom-source-ticket-'))
const projectRoot = await prepareProject(root)
const token = testingClientToken()
let server = await startRustConcierge({ root, env: { LOOM_CLIENT_TOKEN: token, PATH: process.env.PATH } })
let admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: token })
let sourceId
const count = sql => {
  const db = new DatabaseSync(join(root, 'concierge', 'loom.sqlite3'), { readOnly: true })
  const value = db.prepare(sql).get()
  db.close()
  return Object.values(value)[0]
}
const mutate = (sql, ...params) => {
  const db = new DatabaseSync(join(root, 'concierge', 'loom.sqlite3'))
  try { return db.prepare(sql).run(...params) } finally { db.close() }
}
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const replayDigest = specification => createHash('sha256').update(canonical({ ...specification, digest: null })).digest('hex')
const workEventView = async id => (await admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=known-dialogue&limit=200`)).events.find(event => event.id === id)
const counts = () => ['tickets', 'assignments', 'messages', 'audits', 'source_work_specs'].map(table => count(`SELECT COUNT(*) FROM ${table}`))
const ticketAudits = async id => (await admin.get(`/api/v1/audit?ticket_id=${encodeURIComponent(id)}`)).audit
const auditEvidence = entry => JSON.parse(entry.evidence).evidence
try {
  const project = await admin.post('/api/v1/projects', { name: 'Explicit authorized source task', root: projectRoot, mode: 'read_only' })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const runner = new LocalNodeRunner({ stateDir: join(root, 'node-state'), artifactDir: join(root, 'node-artifacts'), baseUrl: server.baseUrl,
    projectRoots: { [projectId]: projectRoot } })
  await runner.start({ enrollmentCode: enrollment.code })
  await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', root_scope: projectRoot })
  const granted = await admin.post('/api/v1/grants', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', operations: ['read'] })
  const source = await admin.post('/api/v1/sources', { source_key: 'authorized-work-control', kind: 'web', label: 'Explicit user instruction, not automatic authority' })
  sourceId = source.source.id
  const objective = 'Read the authorized fixture and preserve its immutable input evidence'
  const event = await admin.post('/api/v1/source-events', { source_id: source.source.id, thread_id: 'known-dialogue', event_id: 'read-under-existing-grant',
    kind: 'user_message', content: objective, occurred_at: '2026-01-01T01:00:00+01:00' })
  const sourceEventId = event.id
  assert.ok(event.thread_id)
  assert.equal(event.ticket_id, null)
  const spec = { project_id: projectId, node_id: runner.nodeId, worker_id: 'default',
    grant_id: granted.grant.id, kind: 'read_summary', relative_path: 'input.txt', objective }

  const diagnosedBinding = (await admin.get('/api/v1/grants')).grants.find(row => row.id === granted.grant.id).project_binding_id
  assert.equal(typeof diagnosedBinding, 'string', `Grant binding projection was ${JSON.stringify(diagnosedBinding)}`)
  assert.ok(diagnosedBinding)
  assert.equal(count(`SELECT COUNT(*) FROM project_bindings WHERE id='${diagnosedBinding}' AND project_id='${projectId}'`), 1)
  const actualGrant = (await admin.get('/api/v1/grants')).grants.find(row => row.id === granted.grant.id)
  assert.equal(actualGrant.project_id, projectId)
  assert.equal(actualGrant.project_binding_id, diagnosedBinding)
  assert.equal(actualGrant.node_id, runner.nodeId)
  assert.equal(count(`SELECT COUNT(*) FROM grants g JOIN project_bindings b ON g.project_binding_id=b.id AND g.project_id=b.project_id WHERE g.id='${granted.grant.id}'`), 1)
  const first = await admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId })
  const ticketId = first.ticket.id
  assert.equal(first.duplicate, false)
  assert.equal(first.task_created, true)
  assert.equal(first.source_event_id, sourceEventId)
  assert.equal(first.ticket.project_id, projectId)
  assert.equal(first.ticket.grant_digest, spec.grant_digest || granted.grant.digest)
  assert.equal(first.ticket.kind, 'read_summary')
  assert.equal(first.ticket.status, 'running')
  assert.equal(first.ticket.assignments.length, 1, 'The current valid worker/Grant creates one actual lease, not a placeholder')
  assert.equal(count('SELECT COUNT(*) FROM source_events WHERE ticket_id IS NULL AND task_ticket_id IS NOT NULL'), 1)
  const firstLink = await workEventView(sourceEventId)
  assert.equal(firstLink.ticket_id, null)
  assert.equal(firstLink.task_ticket_id, ticketId)
  assert.equal(firstLink.creation_kind, 'explicit_task_created_after_intake')
  assert.equal(firstLink.task_spec.ticket_id, ticketId)
  assert.equal(firstLink.task_spec.source_event_id, sourceEventId)
  assert.equal(firstLink.task_spec.event_request_digest, event.payload_digest)
  assert.equal(firstLink.task_digest, replayDigest(firstLink.task_spec))
  const rawSpecStorage = count(`SELECT COALESCE(LENGTH(spec_json),-1) FROM source_work_specs WHERE event_id='${sourceEventId}'`)
  assert.ok(rawSpecStorage > 0, 'The independent canonical work-spec row must actually exist')
  assert.equal(count(`SELECT COALESCE(LENGTH(task_spec_json),-1) FROM source_events WHERE id='${sourceEventId}'`), rawSpecStorage, 'Event link must retain the same canonical task spec')
  assert.equal(count('SELECT COUNT(*) FROM source_work_specs'), 1)
  assert.equal(count('SELECT COUNT(*) FROM tickets'), 1)
  assert.equal(count('SELECT COUNT(*) FROM assignments'), 0 + 1)

  const replay = await admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId })
  assert.equal(replay.duplicate, true)
  assert.equal(replay.task_created, false)
  assert.deepEqual(replay.ticket, first.ticket)
  await Promise.all(Array.from({ length: 3 }, () => admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId })))
  assert.equal(count('SELECT COUNT(*) FROM tickets'), 1)
  assert.equal(count('SELECT COUNT(*) FROM assignments'), 1)

  for (const alteration of [
    { sql: `UPDATE source_events SET task_ticket_id=NULL,task_digest=NULL,task_spec_json=NULL,creation_kind='unbound' WHERE id='${sourceEventId}'`, expected: /bound_source_task_is_immutable/ },
    { sql: `UPDATE source_events SET task_digest='f${'f'.repeat(63)}' WHERE id='${sourceEventId}'`, expected: /source_event_spec_mismatch|source_work_spec_missing|bound_source_task_is_immutable/ },
    { sql: `UPDATE source_events SET payload_digest='${'f'.repeat(64)}' WHERE id='${sourceEventId}'`, expected: /source_event_identity_is_immutable/ },
    { sql: `UPDATE source_events SET occurred_at=NULL WHERE id='${sourceEventId}'`, expected: /source_event_identity_is_immutable/ },
    { sql: `UPDATE source_events SET kind='grant' WHERE id='${sourceEventId}'`, expected: /source_event_identity_is_immutable/ },
    { sql: `UPDATE source_events SET thread_id='forged-thread' WHERE id='${sourceEventId}'`, expected: /source_event_identity_is_immutable/ },
    { sql: `UPDATE source_work_specs SET digest='${'a'.repeat(64)}' WHERE event_id='${sourceEventId}'`, expected: /source_work_spec_immutable/ },
    { sql: `DELETE FROM source_work_specs WHERE event_id='${sourceEventId}'`, expected: /source_work_spec_immutable/ },
  ]) await assert.throws(() => mutate(alteration.sql),alteration.expected,`SQL constraint must refuse this event/stored-spec mutation: ${alteration.sql}`)
  const originalTicketIdentity = await admin.get(`/api/v1/tickets/${ticketId}`)
  await mutate('UPDATE tickets SET node_id=?,installation_id=? WHERE id=?', '0'.repeat(64), 'changed-installation', ticketId)
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId }), error => error.status === 409 && error.code === 'source_task_rebind')
  await mutate('UPDATE tickets SET node_id=?,installation_id=? WHERE id=?', originalTicketIdentity.node_id, originalTicketIdentity.installation_id, ticketId)
  const restoredTicket = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.equal(restoredTicket.node_id, runner.nodeId)
  assert.equal(restoredTicket.installation_id, originalTicketIdentity.installation_id)
  const restoredWork = await workEventView(sourceEventId)
  assert.equal(restoredWork.task_spec.node_id, restoredTicket.node_id)
  assert.equal(restoredWork.task_spec.installation_id, restoredTicket.installation_id)
  assert.equal(restoredWork.content, objective)
  assert.equal(restoredWork.task_spec.objective, objective)
  const originalGrantCount = (await admin.get('/api/v1/grants')).grants.length
  for (const bad of [
    { ...spec, source_event_id: sourceEventId, objective: 'Change the authorized intent into another assignment' },
    { ...spec, relative_path: '../outside', source_event_id: sourceEventId },
    { ...spec, content: 'literal bytes substituted for a project file', source_event_id: sourceEventId },
    { ...spec, source_event_id: 'not-a-real-source-event' },
  ]) await assert.rejects(admin.post('/api/v1/tickets', bad), error => error.status >= 400 && error.status < 500)
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, kind: 'edit_file', source_event_id: sourceEventId }), error => error.status === 403)
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, node_id: 'f'.repeat(64), source_event_id: sourceEventId }), error => error.status === 409 && error.code === 'source_task_rebind')
  const retainedAssignment = (await admin.get(`/api/v1/tickets/${ticketId}`)).assignments[0]
  assert.equal(retainedAssignment.node_id, runner.nodeId, 'A changed source-target worker must not overwrite the original assignment')
  assert.equal(count('SELECT COUNT(*) FROM tickets'), 1)
  assert.equal((await admin.get('/api/v1/grants')).grants.length, originalGrantCount)

  const otherRoot = join(root, 'other-project')
  await mkdir(otherRoot, { mode: 0o700 })
  const otherProject = await admin.post('/api/v1/projects', { name: 'Distinct project for actual cross-scope rejection', root: otherRoot, mode: 'read_only' })
  const crossScope = await admin.post('/api/v1/source-events', { source_id: sourceId, thread_id: 'known-dialogue', event_id: 'cross-project-must-not-execute', kind: 'user_message', content: objective })
  const beforeCrossProject = counts()
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, project_id: otherProject.project.id, source_event_id: crossScope.id }), error => error.status === 403 && error.code === 'grant_scope')
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, project_id: otherProject.project.id, source_event_id: sourceEventId }), error => error.status === 409 && error.code === 'source_task_rebind')
  assert.deepEqual(counts(), beforeCrossProject, 'A grant for another project cannot leave even a waiting ticket or audit fragment')
  await assert.rejects(admin.post('/api/v1/grants', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', operations: ['write'] }), error => error.status === 403 && error.code === 'project_scope')
  const forbiddenCapability = await mutate('UPDATE grants SET operations=? WHERE id=?', JSON.stringify(['credential_inspect']), granted.grant.id)
  assert.equal(forbiddenCapability.changes, 1, 'The intentionally wrong operation fixture must exist')
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, source_event_id: crossScope.id }), error => error.status === 403 && error.code === 'grant_scope')
  assert.equal((await workEventView(crossScope.id)).task_ticket_id, null)
  await mutate('UPDATE grants SET operations=? WHERE id=?', JSON.stringify(['read']), granted.grant.id)
  await mutate('DROP TRIGGER IF EXISTS fail_source_attachment')
  const failedAttachment = await admin.post('/api/v1/source-events', { source_id: sourceId, thread_id: 'known-dialogue', event_id: 'failing-atomic-link', kind: 'user_message', content: objective })
  await mutate(`CREATE TRIGGER fail_source_attachment BEFORE UPDATE OF task_ticket_id ON source_events WHEN NEW.id='${failedAttachment.id}' BEGIN SELECT RAISE(ABORT,'injected_attachment_failure'); END`)
  const beforeFailure = counts()
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, source_event_id: failedAttachment.id }), error => error.status >= 400 && error.status < 500)
  assert.deepEqual(counts(), beforeFailure, 'An attachment write failure after Ticket/Assignment creation must roll everything back')
  assert.equal((await workEventView(failedAttachment.id)).task_ticket_id, null)
  await mutate('DROP TRIGGER IF EXISTS fail_source_attachment')
  const retry = await admin.post('/api/v1/tickets', { ...spec, source_event_id: failedAttachment.id })
  assert.equal(retry.duplicate, false)
  assert.equal(retry.ticket.assignments.length, 1)
  assert.equal((await workEventView(failedAttachment.id)).task_ticket_id, retry.ticket.id)
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, project_id: otherProject.project.id, source_event_id: failedAttachment.id }), error => error.status === 409 && error.code === 'source_task_rebind')

  const retryResult = await runner.pollAndRun()
  assert.equal(retryResult.status, 'succeeded')
  await runner.client.dispatchOutbox()
  const retryCompleted = await admin.get(`/api/v1/tickets/${retry.ticket.id}`)
  assert.equal(retryCompleted.status, 'succeeded')
  assert.equal(retryCompleted.artifacts.length, 1)
  const executed = await runner.pollAndRun()
  assert.equal(executed.status, 'succeeded')
  const delivery = await runner.client.dispatchOutbox()
  assert.ok(delivery.every(entry => entry.status !== 'deferred'), `All local artifact/report evidence must be actually delivered: ${JSON.stringify(delivery)}`)
  const completed = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.artifacts.length, 1)
  assert.equal(completed.reports.at(-1).state, 'succeeded')
  const sourceArtifact = await admin.get(`/api/v1/tickets/${ticketId}/artifacts/${completed.artifacts[0].id}`)
  assert.equal(sourceArtifact.artifact.sha256, completed.artifacts[0].sha256)
  assert.match(sourceArtifact.content, /Real isolated project input/)
  assert.equal(count('SELECT COUNT(*) FROM tickets'), 2)
  assert.equal(count('SELECT COUNT(*) FROM assignments'), 2)
  assert.equal(count('SELECT COUNT(*) FROM effects'), 2, 'Each of two distinctly authorized Source jobs has one real evidence receipt')
  assert.equal(count(`SELECT COUNT(*) FROM source_events WHERE id='${sourceEventId}' AND ticket_id IS NULL AND task_ticket_id='${ticketId}'`), 1, 'The new task relationship is separate from historical intake references and persists after restart')

  const revisited = await admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId })
  assert.equal(revisited.duplicate, true)
  assert.equal(revisited.ticket.status, 'succeeded')
  const duplicateCompleted = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.equal(duplicateCompleted.artifacts.length, 1)
  assert.equal(duplicateCompleted.reports.length, 1)
  assert.equal(duplicateCompleted.effects.length, 1)
  assert.deepEqual(duplicateCompleted.assignments, completed.assignments)
  assert.deepEqual(duplicateCompleted.messages, completed.messages)

  const unrelatedTicket = await admin.post('/api/v1/tickets', { ...spec, objective: 'Ordinary task creation without a source_event binding' })
  assert.equal(unrelatedTicket.source_event_id ?? null, null)
  if (unrelatedTicket.status === 'running') {
    assert.equal((await runner.pollAndRun()).status, 'succeeded')
    await runner.client.dispatchOutbox()
    assert.equal((await admin.get(`/api/v1/tickets/${unrelatedTicket.id}`)).status, 'succeeded')
  }
  assert.equal(count(`SELECT COUNT(*) FROM source_events WHERE id='${sourceEventId}' AND ticket_id IS NULL AND task_ticket_id='${ticketId}'`), 1, 'An ordinary separate Ticket cannot take over the original authorized event relation')
  const unchangedLink = await workEventView(sourceEventId)
  assert.equal(unchangedLink.task_ticket_id, ticketId)
  assert.equal(unchangedLink.task_digest, firstLink.task_digest)
  assert.equal(unchangedLink.task_spec_raw, firstLink.task_spec_raw)
  assert.equal(count(`SELECT COUNT(*) FROM source_work_specs WHERE event_id='${sourceEventId}'`), 1)

  const unrelated = await admin.post('/api/v1/tickets', { ...spec, objective: 'An ordinary existing Ticket used only as intake history' })
  if (unrelated.status === 'running') {
    assert.equal((await runner.pollAndRun()).status, 'succeeded')
    await runner.client.dispatchOutbox()
    assert.equal((await admin.get(`/api/v1/tickets/${unrelated.id}`)).status, 'succeeded')
  }
  const legacyEvent = await admin.post('/api/v1/source-events', { source_id: sourceId, thread_id: 'known-dialogue', event_id: 'historical-reference-is-not-task', kind: 'user_message', content: objective, ticket_id: unrelated.id })
  const completedWithoutSource = await admin.get(`/api/v1/tickets/${unrelated.id}`)
  assert.equal(legacyEvent.task_ticket_id, null)
  const persistedLegacyEvent = await workEventView(legacyEvent.id)
  assert.equal(persistedLegacyEvent.ticket_id, unrelated.id)
  assert.equal(persistedLegacyEvent.task_ticket_id, null)
  assert.equal(persistedLegacyEvent.legacy_reference, 'unverified_intake_reference')
  assert.equal(persistedLegacyEvent.creation_kind, 'unbound')
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, grant_id: 'unknown-grant', source_event_id: sourceEventId }), error => error.status === 409 && error.code === 'source_task_rebind')
  await admin.post('/api/v1/grants/' + granted.grant.id + '/revoke', {})
  const revoked = (await admin.get('/api/v1/grants')).grants.find(row => row.id === granted.grant.id)
  assert.ok(revoked.revoked_at, 'The real Grant must be durably revoked before its authority is tested for new task intake')
  const another = await admin.post('/api/v1/source-events', { source_id: source.source.id, thread_id: 'known-dialogue',
    event_id: 'new-reason-after-valid-revocation', kind: 'user_message', content: objective, ticket_id: unrelated.id })
  const unchanged = await admin.get(`/api/v1/tickets/${unrelated.id}`)
  assert.equal(unchanged.status, completedWithoutSource.status)
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, source_event_id: another.id }), error => error.status === 403)
  assert.equal((await workEventView(another.id)).task_ticket_id, null)
  assert.equal((await workEventView(another.id)).ticket_id, unrelated.id)
  const beforeApprovalReplay = count('SELECT COUNT(*) FROM tickets')
  assert.equal(count(`SELECT COUNT(*) FROM source_events WHERE id='${another.id}' AND task_ticket_id IS NULL`), 1, 'A rejected Grant cannot produce another ticket from a stopped intent')
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)

  const waitingGrant = await admin.post('/api/v1/grants', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', operations: ['read'] })
  const waitingSpec = { ...spec, grant_id: waitingGrant.grant.id }
  const waitingEvent = await admin.post('/api/v1/source-events', { source_id: sourceId, thread_id: 'known-dialogue', event_id: 'waiting-host-keeps-original-spec', kind: 'user_message', content: objective })
  await mutate('UPDATE nodes SET status=?', 'offline')
  const pending = await admin.post('/api/v1/tickets', { ...waitingSpec, source_event_id: waitingEvent.id })
  assert.equal(pending.ticket.status, 'waiting_approval')
  assert.equal(pending.ticket.assignments.length, 0)
  assert.equal(pending.ticket.grant_digest, waitingGrant.grant.digest)
  const pendingBinding = (await admin.get('/api/v1/grants')).grants.find(row => row.id === waitingGrant.grant.id).project_binding_id
  await mutate('UPDATE project_bindings SET root_scope=? WHERE id=?', join(projectRoot, '..'), pendingBinding)
  await mutate('UPDATE grants SET operations=? WHERE id=?', '[]', waitingGrant.grant.id)
  const approvalBeforeInvalid = counts()
  await assert.rejects(admin.post(`/api/v1/tickets/${pending.ticket.id}/approval`, { decision: 'approve', approval_id: 'cannot-execute-changed-root', reason: 'Changed authority must not be silently replaced' }), error => error.status === 403 && error.code === 'grant_scope')
  assert.deepEqual(counts(), approvalBeforeInvalid, 'Approval must fence altered root/operations before issuing another Assignment')
  assert.equal((await admin.get(`/api/v1/tickets/${pending.ticket.id}`)).status, 'waiting_approval')
  const skippedAfterApprovalDenied = await runner.pollAndRun()
  assert.equal(skippedAfterApprovalDenied.status, 'idle')
  assert.equal(count(`SELECT COUNT(*) FROM assignments WHERE ticket_id='${pending.ticket.id}'`), 0)
  assert.equal(count(`SELECT COUNT(*) FROM effects WHERE ticket_id='${pending.ticket.id}'`), 0)
  await mutate('UPDATE project_bindings SET root_scope=? WHERE id=?', projectRoot, pendingBinding)
  await mutate('UPDATE grants SET operations=? WHERE id=?', '["read"]', waitingGrant.grant.id)
  for (const reason of [undefined, null, 42, ' \t\n ', 'x'.repeat(1001)]) {
    const beforeInvalidReason = await admin.get(`/api/v1/tickets/${pending.ticket.id}`)
    const beforeInvalidAudits = await ticketAudits(pending.ticket.id)
    const payload = { decision: 'approve', approval_id: 'invalid-reason-never-authorizes' }
    if (reason !== undefined) payload.reason = reason
    await assert.rejects(admin.post(`/api/v1/tickets/${pending.ticket.id}/approval`, payload), error => error.status === 400)
    assert.deepEqual(await admin.get(`/api/v1/tickets/${pending.ticket.id}`), beforeInvalidReason)
    assert.deepEqual(await ticketAudits(pending.ticket.id), beforeInvalidAudits, 'A malformed reason cannot create an assignment or authority audit')
  }
  for (const failedAction of ['task.approval_granted', 'assignment.retried']) {
    await runner.client.heartbeat({ capabilities: runner.capabilities, workers: [{ worker_id: 'default' }],
      inventory: { project_roots: { [projectId]: projectRoot }, source: 'explicit_local_node_configuration' } })
    const beforeAuditFailure = await admin.get(`/api/v1/tickets/${pending.ticket.id}`)
    const beforeFailedAudits = await ticketAudits(pending.ticket.id)
    await mutate(`CREATE TRIGGER fail_owned_approval_audit BEFORE INSERT ON audits WHEN NEW.action='${failedAction}' BEGIN SELECT RAISE(ABORT,'owned approval audit failure'); END`)
    try {
      await assert.rejects(admin.post(`/api/v1/tickets/${pending.ticket.id}/approval`, { decision: 'approve', approval_id: `rollback-${failedAction}`, reason: 'Execution and this decision audit must be inseparable' }), error => error.status >= 400)
      assert.deepEqual(await admin.get(`/api/v1/tickets/${pending.ticket.id}`), beforeAuditFailure, `Failed ${failedAction} must leave waiting Ticket/attempt/history unchanged`)
      assert.deepEqual(await ticketAudits(pending.ticket.id), beforeFailedAudits, `Failed ${failedAction} cannot commit earlier audits or state`)
      assert.equal(count(`SELECT COUNT(*) FROM assignments WHERE ticket_id='${pending.ticket.id}'`), 0)
    } finally {
      await mutate('DROP TRIGGER IF EXISTS fail_owned_approval_audit')
    }
  }
  const approved = await admin.post(`/api/v1/tickets/${pending.ticket.id}/approval`, { decision: 'approve', approval_id: 'waiting-source-test-approval', reason: '  User explicitly approved this exact original Source scope  ' })
  assert.equal(approved.status, 'running')
  assert.equal(approved.attempt, 1)
  assert.equal(approved.assignments.length, 1)
  assert.equal(approved.assignments[0].lease_epoch, 1)
  assert.match(approved.assignments[0].id, /^asg_[0-9a-f]{32}$/)
  assert.equal(approved.node_id, runner.nodeId)
  assert.equal(approved.grant_id, pending.ticket.grant_id)
  assert.equal(approved.grant_digest, pending.ticket.grant_digest)
  assert.equal(count(`SELECT COUNT(*) FROM grants WHERE id='${waitingGrant.grant.id}'`), 1)
  const approvedAudits = (await ticketAudits(pending.ticket.id)).filter(entry => ['assignment.retried', 'task.approval_granted'].includes(entry.action))
  assert.deepEqual(approvedAudits.map(entry => entry.action), ['assignment.retried', 'task.approval_granted'])
  const grantedEvidence = auditEvidence(approvedAudits[1])
  assert.equal(grantedEvidence.approval_id, 'waiting-source-test-approval')
  assert.equal(grantedEvidence.reason, 'User explicitly approved this exact original Source scope')
  assert.equal(grantedEvidence.decision, 'approve')
  assert.equal(grantedEvidence.assignment_id, approved.assignments[0].id)
  assert.equal(grantedEvidence.lease_id, approved.assignments[0].lease_id)
  assert.equal(grantedEvidence.lease_epoch, 1)
  assert.equal(grantedEvidence.source_authority_preserved, true)
  assert.equal(grantedEvidence.grant_created, false)
  for (const entry of approvedAudits) {
    assert.equal(entry.ticket_id, pending.ticket.id)
    assert.equal(entry.actor, 'client')
  }
  await assert.rejects(admin.post(`/api/v1/tickets/${pending.ticket.id}/approval`, { decision: 'approve', approval_id: 'a-later-id-is-not-a-replay', reason: 'Running cannot accept another waiting approval' }), error => error.status === 409 && error.code === 'approval_not_pending')
  assert.equal((await ticketAudits(pending.ticket.id)).filter(entry => ['assignment.retried', 'task.approval_granted'].includes(entry.action)).length, 2)
  const approvedRun = await runner.pollAndRun()
  assert.equal(approvedRun.status, 'succeeded')
  await runner.client.dispatchOutbox()
  const approvedCompleted = await admin.get(`/api/v1/tickets/${pending.ticket.id}`)
  assert.equal(approvedCompleted.status, 'succeeded')
  assert.equal(approvedCompleted.artifacts.length, 1)
  assert.equal(approvedCompleted.reports.length, 1)
  const approvedArtifact = await admin.get(`/api/v1/tickets/${pending.ticket.id}/artifacts/${approvedCompleted.artifacts[0].id}`)
  assert.match(approvedArtifact.content, /Real isolated project input/)
  const approvedReplay = await admin.post('/api/v1/tickets', { ...waitingSpec, source_event_id: waitingEvent.id })
  assert.equal(approvedReplay.duplicate, true)
  assert.equal(approvedReplay.task_created, false)
  assert.equal(approvedReplay.task_digest, pending.task_digest)
  assert.equal(approvedReplay.ticket.id, pending.ticket.id)
  assert.equal(approvedReplay.ticket.assignments.length, 1)
  const rejectedEvent = await admin.post('/api/v1/source-events', { source_id: sourceId, thread_id: 'known-dialogue', event_id: 'explicit-rejection-has-no-runtime', kind: 'user_message', content: objective })
  await mutate('UPDATE nodes SET status=?', 'offline')
  const remaining = await admin.post('/api/v1/tickets', { ...waitingSpec, source_event_id: rejectedEvent.id })
  assert.equal(remaining.ticket.status, 'waiting_approval')
  const beforeRejection = counts()
  const rejection = await admin.post(`/api/v1/tickets/${remaining.ticket.id}/approval`, { decision: 'reject', approval_id: 'no-execution-for-this-choice', reason: '  Preserve this Source work until I review its bounded input  ' })
  assert.equal(rejection.status, 'waiting_approval')
  assert.equal(rejection.cancel_requested, false)
  assert.equal(rejection.assignments.length, 0)
  assert.equal(rejection.reports.length, 0)
  assert.equal(rejection.artifacts.length, 0)
  assert.equal(rejection.effects.length, 0)
  assert.deepEqual(counts().slice(0, 2), beforeRejection.slice(0, 2), 'An explicit rejection cannot issue a real assignment')
  assert.equal(counts()[3], beforeRejection[3] + 1, 'The actual rejection decision is audited, not confused with an execution')
  const rejectionAudits = await ticketAudits(remaining.ticket.id)
  const rejectedRecord = rejectionAudits.filter(entry => entry.action === 'task.approval_rejected')
  assert.equal(rejectedRecord.length, 1)
  assert.equal(auditEvidence(rejectedRecord[0]).approval_id, 'no-execution-for-this-choice')
  assert.equal(auditEvidence(rejectedRecord[0]).reason, 'Preserve this Source work until I review its bounded input')
  assert.equal(auditEvidence(rejectedRecord[0]).decision, 'reject')
  assert.equal(auditEvidence(rejectedRecord[0]).assignment_created, false)
  assert.equal((await runner.pollAndRun()).status, 'idle')
  await mutate('UPDATE nodes SET status=?', 'online')
  await runner.client.heartbeat({ capabilities: runner.capabilities, workers: [{ worker_id: 'default' }],
    inventory: { project_roots: { [projectId]: projectRoot }, source: 'explicit_local_node_configuration' } })
  const approvedAfterRejection = await admin.post(`/api/v1/tickets/${remaining.ticket.id}/approval`, { decision: 'approve', approval_id: 'a-distinct-later-approval', reason: 'Review complete; proceed once with the unchanged Grant and input' })
  assert.equal(approvedAfterRejection.status, 'running')
  assert.equal(approvedAfterRejection.attempt, 1)
  assert.equal(approvedAfterRejection.assignments.length, 1)
  assert.equal(approvedAfterRejection.assignments[0].lease_epoch, 1)
  const afterHoldAudits = await ticketAudits(remaining.ticket.id)
  assert.equal(afterHoldAudits.filter(entry => entry.action === 'task.approval_rejected').length, 1)
  assert.equal(afterHoldAudits.filter(entry => entry.action === 'task.approval_granted').length, 1)
  assert.equal(auditEvidence(afterHoldAudits.find(entry => entry.action === 'task.approval_granted')).approval_id, 'a-distinct-later-approval')
  assert.equal((await runner.pollAndRun()).status, 'succeeded')
  await runner.client.dispatchOutbox()
  const approvedAfterRejectionCompleted = await admin.get(`/api/v1/tickets/${remaining.ticket.id}`)
  assert.equal(approvedAfterRejectionCompleted.status, 'succeeded')
  assert.equal(approvedAfterRejectionCompleted.artifacts.length, 1)
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, source_event_id: rejectedEvent.id, objective: objective }), error => error.status === 409)
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId, task_spec: {}, root_scope: '/unauthorized', authority: true }), error => error.status === 400)

  const failedEvent = await admin.post('/api/v1/source-events', { source_id: sourceId, thread_id: 'known-dialogue', event_id: 'actual-failed-work-needs-atomic-public-retry', kind: 'user_message', content: 'Read a real missing input before allowing an explicit retry' })
  const failedTicket = await admin.post('/api/v1/tickets', { ...waitingSpec, objective: 'Read a real missing input before allowing an explicit retry', relative_path: 'temporarily-missing.txt', source_event_id: failedEvent.id })
  assert.equal(failedTicket.ticket.status, 'running')
  assert.equal((await runner.pollAndRun()).status, 'failed')
  await runner.client.dispatchOutbox()
  const failedBeforeRetry = await admin.get(`/api/v1/tickets/${failedTicket.ticket.id}`)
  assert.equal(failedBeforeRetry.status, 'failed')
  assert.equal(failedBeforeRetry.attempt, 1)
  assert.equal(failedBeforeRetry.reports.length, 1)
  const beforeRetryFailure = counts()
  await mutate("CREATE TRIGGER fail_owned_public_retry BEFORE INSERT ON audits WHEN NEW.action='ticket.retried' BEGIN SELECT RAISE(ABORT,'owned public retry audit failure'); END")
  try {
    await assert.rejects(admin.post(`/api/v1/tickets/${failedTicket.ticket.id}/retry`, {}), error => error.status >= 400)
    assert.deepEqual(await admin.get(`/api/v1/tickets/${failedTicket.ticket.id}`), failedBeforeRetry, 'Public retry cannot leave actual attempt 2 without its ticket.retried audit')
    assert.deepEqual(counts(), beforeRetryFailure)
  } finally {
    await mutate('DROP TRIGGER IF EXISTS fail_owned_public_retry')
  }
  await writeFile(join(projectRoot, 'temporarily-missing.txt'), 'Real isolated project input delivered by the explicitly retried Assignment\n', { mode: 0o600 })
  const publicRetry = await admin.post(`/api/v1/tickets/${failedTicket.ticket.id}/retry`, {})
  assert.equal(publicRetry.status, 'running')
  assert.equal(publicRetry.attempt, 2)
  assert.equal(publicRetry.assignments.length, 2)
  assert.equal(publicRetry.grant_id, failedBeforeRetry.grant_id)
  assert.equal(publicRetry.grant_digest, failedBeforeRetry.grant_digest)
  const retryAuditRecords = (await ticketAudits(failedTicket.ticket.id)).filter(entry => ['assignment.retried', 'ticket.retried'].includes(entry.action))
  assert.deepEqual(retryAuditRecords.map(entry => entry.action), ['assignment.retried', 'ticket.retried'])
  const retriedEvidence = auditEvidence(retryAuditRecords[0])
  const secondAssignment = publicRetry.assignments.find(row => row.lease_epoch === 2)
  assert.equal(retriedEvidence.assignment_id, secondAssignment.id)
  assert.equal(retriedEvidence.lease_id, secondAssignment.lease_id)
  assert.equal(retriedEvidence.lease_epoch, 2)
  assert.equal((await runner.pollAndRun()).status, 'succeeded')
  await runner.client.dispatchOutbox()
  const retriedCompleted = await admin.get(`/api/v1/tickets/${failedTicket.ticket.id}`)
  assert.equal(retriedCompleted.status, 'succeeded')
  assert.deepEqual(retriedCompleted.reports[0], failedBeforeRetry.reports[0])
  assert.equal(retriedCompleted.reports[1].state, 'succeeded')
  const retriedArtifact = await admin.get(`/api/v1/tickets/${failedTicket.ticket.id}/artifacts/${retriedCompleted.artifacts[0].id}`)
  assert.match(retriedArtifact.content, /explicitly retried Assignment/)
  await server.stop()
  server = await startRustConcierge({ root, env: { LOOM_CLIENT_TOKEN: token, PATH: process.env.PATH } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: token })
  assert.equal((await admin.get(`/api/v1/tickets/${ticketId}`)).status, 'succeeded')
  const afterRestart = await admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId })
  assert.equal(afterRestart.duplicate, true)
  assert.equal(afterRestart.ticket.id, ticketId)
  assert.equal(count('SELECT COUNT(*) FROM tickets'), beforeApprovalReplay + 3, 'Two approved waiting tickets and the real failed→retried ticket exist; replay makes none')
  assert.equal((await admin.get(`/api/v1/tickets/${pending.ticket.id}`)).status, 'succeeded')
  assert.equal((await admin.get(`/api/v1/tickets/${remaining.ticket.id}`)).status, 'succeeded')
  assert.equal((await admin.get(`/api/v1/tickets/${failedTicket.ticket.id}`)).status, 'succeeded')
  assert.equal(count(`SELECT COUNT(*) FROM source_events WHERE id='${sourceEventId}' AND ticket_id IS NULL AND task_ticket_id='${ticketId}'`), 1, 'The new task relationship is separate from historical intake references and persists after restart')
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)

  console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.source-work.v1',
    source_event_not_authority_until_explicit_spec: true,
    original_grant_root_worker_worker_resolution_preserved: true,
    ticket_assignment_and_event_link_atomic: true,
    approval_reason_normalization_and_hold_audited: true,
    approval_retry_audits_share_transaction_with_real_assignment: true,
    public_retry_assignment_and_both_audits_atomic: true,
    reject_then_distinct_approval_creates_one_assignment: true,
    original_ticket_and_grant_unmodified_by_replay: true,
    duplicate_create_and_restart_do_not_re_execute: true,
    actual_single_authorized_file_artifact_and_effect: true,
    wrong_objective_grant_root_scope_missing_source_and_revocation_rejected: true,
    ordinary_tickets_still_work_without_event: true,
    audit_chain_verified: true,
    not_claimed: ['LLM inference from untrusted text', 'automatic task authority by message',
      'non-read tasks from generic source', 'remote IM/OAuth/multi-principal verification',
      'generic source->DAG execution or distributed exactly-once'], owned_cleanup: true }, null, 2))
} finally {
  await server.stop()
  await rm(root, { recursive: true, force: false })
}
