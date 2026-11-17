import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareProject, startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'

const root = await testingRoot()
const server = await startRustConcierge({ root })
const source = JSON.stringify({ schema: 'loom.model-descriptor.v1', provider: 'fixture-local-text',
  revision: 'v1', input_modalities: ['text'], local_only: true }) + '\n'
let runner, currentProject
try {
  const clientToken = server.clientToken
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken })
  const createdProject = await admin.post('/api/v1/projects', { name: 'Descriptor-only local artifact source', root: await prepareProject(root), mode: 'read_write' })
  const actualProjectRoot = join(root, 'project')
  currentProject = createdProject.project
  const projectId = currentProject.id
  const enrollment = (await admin.post('/api/v1/enrollment-codes', {})).code
  runner = await LocalNodeRunner.create({ baseUrl: server.baseUrl, stateDir: join(root, 'worker-state'), artifactDir: join(root, 'worker-artifacts'), enrollmentCode: enrollment, projectRoots: { [projectId]: actualProjectRoot }, registration: { workerId: 'default' } })
  await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: runner.nodeId, installation_id: runner.installationId, worker_id: 'default', root_scope: actualProjectRoot })
  const grant = (await admin.post('/api/v1/grants', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', operations: ['read'] })).grant
  await writeFile(join(actualProjectRoot, 'model.json'), source, { mode: 0o600 })
  const create = (body, grantId) => admin.post('/api/v1/tickets', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default',
    objective: 'Read only an explicitly allowed local descriptor; no model inference', kind: 'model_descriptor', relative_path: 'model.json', grant_id: grantId, ...body })
  for (const bad of [{ relative_path: '../../.ssh/credentials' }, { relative_path: 'other.json' }, { content: source }]) {
    await assert.rejects(create(bad, grant.id), 'unsupported path/write input must be denied before worker')
  }
  const nonReadGrant = (await admin.post('/api/v1/grants', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', operations: ['invoke_text'] })).grant
  await assert.rejects(create({}, nonReadGrant.id), (error) => error.status === 403 && error.code === 'operation_scope')
  const locationGrant = (await admin.post('/api/v1/grants', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', operations: ['place_model'] })).grant
  await assert.rejects(create({}, locationGrant.id), (error) => error.status === 403 && error.code === 'operation_scope')
  const ticket = await create({}, grant.id)
  assert.equal(ticket.kind, 'model_descriptor')
  let executed
  // pollAndRun continues through actual validation/fencing/atomic file proof; no SDK/agent/model call occurs.
  executed = await runner.pollAndRun()
  await runner.client.dispatchOutbox()
  assert.equal(executed.status, 'succeeded')
  const detail = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.equal(detail.status, 'succeeded')
  assert.equal(detail.artifacts.length, 1)
  assert.equal(detail.kind, 'model_descriptor')
  const artifact = detail.artifacts[0]
  const retrieved = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifact.id}`)
  const content = Buffer.from(retrieved.content)
  const digest = createHash('sha256').update(source).digest('hex')
  assert.deepEqual(JSON.parse(content), { ...JSON.parse(source), source_kind: 'explicit_local_artifact_descriptor', relative_path: 'model.json', source_sha256: digest, source_document: source })
  assert.equal(artifact.sha256, createHash('sha256').update(content).digest('hex'))
  assert.notEqual(artifact.sha256, digest)
  assert.equal(await readFile(join(actualProjectRoot, 'model.json'), 'utf8'), source)
  assert.equal(retrieved.artifact.sha256, artifact.sha256)
  assert.equal(runner.capabilities.some((capability) => capability.ticket_kind === 'model_descriptor' && capability.permission === 'read'), true)
  assert.equal(runner.capabilities.some((capability) => capability.ticket_kind === 'place_model' || capability.permission === 'invoke_text'), false)
  const proof = { overall: 'PASS', source_ticket_id: ticket.id, source_artifact_id: artifact.id,
    model_generation: 'NOT RUN', rust_bare_executor_support: 'NOT RUN', actual_typescript_node_execution: true,
    source_sha256: digest, artifact_sha256: artifact.sha256, source_bytes_unchanged: true,
    permission_scope: 'read only model.json / authorized node + project + worker', root }
  await writeFile(join(root, 'produce-descriptor-result.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  if (server.stop) await server.stop().catch(() => {})
  throw error
} finally {
  await server.stop().catch(() => {})
}
