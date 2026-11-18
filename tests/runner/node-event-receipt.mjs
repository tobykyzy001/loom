#!/usr/bin/env node
// One actual enrolled LocalNode delivery-receipt proof. This is deliberately not
// a DSH producer, task executor, physical multi-host, or Compose proof.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareProject, startRustConcierge, testingClientToken } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient, LoomHttpError } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { canonical, sha256 } from '../../packages/node-client/src/util.js'

const root = await mkdtemp(join(tmpdir(), 'loom-node-event-receipt-'))
const clientToken = testingClientToken()
const stateDir = join(root, 'node-state')
const artifactDir = join(root, 'node-artifacts')
const durable = value => JSON.parse(JSON.stringify(value))
const result = {
  overall: 'NOT RUN', schema: 'loom.node-event-receipt.v1',
  scope: 'one-enrolled-LocalNode-real-Rust-HTTP-SQLite-event-delivery-receipt',
  delivery_proof: 'first-outbox-dispatch-and-manual-lost-response-replay-only',
  executor_calls: 0,
  not_claimed: [
    'DSH producer/delegation or accepted self-claimed parent proof',
    'task completion/report/artifact/effect',
    'physical multi-host or three-worker Compose',
    'global exactly-once guarantees',
  ],
}
let center, runner, db
let pass = false

function openDatabase() {
  assert.equal(db, undefined, 'only one owned SQLite reader may be open at once')
  db = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'), { readOnly: true })
}
function closeDatabase() {
  db?.close()
  db = undefined
}
function rows(sql, ...parameters) {
  assert.ok(db, 'SQLite reader must be open')
  return db.prepare(sql).all(...parameters).map(row => durable(row))
}
function one(sql, ...parameters) {
  const found = rows(sql, ...parameters)
  assert.equal(found.length, 1, sql)
  return found[0]
}
function receiptRow(nodeId, requestId) {
  return one("SELECT * FROM requests WHERE node_id=? AND route='events' AND request_id=?", nodeId, requestId)
}
function matchingMessage(requestId) {
  return one('SELECT * FROM messages WHERE request_id=? AND source_event_id IS NULL', requestId)
}
function eventReceiptRows(nodeId) {
  return rows("SELECT * FROM requests WHERE node_id=? AND route='events'", nodeId)
}
async function postEvent(body) {
  const nodeToken = runner?.identity?.token || (await NodeIdentity.open(stateDir)).token
  assert.ok(nodeToken, 'the actual enrolled Node token is required')
  const http = runner?.client?.http || new LoomHttpClient({ baseUrl: center.baseUrl })
  return http.post('/api/v1/nodes/events', body, { token: nodeToken })
}
async function rejected(body, status, code, label) {
  await assert.rejects(() => postEvent(body), error => {
    assert.ok(error instanceof LoomHttpError, `${label}: ${error}`)
    assert.equal(error.status, status, `${label}: ${error}`)
    assert.equal(error.code, code, `${label}: ${error}`)
    return true
  })
}
function reorderedClone(body) {
  const session = body.session_ref
  return {
    activity: body.activity, session_ref: {
      observed_seq: session.observed_seq, session_id: session.session_id,
      host_api: session.host_api, protocol: session.protocol, harness: session.harness,
    }, content: body.content, kind: body.kind, lease_epoch: body.lease_epoch,
    assignment_id: body.assignment_id, ticket_id: body.ticket_id,
    request_id: body.request_id, installation_id: body.installation_id,
    node_id: body.node_id, protocol: body.protocol,
  }
}
async function storedNodeState() {
  return JSON.parse(await readFile(join(stateDir, 'node-state.json'), 'utf8'))
}
function assertOneReceiptAndOriginal(nodeId, requestId, originalReceipt, originalMessage) {
  const eventRows = eventReceiptRows(nodeId)
  assert.equal(eventRows.length, 1, 'one Node-scoped event receipt for this initial Node')
  assert.deepEqual(eventRows[0], originalReceipt, 'receipt bytes, digest, and first timestamp are immutable')
  assert.deepEqual(matchingMessage(requestId), originalMessage, 'original message row remains byte-for-byte unchanged')
}
async function assertNoWorkOutcomes(ticketIds) {
  const placeholders = ticketIds.map(() => '?').join(',')
  assert.equal(one(`SELECT COUNT(*) AS n FROM reports WHERE ticket_id IN (${placeholders})`, ...ticketIds).n, 0)
  assert.equal(one(`SELECT COUNT(*) AS n FROM artifacts WHERE ticket_id IN (${placeholders})`, ...ticketIds).n, 0)
  assert.equal(one(`SELECT COUNT(*) AS n FROM effects WHERE ticket_id IN (${placeholders})`, ...ticketIds).n, 0)
  assert.equal(one(`SELECT COUNT(*) AS n FROM tickets WHERE id IN (${placeholders}) AND cancel_requested=0`, ...ticketIds).n, 2)
  assert.equal(one("SELECT COUNT(*) AS n FROM audits WHERE action='cancel.requested' AND ticket_id IN (?1,?2)", ...ticketIds).n, 0)
  assert.equal(one(`SELECT COUNT(*) AS n FROM assignments WHERE ticket_id IN (${placeholders})`, ...ticketIds).n, 2)
  for (const ticketId of ticketIds) {
    const detail = await new LoomHttpClient({ baseUrl: center.baseUrl, clientToken }).get(`/api/v1/tickets/${ticketId}`)
    assert.equal(detail.status, 'running', 'progress receipt does not complete the task')
    assert.equal(detail.cancel_requested, false)
    assert.equal(detail.assignments.length, 1)
    assert.equal(detail.reports.length, 0)
    assert.equal(detail.artifacts.length, 0)
    assert.equal(detail.effects.length, 0)
  }
}

try {
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: clientToken } })
  let admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken })
  assert.equal((await admin.get('/api/v1/health')).status, 'ok')
  const projectRoot = await prepareProject(root)
  const project = await admin.post('/api/v1/projects', {
    name: 'Owned single-node event receipt fixture', root: projectRoot, mode: 'read_write',
  })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  runner = new LocalNodeRunner({ stateDir, artifactDir, baseUrl: center.baseUrl,
    projectRoots: { [projectId]: projectRoot },
    registration: { workerId: 'default', harnessKind: 'deterministic-local-node' },
    executor: { execute: async () => { result.executor_calls++; throw new Error('Executor must not run for receipt-only proof') } },
  })
  await runner.start({ enrollmentCode: enrollment.code })
  const binding = await admin.post('/api/v1/project-bindings', {
    project_id: projectId, node_id: runner.nodeId, installation_id: runner.installationId,
    worker_id: 'default', root_scope: projectRoot,
  })
  const grant = await admin.post('/api/v1/grants', {
    project_id: projectId, project_binding_id: binding.id, node_id: runner.nodeId,
    installation_id: runner.installationId, worker_id: 'default', operations: ['read', 'write'],
  })
  const ticket = await admin.post('/api/v1/tickets', {
    project_id: projectId, node_id: runner.nodeId,
    worker_id: 'default', grant_id: grant.grant.id, kind: 'read_summary', relative_path: 'input.txt',
    objective: 'Deliver one exact bounded progress event and verify only its persistent receipt',
  })
  const assignment = await runner.client.poll({ waitSeconds: 0 })
  assert.equal(assignment.id, ticket.assignments[0].id, 'Assignment came from actual Node poll')
  assert.equal(assignment.ticket_id, ticket.id)
  assert.equal(assignment.lease_epoch, 1)
  assert.equal(Boolean(assignment.id), true)
  assert.equal(result.executor_calls, 0)
  assert.equal(assignment.cancel_requested, false)

  const created = await runner.client.event({
    ticketId: ticket.id, assignmentId: assignment.id, leaseEpoch: assignment.lease_epoch,
    kind: 'progress', sessionRef: {
      harness: 'deterministic-local-node', protocol: 'loom.node.v1', host_api: 'bounded-loopback',
      session_id: randomUUID(), observed_seq: 1,
    },
    summary: 'Exact bounded progress from the registered Node',
  })
  assert.equal(created.kind, 'event')
  const dispatched = await runner.client.dispatchOutbox()
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].kind, 'event')
  assert.equal(dispatched[0].status, 'delivered')
  assert.equal(dispatched[0].response.accepted, true)
  assert.equal(dispatched[0].response.duplicate, false)
  assert.equal(dispatched[0].response.node_id, runner.nodeId)
  const initialMessageId = dispatched[0].response.message_id
  assert.ok(initialMessageId)
  assert.deepEqual(Object.keys(dispatched[0].response).sort(), ['accepted', 'duplicate', 'message_id', 'node_id'])
  const persisted = await storedNodeState()
  assert.equal(persisted.outbox.length, 0)
  assert.equal(persisted.deliveries.length, 1)
  const body = durable(persisted.deliveries[0].body)
  assert.equal(typeof body.request_id, 'string')
  assert.ok(body.request_id.length > 0)
  assert.notEqual(body.request_id, persisted.deliveries[0].digest, 'event request ID is opaque, not forced equal to digest')
  const firstRequestId = body.request_id
  const logical = { ...body }
  delete logical.request_id
  const expectedDigest = sha256(canonical({ logical_fields: logical }))
  assert.equal(persisted.deliveries[0].digest, expectedDigest)
  assert.equal(body.protocol, 'loom.node.v1')
  assert.equal(body.node_id, runner.nodeId)
  assert.equal(body.installation_id, runner.installationId)
  assert.equal(body.ticket_id, ticket.id)
  assert.equal(body.assignment_id, assignment.id)
  assert.equal(body.lease_epoch, assignment.lease_epoch)
  assert.equal(body.kind, 'progress')
  assert.equal(body.content, 'Exact bounded progress from the registered Node')
  assert.equal(body.activity, body.content)

  openDatabase()
  assert.equal(one('PRAGMA user_version').user_version, 14)
  const originalReceipt = receiptRow(runner.nodeId, firstRequestId)
  const originalMessage = matchingMessage(firstRequestId)
  // Record the direct logical-body digest as diagnostic contrast; the contract
  // under test is the shared logical_fields wrapper digest, not raw body order.
  result.digest_check = {
    client_logical_digest: expectedDigest,
    server_receipt_digest: originalReceipt.payload_digest,
    direct_canonical_digest: sha256(canonical(logical)),
    wrapper_digest_equals_server: expectedDigest === originalReceipt.payload_digest,
  }
  const persistedResponse = JSON.parse(originalReceipt.response)
  assert.equal(persistedResponse.accepted, true)
  assert.equal(persistedResponse.duplicate, false)
  assert.equal(persistedResponse.message_id, initialMessageId)
  assert.equal(originalReceipt.payload_digest, expectedDigest)
  assert.equal(originalReceipt.created_at, originalMessage.created_at)
  assert.equal(originalMessage.id, initialMessageId)
  assert.equal(originalMessage.ticket_id, ticket.id)
  assert.equal(originalMessage.sender, 'worker')
  assert.equal(originalMessage.recipient, 'concierge')
  assert.equal(originalMessage.kind, 'progress')
  assert.equal(originalMessage.content, body.content)
  assert.equal(originalMessage.visibility, 'summary')
  assert.deepEqual(JSON.parse(originalMessage.session_ref), body.session_ref)
  assert.equal(one('SELECT COUNT(*) AS n FROM nodes').n, 1)

  // Preserve every raw value and the opaque request ID; only object insertion
  // order differs. This proves semantic canonical equality, not ID=digest.
  const reordered = reorderedClone(body)
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(body))
  assert.equal(canonical(reordered), canonical(body))
  const formattedReplay = await postEvent(reordered)
  assert.deepEqual(formattedReplay, {
    accepted: true, duplicate: true, node_id: runner.nodeId, message_id: initialMessageId,
  })
  assertOneReceiptAndOriginal(runner.nodeId, firstRequestId, originalReceipt, originalMessage)

  // Deliberate lost-response simulation: after the first real response was
  // successfully delivered and recorded, replay the captured body manually over
  // HTTP after restart. No TCP response was dropped by this driver.
  closeDatabase()
  await center.stop()
  center = undefined
  // Start against the same root and token; identity is reopened from the owned state.
  center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: clientToken } })
  admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken })
  runner = await LocalNodeRunner.create({ stateDir, artifactDir, baseUrl: center.baseUrl,
    registration: { workerId: 'default', harnessKind: 'deterministic-local-node' },
    projectRoots: { [projectId]: projectRoot },
    executor: { execute: async () => { result.executor_calls++; throw new Error('Executor must not run after restart') } },
  })
  // The successful dispatch left one local delivery (and an empty outbox), so
  // this captured-body HTTP call is manual lost-response simulation only.
  assert.equal((await storedNodeState()).outbox.length, 0)
  assert.equal((await storedNodeState()).deliveries.length, 1)
  assert.equal(runner.client.dispatchOutbox instanceof Function, true)
  openDatabase()
  const afterRestart = await postEvent(reordered)
  assert.deepEqual(afterRestart, {
    accepted: true, duplicate: true, node_id: runner.nodeId, message_id: initialMessageId,
  })
  assertOneReceiptAndOriginal(runner.nodeId, firstRequestId, originalReceipt, originalMessage)
  assert.equal(result.executor_calls, 0)

  const variants = [
    ['activity', body => { body.activity = 'Different visible event content' }],
    ['kind:session_link', body => { body.kind = 'session_link' }],
    ['sender:other-worker', body => { body.sender = 'other-worker' }],
    ['session_ref.observed_seq:2', body => { body.session_ref.observed_seq = 2 }],
    ['session_ref.delegated_from.source_verified', body => { body.session_ref.delegated_from = { source_verified: true } }],
  ]
  for (const [label, change] of variants) {
    const changed = structuredClone(body)
    change(changed)
    assert.equal(changed.request_id, firstRequestId)
    await rejected(changed, 409, 'idempotency_conflict', label)
    assertOneReceiptAndOriginal(runner.nodeId, firstRequestId, originalReceipt, originalMessage)
    assert.equal(JSON.parse(matchingMessage(firstRequestId).session_ref).delegated_from, undefined,
      'raw self source_verified is never promoted into stored parent proof')
  }
  const stale = structuredClone(body)
  stale.lease_epoch = 99
  await rejected(stale, 403, 'stale_lease', 'stale lease precedes idempotency')

  // A second ordinary authorized Ticket has its own Assignment/lease. Node-scoped
  // receipt identity means this fixture creates no additional work or message.
  const secondTicket = await admin.post('/api/v1/tickets', {
    project_id: projectId, node_id: runner.nodeId,
    worker_id: 'default', grant_id: grant.grant.id, kind: 'read_summary', relative_path: 'input.txt',
    objective: 'Verify cross-Assignment opaque event ID conflict without executing this second task',
  })
  const secondAssignment = await runner.client.poll({ waitSeconds: 0 })
  assert.equal(secondAssignment.id, secondTicket.assignments[0].id)
  assert.equal(secondAssignment.ticket_id, secondTicket.id)
  assert.notEqual(secondAssignment.id, assignment.id)
  assert.equal(secondAssignment.lease_epoch, 1)
  assert.equal(secondAssignment.cancel_requested, false)
  const crossTask = structuredClone(body)
  crossTask.ticket_id = secondTicket.id
  crossTask.assignment_id = secondAssignment.id
  crossTask.lease_epoch = secondAssignment.lease_epoch
  await rejected(crossTask, 409, 'idempotency_conflict', 'cross-Assignment Node-scoped receipt')
  assert.equal(secondAssignment.node_id, runner.nodeId)
  assert.equal(one('SELECT COUNT(*) AS n FROM tickets WHERE project_id=?', projectId).n, 2)
  assert.equal(one('SELECT COUNT(*) AS n FROM assignments a JOIN tickets t ON t.id=a.ticket_id WHERE t.project_id=?', projectId).n, 2)
  assertOneReceiptAndOriginal(runner.nodeId, firstRequestId, originalReceipt, originalMessage)
  assert.equal(rows('SELECT * FROM messages WHERE ticket_id=? AND request_id=?', secondTicket.id, firstRequestId).length, 0)

  const badRequestIds = [null, 1, 'x'.repeat(161)]
  for (const requestId of badRequestIds) {
    const invalid = { ...body, request_id: requestId }
    await rejected(invalid, 400, 'invalid_request', `invalid request_id ${String(requestId)}`)
  }
  assertOneReceiptAndOriginal(runner.nodeId, firstRequestId, originalReceipt, originalMessage)
  assert.equal(rows("SELECT * FROM requests WHERE route='events'").length, 1)
  assert.equal(rows('SELECT * FROM messages WHERE request_id IS NOT NULL AND source_event_id IS NULL').length, 1)
  await assertNoWorkOutcomes([ticket.id, secondTicket.id])
  assert.equal(result.executor_calls, 0)
  assert.equal(one('PRAGMA integrity_check').integrity_check, 'ok')
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)

  Object.assign(result, {
    overall: 'PASS', first_request_id: firstRequestId, node_id: runner.nodeId,
    assignment_id: assignment.id, initial_message_id: initialMessageId,
    registered_local_node: true, real_rust_concierge: true, http_sqlite_schema: 14,
    first_delivery_accepted: true, first_receipt_duplicate: false,
    exact_replay_duplicate_after_restart: true,
    formatting_equivalence_replay: true,
    changed_event_conflict_preserve_original: true,
    cross_task_opaque_id_conflicts: true,
    node_scoped_receipt_count: 1,
    fixture_tickets: 2, fixture_assignments: 2,
    no_report_artifact_effect: true, no_cancel_created: true,
    ignored_nonstring_null_overlong_request_id: true,
    stale_lease_gate_preserved: true,
    self_claimed_source_verified_not_promoted: true,
    original_immutable_message_id_and_timestamp: true,
    original_payload_digest: expectedDigest,
  })
  pass = true
  console.log(JSON.stringify(result))
} catch (error) {
  result.overall = 'FAIL'
  result.error = String(error.stack || error).replaceAll(clientToken, '[redacted-test-token]')
    .replaceAll(runner?.identity?.token || '__missing_node_token__', '[redacted-node-token]')
  if (error.cause) result.cause = String(error.cause.stack || error.cause)
  console.log(JSON.stringify(result))
  process.exitCode = 1
} finally {
  try { closeDatabase() } catch {}
  if (center) await center.stop().catch(() => {})
  if (pass) await rm(root, { recursive: true, force: true }).catch(() => {})
}
