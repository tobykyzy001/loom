import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LoomNodeClient } from '../src/client.js'
import { LoomHttpClient } from '../src/http.js'
import { NodeIdentity } from '../src/identity.js'
import { NodeState } from '../src/state.js'

const receipt = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'loom-stop-ack-'))
  const identity = await NodeIdentity.open(root)
  await identity.setToken({ token: 'fixture-owned-node-token' })
  const state = await NodeState.open(root)
  const calls = []
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ body, url: String(url), headers: options.headers })
    if (body.reason === 'answer_denied_permission') {
      return receipt({ error: { code: 'grant_scope', message: 'Current permission is denied' } }, 403)
    }
    return receipt({ accepted: true, acknowledged_at: '2026-11-19T00:00:00.000Z' })
  }
  const client = new LoomNodeClient({
    identity,
    state,
    http: new LoomHttpClient({ baseUrl: 'http://fixture.invalid', fetch }),
  })
  return { root, identity, state, client, calls }
}

const flagsFor = flag => ({ [flag]: true })
const ordinary = {
  ticketId: 'tkt-stop-boundary',
  assignmentId: 'asg-stop-boundary',
  leaseEpoch: 3,
  accepted: true,
  reason: 'real stop request boundary',
}

async function exerciseStop(flag) {
  const f = await fixture()
  await f.client.acknowledge(ordinary)
  const previous = structuredClone(f.state.data.deliveries)
  const direct = { ...ordinary, ...flagsFor(flag) }
  const first = await f.client.acknowledge(direct)
  const second = await f.client.acknowledge(direct)
  assert.equal(first.response.accepted, true)
  assert.equal(second.response.accepted, true)
  assert.equal(second.response.duplicate, undefined)
  assert.equal(f.calls.length, 3, 'one ordinary HTTP, followed by two actual direct stop HTTP requests')
  assert.notEqual(f.calls[1].body.request_id, f.calls[2].body.request_id, 'direct stop uses a fresh transport nonce, not an old cached request')
  for (const call of f.calls.slice(1)) {
    assert.equal(call.body.cancel_requested, true)
    assert.equal(call.body.cancellation, true)
    assert.equal(call.headers.authorization, 'Bearer fixture-owned-node-token')
  }
  assert.equal(f.state.outbox.length, 0)
  assert.deepEqual(f.state.data.deliveries, previous, 'ordinary receipt caching remains unchanged and is not coalesced with stop intent')

  const controller = new AbortController()
  controller.abort(new Error('caller already aborted'))
  await assert.rejects(() => f.client.acknowledge({ ...direct, signal: controller.signal }), /caller already aborted/)
  assert.equal(f.calls.length, 3, 'Already-aborted direct stop never reaches fetch')

  await assert.rejects(
    () => f.client.acknowledge({ ...direct, reason: 'answer_denied_permission' }),
    error => error.status === 403 && error.code === 'grant_scope',
  )
  assert.equal(f.calls.length, 4, 'The denied permission reaches the server and rejects as itself, not a faux pending receipt')
  assert.equal(f.state.outbox.length, 0)
  assert.deepEqual(f.state.data.deliveries, previous)
}

test('cancel_requested keeps direct stop transport without cached ordinary duplicates', async () => {
  await exerciseStop('cancelRequested')
})

test('cancellation flag alone keeps the same direct stop transport', async () => {
  await exerciseStop('cancellation')
})

test('legacy raw pending stop remains deliverable without changing direct-stop history into ordinary replay', async () => {
  const f = await fixture()
  const body = {
    ...f.identity.public,
    ticket_id: 'tkt-legacy-stop',
    assignment_id: 'asg-legacy-stop',
    request_id: 'durable-owned-stop-nonce',
    lease_epoch: 1,
    accepted: true,
    reason: 'legacy raw pending stop',
    cancel_requested: true,
    cancellation: true,
  }
  await f.state.enqueue('ack', body, { digest: f.client.logicalDigest(body) })
  const delivery = await f.client.dispatchOutbox()
  assert.equal(delivery[0].status, 'delivered')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].body.request_id, body.request_id)
  assert.equal(f.state.outbox.length, 0)
  const original = structuredClone(f.state.data.deliveries)
  await f.client.acknowledge({ ticketId: 'tkt-legacy-stop', assignmentId: 'asg-legacy-stop', leaseEpoch: 1, accepted: true, reason: body.reason, cancelRequested: true })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.state.data.deliveries, original, 'the legacy delivered stop history is retained but direct stop calls no longer reuse it as ordinary replay')
})
