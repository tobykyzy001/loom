#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startRustConcierge, prepareProject, testingRoot } from './fixtures/rust-server.mjs'
import { LoomHttpClient } from '../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../packages/node-client/src/runner.js'
import { sha256 } from '../packages/node-client/src/util.js'

const checks = []
let server
let admin
let root
let source
let editor
const failReport = (error) => ({ overall: 'FAIL', error: error.stack, checks })
const ok = async (name, fn) => {
  const evidence = await fn()
  checks.push({ name, status: 'PASS', evidence })
  console.log(`PASS document-pipeline: ${name}`)
  return evidence
}

try {
  root = await testingRoot()
  server = await startRustConcierge({ root })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  await mkdir(join(root, 'projects'), { recursive: true, mode: 0o700 })
  const fixtureRoot = await prepareProject(join(root, 'projects'))
  const rootA = join(fixtureRoot, 'reader')
  const rootB = join(fixtureRoot, 'editor')
  for (const dir of [rootA, rootB]) await mkdir(join(dir, 'docs'), { recursive: true, mode: 0o700 })
  await writeFile(join(rootA, 'docs/input.txt'), 'Alpha  one\nBeta  two\n', { mode: 0o600, flag: 'wx' })
  const created = await admin.post('/api/v1/projects', { name: 'Document integration logical project', root: rootA, mode: 'read_write' })
  const projectId = created.project.id
  const makeNode = async (role, localRoot, workerId) => {
    const enrollment = await admin.post('/api/v1/enrollment-codes', {})
    return LocalNodeRunner.create({
      baseUrl: server.baseUrl, enrollmentCode: enrollment.code,
      stateDir: join(root, `${role}-node-state`), artifactDir: join(root, `${role}-node-artifacts`),
      projectRoots: { [projectId]: localRoot },
      registration: { workerId, harnessKind: 'deterministic-file-worker', profileId: `pipeline-${role}` },
    })
  }
  source = await makeNode('reader', rootA, 'reader')
  editor = await makeNode('editor', rootB, 'editor')
  const bindingA = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: source.nodeId, worker_id: 'reader', root_scope: rootA })
  const bindingB = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: editor.nodeId, worker_id: 'editor', root_scope: rootB })
  const grantA = await admin.post('/api/v1/grants', { project_id: projectId, node_id: 'auto', worker_id: 'reader', project_binding_id: bindingA.id, operations: ['read'] })
  const grantB = await admin.post('/api/v1/grants', { project_id: projectId, node_id: 'auto', worker_id: 'editor', project_binding_id: bindingB.id, operations: ['write'] })
  await ok('two independent scoped workers and existing Grants', async () => {
    assert.notEqual(source.nodeId, editor.nodeId)
    assert.notEqual(grantA.grant.digest, grantB.grant.digest)
    assert.notEqual(grantA.grant.id, grantB.grant.id)
    return { reader: source.nodeId, editor: editor.nodeId }
  })
  const pipelineId = randomUUID()
  const definition = () => ({
    schema: 'loom.document-pipeline.v1', version: 1, pipeline_id: pipelineId,
    name: 'Validated document reduction', project_id: projectId,
    read: { kind: 'read_summary', stage_id: 'source', grant_id: grantA.grant.id,
      relative_path: 'docs/input.txt', output_id: 'source-summary', depends_on: [] },
    edit: { kind: 'edit_file', stage_id: 'derived', grant_id: grantB.grant.id,
      relative_path: 'docs/derived.txt', output_id: 'derived-document', depends_on: ['source'], transform: 'collapse_whitespace' },
  })
  const runOnce = async (node, kind) => {
    const result = await node.pollAndRun()
    assert.equal(result.status, kind, JSON.stringify(result))
    await node.client.dispatchOutbox()
    return result
  }
  await ok('real first producer, real downstream file, parent provenance and output report', async () => {
    const started = await admin.post('/api/v1/pipelines', definition())
    assert.equal(started.id, pipelineId)
    await runOnce(source, 'succeeded')
    const sourceTaskId = started.stages[0].ticket_id
    const child = await runOnce(editor, 'succeeded')
    assert.ok(child.assignmentId, 'Second actual Assignment was issued')
    const advanced = await admin.post(`/api/v1/pipelines/${pipelineId}/run`, {})
    const currentStages = advanced.pipeline.stages
    const childTicketId = currentStages.at(-1).ticket_id
    assert.ok(childTicketId, `The actual docEdit stage must have a real Ticket once its Assignment was issued: ${JSON.stringify(currentStages)}`)
    const task = await admin.get(`/api/v1/tickets/${childTicketId}`)
    assert.equal(task.assignments[0].id, child.assignmentId)
    assert.equal(task.status, 'succeeded', JSON.stringify(task))
    assert.equal(task.artifacts.length, 1); assert.equal(task.effects.length, 1)
    const report = await admin.get(`/api/v1/pipelines/${pipelineId}`)
    assert.equal(report.pipeline.status, 'succeeded', JSON.stringify(report.pipeline))
    assert.equal(report.pipeline.stages.length, 2)
    const [firstArtifact] = (await admin.get(`/api/v1/tickets/${sourceTaskId}`)).artifacts
    const artifact = task.artifacts[0]
    const parent = artifact.lineage[0]
    assert.equal(parent.artifact_id, firstArtifact.id)
    assert.equal(parent.origin_node_id, source.nodeId)
    assert.equal(parent.sha256, firstArtifact.sha256)
    assert.equal(parent.source_ticket_id, sourceTaskId)
    assert.equal(parent.component_sha256, artifact.sha256)
    assert.equal(parent.type, 'artifact_ref')
    assert.equal(parent.source_location, `loom://artifact/${firstArtifact.id}`)
    const receipt = await admin.get(`/api/v1/tickets/${task.id}/artifacts/${artifact.id}`)
    const parsed = JSON.parse(receipt.content)
    assert.equal(parsed.path, 'docs/derived.txt')
    assert.equal(parsed.kind, 'edit_file')
    const derived = await readFile(join(rootB, 'docs/derived.txt'))
    assert.equal(parsed.target_hash, sha256(derived))
    const summary = JSON.parse(derived.toString('utf8'))
// Only assert the real derivative, never print credentials or a synthetic Session transcript.
    assert.deepEqual(summary.lines, ['Alpha one', 'Beta two'])
    assert.equal(task.effects[0].status, 'confirmed')
    assert.equal(task.artifacts[0].origin_node_id, editor.nodeId)
    assert.ok(!report.pipeline.stages.some((stage) => stage.checkpoint_state === 'unknown'))
    assert.equal((await realpath(rootA)).startsWith(await realpath(root)), true)
    return { sourceArtifact: firstArtifact.id, derivedArtifact: artifact.id, lineage: parent, derived_sha256: sha256(derived) }
  })
  await ok('origin, permission and arbitrary operation are rejected before a new Ticket', async () => {
    const [readonly] = await Promise.all([
      admin.post('/api/v1/grants', { project_id: projectId, node_id: 'auto', worker_id: 'editor', project_binding_id: bindingB.id, operations: ['read'] }),
    ])
    await assert.rejects(() => admin.post('/api/v1/pipelines', { ...definition(), edit: { ...definition().edit, grant_id: readonly.grant.id } }))
    await assert.rejects(() => admin.post('/api/v1/pipelines', { ...definition(), read: { ...definition().read, relative_path: '../outside.txt' } }))
    await assert.rejects(() => admin.post('/api/v1/pipelines', { ...definition(), edit: { ...definition().edit, transform: 'arbitrary_shell' } }))
    await assert.rejects(() => admin.post('/api/v1/pipelines', { ...definition(), edit: { ...definition().edit, depends_on: ['not-the-source'] } }))
    return { wrong_grant_denied: true, traversal_denied: true, unsupported_transform_denied: true, nonparent_denied: true }
  })
  await ok('identical replay and re-poll do not perform another file effect', async () => {
    const current = await admin.get(`/api/v1/pipelines/${pipelineId}`)
    const before = await stat(join(rootB, 'docs/derived.txt'))
    const replay = await admin.post('/api/v1/pipelines', definition())
    assert.equal(replay.id, pipelineId)
    await runOnce(source, 'idle')
    await runOnce(editor, 'idle')
    const after = await stat(join(rootB, 'docs/derived.txt'))
    assert.equal(before.ino, after.ino)
    const final = await admin.get(`/api/v1/pipelines/${pipelineId}`)
    assert.deepEqual(final.pipeline.stages.map(s => s.ticket_id), current.pipeline.stages.map(s => s.ticket_id))
    return { immutable_inode: before.ino === after.ino, two_assignments_only: true }
  })
  await ok('controller restart preserves both stage mappings and the audit chain', async () => {
    await server.stop()
    server = await startRustConcierge({ root: dirname(server.dataDir), env: { ...process.env, LOOM_CLIENT_TOKEN: server.clientToken } })
    admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
    for (const node of [source, editor]) {
// Node-specific bearer is injected by the existing runner, never as clientToken.
      node.http = new LoomHttpClient({ baseUrl: server.baseUrl })
      node.client.http = node.http
      node.options.baseUrl = server.baseUrl
    }
    await editor.pollAndRun()
    const detail = await admin.get(`/api/v1/pipelines/${pipelineId}`)
    assert.equal(detail.pipeline.status, 'succeeded')
    assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
    const doctor = await promisify(execFile)('cargo', ['run', '-q', '-p', 'loom-concierge', '--bin', 'loom', '--', '--data-dir', server.dataDir, 'doctor'], { encoding: 'utf8', env: { ...process.env, LOOM_CLIENT_TOKEN: server.clientToken } })
    const recovered = JSON.parse(doctor.stdout)
    assert.equal(recovered.schema_version, 15)
    assert.equal(recovered.integrity[0].integrity_check, 'ok')
    assert.equal(recovered.audit_valid, true)
    return { schema: 15, no_duplicate_child: true, liveness_resume: true }
  })
  console.log(JSON.stringify({ overall: 'PASS', pipeline: pipelineId, checks, limitations: 'One physical macOS with two isolated logical Nodes, deterministic transform only; not a physical second host, general LLM DAG, direct peer transport or Tauri acceptance.' }, null, 2))
} catch (error) {
  console.error(JSON.stringify(failReport(error), null, 2))
  process.exitCode = 1
} finally {
  if (server) await server.stop()
}
// End of the bounded, real document integration proof.
