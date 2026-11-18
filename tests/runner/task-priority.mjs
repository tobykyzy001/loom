#!/usr/bin/env node
// Real one-Node priority proof against an owned Rust Concierge and temporary files.
// No DSH Profile/provider, second host, Compose fixture, or management-token fallback
// on Node routes is used. Priority is dispatcher metadata, never an executor input.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LoomHttpClient, LoomHttpError } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { prepareProject, startRustConcierge, testingClientToken, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const root = await testingRoot()
const clientToken = testingClientToken()
const result = {
  overall: 'NOT RUN',
  schema: 'loom.task-priority.v1',
  scope: 'one-enrolled-LocalNode-real-Rust-HTTP-SQLite-priority-and-stop',
  executor_count_real: 0,
  not_claimed: [
    'running-active-job preemption',
    'cross-Node placement authority/physical multiHost',
    'any fair queue or starvation proof',
    'global effective priority across harness/instant side effect',
    'testing.md 1+3 Compose',
    'live model provider',
    'genuine SDK job abort or rollback of an already-started effect',
  ],
}
let center, runner, admin, binding, projectRoot
const createdTickets = []
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const durable = value => JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function rows(sql, ...parameters) {
  assert.ok(center, 'owned center is running')
  const db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'), { readOnly: true })
  try { return db.prepare(sql).all(...parameters).map(durable) } finally { db.close() }
}
function row(sql, ...parameters) {
  const found = rows(sql, ...parameters)
  assert.equal(found.length, 1, sql)
  return found[0]
}
function scalar(sql, ...parameters) {
  const value = Object.values(row(sql, ...parameters))[0]
  return value
}
function mutateOwnedNodeOffline(installationId) {
  // Only the pending-approval fixture changes server inventory by SQL. It is the
  // real center DB, restored by the enrolled Node's own authenticated heartbeat.
  assert.ok(center && runner)
  const db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'))
  try {
    const changed = db.prepare('UPDATE nodes SET status=? WHERE id=? AND installation_id=?')
      .run('offline', runner.nodeId, installationId)
    assert.equal(changed.changes, 1)
  } finally { db.close() }
}
function countOutcomes(ticketId) {
  return {
    reports: scalar('SELECT COUNT(*) AS n FROM reports WHERE ticket_id=?', ticketId),
    artifacts: scalar('SELECT COUNT(*) AS n FROM artifacts WHERE ticket_id=?', ticketId),
    effects: scalar('SELECT COUNT(*) AS n FROM effects WHERE ticket_id=?', ticketId),
  }
}
function assertPriority(ticket, expected, label) {
  assert.equal(typeof ticket.priority, 'number', `${label}: Ticket detail exposes a numeric priority`)
  assert.equal(Number.isInteger(ticket.priority), true, `${label}: Ticket priority remains an integer`)
  assert.equal(ticket.priority, expected, `${label}: persisted API priority`)
  const stored = row('SELECT priority,typeof(priority) AS storage_type FROM tickets WHERE id=?', ticket.id)
  assert.equal(stored.priority, expected, `${label}: SQL priority`)
  assert.equal(stored.storage_type, 'integer', `${label}: numeric SQL storage, not a string`)
}
function assertAssignmentMetadata(assignment, ticket, label) {
  assert.ok(assignment?.id, `${label}: actual non-null Assignment`)
  assert.equal(assignment.id, ticket.assignments.find(item => item.lease_epoch === assignment.lease_epoch)?.id,
    `${label}: current database-backed Assignment, not a cached response`)
  assert.equal(assignment.ticket_id, ticket.id)
  assert.equal(assignment.node_id, runner.nodeId)
  if (assignment.installation_id) assert.equal(assignment.installation_id, runner.installationId)
  assert.equal(assignment.grant.installation_id, runner.installationId)
  const authenticatedNode = row('SELECT installation_id FROM nodes WHERE id=?', runner.nodeId)
  assert.equal(authenticatedNode.installation_id, runner.installationId)
  assert.equal(assignment.worker_id, 'default')
  assert.equal(assignment.project_id, ticket.project_id)
  assert.equal(assignment.grant.id, ticket.grant_id)
  assert.equal(assignment.grant_digest, ticket.grant_digest || assignment.grant.digest)
  assert.equal(assignment.grant.digest, ticket.grant_digest || assignment.grant.digest)
  assert.equal(assignment.grant.project_binding_id, binding.id, `${label}: original exact ProjectBinding`)
  assert.equal(assignment.grant.project_root, projectRoot, `${label}: original exact ProjectRoot`)
  assert.equal(assignment.resource.root_scope, projectRoot, `${label}: Assignment resource is that same root`)
  assert.equal(Object.hasOwn(assignment, 'priority'), false, `${label}: priority must not enter Node work/digest input`)
  assert.equal(Object.hasOwn(assignment.operation, 'priority'), false, `${label}: operation must not enter priority scheduling metadata`)
  const assertNoPriority = value => {
    if (!value || typeof value !== 'object') return
    assert.equal(Object.hasOwn(value, 'priority'), false, `${label}: no Assignment payload field is named priority`)
    for (const child of Object.values(value)) assertNoPriority(child)
  }
  assertNoPriority(assignment)
}
async function acknowledge(ticket, assignment, label) {
  const receipt = await runner.client.acknowledge({
    ticketId: ticket.id, assignmentId: assignment.id, leaseEpoch: assignment.lease_epoch, accepted: true,
  })
  assert.equal(receipt.response.accepted, true, `${label}: actual Node acknowledgement`)
  const persisted = row('SELECT acknowledged_at FROM assignments WHERE id=?', assignment.id)
  assert.ok(persisted.acknowledged_at, `${label}: acknowledgement was committed`)
  return persisted.acknowledged_at
}
async function ticketDetail(id) {
  return admin.get(`/api/v1/tickets/${id}`)
}
async function fileBytes(path) {
  return readFile(path)
}

try {
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: clientToken } })
  admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken, timeoutMs: 10_000 })
  assert.equal((await admin.get('/api/v1/health')).status, 'ok')
  projectRoot = await prepareProject(root)
  const originalInput = await fileBytes(join(projectRoot, 'input.txt'))
  const project = await admin.post('/api/v1/projects', {
    name: 'Owned single-node priority dispatcher fixture', root: projectRoot, mode: 'read_write',
  })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  runner = new LocalNodeRunner({
    stateDir: join(root, 'owned-node-state'), artifactDir: join(root, 'owned-node-artifacts'),
    baseUrl: center.baseUrl, projectRoots: { [projectId]: projectRoot },
    registration: { workerId: 'default', harnessKind: 'deterministic-local-http', profileId: 'not-a-dsh-profile' },
  })
  await runner.start({ enrollmentCode: enrollment.code })
  const actualExecutorExecute = runner.executor.execute.bind(runner.executor)
  runner.executor.execute = async (...args) => {
    result.executor_count_real++
    return actualExecutorExecute(...args)
  }
  binding = await admin.post('/api/v1/project-bindings', {
    project_id: projectId, node_id: runner.nodeId, installation_id: runner.installationId,
    worker_id: 'default', root_scope: projectRoot,
  })
  assert.ok(binding.id)
  const createGrant = async (operations = ['read', 'write']) => {
    const granted = await admin.post('/api/v1/grants', {
      project_id: projectId, project_binding_id: binding.id, node_id: runner.nodeId,
      installation_id: runner.installationId, worker_id: 'default', operations,
    })
    assert.ok(granted.grant.id)
    return granted.grant
  }
  const grant = await createGrant()
  const taskPayload = (objective, { priority, grantId = grant.id, nodeId = runner.nodeId, relativePath = 'input.txt' } = {}) => ({
    project_id: projectId, grant_id: grantId, node_id: nodeId,
    worker_id: 'default', kind: 'read_summary', relative_path: relativePath, objective,
    ...(priority === undefined ? {} : { priority }),
  })
  const createTask = async (objective, options = {}) => {
    const ticket = await admin.post('/api/v1/tickets', taskPayload(objective, options))
    createdTickets.push(ticket.id)
    return ticket
  }

  // Older high priority must outrank a newer default. Before acknowledgement the
  // same high candidate is merely redelivered, not completed or failed. Exhaust
  // this pair before creating the tied-default control so no later task intrudes.
  const high = await createTask('Select the older explicitly high-priority read before newer default work', { priority: 80 })
  assertPriority(high, 80, 'older high')
  assert.equal(high.assignments.length, 1)
  await delay(2)
  const ordinary = await createTask('Create newer default-priority read after the older high-priority task')
  assertPriority(ordinary, 0, 'newer default')
  assert.equal(ordinary.assignments.length, 1)
  const highAssignment = await runner.client.poll({ waitSeconds: 0 })
  assertAssignmentMetadata(highAssignment, high, 'first actual poll')
  assert.equal(highAssignment.cancel_requested, false)
  result.first_poll_observed = { ticket_id: highAssignment.ticket_id, assignment_id: highAssignment.id, priority_from_ticket: 80 }
  const unacknowledgedRepeat = await runner.client.poll({ lastAssignmentId: highAssignment.id, waitSeconds: 0 })
  assertAssignmentMetadata(unacknowledgedRepeat, high, 'unacknowledged redelivery')
  assert.equal(unacknowledgedRepeat.id, highAssignment.id)
  assert.deepEqual(countOutcomes(high.id), { reports: 0, artifacts: 0, effects: 0 })
  assert.equal(result.executor_count_real, 0)
  result.unacknowledged_pre_cancel_presence_protected = true
  result.first_high = { ticketId: high.id, assignmentId: highAssignment.id }
  result.older_higher_priority_selected_first = true
  await acknowledge(high, highAssignment, 'high acknowledgement')
  const defaultAssignment = await runner.client.poll({ lastAssignmentId: highAssignment.id, waitSeconds: 0 })
  assertAssignmentMetadata(defaultAssignment, ordinary, 'second poll after high acknowledgement')
  assert.notEqual(defaultAssignment.id, highAssignment.id)
  await acknowledge(ordinary, defaultAssignment, 'default acknowledgement')
  assert.deepEqual(countOutcomes(high.id), { reports: 0, artifacts: 0, effects: 0 })
  assert.deepEqual(countOutcomes(ordinary.id), { reports: 0, artifacts: 0, effects: 0 })
  assert.equal(result.executor_count_real, 0)
  result.acked_then_lower_selected = true

  const olderTie = await createTask('Create older of two default-zero scheduling control tasks')
  assertPriority(olderTie, 0, 'older zero')
  await delay(2)
  const newerTie = await createTask('Create newer of two default-zero scheduling control tasks')
  assertPriority(newerTie, 0, 'newer zero')
  const tieTimes = rows('SELECT id,created_at FROM tickets WHERE id IN (?,?) ORDER BY rowid', olderTie.id, newerTie.id)
  assert.deepEqual(tieTimes.map(item => item.id), [olderTie.id, newerTie.id])
  assert.ok(Date.parse(tieTimes[1].created_at) > Date.parse(tieTimes[0].created_at),
    'created_at really distinguishes the newest-first tie control')
  const newerTieAssignment = await runner.client.poll({ lastAssignmentId: defaultAssignment.id, waitSeconds: 0 })
  assertAssignmentMetadata(newerTieAssignment, newerTie, 'newest equal-priority first')
  await acknowledge(newerTie, newerTieAssignment, 'newer zero acknowledgement')
  const olderTieAssignment = await runner.client.poll({ lastAssignmentId: newerTieAssignment.id, waitSeconds: 0 })
  assertAssignmentMetadata(olderTieAssignment, olderTie, 'remaining older zero')
  await acknowledge(olderTie, olderTieAssignment, 'older zero acknowledgement')
  assert.equal(result.executor_count_real, 0)
  result.default_when_tied_still_newest_first = true

  const beforeInvalid = scalar('SELECT COUNT(*) AS n FROM tickets')
  const invalidPriorities = [null, 'high', true, 1.5, 101, -101]
  const invalidObserved = []
  for (const priority of invalidPriorities) {
    await assert.rejects(
      () => createTask('Malformed priority must be rejected before creating any Ticket', { priority }),
      error => {
        assert.ok(error instanceof LoomHttpError, `${String(priority)}: ${error}`)
        assert.equal(error.status, 400, `${String(priority)}: ${error}`)
        assert.equal(error.code, 'invalid_request', `${String(priority)}: ${error}`)
        return true
      },
    )
    invalidObserved.push({ priority, status: 400, code: 'invalid_request' })
    assert.equal(scalar('SELECT COUNT(*) AS n FROM tickets'), beforeInvalid)
  }
  assert.equal(createdTickets.length, beforeInvalid, 'invalid attempts are not fixture task records')
  assert.equal((await admin.get('/api/v1/projects')).projects.find(item => item.id === projectId).root, projectRoot)
  assert.equal((await admin.get('/api/v1/grants')).grants.find(item => item.id === grant.id).revoked_at, null)
  result.invalid_priority_rejected_without_ticket = true
  result.invalid_observed = invalidObserved

  // Durable stop intent precedes ordinary priority selection. It is not an
  // admitted active-job abort: the low Assignment has never been acknowledged.
  const low = await createTask('Hold this low-priority pending read while testing stop delivery', { priority: -100 })
  assertPriority(low, -100, 'pending low')
  assert.equal(low.assignments.length, 1)
  await delay(2)
  const urgent = await createTask('Create newer urgent normal work behind an existing stop intent', { priority: 100 })
  assertPriority(urgent, 100, 'pending urgent')
  const cancelResponse = await admin.post(`/api/v1/tickets/${low.id}/cancel`, {})
  assert.equal(cancelResponse.status, 'cancel_requested')
  const stopIntent = row('SELECT status,cancel_requested FROM tickets WHERE id=?', low.id)
  assert.equal(stopIntent.status, 'cancel_requested')
  assert.equal(stopIntent.cancel_requested, 1)
  assert.equal((await ticketDetail(low.id)).cancel_requested, true)
  const stopFrame = await runner.client.poll({ lastAssignmentId: null, waitSeconds: 0 })
  assertAssignmentMetadata(stopFrame, low, 'stop delivery before urgent work')
  assert.equal(stopFrame.cancel_requested, true)
  assert.notEqual(stopFrame.id, urgent.assignments[0].id)
  const repeatedStop = await runner.client.poll({ lastAssignmentId: stopFrame.id, waitSeconds: 0 })
  assertAssignmentMetadata(repeatedStop, low, 'unreported stop remains present')
  assert.equal(repeatedStop.cancel_requested, true)
  assert.equal(result.executor_count_real, 0)
  result.cancel_stop_precedes_regular_priority = true

  const cancellationReport = await runner.client.report({
    ticketId: low.id, assignmentId: stopFrame.id, leaseEpoch: stopFrame.lease_epoch,
    state: 'cancelled', summary: 'Cancelled before the receipt-only fixture executor was ever called',
    artifacts: [], artifactIds: [], effects: [], cancelAcknowledged: true,
  })
  assert.equal(cancellationReport.kind, 'report')
  assert.equal(cancellationReport.body.cancel_acknowledged, true)
  assert.deepEqual(cancellationReport.body.artifacts, [])
  assert.deepEqual(cancellationReport.body.artifact_ids, [])
  assert.deepEqual(cancellationReport.body.effects, [])
  const stopAck = await runner.client.acknowledge({
    ticketId: low.id, assignmentId: stopFrame.id, leaseEpoch: stopFrame.lease_epoch,
    accepted: true, cancelRequested: true,
  })
  assert.equal(stopAck.response.accepted, true)
  const cancelDelivery = await runner.client.dispatchOutbox()
  assert.equal(cancelDelivery.length, 1)
  assert.equal(cancelDelivery[0].kind, 'report')
  assert.equal(cancelDelivery[0].status, 'replay_delivered')
  assert.equal(cancelDelivery[0].requestId, cancellationReport.body.request_id)
  const cancelled = await ticketDetail(low.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.reports.length, 1)
  assert.equal(cancelled.reports[0].state, 'cancelled')
  assert.ok([true, 1].includes(cancelled.reports[0].cancel_acknowledged))
  assert.deepEqual(cancelled.artifacts, [])
  assert.deepEqual(cancelled.effects, [])
  assert.deepEqual(countOutcomes(low.id), { reports: 1, artifacts: 0, effects: 0 })
  assert.deepEqual(await fileBytes(join(projectRoot, 'input.txt')), originalInput)
  assert.equal(result.executor_count_real, 0)
  result.report_cancelled_only_no_execution = true

  const urgentAssignment = await runner.client.poll({ lastAssignmentId: stopFrame.id, waitSeconds: 0 })
  assertAssignmentMetadata(urgentAssignment, urgent, 'urgent after actual cancellation report')
  await acknowledge(urgent, urgentAssignment, 'urgent acknowledgement')
  assert.equal(result.executor_count_real, 0)

  // Offline inventory creates an ordinary waiting_approval Ticket. Its priority
  // is persisted before approval and survives actual heartbeat + approval + poll.
  mutateOwnedNodeOffline(runner.installationId)
  assert.equal(row('SELECT status FROM nodes WHERE id=?', runner.nodeId).status, 'offline')
  const waiting = await createTask('Preserve priority while no covered online host is available', { priority: 47 })
  assert.equal(waiting.status, 'waiting_approval')
  assert.equal(waiting.attempt, 0)
  assert.deepEqual(waiting.assignments, [])
  assert.equal(waiting.grant_id, grant.id)
  assertPriority(waiting, 47, 'waiting approval')
  const heartbeat = await runner.client.heartbeat({
    capabilities: runner.capabilities, workers: [{ worker_id: 'default' }],
    inventory: { project_roots: { [projectId]: projectRoot }, source: 'explicit_local_node_configuration' },
  })
  assert.equal(heartbeat.accepted, true)
  const available = (await admin.get('/api/v1/nodes')).nodes.find(item => item.id === runner.nodeId)
  assert.equal(available.status, 'online')
  assert.deepEqual(available.inventory.project_roots, { [projectId]: projectRoot })
  assert.ok(Date.parse(available.last_heartbeat) >= Date.now() - 60_000)
  const approval = await admin.post(`/api/v1/tickets/${waiting.id}/approval`, {
    decision: 'approve', approval_id: `priority-approval-${randomUUID()}`,
    reason: 'Approve the unchanged priority-47 read under its original Grant, binding, root and Worker',
  })
  assert.equal(approval.status, 'running')
  assert.equal(approval.assignments.length, 1)
  assert.equal(approval.assignments[0].lease_epoch, 1)
  assert.equal(approval.grant_id, waiting.grant_id)
  assert.equal(approval.grant_digest, waiting.grant_digest)
  const approvedTicket = await ticketDetail(waiting.id)
  assertPriority(approvedTicket, 47, 'approved original Ticket')
  assert.equal(approvedTicket.assignments.length, 1)
  const approvalGrant = (await admin.get('/api/v1/grants')).grants.find(item => item.id === waiting.grant_id)
  assert.equal(approvalGrant.project_binding_id, binding.id)
  assert.equal(approvalGrant.installation_id, runner.installationId)
  assert.equal(approvalGrant.revoked_at, null)
  const approvedPlacement = row(`SELECT b.root_scope,b.project_id,b.installation_id,b.worker_id
    FROM assignments a JOIN grants g ON g.id=? JOIN project_bindings b ON b.id=g.project_binding_id
    WHERE a.id=?`, waiting.grant_id, approval.assignments[0].id)
  assert.equal(approvedPlacement.root_scope, projectRoot)
  assert.equal(approvedPlacement.project_id, projectId)
  assert.equal(approvedPlacement.installation_id, runner.installationId)
  assert.equal(approvedPlacement.worker_id, 'default')
  // Legacy ordinary non-Source waiting Tickets start with blank install/digest
  // projection fields; priority does not invent authority there. This SQL check
  // proves the issued Assignment's current Grant still resolves to the original
  // exact installation, binding, root and Worker without a new Grant or Node.
  const approvalAssignment = await runner.client.poll({ lastAssignmentId: urgentAssignment.id, waitSeconds: 0 })
  assertAssignmentMetadata(approvalAssignment, approvedTicket, 'approved original priority delivered')
  assert.equal(approvalAssignment.lease_epoch, 1)
  await acknowledge(approvedTicket, approvalAssignment, 'approval acknowledgement')
  result.approval_waiting_priority_retained_and_delivered = true

  // A real controlled filesystem miss fails through the ordinary LocalNodeRunner
  // executor. No external HTTP response fabricates failed/succeeded state.
  const retry = await createTask('Read an actually missing retry fixture and preserve priority across explicit retry', {
    priority: 40, relativePath: 'retry.txt',
  })
  assertPriority(retry, 40, 'retry first attempt')
  const failedExecution = await runner.pollAndRun()
  assert.equal(failedExecution.status, 'failed', JSON.stringify(failedExecution))
  assert.equal(failedExecution.assignmentId, retry.assignments[0].id)
  assert.equal(result.executor_count_real, 1, 'real failed-read executor attempt')
  const failedCompletion = runner.state.data.completions[retry.assignments[0].id]
  assert.match(failedCompletion.summary, /ENOENT|no such file/i)
  const failedDeliveries = await runner.client.dispatchOutbox()
  assert.equal(failedDeliveries.filter(item => item.kind === 'report').length, 1)
  const failed = await ticketDetail(retry.id)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.reports.map(item => item.state), ['failed'])
  assert.deepEqual(failed.artifacts, [])
  assert.deepEqual(failed.effects, [])
  assert.deepEqual(countOutcomes(retry.id), { reports: 1, artifacts: 0, effects: 0 })
  assert.ok(scalar('SELECT acknowledged_at FROM assignments WHERE id=?', retry.assignments[0].id),
    'the real failed execution was acknowledged by the Node before its failed Report')

  const retryBytes = Buffer.from('Real bytes read only by the successful second controlled-file attempt.\n')
  await writeFile(join(projectRoot, 'retry.txt'), retryBytes, { mode: 0o600 })
  const retryResponse = await admin.post(`/api/v1/tickets/${retry.id}/retry`, {})
  assert.equal(retryResponse.status, 'running')
  assert.equal(retryResponse.attempt, 2)
  assert.equal(retryResponse.assignments.length, 2)
  assert.equal(retryResponse.grant_id, failed.grant_id)
  assert.equal(retryResponse.grant_digest, failed.grant_digest)
  assertPriority(retryResponse, 40, 'retry inherited priority')
  const secondAssignmentRecord = retryResponse.assignments.find(item => item.lease_epoch === 2)
  assert.ok(secondAssignmentRecord)
  assert.notEqual(secondAssignmentRecord.id, retry.assignments[0].id)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM assignments WHERE ticket_id=? AND lease_epoch=2', retry.id), 1)
  const successExecution = await runner.pollAndRun()
  assert.equal(successExecution.status, 'succeeded', JSON.stringify(successExecution))
  assert.equal(successExecution.assignmentId, secondAssignmentRecord.id)
  assert.equal(result.executor_count_real, 2)
  const retryOutbox = runner.state.outbox.filter(item => item.body.ticket_id === retry.id)
  const retryArtifactOutbox = retryOutbox.find(item => item.kind === 'artifact')
  const retryReportOutbox = retryOutbox.find(item => item.kind === 'report')
  assert.ok(retryArtifactOutbox && retryReportOutbox)
  const summary = JSON.parse(Buffer.from(retryArtifactOutbox.body.bytes_base64, 'base64').toString('utf8'))
  assert.equal(summary.path, 'retry.txt')
  assert.equal(summary.byte_length, retryBytes.length)
  assert.equal(summary.input_sha256, sha256(retryBytes))
  assert.equal(retryArtifactOutbox.body.metadata.sha256, sha256(Buffer.from(retryArtifactOutbox.body.bytes_base64, 'base64')))
  assert.equal(retryArtifactOutbox.body.metadata.size_bytes, Buffer.from(retryArtifactOutbox.body.bytes_base64, 'base64').length)
  assert.deepEqual(retryReportOutbox.body.artifact_ids, [retryArtifactOutbox.body.artifact_id])
  assert.equal(retryReportOutbox.body.effects.length, 1)
  assert.deepEqual(retryReportOutbox.body.effects[0].artifacts, [retryArtifactOutbox.body.artifact_id])
  const retryDeliveries = await runner.client.dispatchOutbox()
  assert.deepEqual(retryDeliveries.map(item => item.kind).sort(), ['artifact', 'report'])
  assert.ok(retryDeliveries.every(item => item.status === 'delivered' || item.status === 'replay_delivered'))
  const retried = await ticketDetail(retry.id)
  assert.equal(retried.status, 'succeeded')
  assert.deepEqual(retried.reports.map(item => item.state), ['failed', 'succeeded'])
  assert.deepEqual(retried.reports[0], failed.reports[0], 'the old real failure remains immutable history')
  assert.equal(retried.artifacts.length, 1)
  assert.equal(retried.effects.length, 1)
  assert.equal(retried.artifacts[0].assignment_id, secondAssignmentRecord.id)
  assert.equal(retried.effects[0].assignment_id, secondAssignmentRecord.id)
  assert.equal(retried.effects[0].status, 'confirmed')
  const deliveredSummary = await admin.get(`/api/v1/tickets/${retry.id}/artifacts/${retried.artifacts[0].id}`)
  assert.equal(deliveredSummary.artifact.sha256, retryArtifactOutbox.body.metadata.sha256)
  assert.equal(deliveredSummary.size_bytes, retryArtifactOutbox.body.metadata.size_bytes)
  assert.equal(sha256(Buffer.from(deliveredSummary.content)), deliveredSummary.artifact.sha256)
  assert.deepEqual(JSON.parse(deliveredSummary.content), summary)
  assert.deepEqual(await fileBytes(join(projectRoot, 'retry.txt')), retryBytes)
  assertPriority(retried, 40, 'retry after real success')
  result.retry_preserves_priority_and_old_failure = true
  result.retry = {
    ticket_id: retry.id,
    original_assignment: retry.assignments[0].id,
    second_assignment: secondAssignmentRecord.id,
    report_states: retried.reports.map(item => item.state),
    original_failure_preserved: true,
    input_sha256: sha256(retryBytes),
    summary_artifact_sha256: retried.artifacts[0].sha256,
    real_executor_missing_then_present_file: true,
  }

  // First prove the foreign requested Node is fenced with the original valid
  // Grant, independently of the subsequent separate Grant revocation.
  const beforeForeignTarget = scalar('SELECT COUNT(*) AS n FROM tickets')
  await assert.rejects(
    () => createTask('An unknown requested Node cannot borrow this real Grant', {
      grantId: grant.id, nodeId: 'f'.repeat(64), priority: 100,
    }),
    error => error.status === 403 && error.code === 'placement_scope' && error instanceof LoomHttpError,
  )
  assert.equal(scalar('SELECT COUNT(*) AS n FROM tickets'), beforeForeignTarget)

  // This separate read Grant proves high priority cannot resurrect revoked
  // placement. The unrelated, previously acknowledged valid work is untouched.
  const revokedGrant = await createGrant(['read'])
  const revokedHigh = await createTask('Never deliver this highest-priority task after its exact Grant is revoked', {
    priority: 100, grantId: revokedGrant.id,
  })
  assertPriority(revokedHigh, 100, 'revocation candidate')
  await delay(2)
  const oldGrantStillCurrent = (await admin.get('/api/v1/grants')).grants.find(item => item.id === grant.id)
  assert.equal(oldGrantStillCurrent.revoked_at, null)
  const revoke = await admin.post(`/api/v1/grants/${revokedGrant.id}/revoke`, {})
  assert.equal(revoke.revoked, true)
  assert.ok(revoke.revoked_at)
  const revokedGrantCurrent = (await admin.get('/api/v1/grants')).grants.find(item => item.id === revokedGrant.id)
  assert.equal(revokedGrantCurrent.revoked_at, revoke.revoked_at)
  const revokedTicketHistory = await ticketDetail(revokedHigh.id)
  assert.equal(revokedTicketHistory.reports.length, 0)
  assert.equal(revokedTicketHistory.artifacts.length, 0)
  const revokedPoll = await runner.client.poll({ lastAssignmentId: null, waitSeconds: 0 })
  assert.equal(revokedPoll, null, 'remaining acknowledged/completed jobs do not mask a revoked ready candidate')
  assert.deepEqual(countOutcomes(revokedHigh.id), { reports: 0, artifacts: 0, effects: 0 })
  assert.equal(result.executor_count_real, 2)
  result.revoked_high_priority_never_delivered = true
  result.revocation = {
    ticket_id: revokedHigh.id, grant_id: revokedGrant.id, revoked_at: revoke.revoked_at,
    revoked_version: revokedGrantCurrent.version,
    assignment_never_polled: true, foreign_node_placement_rejected: true,
  }

  // Every delivered frame used the authenticated enrolled Node transport and
  // omitted scheduling metadata. No fake reports or second identity were added.
  assert.equal(scalar('SELECT COUNT(*) AS n FROM nodes'), 1)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM projects'), 1)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM project_bindings'), 1)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM grants'), 2)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM tickets'), createdTickets.length)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM assignments'), 10)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM reports'), 3)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM artifacts'), 1)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM effects'), 1)
  assert.equal(scalar('SELECT COUNT(*) AS n FROM tickets WHERE id=?', revokedHigh.id), 1)
  assert.equal(runner.state.outbox.length, 0, 'all legitimate persisted reports/artifacts were really dispatched')
  assert.deepEqual(await fileBytes(join(projectRoot, 'input.txt')), originalInput)
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  assert.equal(rows('PRAGMA integrity_check')[0].integrity_check, 'ok')
  Object.assign(result, {
    overall: 'PASS', priority_not_in_assignment_body: true, one_real_enrolled_Node: true,
    fixture_valid_tickets: createdTickets.length, fixture_grants: 2,
    authoritative_counts: { nodes: 1, projects: 1, bindings: 1, grants: 2, tickets: 9, assignments: 10, reports: 3, artifacts: 1, effects: 1 },
    node_outbox_empty_after_real_dispatch: true,
    fixture_boundaries: {
      initial_pair: [high.id, ordinary.id], tied_zero_control: [olderTie.id, newerTie.id],
      stop_and_urgent: [low.id, urgent.id], waiting_approval: waiting.id,
      failed_retry: retry.id, revoked_before_delivery: revokedHigh.id,
    },
  })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  result.overall = 'FAIL'
  result.error = String(error.stack || error)
    .replaceAll(clientToken, '[redacted-test-token]')
    .replaceAll(runner?.identity?.token || '__no_enrolled_node_token__', '[redacted-node-token]')
  result.concierge_diagnostics = center?.diagnostics?.() || null
  console.error(JSON.stringify(result, null, 2))
  process.exitCode = 1
} finally {
  // LocalNodeRunner is caller-driven and has no background loop/listener. Close
  // the real center first, then delete only the root created by testingRoot().
  if (center) await center.stop().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
