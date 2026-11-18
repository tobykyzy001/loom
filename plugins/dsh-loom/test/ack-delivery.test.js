import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LoomHttpClient } from '../src/http.js'
import { LoomNodeClient } from '../src/client.js'
import { NodeIdentity } from '../src/identity.js'
import { NodeState } from '../src/state.js'

const firstTime = '2026-11-19T00:00:00.000Z'
const json = (value = { accepted: true, acknowledged_at: firstTime }, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const scope = { ticketId: 'tkt-plugin-ack', assignmentId: 'asg-plugin-ack', leaseEpoch: 2, accepted: true }

async function waitFor(predicate, description, limit = 500) {
  for (let step = 0; step < Math.ceil(limit / 5); step++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function fixture({ fetch, now = () => Date.now() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'loom-dsh-ack-'))
  const identity = await NodeIdentity.open(root)
  await identity.setToken({ token: 'fixture-owned-node-token' })
  const state = await NodeState.open(root)
  const http = new LoomHttpClient({ baseUrl: 'http://fixture.invalid', fetch })
  return { root, identity, state, client: new LoomNodeClient({ http, identity, state }), now }
}

function result(state, effects = [{ effect_id: `fixture-effect-${scope.assignmentId}`, status: 'confirmed', input_digest: 'digest', artifacts: [] }]) {
  return { state: 'succeeded', summary: 'Known local operation, not a central report', artifacts: [{ artifact_id: 'artifact-owned-by-assignment', metadata: { name: 'summary.json' }, bytes: Buffer.from('{"lines":2}') }], effects }
}

test('DSH ACK is durable before transport, reconstructs only intact first receipts and separates epochs', async () => {
  const calls = []
  const f = await fixture({ fetch: async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) })
    return json()
  } })
  const receipt = await f.client.acknowledge(scope)
  assert.equal(f.state.outbox.length, 0)
  assert.equal(receipt.response.acknowledged_at, firstTime)
  assert.equal(calls[0].headers.authorization, 'Bearer fixture-owned-node-token')
  assert.equal(calls[0].url, 'http://fixture.invalid/api/v1/nodes/acknowledge')
  const duplicate = await f.client.acknowledge(scope)
  assert.equal(calls.length, 1)
  assert.equal(duplicate.response.duplicate, true)
  assert.equal(duplicate.response.acknowledged_at, firstTime)
  assert.equal(f.state.data.deliveries[0].response.duplicate, undefined, 'Do not invent a raw stored duplicate marker')
  await f.client.acknowledge({ ...scope, leaseEpoch: 3 })
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].body.request_id, calls[1].body.request_id)
})

test('Lost ACK response retains local artifacts/report and after reopen restores ACK first without a second execution', async () => {
  let online = false
  const calls = []
  const f = await fixture({ fetch: async (url, options) => {
    const route = new URL(url).pathname
    calls.push({ route, body: JSON.parse(options.body) })
    if (route.endsWith('/nodes/acknowledge') && !online) throw new Error('ACK response lost after real server work')
    return json()
  } })
  let executions = 0
  const grant = { id: 'grant-owned-by-this-assignment', version: 1, grant_digest: 'owned-grant-digest', digest: 'owned-grant-digest', operations: ['read'], project_id: 'owned-project', project_root: f.root, worker_id: 'default', node_id: f.identity.nodeId }
  const assignment = { ...f.identity.public, id: scope.assignmentId, ticket_id: scope.ticketId, lease_epoch: scope.leaseEpoch,
    lease_id: 'lease-owned-for-test', attempt: scope.leaseEpoch, lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    grant, grant_version: 1, grant_digest: grant.grant_digest, worker_id: 'default', project_id: grant.project_id,
    kind: 'read_summary', relative_path: 'readme.txt', objective: 'A local fixture reads bounded known bytes' }
  const runner = new (await import('../src/runner.js')).LocalNodeRunner({})
  runner.identity = f.identity
  runner.state = f.state
  runner.http = f.client.http
  runner.client = f.client
  runner.client.poll = async () => assignment
  runner.executor = { execute: async () => { executions++; return result(f.state) } }
  const execute = await runner.pollAndRun()
  assert.equal(executions, 1)
  assert.equal(execute.status, 'succeeded')
  assert.equal(execute.acknowledgement_pending, true)
  assert.deepEqual(f.state.outbox.map(item => item.kind), ['ack', 'artifact', 'report'])
  const requestId = f.state.outbox[0].body.request_id
  const persisted = await NodeState.open(f.root)
  const restored = new LoomNodeClient({ identity: f.identity, state: persisted, http: f.client.http })
  for (const item of persisted.outbox) item.next_attempt_at = new Date(0).toISOString()
  online = true
  const delivered = await restored.dispatchOutbox()
  assert.deepEqual(delivered.map(item => item.kind), ['ack', 'artifact', 'report'])
  assert.equal(calls.filter(item => item.route.endsWith('/nodes/acknowledge')).length, 2)
  assert.equal(calls[0].body.request_id, calls[1].body.request_id)
  assert.equal(requestId, calls[1].body.request_id)
  assert.equal(executions, 1)
})

test('Malformed 200/cache evidence resets to HTTP rather than duplicates accepted fragments', async () => {
  let calls = 0
  const f = await fixture({ fetch: async () => { calls++; return json() } })
  await f.client.acknowledge(scope)
  await f.state.mutate(data => { data.deliveries[0].response.acknowledged_at = 'not-a-timestamp' })
  const reopened = await NodeState.open(f.root)
  const client = new LoomNodeClient({ identity: f.identity, state: reopened, http: f.client.http })
  const receipt = await client.acknowledge(scope)
  assert.equal(receipt.response.acknowledged_at, firstTime)
  assert.equal(calls, 2)
  assert.equal(f.state.outbox.length, 0)
})

test('A delivered body missing request identity is rebuilt with authenticated HTTP, not cloned into a fake receipt', async () => {
  let calls = 0
  const f = await fixture({ fetch: async () => { calls++; return json() } })
  await f.client.acknowledge(scope)
  await f.state.mutate(data => { delete data.deliveries[0].body.request_id })
  const opened = await NodeState.open(f.root)
  assert.equal(opened.data.deliveries[0].body.request_id, undefined, 'The corrupt cache identity must be persisted before this test')
  const missingIdentity = new LoomNodeClient({ identity: f.identity, state: opened, http: f.client.http })
  const repaired = await missingIdentity.acknowledge(scope)
  assert.equal(calls, 2)
  assert.ok(repaired.request.request_id)
  assert.equal(repaired.response.acknowledged_at, firstTime)
  assert.equal(opened.outbox.length, 0)
})

test('An invalid cached duplicate type cannot supersede the actual HTTP response', async () => {
  let calls = 0
  const f = await fixture({ fetch: async () => { calls++; return json() } })
  await f.client.acknowledge(scope)
  await f.state.mutate(data => { data.deliveries[0].response.duplicate = 'not-a-bool' })
  const opened = await NodeState.open(f.root)
  assert.equal(opened.data.deliveries[0].response.duplicate, 'not-a-bool')
  const client = new LoomNodeClient({ identity: f.identity, state: opened, http: f.client.http })
  await client.acknowledge(scope)
  assert.equal(calls, 2)
  assert.equal(client.state.data.deliveries[0].response.duplicate, undefined, 'The real HTTP response, not fabricated stored history, is retained')
  assert.equal(opened.outbox.length, 0)
})

test('Missing timestamp cannot clear pending or release dependent Report; immediate and outbox concurrent intents share HTTP', async () => {
  let online = false
  let secondStarted = false
  let finishSecond
  const secondGate = new Promise(resolve => { finishSecond = resolve })
  const calls = []
  const f = await fixture({ fetch: async (url) => {
    const route = new URL(url).pathname
    if (!route.endsWith('/acknowledge')) throw new Error(`Dependent ${route} reached ahead of the pending ACK`)
    calls.push(route)
    if (!online) throw new Error('Network result unavailable to the sender')
    secondStarted = true
    await secondGate
    return json()
    return json()
  } })
  const invalid = await f.client.acknowledge(scope)
  assert.equal(invalid.response, null)
  assert.equal(invalid.acknowledgement_pending, true)
  await f.client.report({ ...scope, state: 'succeeded', summary: 'Actual prior local outcome, queued separately from receipt delivery',
    artifactIds: ['artifact-owned-by-assignment'], effects: [] })
  online = true
  const concurrent = f.client.acknowledge(scope)
  const outbound = f.client.dispatchOutbox()
  await waitFor(() => secondStarted, 'both immediate and queued ACK to share their in-flight HTTP')
  finishSecond()
  const receipts = await Promise.all([concurrent, outbound])
  assert.equal(calls.length, 2, 'The second shared in-flight recovery is only one HTTP beyond the initial invalid receipt')
  assert.equal(f.state.outbox.some(item => item.kind === 'ack' && item.body.assignment_id === scope.assignmentId), false)
  assert.equal(f.state.outbox.some(item => item.kind === 'report' && item.body.ticket_id === scope.ticketId), true)
  assert.equal(receipts[0].response.acknowledged_at, firstTime)
})

test('Old stop frame remains direct and a denied ordinary ACK preserves quarantine and pending intent', async () => {
  const calls = []
  const f = await fixture({ fetch: async (url, options) => {
    calls.push(JSON.parse(options.body))
    if (calls.length <= 2) return json({ error: { code: 'lease_mismatch', message: 'No valid lease' } }, 403)
    return json({ accepted: true, acknowledged_at: firstTime, message: 'Stop request receipt' })
  } })
  await assert.rejects(() => f.client.acknowledge(scope), error => error.code === 'lease_mismatch' && error.status === 403)
  assert.equal(f.state.outbox.length, 1)
  const runner = new (await import('../src/runner.js')).LocalNodeRunner({})
  runner.client = f.client
  runner.state = f.state
  const rejected = await runner.rejectAssignment({ id: scope.assignmentId, ticket_id: scope.ticketId, lease_epoch: scope.leaseEpoch, grant_digest: 'owned-grant' }, 'Should quarantine without becoming a receipt')
  assert.equal(rejected.rejection.acknowledgement.outcome, 'quarantined')
  await f.client.acknowledge({ ...scope, cancelRequested: true })
  assert.equal(f.state.outbox.filter(item => item.body.cancel_requested).length, 0, 'The existing stop request is not queued as ordinary ACK')
  assert.equal(calls.at(-1).cancel_requested, true)
})

test('ACK backlog gates only its same work; legacy optional deliveries survive and a corrupt ledger fails closed', async () => {
  const routes = []
  const deliveredReportAssignments = []
  const f = await fixture({ fetch: async (url, options) => {
    const route = new URL(url).pathname
    if (route.endsWith('/acknowledge')) throw new Error('Deferred ACK')
    routes.push(route)
    if (route.endsWith('/reports')) deliveredReportAssignments.push(JSON.parse(options.body).assignment_id)
    return json()
  } })
  await f.client.report({ ...scope, state: 'unknown', summary: 'local result unknown', effects: [] })
  const pending = await f.client.acknowledge(scope)
  assert.equal(pending.acknowledgement_pending, true)
  await f.client.event({ ticketId: 'tkt-other-event', assignmentId: 'asg-other-event', leaseEpoch: 1, summary: 'independent ordinary progress' })
  const other = { ...scope, ticketId: 'tkt-other-work', assignmentId: 'asg-other-ok', leaseEpoch: 3 }
  await f.client.report({ ...other, state: 'unknown', summary: 'A different admitted work with no pending ACK',
    effects: [{ effect_id: 'effect-other', status: 'unknown', input_digest: 'other-work', artifacts: [] }] })
  await f.client.dispatchOutbox()
  assert.equal(routes.filter(route => route.endsWith('/events')).length, 1)
  assert.equal(routes.includes('/api/v1/nodes/events'), true)
  assert.equal(routes.filter(route => route.endsWith('/reports')).length, 1)
  assert.equal(f.state.outbox.some(item => item.kind === 'ack' && item.body.assignment_id === scope.assignmentId), true)
  assert.equal(f.state.outbox.some(item => item.kind === 'report' && item.body.assignment_id === scope.assignmentId), true, 'The blocked dependent Report is not silently lost or marked delivered')
  assert.deepEqual(deliveredReportAssignments, ['asg-other-ok'], 'Only the genuinely independent Report is delivered')
  await f.state.mutate(data => { delete data.deliveries })
  const legacy = await NodeState.open(f.root)
  assert.equal(legacy.data.deliveries, undefined)
  await f.state.mutate(data => { data.deliveries = {} })
  await assert.rejects(() => NodeState.open(f.root), /Invalid local delivery ledger/)
})

test('Two newly opened plugin NodeState roots never share mutable default containers', async () => {
  const leftRoot = await mkdtemp(join(tmpdir(), 'loom-dsh-isolated-left-'))
  const rightRoot = await mkdtemp(join(tmpdir(), 'loom-dsh-isolated-right-'))
  const [left, right] = await Promise.all([NodeState.open(leftRoot), NodeState.open(rightRoot)])
  assert.notEqual(left.data.outbox, right.data.outbox)
  assert.notEqual(left.data.assignments, right.data.assignments)
  assert.notEqual(left.data.completions, right.data.completions)
  await left.enqueue('ack', { ticket_id: 'tkt-isolated-left', assignment_id: 'asg-isolated-left', lease_epoch: 1 }, { digest: 'isolated-intent' })
  await left.mutate(data => {
    data.assignments['asg-isolated-left'] = { id: 'asg-isolated-left' }
    data.completions['asg-isolated-left'] = { state: 'unknown' }
  })
  assert.equal(right.outbox.length, 0)
  assert.deepEqual(right.data.assignments, {})
  assert.deepEqual(right.data.completions, {})
  const [persistedLeft, persistedRight] = await Promise.all([NodeState.open(leftRoot), NodeState.open(rightRoot)])
  assert.equal(persistedLeft.outbox.length, 1)
  assert.equal(persistedRight.outbox.length, 0)
  assert.deepEqual(persistedRight.data.assignments, {})
  assert.deepEqual(persistedRight.data.completions, {})
})
