import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SyntheticCoordinator } from '../../scripts/fixtures/coordinator.mjs'
import { LocalNodeRunner as TypeScriptRunner } from '../../packages/node-client/src/runner.js'
import { LocalNodeRunner as PluginRunner } from '../../plugins/dsh-loom/src/runner.js'
import { sha256 } from '../../packages/node-client/src/util.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

const durable = value => JSON.parse(JSON.stringify(value))

async function prove(name, Runner) {
  const root = await mkdtemp(join(tmpdir(), 'loom-durable-assignment-'))
  await mkdir(join(root, 'coordinator'), { mode: 0o700 })
  const coordinator = new SyntheticCoordinator({ root: join(root, 'coordinator') })
  await coordinator.listen()
  let executorCalls = 0
  try {
    const project = await coordinator.prepareProject('Durable task fence')
    const stateDir = join(root, 'node-state')
    const artifactDir = join(root, 'artifacts')
    const run = async (options = {}) => {
      const runner = new Runner({ stateDir, artifactDir, baseUrl: coordinator.baseUrl, projectRoots: { [project.id]: project.root }, ...options })
      await runner.start(options)
      const execute = runner.executor.execute.bind(runner.executor)
      runner.executor.execute = async (...args) => { executorCalls++; return execute(...args) }
      return runner
    }
    const enrollment = await new LoomHttpClient({ baseUrl: coordinator.baseUrl, clientToken: coordinator.clientToken }).post('/api/v1/enrollment-codes', {})
    const first = await run({ enrollmentCode: enrollment.code })
    await coordinator.makeGrant({ project_id: project.id, operations: ['read_summary'] })
    const support = await coordinator.makeTicket({ project_id: project.id, objective: 'First authorized read followed by stale delivery attempts' })
    const firstAssignment = await coordinator.dispatchTicket(support.id, first.nodeId, { kind: 'read_summary', relative_path: 'input.txt' })
    const initial = await first.pollAndRun()
    assert.equal(initial.status, 'succeeded', JSON.stringify(initial))
    assert.ok(first.state.data.assignments[firstAssignment.id])
    assert.ok(first.state.data.completions[firstAssignment.id])
    await first.client.dispatchOutbox()
    assert.equal(executorCalls, 1, 'A real read_summary operation must happen before testing invalid replays')
    const originalAssignment = durable(first.state.data.assignments[firstAssignment.id])
    const originalCompletion = durable(first.state.data.completions[firstAssignment.id])
    const originalGrantDigest = originalAssignment.grant_digest
    assert.equal(coordinator.artifacts.size, 1, 'The accepted operation produced concrete immutable Artifact evidence')
    const pose = assignment => {
      coordinator.assignments.set(assignment.id, assignment)
      coordinator.outbox.set(first.nodeId, assignment)
    }

    pose(firstAssignment)
    const reopened = await run()
      const replay = await reopened.pollAndRun()
    assert.equal(replay.status, 'succeeded')
    assert.deepEqual(durable(reopened.state.data.completions[firstAssignment.id]), originalCompletion, 'Reopen keeps the existing immutable completion rather than creating a replacement execution')
    assert.equal(executorCalls, 1, 'Reopening the real state must reuse the approved historical completion')
    assert.deepEqual(durable(durable(reopened.state.data.assignments[firstAssignment.id])), originalAssignment)
    await reopened.client.dispatchOutbox()

    const changed = { ...firstAssignment,
      grant_digest: sha256('synthetic replacement digest, deliberately not the original grant'),
      grant: { ...firstAssignment.grant, digest: sha256('synthetic replacement digest, deliberately not the original grant') },
    }
    const akBeforeQuarantine = coordinator.acks.length
    const originalHandle = coordinator.handle.bind(coordinator)
    coordinator.handle = async (req, res) => {
      if (rejectAck && req.url.endsWith('/api/v1/nodes/acknowledge')) {
        for await (const _ of req) void _
        return coordinator.reply(res, 409, { error: { code: 'stale_ack_rejected', message: 'Synthetic stale acknowledgement refused' } })
      }
      return originalHandle(req, res)
    }
    pose(changed)
    const baselineRejections = reopened.state.data.rejections
    let rejectAck = true
    const fenced = await reopened.pollAndRun()
      assert.equal(fenced.status, 'fenced')
    assert.equal(executorCalls, 1, 'A replacement digest must not borrow the original permission after restart')
    assert.deepEqual(durable(reopened.state.data.assignments[firstAssignment.id]), originalAssignment, 'Rejected new data cannot replace the valid persisted admission')
    assert.deepEqual(durable(reopened.state.data.completions[firstAssignment.id]), originalCompletion)
    assert.equal(reopened.state.outbox.length, 0, 'A local stale fence must not synthesize an ordinary failed Report')
    const fingerprint = fenced.rejection.fingerprint
    assert.equal(fenced.rejection.local_status, 'fenced')
    assert.equal(fenced.rejection.reason, 'stale_grant_digest')
    assert.equal(fenced.rejection.acknowledgement.outcome, 'quarantined')
    assert.equal(fenced.rejection.acknowledgement.status, 409)
    assert.equal(Object.keys(baselineRejections).length, 1)
    const repeated = await reopened.pollAndRun()
    assert.equal(repeated.status, 'fenced')
    assert.equal(repeated.rejection.acknowledgement.outcome, 'quarantined')
    assert.equal(coordinator.acks.length, akBeforeQuarantine, 'First quarantine prevents any repeated doomed acknowledgement')

    const backward = { ...firstAssignment, lease_epoch: 0 }
    rejectAck = false
    pose(backward)
    const staleEpoch = await reopened.pollAndRun()
    assert.equal(staleEpoch.status, 'fenced')
    assert.equal(executorCalls, 1)
    assert.deepEqual(durable(reopened.state.data.assignments[firstAssignment.id]), originalAssignment)
    assert.deepEqual(durable(reopened.state.data.completions[firstAssignment.id]), originalCompletion)
    assert.equal(staleEpoch.rejection.acknowledgement.outcome, 'accepted', 'A distinct stale-epoch fingerprint may have a receipt, but is not a new execution authority')
    assert.equal(coordinator.acks.length, akBeforeQuarantine + 1, 'Only the distinct acknowledged fingerprint can add one controller receipt')

    pose(changed)
    rejectAck = true
    const recovered = await run()
    const repeatedStale = await recovered.pollAndRun()
    assert.equal(repeatedStale.status, 'fenced')
    assert.equal(repeatedStale.rejection.acknowledgement.outcome, 'quarantined')
    assert.equal(coordinator.acks.length, akBeforeQuarantine + 1, 'A real reopen retains the distinct epoch receipt but cannot repeat the quarantined digest acknowledgement')
    assert.ok(Object.hasOwn(recovered.state.data.rejections, fingerprint))
    assert.equal(executorCalls, 1)
    assert.deepEqual(durable(recovered.state.data.assignments[firstAssignment.id]), originalAssignment)
    assert.deepEqual(durable(recovered.state.data.completions[firstAssignment.id]), originalCompletion)
    assert.equal(Object.keys(recovered.state.data.rejections).length, 2)
    const disk = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
    assert.deepEqual(disk.assignments[firstAssignment.id], originalAssignment)
    assert.deepEqual(disk.completions[firstAssignment.id], originalCompletion)

    pose(firstAssignment)
    rejectAck = false
    const validAgain = await run()
    const validReplay = await validAgain.pollAndRun()
    assert.equal(validReplay.status, 'succeeded')
    assert.deepEqual(durable(validAgain.state.data.completions[firstAssignment.id]), originalCompletion, 'The original completion can be replayed without an unauthorized overwritten history')
    assert.equal(executorCalls, 1, 'A stale variant cannot blacklist the original valid evidence fingerprint')
    assert.deepEqual(durable(validAgain.state.data.assignments[firstAssignment.id]), originalAssignment)
    assert.deepEqual(durable(validAgain.state.data.completions[firstAssignment.id]), originalCompletion)
    for (const item of validAgain.state.outbox) {
      assert.equal(item.body.ticket_id, firstAssignment.ticket_id)
      assert.equal(item.body.assignment_id, firstAssignment.id)
      assert.equal(item.body.lease_epoch, firstAssignment.lease_epoch)
    }
    await validAgain.client.dispatchOutbox()
    // Explicit legacy-missing provenance fixture: preserve bytes/history without treating a
    // missing task input digest as a replayable completion or rerunning its operation.
    await validAgain.state.mutate((data) => {
      data.completions[firstAssignment.id].state = 'unknown'
      data.completions[firstAssignment.id].summary = 'Legacy record intentionally lacks its logical input digest'
      delete data.completions[firstAssignment.id].digest
    })
    const legacyRecord = durable(validAgain.state.data.completions[firstAssignment.id])
    pose(firstAssignment)
    const legacyRunner = await run()
    const legacy = await legacyRunner.pollAndRun()
    assert.equal(legacy.status, 'fenced')
    assert.match(legacy.rejection.reason, /input digest/)
    assert.equal(executorCalls, 1, 'A legacy completion lacking input identity must not provide a shortcut to another execution')
    assert.deepEqual(durable(legacyRunner.state.data.completions[firstAssignment.id]), legacyRecord)
    assert.equal(legacyRunner.state.outbox.length, 0, 'Non-verifiable completion cannot manufacture a new failed report')
    assert.equal(coordinator.artifacts.size, 1)
    return { scenario: name, status: 'PASS', executor_calls: executorCalls,
      legacy_completion_fenced_without_input_digest: true,
      actual_artifacts: coordinator.artifacts.size,
      changed_digest_fenced: true,
      stale_epoch_fenced: true,
      valid_fingerprint_reusable: true,
      no_unauthorized_record_overwrite: true,
      one_quarantine_ack_effect: true,
      synthetic_local_coordinator: true,
    }
  } finally { await coordinator.close() }
}

const results = []
for (const [name, Runner] of [['typescript', TypeScriptRunner], ['vendored', PluginRunner]]) {
  results.push(await prove(name, Runner))
}
console.log(JSON.stringify({ overall: 'PASS', schema: 1, results,
  not_claimed: ['real distributed Grant replacement order', 'general DSH coordinator admission', 'remote/tls validation', 'exact-once'], root_cleanup: 'Foreground fixtures closed; no user profile writes' }, null, 2))
