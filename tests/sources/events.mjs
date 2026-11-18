import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { startRustConcierge, prepareProject, testingClientToken } from '../../scripts/fixtures/rust-server.mjs'

const root = await mkdtemp(join(tmpdir(), 'loom-source-events-'))
const projectRoot = await prepareProject(root)
const token = testingClientToken()
let server = await startRustConcierge({ root, env: { LOOM_CLIENT_TOKEN: token, PATH: process.env.PATH } })
let admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: token })
const project = await admin.post('/api/v1/projects', { name: 'Source ingestion evidence', root: projectRoot, mode: 'read_only' })
const projectId = project.project.id
const tuple = value => ({ id: value.id, source_sequence: value.source_sequence, thread_sequence: value.thread_sequence, external_event_id: value.external_event_id, received_at: value.received_at, payload_digest: value.payload_digest })
const eventBody = (sourceId, eventId, content, extra = {}) => ({ schema: 'loom.source-event.v1', source_id: sourceId, thread_id: 'thread-alpha', event_id: eventId, kind: 'user_message', content, ...extra })
const preview = (sourceId, cursor) => cursor
  ? admin.get(`/api/v1/source-events?cursor=${encodeURIComponent(cursor)}&limit=1`)
  : admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=thread-alpha&limit=1`)
const scalar = (sql) => {
  const db = new DatabaseSync(join(root, 'concierge', 'loom.sqlite3'), { readOnly: true })
  const value = db.prepare(sql).get()
  db.close()
  return Object.values(value)[0]
}
try {
  const started = scalar('SELECT COUNT(*) FROM source_instances')
  assert.equal(started, 0)
  const unauthenticated = await fetch(`${server.baseUrl}/api/v1/sources`)
  assert.equal(unauthenticated.status, 401, 'A known source_id cannot be used for anonymous enumeration')
  const registration = { schema: 'loom.source-instance.v1', source_key: 'desktop-source', kind: 'web', label: 'Controlled browser messages' }
  const created = await admin.post('/api/v1/sources', registration)
  const sourceId = created.source.id
  assert.match(sourceId, /^src_/)
  assert.equal(created.duplicate, false)
  assert.equal(created.permission_granted, false)
  assert.equal(created.task_created, false)
  assert.equal(created.source.owner_key, 'authenticated_client')
  const registeredAgain = await admin.post('/api/v1/sources', registration)
  assert.equal(registeredAgain.duplicate, true)
  assert.equal(registeredAgain.source.id, sourceId)
  assert.equal(registeredAgain.source.last_sequence, 0)
  assert.equal(scalar('SELECT COUNT(*) FROM source_instances'), 1)
  await assert.rejects(admin.post('/api/v1/sources', { ...registration, label: 'Other source definition' }), error => error.status === 409)
  const concurrent = await Promise.all([...Array(4)].map(() => admin.post('/api/v1/sources', registration)))
  assert.ok(concurrent.every(response => response.duplicate === true && response.source.id === sourceId))
  assert.equal(scalar('SELECT COUNT(*) FROM source_instances'), 1)

  const firstInput = eventBody(sourceId, 'event-1', 'Read this known input under a separately issued Grant', { occurred_at: '2026-01-01T01:00:00+01:00' })
  const first = await admin.post('/api/v1/source-events', firstInput)
  assert.equal(first.duplicate, false)
  assert.equal(first.source_sequence, 1)
  assert.equal(first.thread_sequence, 1)
  assert.equal(first.task_created, false)
  assert.equal(first.permission_granted, false)
  assert.equal(first.delivery_stage, 'recorded')
  assert.equal(first.occurred_at, '2026-01-01T00:00:00Z')
  const replay = await admin.post('/api/v1/source-events', firstInput)
  assert.deepEqual(tuple(replay), tuple(first))
  assert.equal(replay.duplicate, true)
  assert.equal(replay.source_sequence, 1)
  await assert.rejects(admin.post('/api/v1/source-events', { ...firstInput, content: 'Changed under the same event identity' }), error => error.status === 409)
  await assert.rejects(admin.post('/api/v1/source-events', { ...firstInput, thread_id: 'unrelated-thread' }), error => error.status === 409)
  assert.equal(scalar("SELECT COUNT(*) FROM source_threads WHERE client_thread_id='unrelated-thread'"), 0, 'Conflicts do not create a new thread')
  assert.equal(scalar('SELECT COUNT(*) FROM source_events'), 1)
  assert.equal(scalar("SELECT last_sequence FROM source_instances WHERE id = (SELECT id FROM source_instances LIMIT 1)"), 1)
  await Promise.all(Array.from({ length: 3 }, () => admin.post('/api/v1/source-events', firstInput)))
  assert.equal(scalar('SELECT COUNT(*) FROM source_events'), 1)
  assert.equal(scalar("SELECT last_sequence FROM source_instances WHERE id = (SELECT id FROM source_instances LIMIT 1)"), 1)

  const unicode = '保留这个 UTF-8 message byte-for-byte，without normalisation.'
  const second = await admin.post('/api/v1/source-events', eventBody(sourceId, 'event-2', unicode, { occurred_at: '2026-01-02T00:00:00.500Z' }))
  assert.equal(second.source_sequence, 2)
  assert.equal(second.content, unicode)
  assert.equal(second.occurred_at, '2026-01-02T00:00:00.500Z')
  const basics = [
    eventBody(sourceId, 'no-owner', 'fake owner', { owner: 'some-other-principal' }),
    eventBody(sourceId, 'no-permission', 'fake permission', { grant_id: 'forged' }),
    eventBody(sourceId, 'bad-time', 'invalid time', { occurred_at: 'tomorrow' }),
    eventBody(sourceId, 'bad-event', 'must not create a thread', { ticket_id: 'not-a-real-ticket' }),
    eventBody('unknown-source', 'invalid-scope', 'unknown source'),
    eventBody(sourceId, 'empty-content', '   '),
    eventBody(sourceId, 'false-role', 'not a task trigger', { kind: 'grant' }),
    eventBody(sourceId, 'oversized', 'x'.repeat(16001)),
  ]
  for (const request of basics) {
    await assert.rejects(admin.post('/api/v1/source-events', request), error => error.status >= 400 && error.status < 500)
  }
  assert.equal(scalar('SELECT COUNT(*) FROM source_threads'), 1)
  assert.equal(scalar('SELECT COUNT(*) FROM source_events'), 2)
  const duplicateKeys = await fetch(`${server.baseUrl}/api/v1/sources`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{"source_key":"desktop-source","source_key":"other-source"}',
  })
  assert.equal(duplicateKeys.status, 400, 'Duplicate key bodies cannot be silently normalized into a new source')

  const secondSource = await admin.post('/api/v1/sources', { ...registration, source_key: 'other-inbox', label: 'Another SourceInstance, not a network discovery' })
  const differentNamespace = await admin.post('/api/v1/source-events', eventBody(secondSource.source.id, 'event-1', 'Same external id, independent source', { occurred_at: '2020-01-01T00:00:00Z' }))
  assert.equal(differentNamespace.source_sequence, 1)
  assert.equal(differentNamespace.thread_sequence, 1)
  assert.notEqual(differentNamespace.id, first.id)
  assert.notEqual(differentNamespace.thread_id, first.thread_id, 'Internal thread identities stay separate across sources')
  assert.equal(differentNamespace.client_thread_id, first.client_thread_id)
  assert.equal(differentNamespace.client_thread_id, 'thread-alpha', 'The stable client thread name is opaque outside this source namespace')
  const originalDrawing = await admin.post('/api/v1/source-events', eventBody(sourceId, 'event-3', 'Third source-local event'))
  assert.equal(originalDrawing.source_sequence, 3)
  assert.equal(originalDrawing.thread_sequence, 3)
  let cursor = null
  let firstPageCursor = null
  const sequences = []
  for (let page = 0; page < 3; page++) {
    const listing = await preview(sourceId, cursor)
    assert.equal(listing.events.length, 1)
    sequences.push(listing.events[0].source_sequence)
    assert.equal(listing.next_sequence ?? listing.last_sequence, listing.events[0].source_sequence)
    cursor = listing.next_cursor
    if (page === 0) firstPageCursor = cursor
    if (page < 2) assert.equal(listing.has_more, true)
    else assert.equal(listing.has_more, false)
  }
  assert.deepEqual(sequences, [1, 2, 3])
  assert.equal(cursor, null)
  await assert.rejects(admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(secondSource.source.id)}&thread_id=thread-alpha&cursor=${encodeURIComponent(firstPageCursor)}`), error => {
     return error.status === 409 && error.code === 'preview_cursor_bound'
  }, 'A real bound cursor cannot be reused under another source')

  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const runner = new LocalNodeRunner({ stateDir: join(root, 'node-state'), artifactDir: join(root, 'node-artifacts'),
    baseUrl: server.baseUrl, projectRoots: { [projectId]: projectRoot } })
  await runner.start({ enrollmentCode: enrollment.code })
  await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', root_scope: projectRoot })
  const grant = await admin.post('/api/v1/grants', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', operations: ['read'] })
  const ticket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', grant_id: grant.grant.id,
    objective: 'Existing controlled work referenced by a receipt-only message', kind: 'read_summary', relative_path: 'input.txt' })
  const before = await admin.get(`/api/v1/tickets/${ticket.id}`)
  const beforeGrants = (await admin.get('/api/v1/grants')).grants
  const beforeTickets = scalar('SELECT COUNT(*) FROM tickets')
  const beforeAssignments = scalar('SELECT COUNT(*) FROM assignments')
  const linked = await admin.post('/api/v1/source-events', eventBody(sourceId, 'event-linked', 'Link this immutable message to already authorized work', { ticket_id: ticket.id }))
  assert.equal(linked.ticket_id, ticket.id)
  assert.equal(linked.task_created, false)
  assert.equal(linked.permission_granted, false)
  const after = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.equal(after.status, before.status)
  assert.equal(after.grant_digest, before.grant_digest)
  assert.equal(after.node_id, before.node_id)
  assert.deepEqual(after.reports, before.reports)
  assert.deepEqual(after.artifacts, before.artifacts)
  assert.deepEqual(after.effects, before.effects)
  assert.equal(scalar('SELECT COUNT(*) FROM tickets'), beforeTickets)
  assert.equal(scalar('SELECT COUNT(*) FROM assignments'), beforeAssignments)
  assert.equal((await admin.get('/api/v1/grants')).grants.length, beforeGrants.length)
  assert.equal(scalar("SELECT COUNT(*) FROM messages WHERE source_event_id IS NOT NULL"), 5)
  {
    const db = new DatabaseSync(join(root, 'concierge', 'loom.sqlite3'), { readOnly: true })
    const ids = db.prepare('SELECT source_event_id FROM messages WHERE source_event_id IS NOT NULL').all().map(row => row.source_event_id)
    db.close()
    assert.equal(new Set(ids).size, ids.length, 'A replay must not attach a second message to the same event')
    assert.deepEqual([...ids].sort(), [first.id, second.id, originalDrawing.id, differentNamespace.id, linked.id].sort())
  }
  const ticketMessages = (await admin.get(`/api/v1/messages?ticket_id=${encodeURIComponent(ticket.id)}`)).messages
  assert.equal(ticketMessages.filter(message => message.source_event_id !== null).length, 1)
  assert.ok(ticketMessages.some(message => message.source_event_id === null && message.kind === 'activity'), 'The existing activity message remains intact')

  const offsetPage = await admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=thread-alpha&after_sequence=1&limit=1`)
  assert.equal(offsetPage.events[0].source_sequence, 2)
  assert.equal(offsetPage.has_more, true)
  const lastPage = await admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=thread-alpha&after_sequence=3&limit=200`)
  assert.equal(lastPage.has_more, false)
  assert.equal(lastPage.next_cursor, null)
  assert.equal(lastPage.events.length, 1)
  const readCursor = offsetPage.next_cursor
  assert.ok(typeof readCursor === 'string')
  const crossSourceCursor = await fetch(`${server.baseUrl}/api/v1/source-events?source_id=${encodeURIComponent(secondSource.source.id)}&thread_id=thread-alpha&cursor=${encodeURIComponent(readCursor)}`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(crossSourceCursor.status, 409, 'A cursor cannot migrate to another SourceInstance')
  const crossThreadCursor = await fetch(`${server.baseUrl}/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=missing-thread&cursor=${encodeURIComponent(readCursor)}`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(crossThreadCursor.status, 409)
  for (const query of [
    `source_id=${sourceId}`,
     `source_id=${sourceId}&thread_id=thread-alpha&after_sequence=-1`,
    `source_id=${sourceId}&thread_id=thread-alpha&limit=201`,
    `cursor=does-not-exist`,
  ]) {
    await assert.rejects(admin.get(`/api/v1/source-events?${query}`), error => error.status >= 400 && error.status < 500)
  }
  await assert.rejects(admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=*`), error => error instanceof TypeError && /Invalid Loom API route/.test(error.message))
  const wildcard = await fetch(`${server.baseUrl}/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=%2A`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(wildcard.status, 400, 'A raw wildcard thread selector must still not become an all-thread preview')

  const replaySourceEvent = await admin.post('/api/v1/source-events', firstInput)
  assert.equal(replaySourceEvent.duplicate, true)
  assert.equal(replaySourceEvent.source_sequence, first.source_sequence)
  assert.equal(scalar("SELECT last_sequence FROM source_instances WHERE owner_key='authenticated_client' AND source_key='desktop-source'"), 4)
  await admin.post('/api/v1/messages', { content: 'Legacy conversation must not manufacture a source event' })
  assert.equal((await admin.get('/api/v1/messages')).messages.at(-1).source_event_id, null)
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  const storedDigest = first.payload_digest
  await server.stop()
  server = await startRustConcierge({ root, env: { LOOM_CLIENT_TOKEN: token, PATH: process.env.PATH } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: token })
  const restored = await admin.post('/api/v1/source-events', firstInput)
  assert.equal(restored.duplicate, true)
  assert.equal(restored.payload_digest, storedDigest)
  assert.deepEqual(tuple(restored), tuple(first))
  const recovered = await preview(sourceId, null)
  assert.equal(recovered.events.length, 1)
  assert.equal(recovered.events[0].id, first.id)
  assert.equal(recovered.source_cursor, 4)
  assert.equal(recovered.thread.last_sequence, 4)
  assert.equal(scalar("SELECT user_version FROM pragma_user_version"), 13)
  assert.equal(scalar("SELECT COUNT(*) FROM source_work_specs"), 0)
  for (const request of [firstInput, eventBody(sourceId, 'event-linked', 'Link this immutable message to already authorized work', { ticket_id: ticket.id })]) {
    const actual = await admin.post('/api/v1/source-events', request)
    assert.equal(actual.duplicate, true)
    assert.equal(actual.creation_kind, 'unbound')
    assert.equal(actual.task_ticket_id, null)
    assert.equal(actual.task_digest, null)
    assert.equal(actual.task_spec, null)
  }
  const restoredHistory = (await admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=thread-alpha&limit=200`)).events.find(row => row.id === linked.id)
  assert.equal(restoredHistory.legacy_reference, 'unverified_intake_reference')
  assert.equal(restoredHistory.ticket_id, ticket.id)
  assert.equal(restoredHistory.task_ticket_id, null)
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.source-event-verification.v1',
    registration_idempotent: true, concurrent_first_registration_idempotent: true,
    exact_replay_digest_and_original_receipt: true, source_thread_namespace_isolation: true,
    changed_content_and_cross_thread_conflict: true, opaque_cursor_bound_to_owner_source_thread: true,
    cursor_paging_not_occurred_at: true, legacy_messages_kept_null_and_dedup_unchanged: true,
    linked_existing_ticket_unchanged: true, schema13_upgrade_persists_history: true,
    restart_persists_cursor_ids_and_sequences: true, no_new_task_grant_or_agent_effect: true,
    not_claimed: ['automatic task intent / automated granted execution', 'multi-principal tenant matrix',
      'remote inbox, OAuth, actual IM or network discovery', 'distributed exactly-once or multi-process shared Leader locks',
      'physical phone/device verification'], owned_cleanup: true }, null, 2))
} finally { await server.stop() }
