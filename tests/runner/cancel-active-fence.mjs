import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SyntheticCoordinator } from '../../scripts/fixtures/coordinator.mjs'
import { LocalNodeRunner as TypeScriptRunner } from '../../packages/node-client/src/runner.js'
import { LocalNodeRunner as PluginRunner } from '../../plugins/dsh-loom/src/runner.js'
import { NodeIdentity as TypeScriptIdentity } from '../../packages/node-client/src/identity.js'
import { NodeState as TypeScriptState } from '../../packages/node-client/src/state.js'
import { NodeIdentity as PluginIdentity } from '../../plugins/dsh-loom/src/identity.js'
import { NodeState as PluginState } from '../../plugins/dsh-loom/src/state.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { sha256 } from '../../packages/node-client/src/util.js'

const durable = value => JSON.parse(JSON.stringify(value))
const noReport = () => { throw new Error('Fenced cancellation must not issue an ordinary Report') }

async function disk(stateDir) { return JSON.parse(await readFile(join(stateDir, 'node-state.json'), 'utf8')) }
async function openIndependent(stateDir, Identity, State) {
  const identity = await Identity.open(stateDir)
  return { identity, state: await State.open(stateDir) }
}
function rejectionAcks(coordinator, before) {
  return coordinator.acks.slice(before).filter(item => item.accepted === false).length
}

async function prove(name, Runner, Identity, State) {
  const root = await mkdtemp(join(tmpdir(), `loom-cancel-active-${name}-`))
  await mkdir(join(root, 'coordinator'), { mode: 0o700 })
  const coordinator = new SyntheticCoordinator({ root: join(root, 'coordinator') })
  await coordinator.listen()
  let executorCalls = 0
  let realExecutorCalls = 0
  let execute
  const start = async options => {
    const runner = new Runner({ stateDir: join(root, 'node-state'), artifactDir: join(root, 'artifacts'),
      baseUrl: coordinator.baseUrl, ...options })
    await runner.start(options)
    execute = runner.executor.execute.bind(runner.executor)
    runner.executor.execute = async (...args) => { executorCalls++; return execute(...args) }
    return runner
  }
  const pose = (runner, assignment) => {
    coordinator.assignments.set(assignment.id, assignment)
    coordinator.outbox.set(runner.nodeId, assignment)
  }
  const admin = new LoomHttpClient({ baseUrl: coordinator.baseUrl, clientToken: coordinator.clientToken })
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const project = await coordinator.prepareProject('Cancellation fencing fixture')
  try {
    const runner = await start({ enrollmentCode: enrollment.code, projectRoots: { [project.id]: project.root } })
    await coordinator.makeGrant({ project_id: project.id, operations: ['read_summary'] })
    const ticket = await coordinator.makeTicket({ project_id: project.id, objective: 'Durable cancellation and active fencing' })
    const original = await coordinator.dispatchTicket(ticket.id, runner.nodeId, { kind: 'read_summary', relative_path: 'input.txt' })
    assert.equal((await runner.pollAndRun()).status, 'succeeded')
    await runner.client.dispatchOutbox()
    assert.equal(executorCalls, 1, 'The real ControlledFileExecutor ran once')
    const originalAssignment = durable(runner.state.data.assignments[original.id])
    const originalCompletion = durable(runner.state.data.completions[original.id])
    const originalArtifacts = coordinator.artifacts.size
    const report = runner.report
    const attacks = [
      ['old_epoch', { ...original, lease_epoch: 0, cancel_requested: true }],
      ['changed_grant', { ...original, grant_digest: sha256('forged cancellation grant'),
        grant: { ...original.grant, digest: sha256('forged cancellation grant') }, cancel_requested: true }],
      ['changed_content', { ...original, relative_path: 'unauthorized.txt', cancel_requested: true }],
    ]
    for (const [label, changed] of attacks) {
      pose(runner, changed)
      const before = coordinator.acks.length
      runner.report = noReport
      const result = await runner.pollAndRun()
      assert.equal(result.status, 'fenced', label)
      assert.equal(executorCalls, 1, label)
      assert.deepEqual(durable(runner.state.data.assignments[original.id]), originalAssignment, label)
      assert.deepEqual(durable(runner.state.data.completions[original.id]), originalCompletion, label)
      assert.ok(runner.state.data.rejections[result.rejection.fingerprint], label)
      assert.equal(runner.state.outbox.some(item => item.kind === 'report'), false, label)
      assert.equal(rejectionAcks(coordinator, before), 1,
        `${label}: one local rejection acknowledgement; ${JSON.stringify({ acks: coordinator.acks, result })}`)
      assert.equal(coordinator.reports.size, 1, label)
    }
    runner.report = report
    const persistedAttacks = await disk(join(root, 'node-state'))
    assert.deepEqual(persistedAttacks.assignments[original.id], originalAssignment, 'Attack frames stayed unchanged on disk')
    assert.deepEqual(persistedAttacks.completions[original.id], originalCompletion, 'Attack completions stayed unchanged on disk')
    const rejectionCount = Object.keys(runner.state.data.rejections).length

    const reopened = await start({ projectRoots: { [project.id]: project.root } })
    const identityState = await openIndependent(join(root, 'node-state'), Identity, State)
    assert.equal(identityState.identity.node_id, runner.nodeId, 'Genuine NodeIdentity.open restored the same node')
    assert.deepEqual(identityState.state.data.assignments, reopened.state.data.assignments, 'Genuine NodeState.open restored all frames')
    for (const [label, changed] of attacks) {
      pose(reopened, changed)
      reopened.report = noReport
      const result = await reopened.pollAndRun()
      assert.equal(result.status, 'fenced', `${label}: after reopen`)
      assert.equal(result.rejection.acknowledgement.outcome, 'accepted')
    }
    assert.equal(coordinator.acks.length, rejectionCount + 1, 'Reopen preserved all terminal rejection receipts')
    assert.equal(executorCalls, 1)
    const rejectionState = await disk(join(root, 'node-state'))
    assert.equal(Object.keys(rejectionState.rejections).length, rejectionCount)
    assert.deepEqual(rejectionState.assignments[original.id], originalAssignment)
    assert.deepEqual(rejectionState.completions[original.id], originalCompletion)

    const unknownId = 'unknown-local-assignment'
    pose(reopened, { ...original, id: unknownId, node_id: 'f'.repeat(64), cancel_requested: true })
    reopened.report = noReport
    const unknown = await reopened.pollAndRun()
    assert.equal(unknown.status, 'fenced')
    assert.equal(unknown.rejection.reason, 'Assignment belongs to a different node')
    assert.equal(unknown.rejection.assignment_id, unknownId)
    assert.equal(Object.hasOwn(reopened.state.data.assignments, unknownId), false, 'No {...undefined} durable assignment')
    assert.equal(Object.hasOwn(reopened.state.data.completions, unknownId), false)
    const originalJson = canonical => JSON.stringify(canonical)
    assert.equal(Object.values(reopened.state.data.assignments).some(value => originalJson(value).includes('undefined')), false)
    const unknownDisk = await disk(join(root, 'node-state'))
    assert.equal(Object.hasOwn(unknownDisk.assignments, unknownId), false)
    assert.equal(Object.hasOwn(unknownDisk.completions, unknownId), false)
    assert.equal(unknownDisk.outbox.some(item => item.kind === 'report'), false, 'Unknown cancel has no Report outbox')
    assert.ok(unknownDisk.rejections[unknown.rejection.fingerprint], 'Unknown cancel has only a durable local rejection')
    assert.deepEqual(unknownDisk.assignments[original.id], originalAssignment)
    assert.deepEqual(unknownDisk.completions[original.id], originalCompletion)
    assert.equal(coordinator.artifacts.size, originalArtifacts)

    pose(reopened, { ...original, cancel_requested: true })
    reopened.report = report
    const validCancelled = await reopened.pollAndRun()
    assert.equal(validCancelled.status, 'cancel_acknowledged', 'Ordinary existing current-frame cancellation still works')
    assert.deepEqual(durable(reopened.state.data.assignments[original.id]), { ...originalAssignment, cancel_requested: true })
    assert.deepEqual(durable(reopened.state.data.completions[original.id]), originalCompletion, 'Cancel does not rewrite completion')
    assert.equal(executorCalls, 1)
    const validDisk = await disk(join(root, 'node-state'))
    assert.deepEqual(validDisk.assignments[original.id], { ...originalAssignment, cancel_requested: true })
    assert.deepEqual(validDisk.completions[original.id], originalCompletion)
    if (name === 'typescript') {
      assert.equal(reopened.state.outbox.length, 1, 'Valid TypeScript cancellation creates one ordinary Report outbox entry')
      assert.equal(reopened.state.outbox[0].body.cancel_acknowledged, true)
      assert.equal(reopened.state.outbox[0].body.lease_epoch, original.lease_epoch)
      coordinator.assignments.set(original.id, original)
      const deliveredCancellation = await reopened.client.dispatchOutbox()
      assert.equal(deliveredCancellation[0].status, 'deferred')
      assert.match(deliveredCancellation[0].error, /Idempotent callback has different content/,
        'SyntheticCoordinator retains the completed Report; this fixture proves durable cancel Report shape, not redelivery')
      assert.equal(coordinator.reports.size, 1, 'No invalid path or impossible completed-report replacement reached the coordinator')
      const cancelReport = reopened.state.outbox.find(item => item.kind === 'report').body
      assert.equal(cancelReport.requested_state, 'cancelled')
      assert.equal(cancelReport.cancel_acknowledged, true)
      assert.equal(cancelReport.assignment_id, original.id)
      assert.equal(cancelReport.lease_epoch, original.lease_epoch)
    } else assert.equal(coordinator.reports.size, 1, 'Existing DSH-source runner does not directly add a cancellation Report')

    const activeRoot = await mkdtemp(join(tmpdir(), `loom-cancel-active-held-${name}-`))
    await mkdir(join(activeRoot, 'coordinator'), { mode: 0o700 })
    const activeCoordinator = new SyntheticCoordinator({ root: join(activeRoot, 'coordinator') })
    await activeCoordinator.listen()
    try {
      const activeAdmin = new LoomHttpClient({ baseUrl: activeCoordinator.baseUrl, clientToken: activeCoordinator.clientToken })
      const activeEnrollment = await activeAdmin.post('/api/v1/enrollment-codes', {})
      const activeProject = await activeCoordinator.prepareProject('Held active cancellation fixture')
      const activeStateDir = join(activeRoot, 'node-state')
      const activeRunner = new Runner({ stateDir: activeStateDir, artifactDir: join(activeRoot, 'artifacts'),
        baseUrl: activeCoordinator.baseUrl, projectRoots: { [activeProject.id]: activeProject.root } })
      await activeRunner.start({ enrollmentCode: activeEnrollment.code })
      await activeCoordinator.makeGrant({ project_id: activeProject.id, operations: ['read_summary'] })
      const activeTicket = await activeCoordinator.makeTicket({ project_id: activeProject.id, objective: 'Attack an actually active authorized snapshot' })
      const activeAssignment = await activeCoordinator.dispatchTicket(activeTicket.id, activeRunner.nodeId, { kind: 'read_summary', relative_path: 'input.txt' })
      const activePose = changed => {
        activeCoordinator.assignments.set(changed.id, changed)
        activeCoordinator.outbox.set(activeRunner.nodeId, changed)
      }
      let release
      const gate = new Promise(resolve => { release = resolve })
      let activeEntered
      const entered = new Promise(resolve => { activeEntered = resolve })
      const heldExecute = activeRunner.executor.execute.bind(activeRunner.executor)
      activeRunner.executor.execute = async (...args) => {
        activeEntered()
        await gate
        realExecutorCalls++
        return heldExecute(...args)
      }
      let executing = true
      const execution = activeRunner.pollAndRun().finally(() => { executing = false })
      await entered
      const activeSnapshot = durable(activeRunner.state.data.assignments[activeAssignment.id])
      const originalInputBytes = await readFile(join(activeProject.root, 'input.txt'), 'utf8')
      assert.equal(executing, true, 'The first real execution is still pending')
      const activeController = activeRunner.active.get(activeAssignment.id)
      assert.ok(activeController instanceof AbortController)
      assert.equal(activeController.signal.aborted, false)
      const activeReports = activeRunner.report
      activeRunner.report = noReport

      activePose({ ...activeAssignment, grant_digest: sha256('active forged digest'),
        grant: { ...activeAssignment.grant, digest: sha256('active forged digest') } })
      const changedActive = await activeRunner.pollAndRun()
      assert.equal(changedActive.status, 'fenced', 'Changed active digest cannot claim duplicate_active')
      assert.equal(activeRunner.active.get(activeAssignment.id), activeController, 'Wrong replay preserves the original controller')
      assert.equal(activeController.signal.aborted, false)
      activePose({ ...activeAssignment, content: 'changed undigested input' })
      const changedInput = await activeRunner.pollAndRun()
      assert.equal(changedInput.status, 'fenced', 'Same-digest changed content cannot claim duplicate_active')
      assert.equal(activeController.signal.aborted, false)

      const activeCancels = [
        { ...activeAssignment, lease_epoch: 0, cancel_requested: true },
        { ...activeAssignment, grant_digest: sha256('active cancellation forged digest'),
          grant: { ...activeAssignment.grant, digest: sha256('active cancellation forged digest') }, cancel_requested: true },
        { ...activeAssignment, content: 'malicious cancel changed input', cancel_requested: true },
      ]
      for (const wrong of activeCancels) {
        activePose(wrong)
        const result = await activeRunner.pollAndRun()
        assert.equal(result.status, 'fenced')
        assert.equal(result.status === 'cancel_acknowledged', false)
        assert.equal(activeController.signal.aborted, false, 'Wrong active cancel must not abort')
        assert.deepEqual(durable(activeRunner.state.data.assignments[activeAssignment.id]), activeSnapshot)
        assert.deepEqual(activeRunner.activeAssignments.get(activeAssignment.id), activeSnapshot)
        assert.equal(await activeRunner.active.has(wrong.id), true)
      }
      assert.equal(activeCoordinator.reports.size, 0, 'No Reports from active attack paths')
      assert.equal(activeRunner.state.outbox.some(item => item.kind === 'report'), false, 'No durable Report from active attack paths')
      activePose(activeAssignment)
      const replay = await activeRunner.pollAndRun()
      assert.equal(replay.status, 'duplicate_active')
      assert.equal(activeController.signal.aborted, false)
      assert.equal(realExecutorCalls, 0, 'The sole real invocation is held; identical replay has no second executor')
      assert.equal(executing, true, 'Wrong replay/cancel cannot deactivate the original promise')
      const heldDisk = await disk(activeStateDir)
      assert.deepEqual(heldDisk.assignments[activeAssignment.id], activeSnapshot)
      assert.equal(heldDisk.completions[activeAssignment.id].state, 'running')
      assert.equal(heldDisk.completions[activeAssignment.id].digest, activeRunner.state.data.completions[activeAssignment.id].digest)
      // Simulate an old asynchronous delivery/deactivation changing the durable history
      // just before the next poll identifies the same active ID. A matching incoming digest
      // and live controller must never turn this into duplicate/normal acceptance.
      await activeRunner.state.mutate(data => {
        data.assignments[activeAssignment.id] = { ...data.assignments[activeAssignment.id], content: 'late altered durable frame' }
      })
      activePose(activeAssignment)
      const deactivationRace = await activeRunner.pollAndRun()
      assert.equal(deactivationRace.status, 'fenced')
      assert.equal(deactivationRace.rejection.reason, 'active_assignment_mismatch')
      assert.equal(activeController.signal.aborted, false, 'Async active mismatch preserves the original controller')
      assert.equal(activeRunner.active.get(activeAssignment.id), activeController)
      assert.equal(executing, true)
      assert.equal(activeRunner.state.outbox.some(item => item.kind === 'report'), false)
      activePose({ ...activeAssignment, cancel_requested: true })
      const racedCancel = await activeRunner.pollAndRun()
      assert.equal(racedCancel.status, 'fenced')
      assert.equal(racedCancel.rejection.reason, 'active_assignment_mismatch', 'Cancellation refuses the active-to-durable divergence')
      assert.equal(activeController.signal.aborted, false)
      const racedSnapshot = await disk(activeStateDir)
      assert.equal(racedSnapshot.assignments[activeAssignment.id].content, 'late altered durable frame')
      assert.equal(racedSnapshot.completions[activeAssignment.id].digest, heldDisk.completions[activeAssignment.id].digest)
      await activeRunner.state.mutate(data => { delete data.assignments[activeAssignment.id]; delete data.completions[activeAssignment.id] })
      activePose({ ...activeAssignment, cancel_requested: true })
      const liveButMissingDurable = await activeRunner.pollAndRun()
      assert.equal(liveButMissingDurable.status, 'fenced')
      assert.equal(liveButMissingDurable.rejection.reason, 'missing_previous_assignment')
      assert.equal(activeRunner.state.data.completions[activeAssignment.id], undefined, 'Active memory cannot gain an invented never-started completion')
      assert.equal(activeController.signal.aborted, false)
      assert.equal(executing, true)
      assert.equal(await readFile(join(activeProject.root, 'input.txt'), 'utf8'), originalInputBytes)
      await activeRunner.state.mutate(data => {
        data.assignments[activeAssignment.id] = activeSnapshot
        data.completions[activeAssignment.id] = heldDisk.completions[activeAssignment.id]
      })
      activeRunner.report = activeReports
      activePose({ ...activeAssignment, cancel_requested: true,
        grant: { ...activeAssignment.grant, revoked_at: new Date().toISOString() } })
      const validActiveCancel = await activeRunner.pollAndRun()
      assert.equal(validActiveCancel.status, 'cancel_acknowledged')
      assert.equal(activeController.signal.aborted, true, 'Valid cancellation aborts the existing exact controller')
      assert.equal((await activeRunner.pollAndRun()).status, 'cancel_acknowledged', 'Repeated valid cancellation remains ordinary')
      release()
      const final = await execution
      assert.equal(final.status, 'unknown', 'Abort after a completed real effect must retain unknown outcome, not rewrite success')
      assert.equal(executing, false)
      assert.equal(realExecutorCalls, 1, 'All active replays/cancels retain one actual executor call')
      const finalDisk = await disk(activeStateDir)
      assert.deepEqual(finalDisk.assignments[activeAssignment.id], { ...activeSnapshot, cancel_requested: true })
      assert.equal(finalDisk.completions[activeAssignment.id].state, 'unknown')
      assert.equal(finalDisk.completions[activeAssignment.id].digest, heldDisk.completions[activeAssignment.id].digest)
      assert.equal(finalDisk.completions[activeAssignment.id].summary, 'Cancellation raced with a completed effect; reconciliation is required.')
    } finally { await activeCoordinator.close() }
    return { runner: name, status: 'PASS', completed_wrong_cancels: attacks.length,
      reopened_rejections: rejectionCount, unknown_cancel_durable_rejection_only: true,
      valid_existing_cancel: true, real_executor_calls: executorCalls,
      active_real_executor_calls: realExecutorCalls,
      active_wrong_replays_fenced: 2, active_wrong_cancels_fenced: 3,
      asynchronous_active_deactivation_fenced: true,
      valid_active_controller_aborted: true, valid_identical_replay_not_duplicated: true,
      real_filesystem_identity_state_reopens: true, synthetic_local_only: true }
  } finally { await coordinator.close() }
}

const results = []
for (const [name, Runner, Identity, State] of [
  ['typescript', TypeScriptRunner, TypeScriptIdentity, TypeScriptState],
  ['vendored', PluginRunner, PluginIdentity, PluginState],
]) results.push(await prove(name, Runner, Identity, State))
console.log(JSON.stringify({ overall: 'PASS', results, not_claimed: [
  'real DSH harness or profile', 'remote/network discovery', 'live model or credentials',
  'generic abort-aware executor', 'full distributed cancellation or exactly-once',
], artifacts: 'Only owned temporary fixtures; no commit or global installation' }, null, 2))
