import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalNodeRunner } from '../src/runner.js'
import { LoomNodeClient, LoomHttpClient, NodeIdentity, NodeState } from '../src/index.js'

test('an observed cancelled Report keeps boolean acknowledgement through runner', async () => {
  let body
  const runner = new LocalNodeRunner({})
  runner.client = { report: async args => { body = args; return { accepted: true } } }
  await runner.report({ ticket_id: 'tkt-cancel', id: 'asg-cancel', lease_epoch: 1 }, {
    state: 'unknown', summary: 'Source is confirmed, but cancellation prevents the overall result from being called a success.',
    artifacts: [], effects: [], cancel_acknowledged: true,
  })
  assert.equal(body.state, 'unknown')
  assert.equal(body.cancelAcknowledged, true)
  await runner.report({ ticket_id: 'tkt-normal-unknown', id: 'asg-normal-unknown', lease_epoch: 1 }, {
    state: 'unknown', summary: 'Ordinary unknown outcomes do not invent a cancellation acknowledgement.', artifacts: [], effects: [],
  })
  assert.equal(body.cancelAcknowledged, false)
})

test('unknown acknowledgement is serialized and durable, not implicit from stop intent or a model field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loom-node-cancel-ack-'))
  const identity = await NodeIdentity.open(root)
  await identity.setToken({ token: 'fixed-local-test-token' })
  const state = await NodeState.open(root)
  const requests = []
  const http = new LoomHttpClient({ baseUrl: 'http://example.invalid', fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ accepted: true }), { headers: { 'content-type': 'application/json' } })
  } })
  const client = new LoomNodeClient({ http, identity, state })
  const common = { ticketId: 'tkt-cancel-evidence', assignmentId: 'asg-cancel-evidence', leaseEpoch: 1, state: 'unknown', summary: 'actual cancellation has settled' }
  const ordinary = await client.report(common)
  const acknowledged = await client.report({ ...common, cancelAcknowledged: true })
  assert.equal(ordinary.body.cancel_acknowledged, false)
  assert.equal(acknowledged.body.cancel_acknowledged, true)
  assert.notEqual(ordinary.body.request_id, acknowledged.body.request_id)
  const saved = await NodeState.open(root)
  const preserved = saved.outbox.find(item => item.kind === 'report' && item.digest === acknowledged.digest)
  assert.equal(preserved.body.cancel_acknowledged, true)
  await client.dispatchOutbox()
  assert.equal(requests.at(-1).requested_state, 'unknown')
  assert.equal(requests.at(-1).cancel_acknowledged, true)
})
