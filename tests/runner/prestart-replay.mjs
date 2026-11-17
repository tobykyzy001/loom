import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SyntheticCoordinator } from '../../scripts/fixtures/coordinator.mjs'
import { LocalNodeRunner } from '../../plugins/dsh-loom/src/runner.js'
import { LocalFileDispatcher } from '../../plugins/dsh-loom/lib/file-dispatcher.js'
import { CoordinatorLoop } from '../../plugins/dsh-loom/lib/coordinator.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

const root = await mkdtemp(join(tmpdir(), 'loom-prestart-replay-'))
await mkdir(join(root, 'sim'), { mode: 0o700 })
const coordinator = new SyntheticCoordinator({ root: join(root, 'sim') })
await coordinator.listen()
const admin = new LoomHttpClient({ baseUrl: coordinator.baseUrl, clientToken: coordinator.clientToken })
let server, runner, executorCalls = 0
try {
  server = coordinator
  const project = await coordinator.prepareProject('A stop before any this dispatch')
  const registration = { project_roots: { [project.id]: project.root } }
  const options = { stateDir: join(root, 'node-state'), artifactDir: join(root, 'artifacts'), baseUrl: coordinator.baseUrl,
    projectRoots: { [project.id]: project.root }, registration }
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  runner = new LocalNodeRunner(options)
  await runner.start({ enrollmentCode: enrollment.code })
  runner.executor.execute = async () => { executorCalls++; throw new Error('No executor is permitted in pre-start cancellation replay') }
  await coordinator.makeGrant({ project_id: project.id, operations: ['edit_file'] })
  const ticket = await coordinator.makeTicket({ project_id: project.id, objective: 'Stop before this real local task emits effects' })
  const assignment = await coordinator.dispatchTicket(ticket.id, runner.nodeId, {
    kind: 'edit_file', relative_path: 'not-created-during-prestart.txt', content: 'No effect allowed.\n',
  })
  await admin.post(`/api/v1/tickets/${ticket.id}/cancel`, {})
  assignment.cancel_requested = true

  // The simulated controller will really commit the first Report; only the client sees no response.
  let lostResponse = false
  const outgoing = runner.http.post.bind(runner.http)
  runner.http.post = async (route, body, options) => {
    const response = await outgoing(route, body, options)
    if (route.endsWith('/reports') && !lostResponse) {
      lostResponse = true
      throw new Error('Artificial response loss after a genuine report commit')
    }
    return response
  }
  const firstDispatcher = new LocalFileDispatcher(runner)
  const firstLoop = new CoordinatorLoop({ max_active_workers: 1 }, firstDispatcher, runner.client)
  await firstLoop.startAssignment(assignment)
  assert.equal(executorCalls, 0)
  assert.equal(firstDispatcher.active.size, 0)
  assert.equal(runner.state.data.assignments[assignment.id].cancel_requested, true)
  const completion = runner.state.data.completions[assignment.id]
  assert.equal(completion.state, 'cancelled')
  assert.equal(completion.execution_started, false)
  assert.equal(completion.cancel_acknowledged, true)
  assert.equal(runner.state.outbox.filter(item => item.kind === 'artifact').length, 0)
  await assert.rejects(readFile(join(project.root, 'not-created-during-prestart.txt')), error => error.code === 'ENOENT')
  const firstReceipt = coordinator.reports.get(assignment.id)
  assert.ok(firstReceipt?.request_id)
  const snapshot = structuredClone(completion)
  assert.equal(coordinator.acks.at(-1).accepted, true)
  assert.equal(lostResponse, true, 'The first genuine report response must be intercepted after commit')
  assert.ok(coordinator.reports.has(assignment.id), 'The genuine report was already accepted by the fixture controller')
  assert.equal(runner.state.outbox.filter(item => item.kind === 'report').length, 1,
    'The response interruption cannot erase the artifact of an undecided delivery')

  const reopened = new LocalNodeRunner(options)
  await reopened.start({})
  reopened.executor.execute = async () => { executorCalls++; throw new Error('No replay executor may run') }
  const secondDispatcher = new LocalFileDispatcher(reopened)
  const secondLoop = new CoordinatorLoop({ max_active_workers: 1 }, secondDispatcher, reopened.client)
  let replayResponse
  const outboundReplay = reopened.http.post.bind(reopened.http)
  reopened.http.post = async (route, body, options) => {
    const response = await outboundReplay(route, body, options)
    if (route.endsWith('/reports') && body.assignment_id === assignment.id) replayResponse = response
    return response
  }
  const pending = reopened.state.outbox.find(item => item.kind === 'report')
  assert.ok(pending?.next_attempt_at)
  const retryAt = Date.parse(pending.next_attempt_at)
  assert.ok(Number.isFinite(retryAt) && retryAt > 0)
  const remaining = Math.max(0, retryAt - Date.now())
  assert.ok(remaining < 31_000, `Unexpected persistent retry schedule: ${remaining}ms`)
  await new Promise(resolve => setTimeout(resolve, remaining + 15))
  await secondLoop.handle(assignment)
  assert.deepEqual(reopened.state.data.completions[assignment.id], snapshot,
    'Reopen must preserve the exact cancellation and matching proof without starting work')
  const replayReceipt = coordinator.reports.get(assignment.id)
  assert.equal(replayReceipt.request_id, firstReceipt.request_id)
  if (!replayResponse) throw new Error(`Replay delivery did not happen: ${JSON.stringify({ lastError: secondLoop.lastError, pending: reopened.state.outbox.map(item => ({ kind: item.kind, digest: item.digest })), completion: reopened.state.data.completions[assignment.id] })}`)
  assert.equal(replayResponse.duplicate, true, 'Replay after a real HTTP success whose response was hidden must use the original receipt')
  assert.equal(coordinator.reports.size, 1)
  assert.equal(executorCalls, 0)
  assert.equal(secondDispatcher.active.size, 0)
  await assert.rejects(readFile(join(project.root, 'not-created-during-prestart.txt')), error => error.code === 'ENOENT')
  console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.prestart-replay.v1', actual_coordinator: 'owned SyntheticCoordinator over real HTTP/http persistence, not DSH',
    durable_cancel_completion: true, genuine_report_committed_before_loss: true, exact_duplicate_receipt: true,
    no_executor_or_file_effect: true, snapshot_preserved_reopen: true,
    not_claimed: ['all DSH pending Promise cancellations', 'rollback of an actual file effect', 'TLS/multi-host cancellation'], background_jobs: 0 }, null, 2))
} finally { await server?.close() }
