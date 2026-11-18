import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
 import { SyntheticCoordinator } from '../../scripts/fixtures/coordinator.mjs'
import { LocalNodeRunner } from '../../plugins/dsh-loom/src/runner.js'
import { LocalFileDispatcher } from '../../plugins/dsh-loom/lib/file-dispatcher.js'
import { DshDispatcher } from '../../plugins/dsh-loom/lib/dsh-dispatcher.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { sha256 } from '../../plugins/dsh-loom/src/util.js'
import { NodeIdentity, NodeState } from '../../plugins/dsh-loom/src/index.js'
import { stableArtifactId } from '../../plugins/dsh-loom/lib/ids.js'
import { CoordinatorLoop } from '../../plugins/dsh-loom/lib/coordinator.js'

const durable = value => JSON.parse(JSON.stringify(value))
const coordinatorRoot = await mkdtemp(join(tmpdir(), 'loom-dshaw-coordinator-admission-'))
await mkdir(join(coordinatorRoot, 'coordinator'), { mode: 0o700 })
const coordinator = new SyntheticCoordinator({ root: join(coordinatorRoot, 'coordinator') })
await coordinator.listen()
try {
  const project = await coordinator.prepareProject('Coordinator fencing fixture')
  const admin = new LoomHttpClient({ baseUrl: coordinator.baseUrl, clientToken: coordinator.clientToken })
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const runner = await LocalNodeRunner.create({ stateDir: join(coordinatorRoot, 'disk-state'), artifactDir: join(coordinatorRoot, 'artifacts'), baseUrl: coordinator.baseUrl, enrollmentCode: enrollment.code, projectRoots: { [project.id]: project.root } })
  await coordinator.makeGrant({ project_id: project.id, operations: ['read_summary', 'read', 'write'] })
  const ticket = await coordinator.makeTicket({ project_id: project.id, objective: 'Read the isolated project for this test only' })
  const original = await coordinator.dispatchTicket(ticket.id, runner.nodeId, { kind: 'read_summary', relative_path: 'input.txt' })
  const local = new LocalFileDispatcher(runner)
  let fileExecutorCalls = 0
  const executorIds = []
  const fileExecute = runner.executor.execute.bind(runner.executor)
  runner.executor.execute = async (...args) => { fileExecutorCalls++; executorIds.push(args[0].id); return fileExecute(...args) }
  assert.equal(await local.canExecute(original), true)
  const initial = await local.executeAssignment(original)
  assert.equal(initial.state, 'succeeded')
  assert.ok(runner.state.data.completions[original.id])
  await runner.report(original, initial)
  await runner.client.dispatchOutbox()
  const originalAssignment = durable(runner.state.data.assignments[original.id])
  const originalCompletion = durable(runner.state.data.completions[original.id])
  const originalSource = await readFile(join(project.root, 'input.txt'), 'utf8')
  const previousBytes = coordinator.artifacts.size
  const agent = { ctx: {}, sequence: new Map(), executeAssignment: async () => { throw new Error('Synthetic Agent must not execute stale data') } }
  const dsh = new DshDispatcher(runner, agent, {}, local)
  const changed = { ...original, grant_digest: sha256('coordinator fixture altered digest'),
    grant: { ...original.grant, digest: sha256('coordinator fixture altered digest') } }
  coordinator.assignments.set(original.id, changed)
  for (const dispatcher of [local, dsh]) {
    assert.equal(await dispatcher.canExecute(changed), false, 'stale preflight must not reach dispatch')
    const result = await dispatcher.executeAssignment(changed)
    assert.equal(result.status, 'fenced')
    assert.equal(result.rejection.reason, 'stale_grant_digest')
    assert.deepEqual(durable(runner.state.data.assignments[original.id]), originalAssignment)
    assert.deepEqual(durable(runner.state.data.completions[original.id]), originalCompletion)
    assert.equal(coordinator.artifacts.size, previousBytes, 'Stale inputs cannot create an extra Artifact')
    assert.equal(runner.state.outbox.length, 0, 'No automatic fabricated ordinary success/failure Report for a stale fence')
    assert.equal(fileExecutorCalls, 1, 'Stale Assignment cannot call the real ControlledFileExecutor again')
    assert.equal(await readFile(join(project.root, 'input.txt'), 'utf8'), originalSource)
  }
  assert.equal(runner.state.data.completions[original.id].digest, originalCompletion.digest)
  coordinator.assignments.set(original.id, original)
  coordinator.outbox.set(runner.nodeId, original)
  const same = await local.executeAssignment(original)
  assert.equal(same.state, 'succeeded')
  assert.equal(same.duplicate, true, 'The underlying real durable once ledger must mark unchanged replay')
  assert.equal(fileExecutorCalls, 1)
  await runner.client.dispatchOutbox()
  assert.equal(coordinator.artifacts.size, previousBytes, 'Replaying immutable bytes does not create a second artifact upload')
  assert.deepEqual(durable(runner.state.data.completions[original.id]), originalCompletion)

  const advancedStale = { ...original, lease_epoch: original.lease_epoch + 1,
    grant_digest: sha256('another stale coordinator epoch and digest'),
    grant: { ...original.grant, digest: sha256('another stale coordinator epoch and digest') } }
  let cancelCalls = 0
  dsh.cancel = async () => { cancelCalls++; return true }
  const ControllerLoop = CoordinatorLoop
  const firstLoop = new ControllerLoop({ max_active_workers: 1 }, dsh, runner.client)
  const ackBeforeLoop = coordinator.acks.length
  await firstLoop.handle(advancedStale)
  assert.equal(cancelCalls, 0)
  assert.equal(coordinator.acks.length, ackBeforeLoop + 1, 'The actual Loop path persists and attempts one stale acknowledgement')
  assert.equal(runner.state.outbox.length, 0)
  assert.equal(fileExecutorCalls, 1)
  const phaseRoot = await LocalNodeRunner.create({ stateDir: join(coordinatorRoot, 'disk-state'), artifactDir: join(coordinatorRoot, 'artifacts'), baseUrl: coordinator.baseUrl, projectRoots: { [project.id]: project.root } })
  const afterReopen = new DshDispatcher(phaseRoot, agent, {}, local)
  const reopenedLoop = new ControllerLoop({ max_active_workers: 1 }, afterReopen, phaseRoot.client)
  await reopenedLoop.handle(advancedStale)
  assert.equal(coordinator.acks.length, ackBeforeLoop + 1, 'A reopened CoordinatorLoop reuses the terminal local receipt')
  await reopenedLoop.handle({ ...advancedStale, cancel_requested: true })
  assert.equal(cancelCalls, 0, 'A stale cancellation cannot abort another locally recorded assignment')
  const unknownCancel = { ...original, id: stableArtifactId('not-a-local-assignment'), node_id: 'f'.repeat(64), cancel_requested: true }
  await reopenedLoop.handle(unknownCancel)
  assert.equal(cancelCalls, 0)
  assert.ok(phaseRoot.state.data.assignments[unknownCancel.id] === undefined, 'Unknown cancellation must not manufacture an Assignment history')
  assert.deepEqual(durable(phaseRoot.state.data.assignments[original.id]), originalAssignment)
  assert.deepEqual(durable(phaseRoot.state.data.completions[original.id]), originalCompletion)
  assert.ok(coordinator.reports.get(original.id).requested_state !== 'cancelled')

  const stopTicket = await coordinator.makeTicket({ project_id: project.id, objective: 'A cancellation-racing actual file write' })
  const stopAssignment = await coordinator.dispatchTicket(stopTicket.id, runner.nodeId, {
    kind: 'edit_file', relative_path: 'stop-output.txt', content: 'Owned output written before the delayed result is observed.\n',
  })
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const actualExecute = runner.executor.execute.bind(runner.executor)
  runner.executor.execute = async (...args) => {
    // Gate one real invocation, don't count another spy layered around the same Native call.
    entered.resolve()
    await gate.promise
    return actualExecute(...args)
  }
  const stopDispatcher = new LocalFileDispatcher(runner)
  const stopLoop = new CoordinatorLoop({ max_active_workers: 1 }, stopDispatcher, runner.client)
  const initialWrite = stopLoop.startAssignment(stopAssignment)
  await entered.promise
  assert.equal(stopDispatcher.active.get(stopAssignment.id).controller.signal.aborted, false)
  const stopAcknowledged = Promise.withResolvers()
  const sendAck = runner.client.acknowledge.bind(runner.client)
  runner.client.acknowledge = async (body) => {
    const result = await sendAck(body)
    if (body.cancelRequested || body.cancel_requested) stopAcknowledged.resolve(body)
    return result
  }
  const stopActiveAssignment = stopDispatcher.active.get(stopAssignment.id).assignment
  const retainedHeldState = durable(runner.state.data)
  await runner.state.mutate(data => {
    delete data.assignments[stopAssignment.id]
    delete data.completions[stopAssignment.id]
  })
  await stopLoop.handle({ ...stopAssignment, cancel_requested: true })
  const liveRejection = Object.values(runner.state.data.rejections).find(item => item.ticket_id === stopTicket.id)
  assert.equal(liveRejection?.reason, 'missing_previous_assignment')
  assert.deepEqual(stopDispatcher.active.get(stopAssignment.id).assignment, stopActiveAssignment)
  assert.equal(runner.state.data.completions[stopAssignment.id], undefined, 'Active Coordinator work must not gain a fabricated never-started completion')
  assert.equal(stopDispatcher.active.get(stopAssignment.id).controller.signal.aborted, false)
  assert.equal(coordinator.reports.has(stopAssignment.id), false, 'A missing durable history cannot fabricate a stopped Agent report')
  await runner.state.mutate(data => {
    data.assignments[stopAssignment.id] = retainedHeldState.assignments[stopAssignment.id]
    data.completions[stopAssignment.id] = retainedHeldState.completions[stopAssignment.id]
  })
  const stopIntent = await admin.post(`/api/v1/tickets/${stopTicket.id}/cancel`, {})
  const stopTask = stopLoop.startAssignment(stopIntent)
  const stopAck = await stopAcknowledged.promise
  assert.equal(stopAck.accepted, true)
  assert.equal(stopDispatcher.active.get(stopAssignment.id).controller.signal.aborted, true,
    'The real active file operation receives its exact stop intent, not just an unrelated map lookup')
  assert.equal(coordinator.acks.at(-1).cancel_requested, true)
  assert.equal(coordinator.acks.at(-1).cancellation, true)
  gate.resolve()
  await initialWrite
  await stopTask
  assert.equal((await readFile(join(project.root, 'stop-output.txt'), 'utf8')), stopAssignment.content)
  const stopCompletion = runner.state.data.completions[stopAssignment.id]
  assert.equal(stopCompletion.state, 'unknown', 'The actual already-started operation cannot be falsely declared cancelled or rolled back')
  assert.equal(stopCompletion.effect.status, 'confirmed')
  const stopReport = coordinator.reports.get(stopAssignment.id)
  assert.equal(stopReport.requested_state, 'unknown')
  assert.equal(stopReport.effects[0].status, 'confirmed')
  assert.notEqual(stopReport.cancel_acknowledged, true, 'An unknown file outcome must not carry a confirmed cancellation acknowledgement')
  assert.equal(fileExecutorCalls, 2)
  assert.deepEqual(executorIds, [original.id, stopAssignment.id], 'One real tool call for the original read, one for the racing write; no duplicate stop work')
  const stopDisk = JSON.parse(await readFile(join(coordinatorRoot, 'disk-state', 'node-state.json'), 'utf8'))
  assert.equal(stopDisk.completions[stopAssignment.id].state, 'unknown')
  assert.equal(stopDisk.completions[stopAssignment.id].digest, stopCompletion.digest)

  const normalizationTicket = await coordinator.makeTicket({ project_id: project.id,
    objective: 'A deterministic normalization fixture, not an SDK/model claim' })
  const normalizedAssignment = await coordinator.dispatchTicket(normalizationTicket.id, runner.nodeId, { kind: 'read_summary', relative_path: 'input.txt' })
  const bytes = Buffer.from(JSON.stringify({ schema: 'loom.normalization-fixture.v1', actual_bytes: 'owned synthetic output' }))
  const artifactId = stableArtifactId(`normalization-${normalizedAssignment.id}`)
  const effectId = stableArtifactId(`normalization-effect-${normalizedAssignment.id}`)
  const effect = { effect_id: effectId, status: 'unknown', input_digest: sha256(JSON.stringify({ id: normalizedAssignment.id, lease_epoch: 1 })),
    artifacts: [artifactId], evidence: { effect_id: effectId, artifact_id: artifactId, target_sha256: sha256(bytes) } }
  const metadata = { name: 'normalization-unit.json', media_type: 'application/json', size_bytes: bytes.length, sha256: sha256(bytes), origin_node_id: runner.nodeId }
  let producerCalls = 0
  const producer = { ctx: {}, sequence: new Map(), executeAssignment: async () => {
    producerCalls++
    return { state: 'unknown', summary: 'Synthetic unknown effect plus actual Artifact bytes; this is not a real SDK Tool proof.',
      artifact: { artifact_id: artifactId, bytes, metadata }, artifacts: [], artifact_ids: [], effects: [effect] }
  } }
  const normalizedDispatcher = new DshDispatcher(runner, producer, {}, local)
  assert.equal(await normalizedDispatcher.canExecute(normalizedAssignment), true)
  const normalized = await normalizedDispatcher.executeAssignment(normalizedAssignment)
  assert.equal(producerCalls, 1)
  assert.equal(normalized.artifacts[0].artifact_id, artifactId)
  assert.deepEqual(normalized.artifact_ids, [artifactId])
  assert.equal(normalized.effects.length, 1)
  const admissionReceipts = runner.state.data.deliveries?.filter(item => item.kind === 'ack' && item.body?.assignment_id === normalizedAssignment.id) || []
  assert.equal(admissionReceipts.length, 1, 'This dispatcher intentionally performs the normal ACK before its operation')
  assert.equal(admissionReceipts[0].response.accepted, true)
  assert.equal(admissionReceipts[0].body.ticket_id, normalizedAssignment.ticket_id)
  assert.equal(admissionReceipts[0].body.lease_epoch, normalizedAssignment.lease_epoch)
  assert.equal(admissionReceipts[0].body.cancel_requested, false)
  assert.equal(Number.isFinite(Date.parse(admissionReceipts[0].response.acknowledged_at || '')), true)
  assert.equal(runner.state.data.deliveries?.filter(item => ['artifact', 'report'].includes(item.kind) && item.body?.assignment_id === normalizedAssignment.id).length || 0, 0,
    'Normal ACK delivery is distinct from results: no Artifact/Report is delivered before the complete unknown normalization is durably projected')
  const completedBytes = JSON.parse(await readFile(join(coordinatorRoot, 'disk-state', 'node-state.json'), 'utf8')).completions[normalizedAssignment.id]
  assert.equal(completedBytes.digest, normalized.digest)
  assert.deepEqual(completedBytes.artifact_ids, [artifactId])
  assert.equal(completedBytes.artifact.metadata.artifact_id, artifactId)
  assert.equal(completedBytes.artifact.metadata.sha256, sha256(bytes))
  assert.deepEqual(completedBytes.artifacts, [ { ...metadata, artifact_id: artifactId } ])
  assert.deepEqual(completedBytes.effects, [effect])
  const reopenedRunner = await LocalNodeRunner.create({ stateDir: join(coordinatorRoot, 'disk-state'), artifactDir: join(coordinatorRoot, 'artifacts'), baseUrl: coordinator.baseUrl, projectRoots: { [project.id]: project.root } })
  const reopenedDispatcher = new DshDispatcher(reopenedRunner, producer, {}, local)
  const replayed = await reopenedDispatcher.executeAssignment(normalizedAssignment)
  assert.equal(producerCalls, 1, 'The durable, normalized completion does not invoke another producer on reopen')
  assert.equal(replayed.duplicate, true)
  assert.deepEqual(reopenedRunner.state.data.completions[normalizedAssignment.id].effects, [effect])
  await reopenedRunner.report(normalizedAssignment, replayed)
  await reopenedRunner.client.dispatchOutbox()
  assert.equal(coordinator.artifacts.get(artifactId).bytes_base64, bytes.toString('base64'))
  const expectedArtifacts = [runner.state.data.completions[original.id].artifact.artifact_id,
    stopCompletion.artifact.artifact_id, artifactId].sort()
  assert.deepEqual([...coordinator.artifacts.keys()].sort(), expectedArtifacts,
    'Exactly the original artifact, the racing file effect and the normalized fixture artifact: recreated reports add no new UUIDs')
  const stopArtifact = coordinator.artifacts.get(stopCompletion.artifact.artifact_id)
  assert.equal(stopArtifact.metadata.sha256, sha256(Buffer.from(stopArtifact.bytes_base64, 'base64')), 'The immutable Artifact container must hash its own exact bytes')
  assert.equal(stopCompletion.effect.evidence.target_sha256, sha256(stopAssignment.content), 'The distinct target-file hash must match the actual controlled file bytes')
  assert.equal(coordinator.reports.get(normalizedAssignment.id).requested_state, 'unknown')
  assert.equal(coordinator.reports.get(normalizedAssignment.id).effects[0].status, 'unknown')

  const root = await mkdtemp(join(tmpdir(), 'loom-node-digest-receipts-'))
  const identity = await NodeIdentity.open(root)
  const state = await NodeState.open(root)
  await assert.rejects(() => state.once('asg-missing-proof', 'input-proof', async () => ({ state: 'unknown', summary: 'Unresolved unit outcome' })).then(async () => {
    await state.mutate((data) => { delete data.completions['asg-missing-proof'].digest })
    return state.once('asg-missing-proof', 'input-proof', async () => { throw new Error('Must not execute a completion without input provenance') })
  }), /input digest/)
  await state.mutate((data) => { delete data.completions['asg-missing-proof']; data.outbox = []; data.rejections = {} })
  const once = await state.once('asg-proof', 'input-proof', async () => ({ state: 'unknown', summary: 'Unresolved unit outcome' }))
  assert.equal(once.digest, 'input-proof', 'Persist the task input identity separately from effect input digest')
  assert.equal(once.effects.length, 0, 'This fixture tests lack of evidence, not invented effect proof')
  assert.deepEqual(durable((await NodeState.open(root)).data.completions['asg-proof']), durable(once))
  console.log(JSON.stringify({ overall: 'PASS', original_read_executor_calls: 1,
    racing_write_executor_calls: executorIds.filter(id => id === stopAssignment.id).length,
    stop_intent_captured: true,
    local_dispatcher_stale_fenced: true, dsh_dispatcher_stale_fenced: true,
    original_completion_unmodified: true, immutable_artifact_count: expectedArtifacts.length,
    missing_legacy_input_digest_refused_without_execution: true,
    synthetic_control_plane_only: true, real_sdk_model_or_agent_claimed: false }, null, 2))
} finally { await coordinator.close() }
