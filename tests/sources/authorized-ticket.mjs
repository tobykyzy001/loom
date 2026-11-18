import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
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
  await assert.rejects(admin.post(`/api/v1/tickets/${pending.ticket.id}/approval`, { decision: 'approve', approval_id: 'cannot-execute-changed-root' }), error => error.status === 403 && error.code === 'grant_scope')
  assert.deepEqual(counts(), approvalBeforeInvalid, 'Approval must fence altered root/operations before issuing another Assignment')
  assert.equal((await admin.get(`/api/v1/tickets/${pending.ticket.id}`)).status, 'waiting_approval')
  const skippedAfterApprovalDenied = await runner.pollAndRun()
  assert.equal(skippedAfterApprovalDenied.status, 'idle')
  assert.equal(count(`SELECT COUNT(*) FROM assignments WHERE ticket_id='${pending.ticket.id}'`), 0)
  assert.equal(count(`SELECT COUNT(*) FROM effects WHERE ticket_id='${pending.ticket.id}'`), 0)
  await mutate('UPDATE project_bindings SET root_scope=? WHERE id=?', projectRoot, pendingBinding)
  await mutate('UPDATE grants SET operations=? WHERE id=?', '["read"]', waitingGrant.grant.id)
  await mutate('UPDATE nodes SET status=?', 'online')
  const approved = await admin.post(`/api/v1/tickets/${pending.ticket.id}/approval`, { decision: 'approve', approval_id: 'waiting-source-test-approval' })
  assert.equal(approved.status, 'running')
  assert.equal(approved.assignments.length, 1)
  assert.equal(approved.node_id, runner.nodeId)
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
  const rejection = await admin.post(`/api/v1/tickets/${remaining.ticket.id}/approval`, { decision: 'reject', approval_id: 'no-execution-for-this-choice' })
  assert.equal(rejection.status, 'waiting_approval')
  assert.equal(rejection.assignments.length, 0)
  assert.deepEqual(counts().slice(0, 2), beforeRejection.slice(0, 2), 'An explicit rejection cannot issue a real assignment')
  assert.equal(counts()[3], beforeRejection[3] + 1, 'The actual rejection decision is audited, not confused with an execution')
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, source_event_id: rejectedEvent.id, objective: objective }), error => error.status === 409)
  await mutate('UPDATE nodes SET status=?', 'online')
  await assert.rejects(admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId, task_spec: {}, root_scope: '/unauthorized', authority: true }), error => error.status === 400)
  await server.stop()
  server = await startRustConcierge({ root, env: { LOOM_CLIENT_TOKEN: token, PATH: process.env.PATH } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: token })
  assert.equal((await admin.get(`/api/v1/tickets/${ticketId}`)).status, 'succeeded')
  const afterRestart = await admin.post('/api/v1/tickets', { ...spec, source_event_id: sourceEventId })
  assert.equal(afterRestart.duplicate, true)
  assert.equal(afterRestart.ticket.id, ticketId)
  assert.equal(count('SELECT COUNT(*) FROM tickets'), beforeApprovalReplay + 2, 'One approved queued ticket and one rejected queued ticket are created; replay did not make another')
  assert.equal(count(`SELECT COUNT(*) FROM source_events WHERE id='${sourceEventId}' AND ticket_id IS NULL AND task_ticket_id='${ticketId}'`), 1, 'The new task relationship is separate from historical intake references and persists after restart')
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)

  console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.source-work.v1',
    source_event_not_authority_until_explicit_spec: true,
    original_grant_root_worker_worker_resolution_preserved: true,
    ticket_assignment_and_event_link_atomic: true,
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
