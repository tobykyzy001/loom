import assert from 'node:assert/strict'
import { mkdtemp, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startRustConcierge, prepareProject } from '../../scripts/fixtures/rust-server.mjs'
import { LocalNodeRunner as MainRunner } from '../../packages/node-client/src/runner.js'
import { LocalNodeRunner as PluginRunner } from '../../plugins/dsh-loom/src/runner.js'
import { validateAssignment } from '../../packages/node-client/src/validation.js'
import { canonical, sha256 } from '../../packages/node-client/src/util.js'
import { rejectionFingerprint, sameAuthorizedAssignment } from '../../packages/node-client/src/admission.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { NodeState as MainState } from '../../packages/node-client/src/state.js'
import { NodeState as PluginState } from '../../plugins/dsh-loom/src/state.js'

async function legacyContextTest(Root, State, Runner) {
  const dir = join(Root, 'legacy-muted-receipts')
  const runner = { state: await State.open(dir) }
  const recordKey = rejectionFingerprint({ id: 'assignment-from-legacy', lease_epoch: 1, grant_digest: 'old-grant-digest' })
  const previous = { schema: 'loom.local-rejection.v1', fingerprint: recordKey,
    assignment_id: 'assignment-from-legacy', ticket_id: 'ticket-from-legacy', lease_epoch: 1,
    reason: 'Assignment belongs to a different node', acknowledgement: { outcome: 'accepted' } }
  runner.state.data.rejections = { [recordKey]: previous }
  runner.client = { acknowledge: async () => { throw new Error('A legacy terminal receipt must not be blindly reissued for a new input') } }
  const result = await Runner.prototype.rejectAssignment.call(runner, { id: 'assignment-from-legacy', ticket_id: 'ticket-from-legacy',
    node_id: recordKey, installation_id: 'future-installation', worker_id: 'default',
    project_id: 'changed-project', kind: 'read_summary', relative_path: 'different-file.txt',
    lease_epoch: 1, grant_digest: 'old-grant-digest' }, 'Assignment belongs to a different node')
  assert.equal(result.rejection.current_context_unverified, true)
  assert.equal(runner.state.data.rejections[recordKey].input_digest, undefined)
  assert.deepEqual(runner.state.outbox, [])
  return true
}

async function prove(label, Runner) {
  const root = await mkdtemp(join(tmpdir(), `loom-first-stop-${label}-`))
  const projectRoot = await prepareProject(root)
  await mkdir(join(root, 'server'), { mode: 0o700 })
  const server = await startRustConcierge({ root: join(root, 'server') })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const stateDir = join(root, 'node-state')
  const options = { stateDir, artifactDir: join(root, 'artifacts'), baseUrl: server.baseUrl,
    projectRoots: { project: projectRoot }, registration: { workerId: 'default', harnessKind: 'local-fixture',
      profileId: `isolated-${label}`, project_roots: { project: projectRoot } } }
  let executorCalls = 0
  const gated = runner => {
    const execute = runner.executor.execute.bind(runner.executor)
    runner.executor.execute = async (...args) => { executorCalls++; throw new Error('This pre-cancelled Assignment must never execute') }
    return execute
  }
  try {
    const project = await admin.post('/api/v1/projects', { name: 'Authorized but never started stop', root: projectRoot, mode: 'read_write' })
    const projectId = project.project.id
    options.projectRoots = { [projectId]: projectRoot }
    options.registration.project_roots = { [projectId]: projectRoot }
    const enrollment = await admin.post('/api/v1/enrollment-codes', {})
    const runner = new Runner(options)
    await runner.start({ enrollmentCode: enrollment.code })
    gated(runner)
    await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', root_scope: projectRoot })
    const grant = await admin.post('/api/v1/grants', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', operations: ['read', 'write'] })
    const ticket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', grant_id: grant.grant.id,
      objective: 'Do not write this file; verify a first validated stop', kind: 'edit_file', relative_path: 'never-created.txt', content: 'No effect allowed.' })
    const stopped = await admin.post(`/api/v1/tickets/${ticket.id}/cancel`, {})
    assert.equal(stopped.status, 'cancel_requested')
    const assignmentId = ticket.assignments?.[0]?.id || (await admin.get(`/api/v1/tickets/${ticket.id}`)).assignments[0].id

    // This is the first Assignment the client ever sees, and it already carries a durable stop intent.
    const first = await runner.pollAndRun()
    assert.equal(first.status, 'cancel_acknowledged', JSON.stringify(first))
    assert.equal(executorCalls, 0, 'A first valid pre-start stop must not invoke the real file executor')
    const admitted = runner.state.data.assignments[assignmentId]
    assert.ok(admitted?.cancel_requested)
    assert.equal(admitted.ticket_id, ticket.id)
    assert.equal(admitted.grant_digest, ticket.grant_digest)
    assert.equal(admitted.relative_path, 'never-created.txt')
    const completion = runner.state.data.completions[assignmentId]
    assert.equal(completion?.state, 'cancelled')
    assert.equal(completion.cancel_acknowledged, true)
    assert.equal(runner.state.outbox.filter(item => item.kind === 'artifact').length, 0)
    await runner.client.dispatchOutbox()
    const reported = await admin.get(`/api/v1/tickets/${ticket.id}`)
    assert.equal(reported.status, 'cancelled')
    assert.equal(reported.reports.at(-1).state, 'cancelled')
    assert.ok([true, 1].includes(reported.reports.at(-1).cancel_acknowledged))
    assert.deepEqual(reported.artifacts, [])
    await assert.rejects(stat(join(projectRoot, 'never-created.txt')), error => error.code === 'ENOENT')

    const reopened = new Runner(options)
    await reopened.start({})
    const restored = reopened.state.data.assignments[assignmentId]
    assert.equal(restored.ticket_id, admitted.ticket_id)
    assert.equal(restored.relative_path, admitted.relative_path)
    assert.equal(restored.grant_digest, admitted.grant_digest)
    assert.equal(restored.lease_epoch, admitted.lease_epoch)
    assert.equal(reopened.state.data.rejections && Object.keys(reopened.state.data.rejections).length, 0)
    assert.equal((await reopened.pollAndRun()).status, 'idle')
    assert.equal(executorCalls, 0)
    const repeatCancellation = await reopened.report(restored, reopened.state.data.completions[assignmentId])
    const replayDeliveries = await reopened.client.dispatchOutbox()
    const replayedDelivery = replayDeliveries.find(delivery => delivery.kind === 'report' && delivery.status === 'replay_delivered' && delivery.requestId === repeatCancellation.body.request_id)
    assert.equal(replayedDelivery?.response?.duplicate, true,
      'The real Rust controller must deduplicate the same never-started cancellation receipt after reopen')
    const deduplicatedReport = await admin.get(`/api/v1/tickets/${ticket.id}`)
    assert.equal(deduplicatedReport.reports.length, 1)
    assert.equal(deduplicatedReport.artifacts.length, 0)
    assert.equal(executorCalls, 0)

    // Existing cancelled native completion may not be replayed for a tampered incoming work/grant.
    const replayCurrentPoll = reopened.client.poll
    for (const altered of [{ grant_digest: '0'.repeat(64) }, { relative_path: 'other-target.txt' }]) {
      const received = { ...structuredClone(admitted), ...altered }
      reopened.client.poll = async () => received
      const duplicate = await reopened.pollAndRun()
      assert.equal(duplicate.status, 'fenced', `Changed incoming work must not replay its recorded pre-start stop: ${JSON.stringify(duplicate)}`)
      assert.equal(reopened.state.data.assignments[assignmentId].relative_path, 'never-created.txt')
      const expectedDigest = sha256(canonical({ assignment_id: assignmentId, lease_epoch: received.lease_epoch, grant_version: received.grant_version }))
      assert.equal(reopened.state.data.completions[assignmentId].digest, expectedDigest)
    }
    reopened.client.poll = replayCurrentPoll
    assert.equal(executorCalls, 0)

    const normalizationTicket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', grant_id: grant.grant.id, objective: 'Normalize the issued Grant version during first-stop admission', kind: 'edit_file', relative_path: 'never-created-normalization.txt', content: 'This file must never be created.\n' })
    assert.ok(typeof normalizationTicket?.id === 'string')
    await admin.post(`/api/v1/tickets/${normalizationTicket.id}/cancel`, {})
    const normalizedIdentity = await reopened.client.poll({ lastAssignmentId: null, waitSeconds: 0 })
    delete normalizedIdentity.grant_version
    const normalizedStop = await reopened.pollAndRun()
    assert.equal(normalizedStop.status, 'cancel_acknowledged', JSON.stringify(normalizedStop))
    const canonicalStop = reopened.state.data.assignments[normalizedIdentity.id]
    assert.equal(canonicalStop.grant_version, normalizedIdentity.grant?.version)
    const ordinaryEquivalent = { ...structuredClone(canonicalStop) }
    delete ordinaryEquivalent.grant_version
    assert.equal(sameAuthorizedAssignment(canonicalStop, ordinaryEquivalent), true)
    await reopened.client.dispatchOutbox()
    const normalizedReported = await admin.get(`/api/v1/tickets/${normalizationTicket.id}`)
    assert.equal(normalizedReported.reports?.at(-1)?.state, 'cancelled')
    assert.equal(normalizedReported.status, 'cancelled')
    assert.ok([true, 1].includes(normalizedReported.reports.at(-1).cancel_acknowledged))
    assert.deepEqual(normalizedReported.artifacts, [])
    await assert.rejects(stat(join(projectRoot, 'never-created-normalization.txt')), error => error.code === 'ENOENT')
    assert.equal(executorCalls, 0)

    const wrongTicket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', grant_id: grant.grant.id,
      objective: 'Verify invalid cancellation identities do not bypass the original fence', kind: 'read_summary', relative_path: 'input.txt' })
    const cancelWrong = await admin.post(`/api/v1/tickets/${wrongTicket.id}/cancel`, {})
    assert.equal(cancelWrong.status, 'cancel_requested')
    const valid = await runner.client.poll({ lastAssignmentId: null, waitSeconds: 0 })
    assert.ok(valid?.id && valid.cancel_requested)
    const challenged = [
      { field: 'node_id', mutate: value => ({ ...value, node_id: 'f'.repeat(64) }), expected: /different node/ },
      { field: 'grant_digest', mutate: value => ({ ...value, grant_digest: '0'.repeat(64) }), expected: /digest/ },
      { field: 'lease_expires_at', mutate: value => ({ ...value, lease_expires_at: 'not-a-time' }), expected: /expiry/ },
    ]
    const rejectionOutcomes = []
    for (const { field, mutate, expected } of challenged) {
      const currentPoll = runner.client.poll
      const injected = mutate(structuredClone(valid))
      runner.client.poll = async () => injected
       const result = await runner.pollAndRun()
      runner.client.poll = currentPoll
            assert.equal(result.status, 'fenced', `${field}: ${JSON.stringify(result)}`)
      rejectionOutcomes.push({ field, reason: result.rejection?.reason })
      assert.match(result.rejection?.reason || '', expected)
      assert.equal(runner.state.data.assignments[valid.id], undefined, `${field}: no cancelled assignment should be manufactured`)
    }
    assert.equal(executorCalls, 0, 'Rejected cancellation identities cannot enter the executor')
    const rejectionContexts = new Set(Object.entries(runner.state.data.rejections || {}))
    assert.equal(rejectionContexts.size, 2, 'Shared assignment/epoch/Grant fingerprints must not be inflated by rejection kinds')
    for (const { field, expected } of challenged) {
      const observed = rejectionOutcomes.find(outcome => outcome.field === field)
      assert.ok(observed, `Every negative case must record an observed outcome: ${field}`)
      assert.match(observed.reason || '', expected)
    }
    assert.equal((await admin.get(`/api/v1/tickets/${wrongTicket.id}`)).reports.at(-1)?.state || '', '')
    assert.throws(() => validateAssignment({ ...valid, cancel_requested: false }, valid.grant, runner.identity), /expired/)
    assert.ok(await legacyContextTest(root, label === 'main' ? MainState : PluginState, Runner))
    return { implementation: label, first_cancel_acknowledged: true, executor_calls: 0,
      real_center_cancelled_report: true, no_artifacts_or_file_effects: true,
      same_identity_and_work_after_reopen: true,
      incorrect_node_grant_or_expiry_fenced_without_execution: true }
  } finally { await server.stop() }
}

const outcomes = [await prove('main', MainRunner), await prove('vendored', PluginRunner)]
console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.cancel-before-admission.v1', outcomes,
  facts: ['Actual Rust centre creates grants and cancel intent', 'First authorized intake cancellation before any executor',
    'No real SDK or model provider was called', 'Invalid identity/digest/window remains isolated rather than granted cancellation'],
  not_claimed: ['unknown Assignment cancellation', 'rollback of actual effects', 'exactly-once network delivery', 'remote/multi-device cancellation'] }, null, 2))
