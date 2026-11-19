#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { NodeState } from '../../packages/node-client/src/state.js'
import { LoomNodeClient } from '../../packages/node-client/src/client.js'

const root = await mkdtemp(join(tmpdir(), 'loom-memory-observation-')
)
const projectDir = join(root, 'project')
const otherDir = join(root, 'other-project')
await mkdir(projectDir, { mode: 0o700 })
await mkdir(otherDir, { mode: 0o700 })
const envDirectory = join(root, 'node-state')
await mkdir(envDirectory, { recursive: true, mode: 0o700 })
let server
let browserProof = 'NOT RUN (default is HTTP workflow; --browser adds isolated Edge)'
assert.ok(process.argv.slice(2).every(arg => arg === '--browser'), 'Only --browser is supported')
try {
  server = await startRustConcierge({ root: join(root, 'rust') })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const secrets = [server.clientToken]
  const post = (path, body) => admin.post(`/api/v1${path}`, body)
  const get = path => admin.get(`/api/v1${path}`)
  const patch = (path, body) => admin.patch(`/api/v1${path}`, body)
  const auditRecords = async () => (await get('/audit')).audit
  const memoryAudits = async (action, memoryId) => (await auditRecords()).filter(entry => {
    if (entry.action !== action) return false
    const envelope = JSON.parse(entry.evidence)
    assert.equal(envelope.event_type, action)
    assert.equal(envelope.actor, entry.actor)
    return envelope.evidence.memory_id === memoryId
  })
  const projects = []
  for (const [kind, directory] of [['source-demo', projectDir], ['different-demo', otherDir]]) {
    const created = await post('/projects', { name: kind, root: directory, mode: 'read_write' })
    projects.push(created.project.id)
  }
  const [projectId, otherProject] = projects
  const enrollment = await post('/enrollment-codes', {})
  secrets.push(enrollment.code)
  const identity = await NodeIdentity.open(envDirectory)
  const durable = await NodeState.open(envDirectory)
  const client = new LoomNodeClient({ http: new LoomHttpClient({ baseUrl: server.baseUrl }), identity, state: durable })
  await client.enroll({ enrollmentCode: enrollment.code, capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], workerId: 'default' })
  const heartbeat = await client.heartbeat({
    capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }],
    workers: [{ worker_id: 'default', harness_kind: 'local-fixture', capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }] }],
    inventory: { project_roots: { [projectId]: projectDir, [otherProject]: otherDir } },
  })
  assert.ok(heartbeat.accepted)
  const nodeId = identity.nodeId
  const grants = []
  for (const [id, directory] of [[projectId, projectDir], [otherProject, otherDir]]) {
    await post('/project-bindings', { project_id: id, node_id: nodeId, installation_id: identity.installationId, worker_id: 'default', root_scope: directory })
    const rootGrant = await post('/grants', { project_id: id, node_id: nodeId, worker_id: 'default', operations: ['read'] })
    grants.push(rootGrant.grant.id)
  }
  const tickets = []
  const makeTicket = async (number) => {
    const response = await post('/tickets', { project_id: projectId, objective: `Established source observation ${number}`,
      kind: 'read_summary', relative_path: 'input.txt', content: `Source ${number}`, grant_id: grants[0] })
    tickets.push(response.id)
    return response.id
  }
  const other = await post('/tickets', { project_id: otherProject, objective: 'A separate project source for forbidden cross-scope observation', kind: 'read_summary', relative_path: 'input.txt', grant_id: grants[1] })
  const firstSource = await makeTicket(1)
  for (const [label, input, reason] of [
    ['missing evidence', { value: 'Preference', source_refs: [] }, 'source_refs must contain 1 through 32 Ticket IDs'],
    ['fabricated evidence', { value: 'Preference', source_refs: ['tkt_not_real'] }, 'source Ticket not found'],
    ['cross project', { value: 'Preference', source_refs: [other.id] }, 'belongs to another project'],
    ['unknown field', { value: 'Preference', source_refs: [firstSource], implicit_grant: true }, 'unsupported field'],
    ['unrecognized kind', { value: 'Preference', kind: 'classified_as_runtime', source_refs: [firstSource] }, 'kind must be memory, skill or route'],
  ]) {
    await assert.rejects(() => post('/candidates', { project_id: projectId, kind: 'memory', ...input }), error => error.message.includes(reason), `${label}: expected ${reason}`)
  }
  // A source reference is a durable claim of origin, not an optional user string.
  // Project memory may cite only that project's actual Ticket; independent
  // explicit Remember without any source remains valid and is separately deleted.
  const auditBefore = await get('/audit')
  for (const [source_ticket_id, reason, expectedStatus] of [
    [other.id, 'belongs to another project, not this Memory', 400],
    ['tkt_not_a_real_source', 'Source Ticket not found', 404],
    [7, 'source_ticket_id', 400],
  ]) {
    await assert.rejects(() => post('/memories', { project_id: projectId, scope: 'project',
      content: 'A bounded project preference with an invalid origin', source_ticket_id }),
      error => error.status === expectedStatus && new RegExp(reason).test(error.message), `Rejected a forged direct Memory source: ${reason}`)
    assert.equal((await get('/memories')).memories.length, 0, 'Rejected provenance must leave no visible Memory')
    assert.deepEqual(await get('/audit'), auditBefore, 'A rejected Memory source cannot write memory.explicit_saved or any corresponding audit mutation')
  }
  const sourcedMemory = await post('/memories', { project_id: projectId, scope: 'project',
    content: 'A real explicit Memory may refer to a same-project Ticket', source_ticket_id: firstSource })
  assert.equal(sourcedMemory.grant_created, false)
  let directMemory = (await get('/memories')).memories.find(memory => memory.id === sourcedMemory.id)
  assert.equal(directMemory.project_id, projectId)
  assert.equal(directMemory.source_ticket_id, firstSource)
  await admin.request('DELETE', `/api/v1/memories/${sourcedMemory.id}`)
  const sourcedDeleteAudits = await memoryAudits('memory.explicit_deleted', sourcedMemory.id)
  assert.equal(sourcedDeleteAudits.length, 1, 'The provenance fixture establishes one real sourced ordinary deletion audit')
  assert.equal(sourcedDeleteAudits[0].ticket_id, firstSource)
  const unboundMemory = await post('/memories', { project_id: projectId, scope: 'project',
    content: 'An explicit standalone preference does not require the user to explain a source Ticket' })
  directMemory = (await get('/memories')).memories.find(memory => memory.id === unboundMemory.id)
  assert.equal(directMemory.project_id, projectId)
  assert.equal(directMemory.source_ticket_id, null)
  await admin.request('DELETE', `/api/v1/memories/${unboundMemory.id}`)
  assert.equal((await get('/memories')).memories.length, 0)
  assert.equal((await get('/candidates')).candidates.length, 0)
  assert.equal((await get('/grants')).grants.length, 2)

  for (const expected of [1, 1]) {
    const observation = await post('/candidates', { project_id: projectId, kind: 'memory', value: 'Concise reports with citations', source_refs: [firstSource] })
    assert.equal(observation.observations, expected)
    assert.equal(observation.candidate, null)
  }
  const second = await makeTicket(2)
  assert.equal((await post('/candidates', { project_id: projectId, kind: 'memory', value: 'Concise reports with citations', source_refs: [second] })).candidate, null)
  const third = await makeTicket(3)
  const { candidate } = await post('/candidates', { project_id: projectId, kind: 'memory', value: 'Concise reports with citations', source_refs: [third] })
  assert.equal(candidate.id.startsWith('candidate_'), true)
  assert.equal(candidate.kind, 'memory')
  assert.equal(candidate.scope, projectId)
  assert.equal(candidate.status, 'pending')
  assert.deepEqual(JSON.parse(candidate.source_refs), [firstSource, second, third])
  const candidateId = candidate.id
  const rawObservation = JSON.parse(candidate.content)
  assert.ok((await post('/candidates', { project_id: projectId, kind: 'memory', value: 'Concise reports with citations', source_refs: [firstSource] })).observations >= 1)
  assert.equal((await get('/candidates')).candidates.length, 1)
  assert.equal((await get('/memories')).memories.length, 0)
  if (process.argv.includes('--browser')) {
    const { verifyMemoryCandidateBrowser } = await import('../browser/memory-candidates.mjs')
    browserProof = await verifyMemoryCandidateBrowser({ server, root, candidateId })
    assert.equal((await get('/memories')).memories.length, 0, 'Browser deliberately withdrew the associated preference via its actual UI')
    assert.equal((await get('/grants')).grants.length, 2, 'UI review never creates authority')
  }

  // Correcting a proposal is distinct from accepting it. The source-group
  // fingerprint belongs to the raw observation, not to the revised human text.
  const beforeCandidateEdit = (await get('/candidates')).candidates.find(row => row.id === candidateId)
  const proposalBeforeHttpEdit = JSON.parse(beforeCandidateEdit.content)
  const correctedCandidateText = 'Reviewed project preference: keep concise evidence visible'
  const candidateEditAudits = async () => (await auditRecords()).filter(entry => entry.action === 'candidate.memory.edited'
    && JSON.parse(entry.evidence).evidence.candidate_id === candidateId)
  const candidateEdit = (version, content) => patch(`/candidates/${candidateId}`, { decision: 'edit', expected_version: version, content })
  const editedCandidate = await candidateEdit(beforeCandidateEdit.version, correctedCandidateText)
  const correctedProposal = JSON.parse(editedCandidate.content)
  assert.equal(editedCandidate.id, candidateId)
  assert.equal(editedCandidate.status, beforeCandidateEdit.status)
  assert.equal(editedCandidate.scope, projectId)
  assert.equal(editedCandidate.version, beforeCandidateEdit.version + 1)
  assert.equal(correctedProposal.content, correctedCandidateText)
  assert.equal(proposalBeforeHttpEdit.fingerprint, rawObservation.fingerprint)
  assert.equal(correctedProposal.fingerprint, rawObservation.fingerprint, 'Human correction must not change its observation-group identity')
  for (const field of ['schema', 'source', 'project_id', 'kind', 'replay_state']) {
    assert.deepEqual(correctedProposal[field], proposalBeforeHttpEdit[field], `${field} stays the original source projection`)
  }
  assert.deepEqual(JSON.parse(editedCandidate.source_refs), JSON.parse(beforeCandidateEdit.source_refs))
  assert.equal((await get('/memories')).memories.length, 0, 'Editing a candidate must not accept it or create a Memory')
  assert.equal((await get('/grants')).grants.length, 2)

  const repeatedEdit = await candidateEdit(editedCandidate.version, correctedCandidateText)
  assert.equal(repeatedEdit.version, editedCandidate.version)
  assert.equal(repeatedEdit.content, editedCandidate.content)
  const exactHttpEditAudits = (await candidateEditAudits()).filter(entry => {
    const evidence = JSON.parse(entry.evidence).evidence
    return evidence.previous_version === beforeCandidateEdit.version && evidence.version === editedCandidate.version
  })
  assert.equal(exactHttpEditAudits.length, 1, 'An identical proposal correction on the same version cannot create another audit; earlier browser versions remain valid history')
  const candidateEditAudit = exactHttpEditAudits[0]
  assert.equal(candidateEditAudit.actor, 'client')
  const candidateEditEnvelope = JSON.parse(candidateEditAudit.evidence)
  assert.equal(candidateEditEnvelope.event_type, 'candidate.memory.edited')
  assert.deepEqual(candidateEditEnvelope.evidence, {
    candidate_id: candidateId, scope: projectId, fingerprint: rawObservation.fingerprint,
    source_refs: JSON.parse(beforeCandidateEdit.source_refs),
    previous_version: beforeCandidateEdit.version, version: editedCandidate.version,
    content_changed: true, accepted_memory_created: false, authority_created: false,
  })
  assert.equal(JSON.stringify(candidateEditEnvelope).includes(correctedCandidateText), false, 'Audit does not copy preference text into a second record')

  await assert.rejects(() => candidateEdit(beforeCandidateEdit.version, correctedCandidateText), error => {
    assert.equal(error.status, 409)
    assert.match(error.message, /MemoryCandidate version conflict/)
    return true
  }, 'Even identical old-version text cannot overwrite a later revision')
  const auditsBeforeInvalidEdits = await auditRecords()
  for (const content of [null, true, { text: correctedCandidateText }, '', '   ', 'x'.repeat(501), '记'.repeat(251), 'SECRET must not be copied', 'api_key=copy-not-allowed', 'private_key=copy-not-allowed', 'https://resource.example/private']) {
    await assert.rejects(() => candidateEdit(editedCandidate.version, content), error => error.status === 400)
  }
  for (const expected_version of [null, true, '2', 1.5]) {
    await assert.rejects(() => patch(`/candidates/${candidateId}`, { decision: 'edit', content: correctedCandidateText, expected_version }), error => error.status === 400)
  }
  await assert.rejects(() => patch(`/candidates/${candidateId}`, { decision: 'edit', content: correctedCandidateText, expected_version: editedCandidate.version, scope: otherProject }), error => error.status === 400)
  await assert.rejects(() => patch(`/candidates/${candidateId}`, { decision: 'edit', content: correctedCandidateText, expected_version: editedCandidate.version, source_refs: [other.id] }), error => error.status === 400)
  await assert.rejects(() => patch('/candidates/candidate_missing', { decision: 'edit', expected_version: 1, content: correctedCandidateText }), error => error.status === 404)
  assert.deepEqual(await auditRecords(), auditsBeforeInvalidEdits, 'Every rejected candidate correction leaves original content and successful audit history unchanged')
  assert.deepEqual((await get('/candidates')).candidates.find(row => row.id === candidateId).content, editedCandidate.content)
  assert.equal((await get('/memories')).memories.length, 0)

  const addedSourceAfterEdit = await makeTicket(4)
  // Re-observe the actual original raw input. A UI-edited proposal is not a
  // substitute observation value and must not silently define a semantic merge.
  const mergedAfterEdit = await post('/candidates', { project_id: projectId, kind: 'memory', value: rawObservation.content, source_refs: [addedSourceAfterEdit] })
  assert.equal(mergedAfterEdit.candidate.id, candidateId)
  assert.equal(mergedAfterEdit.candidate.version, editedCandidate.version, 'Observing another source does not rewrite or promote the human-edited candidate')
  assert.equal(JSON.parse(mergedAfterEdit.candidate.content).content, correctedCandidateText)
  assert.equal(JSON.parse(mergedAfterEdit.candidate.content).fingerprint, rawObservation.fingerprint)
  assert.equal(mergedAfterEdit.existing_candidate, true)
  assert.equal(mergedAfterEdit.promotion, 'retained_history_not_auto_promoted')
  assert.deepEqual(JSON.parse(mergedAfterEdit.candidate.source_refs), JSON.parse(beforeCandidateEdit.source_refs), 'The stored candidate keeps its own original source projection, instead of claiming the later source was already attached')
  const mergedObservation = JSON.parse(await sql(join(server.dataDir, 'loom.sqlite3'), `SELECT json_object('occurrences',occurrences,'source_refs',source_refs) FROM observations WHERE fingerprint='${rawObservation.fingerprint}'`))
  assert.equal(mergedObservation.occurrences, 4)
  assert.deepEqual(JSON.parse(mergedObservation.source_refs), [...JSON.parse(beforeCandidateEdit.source_refs), addedSourceAfterEdit], 'The observation history itself gains the exact validated new source in first-seen order')
  assert.equal((await get('/memories')).memories.length, 0)

  const accepted = await patch(`/candidates/${candidateId}`, { decision: 'accept', scope: projectId })
  assert.equal(accepted.status, 'accepted')
  let memories = (await get('/memories')).memories
  assert.equal(memories.length, 1)
  assert.equal(memories[0].id, accepted.derived_memory_id)
  assert.equal(memories[0].scope, 'project')
  assert.equal(memories[0].project_id, projectId)
  assert.equal(memories[0].source_ticket_id, firstSource)
  assert.equal(memories[0].content, correctedCandidateText)
  await assert.rejects(() => candidateEdit(accepted.version, 'A second candidate edit must not overwrite the accepted Memory'), error => error.status === 400, 'Editing an accepted proposal cannot rewrite its derived Memory')
  assert.equal((await get('/memories')).memories[0].content, correctedCandidateText)
  assert.equal((await candidateEditAudits()).length, 1 + Number(process.argv.includes('--browser')), 'Only the one HTTP edit and, when exercised, the one real browser edit are present; terminal-history attempts add none')
  assert.equal((await get('/grants')).grants.length, 2, 'Reviewing candidates must not create new permissions')
  const linkedMemoryId = memories[0].id
  const edited = await patch(`/memories/${linkedMemoryId}`, { content: memories[0].content, scope: 'user', project_id: null })
  assert.equal(edited.memory.scope, 'user')
  assert.equal(edited.memory.project_id, null)
  const [firstEditAudit, ...duplicateFirstEditAudits] = await memoryAudits('memory.explicit_updated', linkedMemoryId)
  assert.deepEqual(duplicateFirstEditAudits, [], 'One explicit UPDATE intent has exactly one edit audit')
  assert.equal(firstEditAudit.ticket_id, firstSource, 'Edit audit remains associated with the original Ticket origin')
  const firstEditEnvelope = JSON.parse(firstEditAudit.evidence)
  assert.equal(firstEditAudit.actor, 'client')
  assert.equal(firstEditEnvelope.event_type, 'memory.explicit_updated')
  const firstEditEvidence = firstEditEnvelope.evidence
  assert.deepEqual(firstEditEvidence, {
    memory_id: linkedMemoryId, previous_scope: 'project', scope: 'user', previous_version: 1, version: 2,
    content_changed: false, project_changed: true, authority_changed: false, origin_preserved: true,
    client_reason: 'explicit_memory_edit',
  }, 'Audit evidence is bounded and derived from the actual project-to-user Memory update')
  const restored = await patch(`/memories/${linkedMemoryId}`, { content: memories[0].content, scope: 'project', project_id: projectId })
  assert.equal(restored.memory.scope, 'project')
  assert.equal(restored.memory.project_id, projectId)
  assert.equal(restored.memory.source_ticket_id, firstSource)
  const restoredEditAudits = await memoryAudits('memory.explicit_updated', linkedMemoryId)
  assert.equal(restoredEditAudits.length, 2, 'Unchanged content still increments and audits the second UPDATE intent')
  assert.deepEqual(JSON.parse(restoredEditAudits[0].evidence).evidence, {
    memory_id: linkedMemoryId, previous_scope: 'user', scope: 'project', previous_version: 2, version: 3,
    content_changed: false, project_changed: true, authority_changed: false, origin_preserved: true,
    client_reason: 'explicit_memory_edit',
  })
  assert.equal(restoredEditAudits[0].ticket_id, firstSource)
  const unchanged = await patch(`/memories/${linkedMemoryId}`, { content: memories[0].content, scope: 'project', project_id: projectId })
  assert.equal(unchanged.memory.version, 4)
  assert.notEqual(unchanged.memory.updated_at, restored.memory.updated_at, 'The no-op UPDATE intent still rewrites its durable timestamp as before')
  const unchangedEditAudits = await memoryAudits('memory.explicit_updated', linkedMemoryId)
  assert.equal(unchangedEditAudits.length, 3, 'Even unchanged content and scope has one successful UPDATE audit')
  assert.deepEqual(JSON.parse(unchangedEditAudits[0].evidence).evidence, {
    memory_id: linkedMemoryId, previous_scope: 'project', scope: 'project', previous_version: 3, version: 4,
    content_changed: false, project_changed: false, authority_changed: false, origin_preserved: true,
    client_reason: 'explicit_memory_edit',
  })
  assert.equal(unchanged.memory.source_ticket_id, firstSource)
  assert.notEqual(await patch(`/memories/${linkedMemoryId}`, { content: memories[0].content, scope: 'project', project_id: 'missing' }).catch(error => error.status), 200)
  const auditsBeforeMissingEdit = await auditRecords()
  assert.equal(await patch('/memories/memory_missing', { content: 'Never persist missing fixture text', scope: 'user', project_id: null }).catch(error => error.status), 404)
  assert.deepEqual(await auditRecords(), auditsBeforeMissingEdit, 'A missing Memory edit produces no successful-operation audit')
  await assert.rejects(() => patch(`/candidates/${candidateId}`, { decision: 'accept' }), error => /pending|second Memory/.test(error.message), 'Every already-accepted candidate must require an explicit undo before a new save')
  const unrelated = await post('/memories', { project_id: projectId, scope: 'project', content: 'A separately saved manual preference, not a candidate observation' })
  assert.equal((await get('/memories')).memories.length, 2)
  const directDelete = await admin.request('DELETE', `/api/v1/memories/${encodeURIComponent(memories[0].id)}`)
  assert.equal(directDelete.candidate_withdrawal, true)
  assert.equal(directDelete.candidate_status, 'pending')
  assert.equal(directDelete.grants_changed, false)
  assert.deepEqual(await memoryAudits('memory.explicit_deleted', linkedMemoryId), [], 'Linked deletion is candidate withdrawal, not a duplicate ordinary deletion')
  const linkedWithdrawals = (await auditRecords()).filter(entry => entry.action === 'candidate.memory.withdrawn' && JSON.parse(entry.evidence).evidence.memory_id === linkedMemoryId)
  assert.equal(linkedWithdrawals.length, 1, 'The existing linked withdrawal remains its exact single candidate action')
  const survivingMemories = (await get('/memories')).memories
  assert.equal(survivingMemories.length, 1)
  assert.equal(survivingMemories[0].id, unrelated.id, 'Linked withdrawal must not remove an unrelated manual Memory')
  const ordinaryDelete = await admin.request('DELETE', `/api/v1/memories/${encodeURIComponent(unrelated.id)}`)
  assert.equal(ordinaryDelete.deleted, true)
  assert.equal(ordinaryDelete.grants_changed, false)
  assert.equal(ordinaryDelete.authority_changed, false)
  assert.equal(ordinaryDelete.candidate_withdrawal, undefined, 'Unlinked Memory deletion remains its own ordinary operation')
  const [ordinaryDeleteAudit, ...duplicateDeleteAudits] = await memoryAudits('memory.explicit_deleted', unrelated.id)
  assert.deepEqual(duplicateDeleteAudits, [])
  assert.equal(ordinaryDeleteAudit.actor, 'client')
  assert.equal(ordinaryDeleteAudit.ticket_id, null)
  assert.deepEqual(JSON.parse(ordinaryDeleteAudit.evidence).evidence, {
    memory_id: unrelated.id, previous_scope: 'project', authority_changed: false, candidate_withdrawal: false,
  }, 'Delete evidence retains only the original scope and explicit, non-candidate operation facts')
  assert.deepEqual(await memoryAudits('memory.explicit_deleted', linkedMemoryId), [], 'The unrelated delete never attributes itself to the linked Memory')
  assert.equal((await get('/memories')).memories.length, 0)
  const auditsBeforeMissingDelete = await auditRecords()
  assert.equal((await admin.request('DELETE', '/api/v1/memories/memory_missing').catch(error => error.status)), 404)
  assert.deepEqual(await auditRecords(), auditsBeforeMissingDelete, 'A missing Memory deletion produces no successful-operation audit')
  assert.equal((await get('/candidates')).candidates.find(row => row.id === candidateId).status, 'pending')
  const restoredAfterDelete = await patch(`/candidates/${candidateId}`, { decision: 'accept' })
  assert.equal(restoredAfterDelete.status, 'accepted')
  memories = (await get('/memories')).memories
  assert.equal(memories.length, 1)
  assert.equal(memories[0].id, restoredAfterDelete.derived_memory_id)
    const routeSources = [await makeTicket(4), await makeTicket(5), await makeTicket(6)]
  await post('/candidates', { project_id: projectId, kind: 'route', value: 'Concise reports with citations', source_refs: [routeSources[0]] })
  await post('/candidates', { project_id: projectId, kind: 'route', value: 'Concise reports with citations', source_refs: [routeSources[1]] })
  const { candidate: routeCandidate } = await post('/candidates', { project_id: projectId, kind: 'route', value: 'Concise reports with citations', source_refs: [routeSources[2]] })
  assert.equal(routeCandidate.kind, 'route')
  await assert.rejects(() => patch(`/candidates/${routeCandidate.id}`, { decision: 'accept' }), /route candidate is not a portable memory/)
  await assert.rejects(() => patch(`/candidates/${routeCandidate.id}`, { decision: 'edit', expected_version: routeCandidate.version, content: 'A route must not become a reviewed preference through text editing' }), error => error.status === 400)
  assert.equal((await get('/candidates')).candidates.find(row => row.id === routeCandidate.id).content, routeCandidate.content)
  assert.equal((await get('/memories')).memories.length, 1)
  await assert.rejects(() => patch(`/candidates/${candidateId}`, { decision: 'never' }), /accepted Memory|explicit undo/)
  let suppressionCandidate
  for (const number of [7, 8, 9]) {
    const observed = await post('/candidates', { project_id: projectId, kind: 'memory', value: 'An independently reviewable preference', source_refs: [await makeTicket(number)] })
    if (observed.candidate) suppressionCandidate = observed.candidate
  }
  assert.equal((await patch(`/candidates/${suppressionCandidate.id}`, { decision: 'never' })).status, 'never')
  assert.equal((await patch(`/candidates/${suppressionCandidate.id}`, { decision: 'never' })).status, 'never', 'Never is idempotent')
  assert.equal((await post('/candidates', { project_id: projectId, kind: 'memory', value: 'An independently reviewable preference', source_refs: [await makeTicket(10)] })).candidate.status, 'never')
  assert.equal((await patch(`/candidates/${suppressionCandidate.id}`, { decision: 'undo' })).status, 'pending')
  assert.equal((await get('/memories')).memories.length, 1)
  assert.equal((await patch(`/candidates/${candidateId}`, { decision: 'undo' })).status, 'pending')
  assert.equal((await get('/memories')).memories.length, 0)
  const rebuilt = await patch(`/candidates/${candidateId}`, { decision: 'accept' })
  assert.equal(rebuilt.status, 'accepted')
  assert.notEqual(rebuilt.derived_memory_id, accepted.derived_memory_id)
  memories = (await get('/memories')).memories
  assert.equal(memories.length, 1, 'Re-accepting after undo creates exactly one new linked Memory, not a duplicate')
  assert.equal(memories[0].id, rebuilt.derived_memory_id)
  await assert.rejects(() => patch(`/candidates/${candidateId}`, { decision: 'accept' }), /pending|second Memory/)
  assert.equal((await patch(`/candidates/${candidateId}`, { decision: 'undo' })).status, 'pending')
  assert.equal((await get('/memories')).memories.length, 0)
  assert.equal((await patch(`/candidates/${candidateId}`, { decision: 'later' })).status, 'later')
  assert.equal((await post('/candidates', { project_id: projectId, kind: 'memory', value: 'Concise reports with citations', source_refs: [await makeTicket(8)] })).candidate.status, 'later')
  assert.equal((await patch(`/candidates/${candidateId}`, { decision: 'never' })).status, 'never')
  assert.equal((await patch(`/candidates/${candidateId}`, { decision: 'undo' })).status, 'pending')

  const failureFixture = await post('/memories', { project_id: projectId, scope: 'project', source_ticket_id: firstSource,
    content: 'Owned SQL failure fixture: preserve original content' })
  const failureMemory = (await get('/memories')).memories.find(memory => memory.id === failureFixture.id)
  assert.equal(failureMemory.content, 'Owned SQL failure fixture: preserve original content')
  assert.equal(failureMemory.version, 1)
  const failureOriginal = { content: failureMemory.content, scope: failureMemory.scope, projectId: failureMemory.project_id,
    version: failureMemory.version, updatedAt: failureMemory.updated_at, source: failureMemory.source_ticket_id }
  const beforeFailures = await auditRecords()
  const database = join(server.dataDir, 'loom.sqlite3')
  let failureChecksCompleted = false
  async function withRejectedAudit(action, operation) {
    await sqlScript(database, `CREATE TRIGGER reject_memory_audits BEFORE INSERT ON audits WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'audit_injected_failure'); END;`)
    let error
    try { error = await operation().catch(cause => cause) }
    finally { await sqlScript(database, "DROP TRIGGER IF EXISTS reject_memory_audits") }
    assert.equal(error?.status, 500, `Audit insertion failure for ${action} must not return HTTP success`)
    const current = (await get('/memories')).memories.find(memory => memory.id === failureFixture.id)
    assert.ok(current, 'The unlinked failure-fixture Memory survives both edit and delete rollback')
    assert.equal(current.content, failureOriginal.content)
    assert.equal(current.scope, failureOriginal.scope)
    assert.equal(current.project_id, failureOriginal.projectId)
    assert.equal(current.version, failureOriginal.version)
    assert.equal(current.updated_at, failureOriginal.updatedAt)
    assert.equal(current.source_ticket_id, failureOriginal.source)
    assert.deepEqual(await memoryAudits(action, failureFixture.id), [], 'No rejected audit was recorded as a successful Memory operation')
    assert.deepEqual(await auditRecords(), beforeFailures, 'Failed mutation and failed audit insertion leave the whole audit list unchanged')
  }
  try {
    await withRejectedAudit('memory.explicit_updated', () => patch(`/memories/${failureFixture.id}`, {
      content: 'Failing audit must roll this attempted content back' }))
    await withRejectedAudit('memory.explicit_deleted', () => admin.request('DELETE', `/api/v1/memories/${failureFixture.id}`))
    failureChecksCompleted = true
  } finally {
    // Always remove the fixture trigger before the remaining real workflow and restart.
    await sqlScript(database, 'DROP TRIGGER IF EXISTS reject_memory_audits')
    assert.equal(await sql(database, "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='reject_memory_audits'"), 0)
  }
  const failureRecovered = await patch(`/memories/${failureFixture.id}`, { content: 'Audit insertion recovered only after fixture cleanup' })
  assert.equal(failureRecovered.memory.version, 2)
  assert.equal((await memoryAudits('memory.explicit_updated', failureFixture.id)).length, 1)
  const recoveredDelete = await admin.request('DELETE', `/api/v1/memories/${failureFixture.id}`)
  assert.equal(recoveredDelete.deleted, true)
  assert.equal((await memoryAudits('memory.explicit_deleted', failureFixture.id)).length, 1)
  assert.equal(failureChecksCompleted, true, 'Both actual SQL trigger rollback checks completed before cleanup/recovery')
  assert.equal(await sql(database, "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='reject_memory_audits'"), 0, 'No failure-injection trigger remains before restart')
  const durableDeletedEvidence = JSON.parse((await memoryAudits('memory.explicit_deleted', failureFixture.id))[0].evidence).evidence
  assert.deepEqual(durableDeletedEvidence, { memory_id: failureFixture.id, previous_scope: 'project', authority_changed: false, candidate_withdrawal: false })

  const fingerprint = JSON.parse(candidate.content).fingerprint
  await promisify(execFile)('python3', ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE observations SET expires_at=? WHERE fingerprint=?", ("2000-01-01T00:00:00Z",sys.argv[2])); db.execute("INSERT INTO messages(id,ticket_id,sender,content,kind,visibility,created_at) VALUES(?,?,?,?,?,?,?)",("fixture-source-notice",sys.argv[2],"client","Only synthetic candidate observation, no private transcript", "activity", "summary", "2026-01-01T00:00:00Z")); db.commit()', join(server.dataDir, 'loom.sqlite3'), fingerprint])
  const expired = await post('/candidates', { project_id: projectId, kind: 'memory', value: 'Concise reports with citations', source_refs: [await makeTicket(9)] })
  assert.equal(expired.occurrences, 1, 'Expired evidence cannot keep its old repetition count or create a fresh candidate')
  assert.equal(expired.promotion, 'retained_history_not_auto_promoted')
  assert.equal(expired.candidate.id, candidateId, 'Previously observed candidate stays readable without claiming another promotion')
  assert.equal((await get('/memories')).memories.length, 0)
  assert.equal((await get('/candidates')).candidates.filter(row => row.id.startsWith('candidate_')).length, 3 + Number(process.argv.includes('--browser')))
  assert.equal(await sql(join(server.dataDir, 'loom.sqlite3'), 'SELECT COUNT(*) FROM candidate_memory_links'), 0)
  assert.equal(await sql(join(server.dataDir, 'loom.sqlite3'), 'PRAGMA user_version'), 16)
  assert.equal((await get('/audit/verify')).valid, true)

  const durableMemoryAudits = (await auditRecords()).filter(entry => ['memory.explicit_updated', 'memory.explicit_deleted'].includes(entry.action))
  assert.ok(durableMemoryAudits.some(entry => JSON.parse(entry.evidence).evidence.memory_id === failureFixture.id), 'Successful recovery after rollback is itself durably audited')
  const initialToken = server.clientToken
  await server.stop()
  server = await startRustConcierge({ root: join(root, 'rust'), env: { LOOM_CLIENT_TOKEN: initialToken } })
  const reopenAdmin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: initialToken })
  const persisted = await reopenAdmin.get('/api/v1/candidates')
  assert.equal(persisted.candidates.find(row => row.id === candidateId).status, 'pending')
  assert.equal((await reopenAdmin.get('/api/v1/memories')).memories.length, 0)
  assert.equal((await reopenAdmin.get('/api/v1/audit/verify')).valid, true)
  assert.deepEqual((await reopenAdmin.get('/api/v1/audit')).audit.filter(entry => ['memory.explicit_updated', 'memory.explicit_deleted'].includes(entry.action)), durableMemoryAudits, 'Explicit Memory write audits survive a real Concierge restart unchanged')
  console.log(JSON.stringify({ overall: 'PASS', source_and_expiry_checks: true, real_derived_memory_and_link: true, ordinary_edit_and_delete_audit: true, audit_failure_rolls_back_memory_mutation: true, missing_ids_do_not_audit: true, undo_does_not_duplicate: true, never_does_not_suggest_again: true,
    route_never_becomes_memory: true, duplicate_source_is_not_an_observation: true, known_scope_only: true, reopened_schema: 15,
    candidate_edit_preserves_source_identity: true, stale_candidate_edit_rejected: true,
    repeated_candidate_sources_keep_edited_text: true, candidate_edit_is_not_memory_acceptance: true,
    no_generic_learning_or_automatic_listener: true, uses_real_registered_node_and_http: true, browser: browserProof, root }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: String(error.stack || error), fixture_root: root, controller: server?.diagnostics() }, null, 2))
  process.exitCode = 1
} finally { if (server) await server.stop().catch(() => {}) }

async function sqlScript(path, statements) {
  await promisify(execFile)('python3', ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()', path, statements])
}

async function sql(path, query) {
  const result = await promisify(execFile)('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2]).fetchone()[0]))', path, query])
  return JSON.parse(result.stdout.trim())
}
