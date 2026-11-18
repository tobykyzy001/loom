#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { prepareProject, startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { ControlledFileExecutor } from '../../packages/node-client/src/executor.js'

const root = await testingRoot()
const result = { overall: 'NOT RUN', scope: 'one-localNode-valid-ACK-response-loss-and-reopen' }
let center
let firstRunner
let otherNode
const tasks = []
const outsideCommits = []
let dropNextAckResponse = true
const backendFetch = globalThis.fetch.bind(globalThis)
const fetch = async (input, options = {}) => {
  const url = new URL(input)
  if (url.pathname.endsWith('/nodes/acknowledge')) {
    const body = JSON.parse(options.body)
    tasks.push({ kind: 'ack', assignment_id: body.assignment_id, request_id: body.request_id, lease_epoch: body.lease_epoch })
  } else if (url.pathname.endsWith('/nodes/artifacts') || url.pathname.endsWith('/nodes/reports')) {
    tasks.push({ kind: url.pathname.endsWith('/nodes/reports') ? 'report' : 'artifact', assignment_id: JSON.parse(options.body).assignment_id })
  }
  const response = await backendFetch(input, options)
  if (url.pathname.endsWith('/nodes/acknowledge') && dropNextAckResponse) {
    dropNextAckResponse = false
    const text = await response.text()
    assert.equal(response.status, 200, `The fixture requires the actual first server ack: ${text}`)
    const body = JSON.parse(text)
    assert.equal(body.accepted, true)
    outsideCommits.push({ accepted: true, acknowledged_at: body.acknowledged_at })
    const error = new Error('Injected loss of a real ACK response after the server committed it')
    error.after_actual_http_200 = true
    throw error
  }
  return response
}
function timeout(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
try {
  center = await startRustConcierge({ root })
  const admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken: center.clientToken })
  const projectRoot = await prepareProject(root)
  const sourceText = 'First document line for the ACK replay.\nSecond line: UTF-8 source bytes remain unchanged; another line follows.\n'
  const sourcePath = join(projectRoot, 'ack-source.txt')
  await writeFile(sourcePath, sourceText, 'utf8')
  const originalSource = await readFile(sourcePath)
  const project = await admin.post('/api/v1/projects', { name: 'Persistent acknowledgement replay', root: projectRoot, mode: 'read_write' })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const inner = new ControlledFileExecutor({ artifactDir: join(root, 'actual-artifacts'), projectRoots: { [projectId]: projectRoot } })
  let executions = 0
  let issuedAssignment
  firstRunner = new LocalNodeRunner({
    stateDir: join(root, 'node-state'), artifactDir: join(root, 'actual-artifacts'), baseUrl: center.baseUrl,
    registration: { workerId: 'default', harnessKind: 'deterministic-loopback' },
    projectRoots: { [projectId]: projectRoot }, fetch,
    executor: { async execute(assignment, grant) { executions++; issuedAssignment = structuredClone(assignment); return inner.execute(assignment, grant) } },
  })
  await firstRunner.start({ enrollmentCode: enrollment.code })
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: firstRunner.nodeId, installation_id: firstRunner.installationId, worker_id: 'default', root_scope: projectRoot })
  const grant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: firstRunner.nodeId, worker_id: 'default', operations: ['read'] })
  const ticket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: firstRunner.nodeId, worker_id: 'default', grant_id: grant.grant.id, kind: 'read_summary', relative_path: 'ack-source.txt', objective: 'One actual local read, then recover its ACK and report without a second execution' })
  const initial = await firstRunner.pollAndRun()
  assert.equal(executions, 1)
  assert.ok(issuedAssignment)
  assert.equal(issuedAssignment.id, ticket.assignments[0].id)
  await firstRunner.state.flush()
  const storedAtCommit = await admin.get(`/api/v1/tickets/${ticket.id}`)
  const firstTimestamp = storedAtCommit.assignments[0].acknowledged_at
  assert.ok(firstTimestamp)
  assert.equal(outsideCommits[0].acknowledged_at, firstTimestamp)
  assert.equal(storedAtCommit.reports.length, 0, 'A pending response must not claim the report has already reached the center')
  assert.equal(storedAtCommit.artifacts.length, 0)
  assert.equal(storedAtCommit.effects.length, 0)
  assert.equal(firstRunner.state.outbox.filter(item => item.kind === 'ack').length, 1, 'A lost response cannot discard the locally queued ACK')
  assert.equal(firstRunner.state.outbox.filter(item => item.kind === 'artifact').length, 1, 'The real local artifact must remain pending')
  assert.equal(firstRunner.state.outbox.filter(item => item.kind === 'report').length, 1, 'The real report must remain pending')
  const completion = firstRunner.state.data.completions[issuedAssignment.id]
  assert.equal(completion.state, 'succeeded', 'Local execution and still-pending transport are different facts')

  // Reopen the same actual identity and state, not another Node or a fresh nonce.
  const replacement = new LocalNodeRunner({
    stateDir: join(root, 'node-state'), artifactDir: join(root, 'actual-artifacts'), baseUrl: center.baseUrl,
    registration: { workerId: 'default', harnessKind: 'deterministic-loopback' }, projectRoots: { [projectId]: projectRoot }, fetch,
    executor: { async execute() { executions++; throw new Error('No duplicate executor is permitted during recovery') } },
  })
  await replacement.start()
  assert.equal(replacement.nodeId, firstRunner.nodeId)
  assert.equal(replacement.installationId, firstRunner.installationId)
  const deadline = Date.now() + 20_000
  while (replacement.state.outbox.length > 0 && Date.now() < deadline) {
    for (const item of replacement.state.outbox) {
      if (Date.parse(item.next_attempt_at) > Date.now()) {
        // Do not force timestamps or bypass the real persisted backoff.
        await timeout(25)
        continue
      }
    }
    await replacement.client.dispatchOutbox()
  }
  assert.equal(replacement.state.outbox.length, 0, 'Every persisted causal delivery must drain after the connection recovers')
  const ackCalls = tasks.filter(call => call.kind === 'ack')
  assert.equal(ackCalls.length, 2, 'Exactly one initial lost ACK and one durable replay reach the center')
  assert.equal(ackCalls[0].request_id, ackCalls[1].request_id, 'Restart replays the preserved ACK body/request ID')
  const finalAck = replacement.state.data.deliveries.find(item => item.kind === 'ack')
  assert.equal(finalAck.response.duplicate, true)
  assert.equal(finalAck.response.acknowledged_at, firstTimestamp)
  const delivered = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.equal(delivered.assignments[0].acknowledged_at, firstTimestamp)
  assert.equal(delivered.reports.length, 1)
  assert.equal(delivered.artifacts.length, 1)
  assert.equal(delivered.effects.length, 1)
  const artifact = delivered.artifacts[0]
  assert.ok(typeof artifact.id === 'string' && artifact.id, 'Returned artifact records use their actual persistent ID')
  const downloaded = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifact.id}`)
  const bytes = Buffer.from(downloaded.content, 'utf8')
  const actualSha = createHash('sha256').update(bytes).digest('hex')
  assert.equal(actualSha, artifact.sha256, 'The delivered byte artifact is not just a metadata receipt')
  assert.equal(actualSha, downloaded.artifact.sha256)
  assert.equal(bytes.length, downloaded.size_bytes)
  assert.equal(await readFile(sourcePath, 'utf8'), sourceText)
  assert.deepEqual(await readFile(sourcePath), originalSource)
  assert.equal(executions, 1)
  const onceDone = await replacement.pollAndRun()
  assert.equal(onceDone.status, 'idle', 'An already admitted/delivered Assignment must not execute a second time')
  assert.equal(executions, 1)
  const causal = tasks.map(item => item.kind).filter(kind => ['ack', 'artifact', 'report'].includes(kind))
  assert.deepEqual(causal, ['ack', 'ack', 'artifact', 'report'])

  const db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'))
  const auditCount = db.prepare("SELECT COUNT(*) AS count FROM audits WHERE action='assignment.acknowledged'").get().count
  assert.equal(auditCount, 1, 'Both network acknowledgements share one original first admission/audit')
  const auditValid = (await admin.get('/api/v1/audit/verify')).valid
  assert.equal(auditValid, true)
  const report = delivered.reports[0]
  assert.equal(report.state ?? report.requested_state, 'succeeded')

  // A separately enrolled identity is authenticated but cannot acknowledge the
  // original Assignment. No provider/physical second Host is inferred here.
  const secondEnrollment = await admin.post('/api/v1/enrollment-codes', {})
  otherNode = new LocalNodeRunner({ stateDir: join(root, 'other-node'), artifactDir: join(root, 'other-artifacts'), baseUrl: center.baseUrl, fetch, registration: { workerId: 'other', harnessKind: 'deterministic-loopback' }, projectRoots: { [projectId]: projectRoot } })
  await otherNode.start({ enrollmentCode: secondEnrollment.code })
  await assert.rejects(() => otherNode.client.acknowledge({ ticketId: ticket.id, assignmentId: issuedAssignment.id, leaseEpoch: issuedAssignment.lease_epoch, accepted: true }), error => error.status === 403)
  await assert.rejects(() => replacement.client.acknowledge({ ticketId: ticket.id, assignmentId: issuedAssignment.id, leaseEpoch: issuedAssignment.lease_epoch + 1, accepted: true }), error => error.status === 403)
  const revoked = await admin.post(`/api/v1/grants/${grant.grant.id}/revoke`, {})
  assert.equal(revoked.revoked, true)
  assert.equal(revoked.grant_version, 2)
  const ackRequest = finalAck.body
  await replacement.state.enqueue('ack', ackRequest, { digest: replacement.client.logicalDigest(ackRequest) })
  assert.equal(replacement.state.outbox.filter(item => item.kind === 'ack').length, 2, 'Both the stale-epoch and revoked-Grant ACK intents remain durable')
  const denied = await replacement.client.dispatchOutbox()
  const deniedAcknowledgements = denied.filter(item => item.kind === 'ack')
  assert.equal(deniedAcknowledgements.length, 2, 'Both pending ACKs must actually be attempted, not vacuously skipped')
  assert.equal(deniedAcknowledgements.every(item => item.status === 'deferred'), true, 'Current Grant fencing cannot be bypassed by replaying an old ACK/digest')
  assert.equal(db.prepare('SELECT acknowledged_at FROM assignments WHERE id=?').get(issuedAssignment.id).acknowledged_at, firstTimestamp)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audits WHERE action='assignment.acknowledged'").get().count, 1)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true, 'The accepted revocation and original admission keep one valid audit chain')
  const centralSchema = db.prepare('PRAGMA user_version').get().user_version
  assert.equal(centralSchema, 15)

  // A direct stop is not ordinary admission replay. The center has to see
  // this current cancellation intent again, rather than a local cache hiding it.
  const stopGrant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: replacement.nodeId, worker_id: 'default', operations: ['read'] })
  const stopTicket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: replacement.nodeId, worker_id: 'default', grant_id: stopGrant.grant.id,
    kind: 'read_summary', relative_path: 'ack-source.txt', objective: 'Controller-issued stop request without an additional execution' })
  await admin.post(`/api/v1/tickets/${stopTicket.id}/cancel`, {})
  const stopAssignment = await replacement.client.poll({ waitSeconds: 0 })
  assert.equal(stopAssignment.id, stopTicket.assignments[0].id)
  assert.equal(stopAssignment.cancel_requested, true, 'The controller, not a caller-only flag, requested this cancellation')
  const stopOutboxBefore = structuredClone(replacement.state.outbox)
  const stopDeliveryBefore = structuredClone(replacement.state.data.deliveries || [])
  const stopInput = { ticketId: stopTicket.id, assignmentId: stopAssignment.id, leaseEpoch: stopAssignment.lease_epoch, accepted: true, cancelRequested: true, reason: 'Controller-requested direct stop' }
  const firstStop = await replacement.client.acknowledge(stopInput)
  const secondStop = await replacement.client.acknowledge(stopInput)
  const stophttpCalls = tasks.filter(call => call.kind === 'ack' && call.assignment_id === stopAssignment.id)
  assert.equal(stophttpCalls.length, 2, 'Identical stop calls must remain two actual centre authorization requests')
  assert.notEqual(stophttpCalls[0].request_id, stophttpCalls[1].request_id)
  assert.ok(firstStop.response.acknowledged_at)
  assert.ok(secondStop.response.acknowledged_at)
  assert.equal(db.prepare('SELECT acknowledged_at FROM assignments WHERE id=?').get(stopAssignment.id).acknowledged_at, secondStop.response.acknowledged_at)
  assert.equal(secondStop.response.duplicate, undefined, 'A stop response must not be fabricated from ordinary cached replay')
  assert.deepEqual(replacement.state.outbox, stopOutboxBefore, 'Direct stop does not append ordinary queue intent or erase older failed-Grant ACK intents')
  assert.deepEqual(replacement.state.data.deliveries || [], stopDeliveryBefore, 'Existing ordinary ACK history is retained, without stop-cache growth')
  const stopDetails = await admin.get(`/api/v1/tickets/${stopTicket.id}`)
  assert.equal(stopDetails.reports.length, 0, 'An ACK receipt is not a cancelled Report or execution completion')
  assert.equal(stopDetails.effects.length, 0)
  assert.equal(stopDetails.artifacts.length, 0)
  assert.equal(executions, 1, 'No further source executor is invoked by this stop-transport check')
  const stopAudits = db.prepare("SELECT actor,evidence FROM audits WHERE ticket_id=? AND action='assignment.acknowledged'").all(stopTicket.id)
  assert.equal(stopAudits.length, 2, 'The legacy stop path really receives both server decisions; ordinary-ACK one-audit replay is a different path')
  assert.equal(stopAudits.every(audit => audit.actor === 'node'), true)
  for (const audit of stopAudits) {
    assert.equal(audit.actor, 'node')
    const evidence = JSON.parse(audit.evidence).evidence
    assert.equal(evidence.assignment_id, stopAssignment.id)
    assert.equal(evidence.delivered_is_not_read, true)
  }
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  const directStop = {
    actual_stop_intent_from_controller: true,
    stop_ack_http_calls: stophttpCalls.length,
    distinct_request_ids: true,
    no_ordinary_cache_or_pending_created: true,
    prior_ordinary_delivery_and_failed_ack_intents_preserved: true,
    server_audit_records_for_this_direct_stop: stopAudits.length,
    reports: stopDetails.reports.length, artifacts: stopDetails.artifacts.length, effects: stopDetails.effects.length,
    not_cancel_acknowledged_or_execution_completed: true,
  }
  db.close()

  Object.assign(result, {
    overall: 'PASS', assignment_id: issuedAssignment.id, ticket_id: ticket.id,
    fixture_root: root, original_acknowledged_at: firstTimestamp, central_schema: centralSchema,
    actual_loss_after_http_200: true, ordinary_valid_leases_only: true,
    duplicate_returns_first_audited_timestamp: true, exact_ack_audit_count: auditCount,
    persistent_ack_and_downstream_causal_order: causal,
    local_executor_calls: executions, original_bytes_preserved: true,
    actual_artifact_sha256: actualSha, artifact_bytes: bytes.length,
    reports: delivered.reports.length, effects: delivered.effects.length,
    report_status: report.state ?? report.requested_state,
    other_node_rejected: true, stale_epoch_rejected: true, revoked_grant_replay_blocked: true,
    direct_stop: directStop, no_second_execution: true, final_outbox_empty_before_negative_fences: true,
    source_file: originalSource.toString('utf8'),
    direct_first_read_before_outbox: initial.status,
    endpoint_model: 'deterministic loopback LocalNode on one physical host; not multi-host or live DSH',
  })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  Object.assign(result, { overall: 'FAIL', error: error.stack, root, tasks })
  console.error(JSON.stringify(result, null, 2))
  process.exitCode = 1
} finally {
  if (firstRunner) try { await firstRunner.stop() } catch {}
  if (otherNode) try { await otherNode.stop() } catch {}
  if (center) await center.stop()
}
