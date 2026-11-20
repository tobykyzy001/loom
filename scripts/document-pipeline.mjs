#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
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
let cancelReproduction
const failReport = (error) => ({ schema: 'loom.document-pipeline-cancel-reducer.v1', overall: 'FAIL',
  error: error.message, cancel_reproduction: cancelReproduction, checks })
const ok = async (name, fn) => {
  const evidence = await fn()
  checks.push({ name, status: 'PASS', evidence })
  console.log(`PASS document-pipeline: ${name}`)
  return evidence
}
// Read-only inspection is evidence only; the scenario never mutates SQLite directly.
const readEvidence = (sql, params = []) => {
  const db = new DatabaseSync(join(server.dataDir, 'loom.sqlite3'), { readOnly: true })
  try {
    return db.prepare(sql).all(...params).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])))
  } finally { db.close() }
}
const auditCount = (action, ticketId) => readEvidence(
  "SELECT count(*) AS count FROM audits WHERE action=?1 AND ticket_id=?2", [action, ticketId])[0].count

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
    assert.equal(recovered.schema_version, 16)
    assert.equal(recovered.integrity[0].integrity_check, 'ok')
    assert.equal(recovered.audit_valid, true)
    return { schema: 16, no_duplicate_child: true, liveness_resume: true }
  })
  const cancelPipelineId = randomUUID()
  const cancelTarget = 'docs/stop-before-writer.txt'
  let cancelEvidence
  await ok('received edit stops before ordinary admission with a preserved successful parent', async () => {
    await writeFile(join(rootA, 'docs/cancel-input.txt'), 'Stop  after this parent succeeds.\n', { mode: 0o600, flag: 'wx' })
    const cancelDefinition = () => ({
      schema: 'loom.document-pipeline.v1', version: 1, pipeline_id: cancelPipelineId,
      name: 'Received edit stopped before writer', project_id: projectId,
      read: { kind: 'read_summary', stage_id: 'checkpoint_source', grant_id: grantA.grant.id,
        relative_path: 'docs/cancel-input.txt', output_id: 'stop-source-summary', depends_on: [] },
      edit: { kind: 'edit_file', stage_id: 'intent_sink', grant_id: grantB.grant.id,
        relative_path: cancelTarget, output_id: 'stop-derived-document', depends_on: ['checkpoint_source'], transform: 'collapse_whitespace' },
    })
    await admin.post('/api/v1/pipelines', cancelDefinition())
    const cancelSourceId = (await admin.get(`/api/v1/pipelines/${cancelPipelineId}`)).pipeline.stages[0].ticket_id
    await runOnce(source, 'succeeded')
    const beforeNodeReceived = await admin.get(`/api/v1/tickets/${cancelSourceId}`)
    const parentArtifact = beforeNodeReceived.artifacts[0]
    const sourceFileBefore = sha256(await readFile(join(rootA, 'docs/cancel-input.txt')))
    const parentArtifactBefore = parentArtifact.sha256
    // poll yields the real Assignment but executes neither the file writer nor its admission ACK.
    const received = await editor.client.poll({ lastAssignmentId: editor.lastAssignmentId, waitSeconds: 0 })
    assert.equal(received.kind, 'edit_file', JSON.stringify(received))
    assert.equal(received.cancel_requested, false)
    assert.equal(received.grant_digest, grantB.grant.digest)
    assert.equal(received.lease_epoch, 1)
    assert.equal(received.relative_path, cancelTarget)
    assert.equal(received.artifact_input.artifact_ref.sha256, parentArtifactBefore)
    assert.equal(sha256(Buffer.from(received.artifact_input.bytes_base64, 'base64')), parentArtifactBefore)
    assert.equal(editor.state.data.assignments[received.id], undefined)
    const unacknowledged = readEvidence("SELECT acknowledged_at,cancelled_at,lease_epoch FROM assignments WHERE id=?1", [received.id])[0]
    assert.equal(unacknowledged.acknowledged_at, null)
    assert.equal(unacknowledged.cancelled_at, null)
    assert.equal(unacknowledged.lease_epoch, received.lease_epoch)
    await assert.rejects(stat(join(rootB, cancelTarget)), error => error.code === 'ENOENT')
    const receivedChild = await admin.get(`/api/v1/tickets/${received.ticket_id}`)
    assert.equal(receivedChild.assignments.length, 1)
    assert.equal(receivedChild.assignments[0].id, received.id)
    assert.equal(receivedChild.assignments[0].acknowledged_at, null)
    assert.equal(receivedChild.reports.length, 0)
    assert.equal(auditCount('assignment.acknowledged', received.ticket_id), 0)

    const initialCancel = await admin.post(`/api/v1/pipelines/${cancelPipelineId}/cancel`, {})
    assert.equal(initialCancel.cancel_requested, true)
    assert.equal(initialCancel.pipeline.status, 'cancel_requested', JSON.stringify(initialCancel.pipeline))
    const [sourceStage, childStage] = initialCancel.pipeline.stages
    assert.equal(sourceStage.checkpoint_state, 'succeeded')
    assert.equal(childStage.checkpoint_state, 'cancel_requested')
    assert.equal(auditCount('pipeline.cancel_requested', received.ticket_id), 1)
    await assert.rejects(stat(join(rootB, cancelTarget)), error => error.code === 'ENOENT')

    const acknowledged = await editor.pollAndRun()
    assert.equal(acknowledged.status, 'cancel_acknowledged', JSON.stringify(acknowledged))
    assert.equal(acknowledged.assignmentId, received.id)
    await editor.client.dispatchOutbox()
    const localCompletion = editor.state.data.completions[received.id]
    assert.equal(localCompletion.execution_started, false)
    assert.equal(localCompletion.cancel_acknowledged, true)
    const afterAck = await admin.get(`/api/v1/pipelines/${cancelPipelineId}`)
    const child = await admin.get(`/api/v1/tickets/${received.ticket_id}`)
    const parent = await admin.get(`/api/v1/tickets/${cancelSourceId}`)
    assert.equal(child.status, 'cancelled')
    assert.equal(child.assignments.length, 1)
    assert.equal(child.assignments[0].id, received.id)
    assert.equal(child.assignments[0].lease_epoch, received.lease_epoch)
    assert.equal(child.assignments[0].acknowledged_at, null, 'The stop Report is not a forged ordinary execution admission')
    assert.ok(child.reports.length === 1 && child.reports[0].state === 'cancelled')
    assert.ok([true, 1].includes(child.reports[0].cancel_acknowledged))
    assert.equal(child.reports[0].assignment_id, received.id)
    assert.equal(child.reports[0].lease_epoch, received.lease_epoch)
    assert.deepEqual(child.artifacts, [])
    assert.deepEqual(child.effects, [])
    assert.equal(parent.status, 'succeeded')
    assert.equal(parent.cancel_requested, false)
    assert.equal(parent.artifacts.length, 1)
    assert.equal(parent.artifacts[0].id, parentArtifact.id)
    assert.equal(parent.artifacts[0].sha256, parentArtifactBefore)
    assert.equal(parent.grant_digest, grantA.grant.digest)
    assert.equal(child.grant_digest, grantB.grant.digest)
    assert.equal(auditCount('assignment.acknowledged', received.ticket_id), 0)
    await assert.rejects(stat(join(rootB, cancelTarget)), error => error.code === 'ENOENT')

    await assert.rejects(() => editor.client.acknowledge({ ticketId: received.ticket_id, assignmentId: received.id,
      leaseEpoch: received.lease_epoch, accepted: true }), error => error.status === 409 && error.code === 'outcome_unknown')
    const lateAdmission = readEvidence("SELECT acknowledged_at FROM assignments WHERE id=?1", [received.id])[0]
    assert.equal(lateAdmission.acknowledged_at, null)
    assert.equal(auditCount('assignment.acknowledged', received.ticket_id), 0)
    await admin.post(`/api/v1/pipelines/${cancelPipelineId}/cancel`, {})
    const repeated = await admin.post('/api/v1/pipelines', cancelDefinition())
    const replayedRun = await admin.post(`/api/v1/pipelines/${cancelPipelineId}/run`, {})
    assert.equal(repeated.id, cancelPipelineId)
    assert.deepEqual(replayedRun.pipeline.stages.map(stage => stage.ticket_id), afterAck.pipeline.stages.map(stage => stage.ticket_id))
    assert.equal(await editor.client.poll({ lastAssignmentId: editor.lastAssignmentId, waitSeconds: 0 }), null)
    await runOnce(source, 'idle')
    const sourceFileAfter = sha256(await readFile(join(rootA, 'docs/cancel-input.txt')))
    assert.equal(sourceFileAfter, sourceFileBefore)
    const [grantRows, artifacts, effects] = await Promise.all([
      Promise.resolve(readEvidence("SELECT id,digest,version,revoked_at FROM grants WHERE id IN (?1,?2) ORDER BY id", [grantA.grant.id, grantB.grant.id])),
      Promise.resolve(readEvidence("SELECT artifacts.id,artifacts.ticket_id,artifacts.assignment_id,artifacts.sha256 FROM artifacts JOIN document_pipeline_stages ON document_pipeline_stages.ticket_id=artifacts.ticket_id WHERE document_pipeline_stages.pipeline_id=?1", [cancelPipelineId])),
      Promise.resolve(readEvidence("SELECT effects.id,effects.ticket_id,effects.assignment_id FROM effects JOIN document_pipeline_stages ON document_pipeline_stages.ticket_id=effects.ticket_id WHERE document_pipeline_stages.pipeline_id=?1", [cancelPipelineId])),
    ])
    assert.deepEqual(grantRows, [
      { id: grantA.grant.id, digest: grantA.grant.digest, version: 1, revoked_at: null },
      { id: grantB.grant.id, digest: grantB.grant.digest, version: 1, revoked_at: null },
    ].sort((a, b) => a.id.localeCompare(b.id)))
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].id, parentArtifact.id)
    assert.equal(artifacts[0].ticket_id, cancelSourceId)
    assert.equal(artifacts[0].sha256, parentArtifactBefore)
    assert.equal(effects.length, 1, 'The kept successful source has one read Effect; the stopped child has none')
    assert.equal(effects[0].ticket_id, cancelSourceId)
    assert.equal(effects[0].assignment_id, parent.assignments[0].id)
    const countsBeforeRestart = {
      tickets: readEvidence("SELECT count(*) AS count FROM document_pipeline_stages WHERE pipeline_id=?1 AND ticket_id IS NOT NULL", [cancelPipelineId])[0].count,
      assignments: readEvidence("SELECT count(*) AS count FROM assignments WHERE ticket_id IN (?1,?2)", [cancelSourceId, received.ticket_id])[0].count,
      reports: readEvidence("SELECT count(*) AS count FROM reports WHERE ticket_id IN (?1,?2)", [cancelSourceId, received.ticket_id])[0].count,
      pipeline_cancel_audits: auditCount('pipeline.cancel_requested', received.ticket_id),
      child_ordinary_acknowledgements: auditCount('assignment.acknowledged', received.ticket_id),
    }
    assert.deepEqual(countsBeforeRestart, { tickets: 2, assignments: 2, reports: 2, pipeline_cancel_audits: 1, child_ordinary_acknowledgements: 0 })
    await assert.rejects(stat(join(rootB, cancelTarget)), error => error.code === 'ENOENT')
    cancelEvidence = {
      calls: 'source.pollAndRun; editor.client.poll; pipeline.cancel; editor.pollAndRun; dispatchOutbox; ordinary acknowledge; pipeline.cancel; create replay; pipeline.run; polls; Concierge restart',
      before_node_receive: { assignment_id: received.id, lease_epoch: received.lease_epoch,
        acknowledged_at: unacknowledged.acknowledged_at, cancelled_at: unacknowledged.cancelled_at,
        target_exists: false, local_admission: false },
      initial_cancel: { response_status: initialCancel.pipeline.status, source_status: sourceStage.checkpoint_state, child_status: childStage.checkpoint_state },
      after_node_ack: { before_parent_status: initialCancel.pipeline.status, full_status: afterAck.pipeline.status,
        source_status: parent.status, child_status: child.status,
        source_checkpoint: afterAck.pipeline.stages[0].checkpoint_state, child_checkpoint: afterAck.pipeline.stages[1].checkpoint_state,
        report_count: child.reports.length, cancel_acknowledged: child.reports[0].cancel_acknowledged,
        artifact_count: child.artifacts.length, effect_count: child.effects.length,
        assignment_id: child.assignments[0].id, lease_epoch: child.assignments[0].lease_epoch },
      late_ordinary_ack: { http_status: 409, code: 'outcome_unknown', acknowledged_at: lateAdmission.acknowledged_at },
      before_restart: { pipeline_status: replayedRun.pipeline.status, counts: countsBeforeRestart,
        source_file_sha256: sourceFileAfter, source_artifact_sha256: parentArtifactBefore,
        original_grants: grantRows },
      expected_terminal_status: 'cancelled',
    }
    return cancelEvidence
  })
  await ok('stopped pipeline stays terminal after center restart without a new descendant', async () => {
    const childTicketId = (await admin.get(`/api/v1/pipelines/${cancelPipelineId}`)).pipeline.stages[1].ticket_id
    const sourceTicketId = (await admin.get(`/api/v1/pipelines/${cancelPipelineId}`)).pipeline.stages[0].ticket_id
    await server.stop()
    server = await startRustConcierge({ root: dirname(server.dataDir), env: { ...process.env, LOOM_CLIENT_TOKEN: server.clientToken } })
    admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
    for (const node of [source, editor]) {
      node.http = new LoomHttpClient({ baseUrl: server.baseUrl })
      node.client.http = node.http
      node.options.baseUrl = server.baseUrl
    }
    await runOnce(source, 'idle')
    await runOnce(editor, 'idle')
    const restored = await admin.post(`/api/v1/pipelines/${cancelPipelineId}/run`, {})
    const child = await admin.get(`/api/v1/tickets/${childTicketId}`)
    const parent = await admin.get(`/api/v1/tickets/${sourceTicketId}`)
    const afterRestartCounts = {
      assignments: readEvidence("SELECT count(*) AS count FROM assignments WHERE ticket_id IN (?1,?2)", [sourceTicketId, childTicketId])[0].count,
      reports: readEvidence("SELECT count(*) AS count FROM reports WHERE ticket_id IN (?1,?2)", [sourceTicketId, childTicketId])[0].count,
      artifacts: readEvidence("SELECT count(*) AS count FROM artifacts WHERE ticket_id IN (?1,?2)", [sourceTicketId, childTicketId])[0].count,
    }
    assert.deepEqual(afterRestartCounts, { assignments: 2, reports: 2, artifacts: 1 })
    assert.equal(auditCount('pipeline.cancel_requested', childTicketId), 1)
    assert.equal(auditCount('assignment.acknowledged', childTicketId), 0)
    assert.equal(child.status, 'cancelled')
    assert.equal(child.reports.length, 1)
    assert.equal(parent.status, 'succeeded')
    assert.equal(parent.cancel_requested, false)
    assert.equal(parent.artifacts[0].sha256, cancelEvidence.before_restart.source_artifact_sha256)
    assert.equal(sha256(await readFile(join(rootA, 'docs/cancel-input.txt'))), cancelEvidence.before_restart.source_file_sha256)
    await assert.rejects(stat(join(rootB, cancelTarget)), error => error.code === 'ENOENT')
    assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
    cancelEvidence.after_restart = { full_status: restored.pipeline.status,
      source_status: parent.status, child_status: child.status,
      source_checkpoint: restored.pipeline.stages[0].checkpoint_state, child_checkpoint: restored.pipeline.stages[1].checkpoint_state,
      counts: afterRestartCounts, source_artifact_sha256: parent.artifacts[0].sha256,
      target_exists: false, audit_valid: true }
    // Everything above is real evidence. Only this terminal reducer contract is deferred until the fix.
    cancelReproduction = JSON.parse(JSON.stringify(cancelEvidence))
    assert.equal(restored.pipeline.status, 'cancelled')
    return cancelReproduction
  })
  console.log(JSON.stringify({ overall: 'PASS', pipeline: pipelineId, cancelled_pipeline: cancelPipelineId, checks, limitations: 'One physical macOS with two isolated logical Nodes, deterministic transform only; not a physical second host, general LLM DAG, direct peer transport or Tauri acceptance.' }, null, 2))
} catch (error) {
  console.error(JSON.stringify(failReport(error), null, 2))
  process.exitCode = 1
} finally {
  if (server) await server.stop()
}
// End of the bounded, real document integration proof.
