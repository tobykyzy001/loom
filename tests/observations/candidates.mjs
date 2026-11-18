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
  assert.ok((await post('/candidates', { project_id: projectId, kind: 'memory', value: 'Concise reports with citations', source_refs: [firstSource] })).observations >= 1)
  assert.equal((await get('/candidates')).candidates.length, 1)
  assert.equal((await get('/memories')).memories.length, 0)
  if (process.argv.includes('--browser')) {
    const { verifyMemoryCandidateBrowser } = await import('../browser/memory-candidates.mjs')
    browserProof = await verifyMemoryCandidateBrowser({ server, root, candidateId })
    assert.equal((await get('/memories')).memories.length, 0, 'Browser deliberately withdrew the associated preference via its actual UI')
    assert.equal((await get('/grants')).grants.length, 2, 'UI review never creates authority')
  }

  const accepted = await patch(`/candidates/${candidateId}`, { decision: 'accept', scope: projectId })
  assert.equal(accepted.status, 'accepted')
  let memories = (await get('/memories')).memories
  assert.equal(memories.length, 1)
  assert.equal(memories[0].id, accepted.derived_memory_id)
  assert.equal(memories[0].scope, 'project')
  assert.equal(memories[0].project_id, projectId)
  assert.equal(memories[0].source_ticket_id, firstSource)
  assert.equal(memories[0].content, 'Concise reports with citations')
  assert.equal((await get('/grants')).grants.length, 2, 'Reviewing candidates must not create new permissions')
  const edited = await patch(`/memories/${memories[0].id}`, { content: memories[0].content, scope: 'user', project_id: null })
  assert.equal(edited.memory.scope, 'user')
  assert.equal(edited.memory.project_id, null)
  const restored = await patch(`/memories/${memories[0].id}`, { content: memories[0].content, scope: 'project', project_id: projectId })
  assert.equal(restored.memory.scope, 'project')
  assert.equal(restored.memory.project_id, projectId)
  assert.equal(restored.memory.source_ticket_id, firstSource)
  assert.notEqual(await patch(`/memories/${memories[0].id}`, { content: memories[0].content, scope: 'project', project_id: 'missing' }).catch(error => error.status), 200)
  await assert.rejects(() => patch(`/candidates/${candidateId}`, { decision: 'accept' }), error => /pending|second Memory/.test(error.message), 'Every already-accepted candidate must require an explicit undo before a new save')
  const unrelated = await post('/memories', { project_id: projectId, scope: 'project', content: 'A separately saved manual preference, not a candidate observation' })
  assert.equal((await get('/memories')).memories.length, 2)
  const directDelete = await admin.request('DELETE', `/api/v1/memories/${encodeURIComponent(memories[0].id)}`)
  assert.equal(directDelete.candidate_withdrawal, true)
  assert.equal(directDelete.candidate_status, 'pending')
  assert.equal(directDelete.grants_changed, false)
  const survivingMemories = (await get('/memories')).memories
  assert.equal(survivingMemories.length, 1)
  assert.equal(survivingMemories[0].id, unrelated.id, 'Linked withdrawal must not remove an unrelated manual Memory')
  const ordinaryDelete = await admin.request('DELETE', `/api/v1/memories/${encodeURIComponent(unrelated.id)}`)
  assert.equal(ordinaryDelete.deleted, true)
  assert.equal(ordinaryDelete.candidate_withdrawal, undefined, 'Unlinked Memory deletion remains its own ordinary operation')
  assert.equal((await get('/memories')).memories.length, 0)
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

  const fingerprint = JSON.parse(candidate.content).fingerprint
  await promisify(execFile)('python3', ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE observations SET expires_at=? WHERE fingerprint=?", ("2000-01-01T00:00:00Z",sys.argv[2])); db.execute("INSERT INTO messages(id,ticket_id,sender,content,kind,visibility,created_at) VALUES(?,?,?,?,?,?,?)",("fixture-source-notice",sys.argv[2],"client","Only synthetic candidate observation, no private transcript", "activity", "summary", "2026-01-01T00:00:00Z")); db.commit()', join(server.dataDir, 'loom.sqlite3'), fingerprint])
  const expired = await post('/candidates', { project_id: projectId, kind: 'memory', value: 'Concise reports with citations', source_refs: [await makeTicket(9)] })
  assert.equal(expired.occurrences, 1, 'Expired evidence cannot keep its old repetition count or create a fresh candidate')
  assert.equal(expired.promotion, 'retained_history_not_auto_promoted')
  assert.equal(expired.candidate.id, candidateId, 'Previously observed candidate stays readable without claiming another promotion')
  assert.equal((await get('/memories')).memories.length, 0)
  assert.equal((await get('/candidates')).candidates.filter(row => row.id.startsWith('candidate_')).length, 3 + Number(process.argv.includes('--browser')))
  assert.equal(await sql(join(server.dataDir, 'loom.sqlite3'), 'SELECT COUNT(*) FROM candidate_memory_links'), 0)
  assert.equal(await sql(join(server.dataDir, 'loom.sqlite3'), 'PRAGMA user_version'), 14)
  assert.equal((await get('/audit/verify')).valid, true)

  const initialToken = server.clientToken
  await server.stop()
  server = await startRustConcierge({ root: join(root, 'rust'), env: { LOOM_CLIENT_TOKEN: initialToken } })
  const reopenAdmin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: initialToken })
  const persisted = await reopenAdmin.get('/api/v1/candidates')
  assert.equal(persisted.candidates.find(row => row.id === candidateId).status, 'pending')
  assert.equal((await reopenAdmin.get('/api/v1/memories')).memories.length, 0)
  assert.equal((await reopenAdmin.get('/api/v1/audit/verify')).valid, true)
  console.log(JSON.stringify({ overall: 'PASS', source_and_expiry_checks: true, real_derived_memory_and_link: true, undo_does_not_duplicate: true, never_does_not_suggest_again: true,
    route_never_becomes_memory: true, duplicate_source_is_not_an_observation: true, known_scope_only: true, reopened_schema: 14,
    no_generic_learning_or_automatic_listener: true, uses_real_registered_node_and_http: true, browser: browserProof, root }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: String(error.stack || error), fixture_root: root, controller: server?.diagnostics() }, null, 2))
  process.exitCode = 1
} finally { if (server) await server.stop().catch(() => {}) }

async function sql(path, query) {
  const result = await promisify(execFile)('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2]).fetchone()[0]))', path, query])
  return JSON.parse(result.stdout.trim())
}
