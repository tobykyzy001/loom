import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoordinatorLoop } from '../lib/coordinator.js'

const REVOKED_AT = '2026-11-18T10:00:00.000Z'
const PUBLIC_ROOT = '/controlled-fixtures/source-project'

function originalAssignment(overrides = {}) {
  return {
    id: 'asg-file-revoke', ticket_id: 'tkt-file-revoke', node_id: 'node-file-revoke',
    installation_id: 'install-file-revoke', worker_id: 'default', project_id: 'fixture-project',
    lease_id: 'lease-file-revoke', lease_epoch: 3, grant_digest: 'f'.repeat(64),
    attempt: 1, kind: 'edit_file', relative_path: 'src/fixture.js',
    content: 'export const healthy = true\n', objective: 'Controlled file editing fixture',
    grant_version: 1, grant_id: 'grant-file-revoke', cancel_requested: false, grant_revoked_at: null,
    grant: { id: 'grant-file-revoke', version: 1, revoked_at: null,
      project_root: PUBLIC_ROOT, operations: ['write'] },
    ...overrides,
  }
}
function revokedAssignment(overrides = {}) {
  const prior = originalAssignment()
  const { grant: revokedGrant = {}, ...frame } = overrides
  return {
    ...prior,
    purpose: 'reconcile',
    status: 'reconciling',
    grant_status: false,
    grant_version: 1,
    grant_revoked_at: REVOKED_AT,
    ...frame,
    grant: { ...prior.grant, version: 2, revoked_at: REVOKED_AT, ...revokedGrant },
  }
}
async function waitFor(predicate) {
  for (let remaining = 100; remaining > 0 && !predicate(); remaining--) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(predicate(), `controlled fixture reached its expected running state: ${JSON.stringify(predicate.diagnostics?.() || {})}`)
}

async function fixture({ nativeStop = true, acknowledgment = { ticketId: 'previous', assignmentId: 'other', accepted: true } } = {}) {
  const original = originalAssignment()
  const durable = structuredClone(original)
  const executing = structuredClone(original)
  const gate = Promise.withResolvers()
  const calls = { execute: [], reports: [], cancels: [], acks: [], outbox: 0, rejects: [] }
  const rawArtifact = Buffer.from('the original SDK artifact bytes, not a revocation transformation\n')
  const originalReport = { state: 'unknown', summary: 'Observed original user stop; real local effect retained.',
    effects: [{ effect_id: 'actual-sdk-effect', status: 'confirmed' }],
    artifacts: [{ artifact_id: 'actual-sdk-artifact', bytes: rawArtifact }] }
  const state = { data: { assignments: { [original.id]: durable }, completions: {} },
    async mutate(callback) { const value = callback(this.data); return value },
    async flush() {} }
  const executor = {
    runner: { activeAssignments: new Map(), state,
      rejectAssignment: async (assignment, reason) => { calls.rejects.push({ id: assignment.id, tickets: assignment.ticket_id, reason });
        await state.mutate(data => { data.rejections ||= []; data.rejections.push(reason) }) } },
    active: new Map([[original.id, { assignment: executing, executing: true }]]),
    executeAssignment: async assignment => { calls.execute.push(assignment); return gate.promise },
    cancel: async id => {
      calls.cancels.push(id)
      // public DSH Agent API remains an ordinary user stop, never a new native revoked reason.
      calls.agentCancel = { kind: 'user' }
      calls.revocationAtStop = structuredClone(state.data.assignments[id]?.revocation)
      return nativeStop
    },
    report: async (assignment, result) => {
      calls.reports.push({ assignment, result })
      // No transforms or copies stand in for the actual original producer bytes/effects.
      calls.outboxArtifact = result.artifacts[0]
      return { actualOriginalReport: result }
    },
  }
  const client = { acknowledge: async body => { calls.acks.push(body); return acknowledgment },
    dispatchOutbox: async () => { calls.outbox++; return [{ status: 'delivered', artifact_bytes: rawArtifact }] } }
  const loop = new CoordinatorLoop({ max_active_workers: 1, heartbeat_ms: 1, poll_seconds: 0 }, executor, client)
  return { original, durable, executing, gate, calls, originalReport, rawArtifact, state, executor, client, loop }
}

test('a matching revoked edit_file view stops the attached original once and dispatches its actual Report', async () => {
  const f = await fixture()
  const first = f.loop.startAssignment(f.original)
  await waitFor(Object.assign(() => f.calls.execute.length === 1, { diagnostics: () => ({ error: f.loop.lastError, calls: f.calls, state: f.state.data, worker: f.loop.workerCount }) }))
  const stop = f.loop.startAssignment(revokedAssignment())
  assert.ok(stop, 'the separate revocation task is observable')
  await waitFor(() => f.calls.cancels.length === 1)
  assert.deepEqual(f.calls.cancels, [f.original.id])
  assert.deepEqual(f.calls.agentCancel, { kind: 'user' })
  assert.ok(f.calls.revocationAtStop, 'non-authority metadata is durable before native cancellation')
  assert.equal(f.calls.reports.length, 0, 'stop intent never fabricates an original completion')
  assert.equal(f.calls.outbox, 0, 'nothing dispatches before the original producer settles')
  assert.equal(f.calls.acks.length, 0, 'a revocation is not a Center cancellation acknowledgement')
  const annotated = f.state.data.assignments[f.original.id]
  assert.equal(annotated.cancel_requested, false, 'the incoming reconcile frame never sets Center cancel_requested')
  assert.equal(annotated.grant_version, 1)
  assert.equal(annotated.grant.version, 1)
  assert.equal(annotated.grant.revoked_at, null, 'the executing authorization is not normalized to a revoked Grant')
  assert.deepEqual(annotated.revocation, { schema: 'loom.local-revocation-view.v1', authority: false,
    grant_id: 'grant-file-revoke', version: 2, revoked_at: REVOKED_AT, grant_status: false })
  // Deliver an identical frame during stop: no second native stop, Report or execute.
  const duplicate = f.loop.startAssignment(revokedAssignment())
  assert.equal(duplicate, undefined)
  f.gate.resolve(f.originalReport)
  await first
  await stop
  assert.deepEqual(f.calls.execute.map(value => value.id), [f.original.id])
  assert.equal(f.calls.reports.length, 1, 'the original operation is the unique Report producer')
  assert.strictEqual(f.calls.reports[0].assignment, f.original)
  assert.strictEqual(f.calls.reports[0].result, f.originalReport)
  assert.strictEqual(f.calls.outboxArtifact.bytes, f.rawArtifact)
  assert.equal(f.calls.outboxArtifact.bytes.toString(), f.rawArtifact.toString())
  assert.equal(f.calls.outboxArtifact.status, undefined)
  assert.equal(f.calls.reports[0].result.effects[0].status, 'confirmed')
  assert.equal(f.calls.outbox, 1)
  assert.equal(f.calls.acks.some(body => body.cancelRequested === true || body.cancel_requested === true), false)
  assert.equal(f.calls.acks.some(body => body.accepted === true && body.assignmentId === f.original.id), false)
  assert.equal(f.state.data.assignments[f.original.id].cancel_requested, false)
  assert.equal(f.state.data.assignments[f.original.id].revocation.authority, false)
  assert.equal(f.loop.startAssignment(revokedAssignment()), undefined,
    'even a replay with a retained executing placeholder cannot issue a second stop after completion')
  assert.equal(f.calls.cancels.length, 1)
  // Terminal history cannot be used to create a new Agent after stopping/restart.
  f.executor.active.clear()
  const missingLive = f.loop.startAssignment(revokedAssignment())
  await missingLive
  assert.equal(f.calls.cancels.length, 1)
  assert.equal(f.calls.execute.length, 1)
  assert.equal(f.calls.reports.length, 1)
  assert.equal(f.calls.outbox, 1)
  assert.equal(f.calls.rejects.length, 0, 'the successful stop is not relabelled as an unattached execution')
})

test('a missing outer active flag can use only the exact live adapter claim, not durable history', async () => {
  const f = await fixture()
  f.loop.startAssignment(f.original)
  await waitFor(() => f.calls.execute.length === 1)
  f.executor.active.get(f.original.id).executing = false
  f.executor.adapter = {
    sequence: new Map([[f.original.id, {
      request_started: true,
      agent: { status: 'running', session: { id: 'attached-original-session' } },
    }]]),
    waiters: new Set([f.original.id]),
    sessionOwners: new Map([['attached-original-session', f.original.id]]),
  }
  const stop = f.loop.startAssignment(revokedAssignment())
  await waitFor(() => f.calls.cancels.length === 1)
  f.gate.resolve(f.originalReport)
  await stop
  assert.equal(f.calls.reports.length, 1)
  assert.equal(f.calls.outbox, 1)
  assert.equal(f.state.data.assignments[f.original.id].revocation.authority, false)
})

test('duplicate reconciles never wait on themselves; runner alternatives retain executing evidence', async () => {
  const f = await fixture({ nativeStop: false })
  const first = f.loop.startAssignment(f.original)
  await waitFor(() => f.calls.execute.length === 1)
  f.executor.runner.activeAssignments.set(f.original.id, f.executing)
  const duplicate = f.loop.startAssignment(revokedAssignment())
  await waitFor(() => f.calls.cancels.length === 1)
  assert.ok(f.loop.pending.has(`${f.original.id}:revocation`))
  assert.equal(f.loop.pending.get(f.original.id), first)
  f.gate.resolve({ state: 'unknown', summary: 'SDK returned no result and no restored outcome is claimed.',
    effects: [{ effect_id: 'actual-unresolved-effect', status: 'unknown' }], artifacts: [] })
  await first
  await duplicate
  assert.equal(f.calls.cancels.length, 1, 'false adapter stop still waits the original, not another cancel attempt')
  assert.equal(f.calls.reports.length, 1)
  assert.equal(f.calls.reports[0].result.state, 'unknown')
  assert.equal(f.calls.outbox, 1)
  assert.equal(f.loop.pending.has(`${f.original.id}:revocation`), false)
})

for (const [name, change, reason] of [
  ['foreign ticket', value => { value.ticket_id = 'another-ticket' }, 'revocation_assignment_mismatch'],
  ['foreign path', value => { value.relative_path = 'src/foreign.js' }, 'revocation_assignment_mismatch'],
  ['foreign content', value => { value.content = 'attacker bytes\n' }, 'revocation_assignment_mismatch'],
  ['foreign epoch', value => { value.lease_epoch++ }, 'revocation_assignment_mismatch'],
  // Inconsistent projected revocation timestamps are exercised separately below.
  ['rewritten original Grant version header', value => { value.grant_version = 2 }, 'revocation_assignment_mismatch'],
  ['foreign node', value => { value.node_id = 'another-node' }, 'revocation_assignment_mismatch'],
  ['foreign digest', value => { value.grant_digest = 'e'.repeat(64) }, 'revocation_assignment_mismatch'],
  ['foreign grant id', value => { value.grant.id = 'another-grant'; value.grant_id = 'another-grant' }, 'revocation_assignment_mismatch'],
  ['foreign root', value => { value.grant.project_root = '/controlled-fixtures/not-this-project' }, 'revocation_assignment_mismatch'],
  ['executing snapshot has other work', (_value, f) => { f.executor.active.get(f.original.id).assignment.content = 'other bytes\n' }, 'revocation_assignment_mismatch'],
]) {
  test(`revocation rejects a ${name} before it reaches the live Session or executor`, async () => {
    const f = await fixture()
    f.loop.startAssignment(f.original)
    await waitFor(() => f.calls.execute.length === 1)
    const revoked = revokedAssignment()
    change(revoked, f)
    await f.loop.startAssignment(revoked)
    assert.equal(f.calls.rejects.at(-1).reason, reason)
    assert.equal(f.calls.cancels.length, 0)
    assert.equal(f.calls.execute.length, 1)
    assert.equal(f.calls.reports.length, 0)
    assert.equal(f.state.data.assignments[f.original.id].revocation, undefined)
    assert.equal(f.state.data.assignments[f.original.id].cancel_requested, false)
    f.gate.resolve(f.originalReport)
    await f.loop.pending.get(f.original.id)
  })
}

test('inconsistent projected revocation timestamps never signal the live Agent', async () => {
  const f = await fixture()
  f.loop.startAssignment(f.original)
  await waitFor(() => f.calls.execute.length === 1)
  const frame = revokedAssignment({ grant_revoked_at: '2026-11-19T00:00:00Z' })
  // Exercise the actual handler; ordinary same-ID presentation dedupe would
  // intentionally not replay an already-received task to prove no side effect.
  await f.loop.handle(frame)
  assert.equal(f.calls.cancels.length, 0)
  assert.equal(f.calls.execute.length, 1)
  assert.equal(f.calls.reports.length, 0)
  assert.equal(f.state.data.assignments[f.original.id].revocation, undefined)
  f.gate.resolve(f.originalReport)
  await f.loop.pending.get(f.original.id)
})

test('preflight residue, runnable IDs and terminal-only history are not revocation attachments', async t => {
  for (const [name, prepare] of [
    ['missing original promise', f => { f.loop.pending.delete(f.original.id) }],
    ['missing durable history', f => { delete f.state.data.assignments[f.original.id] }],
    ['preflight executor placeholder', f => { f.executor.active.get(f.original.id).executing = false }],
  ]) {
    await t.test(name, async () => {
      const f = await fixture()
      if (name !== 'missing original promise') f.loop.startAssignment(f.original)
      await Promise.resolve()
      prepare(f)
      await f.loop.startAssignment(revokedAssignment())
      assert.equal(f.calls.cancels.length, 0)
      assert.equal(f.calls.reports.length, 0)
      assert.equal(f.state.data.assignments[f.original.id]?.revocation, undefined)
      assert.ok(['revoked_execution_not_attached', 'revocation_assignment_mismatch'].includes(f.calls.rejects.at(-1).reason))
      f.gate.resolve(f.originalReport)
      await Promise.allSettled([...f.loop.pending.values()])
      assert.equal(f.calls.execute.length, name === 'missing original promise' ? 0 : 1)
    })
  }
})

test('durable changes or persistence errors cannot stop an unmatched live Agent', async t => {
  for (const [name, prepare] of [
    ['changed worker', f => { f.durable.worker_id = 'a-different-worker' }],
    ['failed annotation persistence', f => { f.state.mutate = async () => false }],
  ]) {
    await t.test(name, async () => {
      const f = await fixture()
      f.loop.startAssignment(f.original)
      await waitFor(() => f.calls.execute.length === 1)
      prepare(f)
      await f.loop.startAssignment(revokedAssignment())
      assert.equal(f.calls.cancels.length, 0)
      assert.equal(f.calls.reports.length, 0)
      f.gate.resolve(f.originalReport)
      await f.loop.pending.get(f.original.id)
    })
  }
})

test('resource-only revoked-looking views cannot broadcast normal cancellation to assignments', async t => {
  const frames = [
    originalAssignment({ grant: { ...originalAssignment().grant, version: 2, revoked_at: REVOKED_AT }, grant_status: false }),
    revokedAssignment({ status: 'queued' }),
    revokedAssignment({ grant: { version: 2, revoked_at: '' } }),
  ]
  for (const [index, frame] of frames.entries()) {
    await t.test(`disabled frame ${index + 1}`, async () => {
      const f = await fixture()
      f.loop.startAssignment(f.original)
      await waitFor(() => f.calls.execute.length === 1)
      // Call the coordinator handler directly: polling de-dup must not hide classifier tests.
      await f.loop.handle(frame)
      assert.equal(f.calls.cancels.length, 0)
      assert.equal(f.calls.reports.length, 0)
      assert.equal(f.state.data.assignments[f.original.id].revocation, undefined)
      f.gate.resolve(f.originalReport)
      await f.loop.pending.get(f.original.id)
    })
  }
})

test('fixed PAUSE optional evidence and ordinary cancel flag remain unchanged by revocation metadata', async () => {
  const objective = 'LOOM_FIXTURE_CODE_TASK LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY keeps deterministic fixture behavior'
  const f = await fixture()
  f.original.objective = objective
  f.durable.objective = objective
  f.executing.objective = objective
  f.loop.startAssignment(f.original)
  await waitFor(() => f.calls.execute.length === 1)
  const stop = f.loop.startAssignment(revokedAssignment({ objective: f.original.objective }))
  await waitFor(() => f.calls.cancels.length === 1)
  assert.equal(f.executor.active.get(f.original.id).assignment.objective.includes('LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY'), true)
  assert.equal(f.calls.execute[0].objective.includes('LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY'), true)
  assert.equal(f.calls.execute[0].cancel_requested, false)
  assert.equal(f.original.cancel_requested, false)
  f.gate.resolve(f.originalReport)
  await Promise.all([f.loop.pending.get(f.original.id), stop])
  assert.equal(f.calls.reports[0].result.state, 'unknown')
})
