import assert from 'node:assert/strict'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { envelope } from '../../packages/node-client/src/validation.js'
import { sha256 } from '../../packages/node-client/src/util.js'
import { testingRoot, startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'

let server
const clone = value => JSON.parse(JSON.stringify(value))
try {
  const root = await testingRoot()
  const docs = join(root, 'source')
  await mkdir(join(docs, 'docs'), { recursive: true })
  await writeFile(join(docs, 'docs/first.txt'), 'first producer\n')
  await writeFile(join(docs, 'docs/second.txt'), 'second sibling producer\n')
  server = await startRustConcierge({ root })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const project = (await admin.post('/api/v1/projects', { name: 'Parent lineage boundary', root: docs, mode: 'read_write' })).project
  const newNode = async (role, workerId, projectRoot) => LocalNodeRunner.create({
    baseUrl: server.baseUrl,
    stateDir: join(root, `${role}-state`), artifactDir: join(root, `${role}-artifacts`), projectRoots: { [project.id]: projectRoot },
    enrollmentCode: (await admin.post('/api/v1/enrollment-codes', {})).code,
    registration: { workerId, harnessKind: 'bounded-handoff-fixture', profileId: `bounded-${role}` },
  })
  const A = await newNode('a', 'worker-a', docs)
  const B = await newNode('b', 'worker-b', docs)
  const bindA = (await admin.post('/api/v1/project-bindings', { project_id: project.id, node_id: A.nodeId, worker_id: 'worker-a', root_scope: docs })).id
  const bindB = (await admin.post('/api/v1/project-bindings', { project_id: project.id, node_id: B.nodeId, worker_id: 'worker-b', root_scope: docs })).id
  const read = (await admin.post('/api/v1/grants', { project_id: project.id, node_id: A.nodeId, worker_id: 'worker-a', project_binding_id: bindA, operations: ['read'] })).grant
  const write = (await admin.post('/api/v1/grants', { project_id: project.id, node_id: B.nodeId, worker_id: 'worker-b', project_binding_id: bindB, operations: ['write'] })).grant
  const definition = (id, suffix) => ({ schema: 'loom.document-pipeline.v1', version: 1, pipeline_id: id, project_id: project.id,
    read: { stage_id: 'source', kind: 'read_summary', grant_id: read.id, relative_path: `docs/${suffix}.txt`, output_id: `source-${suffix}`, depends_on: [], worker_id: 'worker-a' },
    edit: { stage_id: 'child', kind: 'edit_file', grant_id: write.id, relative_path: `docs/out-${suffix}.txt`, output_id: `output-${suffix}`, depends_on: ['source'], worker_id: 'worker-b', transform: 'trim', direct: true } })
  const parents = [], children = []
  for (const suffix of ['first', 'second']) {
    const id = randomUUID()
    await admin.post('/api/v1/pipelines', definition(id, suffix))
    assert.equal((await A.pollAndRun()).status, 'succeeded')
    await A.client.dispatchOutbox()
    await B.client.poll({ waitSeconds: 0 })
    const pipeline = (await admin.get(`/api/v1/pipelines/${id}`)).pipeline
       const parent = await admin.get(`/api/v1/tickets/${pipeline.stages[0].ticket_id}`)
    assert.equal(parent.status, 'succeeded')
    const child = await B.client.poll({ waitSeconds: 0 })
    assert.equal(child.ticket_id, pipeline.stages[1].ticket_id)
    assert.equal(child.artifact_input.direct_offer, true)
    parents.push({ ticket: parent, artifact: parent.artifacts[0] })
    children.push(child)
  }
  assert.notEqual(children[0].ticket_id, children[1].ticket_id)
  assert.notEqual(children[0].artifact_input.artifact_ref.artifact_id, children[1].artifact_input.artifact_ref.artifact_id)
  assert.deepEqual(children[0].grant, children[1].grant)

  const firstBefore = clone(await admin.get(`/api/v1/tickets/${parents[0].ticket.id}`))
  const siblingBefore = clone(await admin.get(`/api/v1/tickets/${parents[1].ticket.id}`))
  const grantsBefore = clone(await admin.get('/api/v1/grants'))
  const acknowledged = await B.http.post('/api/v1/nodes/acknowledge', {
    ...envelope(B, randomUUID()), ticket_id: children[0].ticket_id, assignment_id: children[0].id,
    lease_epoch: children[0].lease_epoch, accepted: true,
  }, { token: B.identity.token })
  assert.equal(acknowledged.accepted, true)
  const beforeRejected = clone(await admin.get(`/api/v1/tickets/${children[0].ticket_id}`))
  const siblingRef = structuredClone(children[1].artifact_input.artifact_ref)
  const badArtifactId = randomUUID()
  const forwarded = Buffer.from(JSON.stringify({ path: children[0].relative_path, kind: 'edit_file', operation: 'replaced_project_file', target_hash: sha256(Buffer.from('unrelated destination content')) }))
  let wrong
  try {
    await B.http.post('/api/v1/nodes/artifacts', {
      ...envelope(B, randomUUID()), ticket_id: children[0].ticket_id, assignment_id: children[0].id,
      lease_epoch: children[0].lease_epoch, artifact_id: badArtifactId,
      metadata: { artifact_id: badArtifactId, name: 'edit_file-proof.json', media_type: 'application/json', artifact_ref: siblingRef, parents: [{ artifact_id: parents[1].artifact.id }] },
      bytes_base64: forwarded.toString('base64'),
    }, { token: B.identity.token })
    wrong = { status: 'Unexpectedly accepted' }
  } catch (error) { wrong = { status: error.status, code: error.code, message: error.message } }
  assert.deepEqual(wrong, { status: 403, code: 'artifact_lineage', message: 'Loom HTTP 403 artifact_lineage: A derived Assignment requires its exact server-selected parent artifact, not a familiar sibling' })
  assert.deepEqual(clone(await admin.get(`/api/v1/tickets/${children[0].ticket_id}`)), beforeRejected, 'A rejected derived write must not become a completion or mutate its original Assignment')
  assert.deepEqual(clone(await admin.get(`/api/v1/tickets/${parents[1].ticket.id}`)), siblingBefore, 'The legitimate sibling Artifact remains unchanged')
  assert.deepEqual(clone(await admin.get('/api/v1/grants')), grantsBefore)
  const childAfter = await admin.get(`/api/v1/tickets/${children[0].ticket_id}`)
  assert.deepEqual(childAfter.artifacts, [], 'There is no output from the substituted root')
  assert.equal(childAfter.reports.length, 0)
  assert.equal(childAfter.effects.length, 0)
  assert.equal(childAfter.status, 'running')

  // Use only the exact immutable descriptor returned for the correct child.
  const proper = children[1]
  const properAck = await B.http.post('/api/v1/nodes/acknowledge', {
    ...envelope(B, randomUUID()), ticket_id: proper.ticket_id, assignment_id: proper.id,
    lease_epoch: proper.lease_epoch, accepted: true,
  }, { token: B.identity.token })
  assert.equal(properAck.accepted, true)
  const artifactId = randomUUID()
  const actualParentRef = structuredClone(proper.artifact_input.artifact_ref)
  const uploaded = await B.http.post('/api/v1/nodes/artifacts', {
    ...envelope(B, randomUUID()), ticket_id: proper.ticket_id, assignment_id: proper.id, lease_epoch: proper.lease_epoch,
    artifact_id: artifactId, metadata: { artifact_id: artifactId, name: 'proper-proof.json', media_type: 'application/json', artifact_ref: actualParentRef, parents: [actualParentRef.artifact_id] },
    bytes_base64: forwarded.toString('base64'),
  }, { token: B.identity.token })
  assert.equal(uploaded.artifact_id, artifactId)
  const report = await B.http.post('/api/v1/nodes/reports', {
    ...envelope(B, randomUUID()), ticket_id: proper.ticket_id, assignment_id: proper.id, lease_epoch: proper.lease_epoch,
    state: 'succeeded', summary: 'The exact server-selected parent remains authoritative', artifact_ids: [artifactId],
    effects: [{ effect_id: randomUUID(), status: 'confirmed', input_digest: 'correct-parent-controlled-context', evidence: { no_records_rebound: true }, artifacts: [artifactId] }], evidence: [],
  }, { token: B.identity.token })
  assert.equal(report.accepted, true)
  const completed = await admin.get(`/api/v1/tickets/${proper.ticket_id}`)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.reports.length, 1)
  assert.equal(completed.effects.length, 1)
  const parentSourceDigest = completed.artifacts.find(a => a.id === artifactId)
  assert.equal(parentSourceDigest.lineage[0].artifact_id, parents[1].artifact.id)
  assert.deepEqual(clone(await admin.get(`/api/v1/tickets/${parents[0].ticket.id}`)), firstBefore, 'The good substitution-refusal did not later edit the first parent record')
  assert.deepEqual(clone(await admin.get('/api/v1/grants')), grantsBefore)

  const missingDestination = await readFile(join(docs, 'docs/out-first.txt')).catch(error => error)
  assert.equal(missingDestination.code, 'ENOENT', 'This API lineage probe did not perform a destination write')
  await server.stop()
  const previousAdminToken = server.clientToken
  server = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: previousAdminToken } })
  const resumed = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  try {
    await resumed.post('/api/v1/nodes/artifacts', {
      ...envelope(B, randomUUID()), ticket_id: children[0].ticket_id, assignment_id: children[0].id, lease_epoch: children[0].lease_epoch,
      artifact_id: badArtifactId, metadata: { artifact_id: badArtifactId, name: 'edit_file-proof.json', media_type: 'application/json', artifact_ref: siblingRef, parents: [{ artifact_id: parents[1].artifact.id }] },
      bytes_base64: forwarded.toString('base64'),
    }, { token: B.identity.token })
    assert.fail('Reopened center must still reject the sibling substitution')
  } catch (error) {
    assert.equal(error.status, 403)
    assert.equal(error.code, 'artifact_lineage')
  }
  assert.deepEqual(clone(await resumed.get(`/api/v1/tickets/${children[0].ticket_id}`)), childAfter)
  assert.deepEqual(clone(await resumed.get(`/api/v1/tickets/${proper.ticket_id}`)), completed)
  assert.deepEqual(clone(await resumed.get('/api/v1/grants')), grantsBefore)
  console.log(JSON.stringify({
    overall: 'PASS', reopen_persists_same_denial_and_original_correct_output: true, scope: 'same-node distinct logical Workers with real pipeline producer/receiver metadata',
    forbidden_substitution: wrong, forbidden_artifact_id: badArtifactId,
    accepted_exact_parent_id: artifactId, accepted_report_id: report.report_id,
    original_assignment_and_ACK_preserved: true,
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: error.message, detail: { status: error.status, code: error.code } }, null, 2))
  process.exitCode = 1
} finally { if (server) await server.stop() }
