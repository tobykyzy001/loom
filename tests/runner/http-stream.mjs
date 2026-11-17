import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LoomHttpClient as SharedHttp } from '../../packages/node-client/src/http.js'
import { LoomHttpClient as VendoredHttp } from '../../plugins/dsh-loom/src/http.js'
import { LoomNodeClient } from '../../packages/node-client/src/client.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { NodeState } from '../../packages/node-client/src/state.js'
import { LoomNodeClient as VendoredNodeClient, NodeIdentity as VendoredNodeIdentity, NodeState as VendoredNodeState } from '../../plugins/dsh-loom/src/index.js'

const encoder = new TextEncoder()
function streamResponse(parts, { observer = { pulls: 0, cancels: [] }, status = 200, headers = { 'content-type': 'application/json' } } = {}) {
  return new Response(new ReadableStream({
    pull(controller) {
      observer.pulls++
      const part = parts.shift()
      if (part === undefined) controller.close()
      else controller.enqueue(part)
    },
    cancel(reason) {
      observer.cancels.push(reason)
      if (observer.cancelError) throw observer.cancelError
    },
  }), { status, headers })
}
const request = (Client, fetch, maxResponseBytes = 1_048_576, timeoutMs = 1000, signal) =>
  new Client({ baseUrl: 'http://fixture.invalid', fetch, maxResponseBytes, timeoutMs })
  .post('/api/v1/nodes/challenge', { protocol: 'loom.node.v1' }, { noAuth: true, ...(signal ? { signal } : {}) })
const rejects = (promise, expected) => assert.rejects(promise, typeof expected === 'string' ? (error) => error.message.includes(expected) : expected)

async function prove(label, HttpClient, NodeClient, Identity, State) {
  const evidence = { implementation: label }
  const body = JSON.stringify({ schema: 'loom.http-stream.v1', text: '単体🎻边界_測試', value: 7 })
  const bytes = encoder.encode(body)
  const ordinary = { pulls: 0, cancels: [] }
  const ordinaryFetch = async (_url, init) => {
    assert.equal(init.headers.authorization, undefined)
    const response = streamResponse(Array.from(bytes, byte => Uint8Array.of(byte)), { observer: ordinary,
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } })
    assert.equal(typeof response.body?.getReader, 'function', 'Must exercise the native streaming path')
    return response
  }
  assert.deepEqual(await request(HttpClient, ordinaryFetch, bytes.length), JSON.parse(body))
  assert.equal(ordinary.cancels.length, 0, 'Successful bounded reads do not cancel their reader')
  evidence.exact_limit_and_split_utf8 = true

  const prefix = encoder.encode('{"sequence":[')
  const suffix = encoder.encode('1,2,3]}')
  const fragments = [prefix, ...Array.from('abcdefghij'.repeat(12), c => encoder.encode(c)), suffix]
  const oversized = { pulls: 0, cancels: [] }
  const overflowFetch = async () => streamResponse(fragments.map(part => part.slice()), { observer: oversized })
  await rejects(request(HttpClient, overflowFetch, prefix.length + 12), error => {
    assert.equal(error.message, 'Loom HTTP response exceeds configured limit')
    assert.equal(error.message.includes('abcdefghij'), false, 'Size errors must not reflect payload contents')
    return true
  })
  assert.equal(oversized.cancels.length, 1)
  assert.equal(oversized.cancels[0].message, 'Loom HTTP response exceeds configured limit')
  assert.ok(oversized.pulls < fragments.length, `Must stop before draining every fragment: ${oversized.pulls}/${fragments.length}`)
  evidence.stops_before_drain = oversized.pulls

  const overDeclared = { pulls: 0, cancels: [] }
  const declared = await request(HttpClient, async () => streamResponse([encoder.encode('{"accepted":true}')], {
    observer: overDeclared, headers: { 'content-type': 'application/json', 'content-length': '9999999' },
  }), 64)
  assert.deepEqual(declared, { accepted: true })
  const underDeclared = { pulls: 0, cancels: [] }
  await rejects(request(HttpClient, async () => streamResponse(Array.from(bytes, byte => Uint8Array.of(byte)), {
    observer: underDeclared, headers: { 'content-type': 'application/json', 'content-length': '1' },
  }), 16), 'exceeds configured limit')
  assert.equal(underDeclared.cancels.length, 1)
  evidence.afactual_not_declared_size = true

  const setup = () => {
    const watcher = { reads: 0, cancels: 0, onAbort: null }
    const reader = {
      read() {
        watcher.reads++
        return new Promise((_resolve, reject) => { watcher.reject = reject })
      },
      cancel: () => { watcher.cancels++; return Promise.resolve() },
      releaseLock() {},
    }
    const fetch = async (_url, init) => {
      watcher.onAbort = () => watcher.reject(init.signal.reason)
      init.signal.addEventListener('abort', watcher.onAbort, { once: true })
      return { ok: true, status: 200, body: { getReader: () => reader } }
    }
    return { watcher, fetch }
  }
  const reason = new Error('Caller deliberately stopped this HTTP read')
  const cancelled = new AbortController()
  const halt = setup()
  const pending = request(HttpClient, halt.fetch, 1_000, 5000, cancelled.signal)
  while (!halt.watcher.reads) await new Promise(resolve => setImmediate(resolve))
  cancelled.abort(reason)
  await rejects(pending, error => error === reason)
  assert.equal(halt.watcher.reads, 1)
  assert.equal(halt.watcher.cancels, 1)
  evidence.cancel_wakes_stalled_read_and_preserves_reason = true

  const timeout = setup()
  await rejects(request(HttpClient, timeout.fetch, 1_000, 15), 'timed out')
  assert.equal(timeout.watcher.cancels, 1)
  assert.ok(timeout.watcher.reads >= 1)
  evidence.timeout_wakes_stalled_read = true

  const emptyFrames = { pulls: 0, cancels: [] }
  await rejects(request(HttpClient, async () => streamResponse(
    Array.from({ length: 1_000_000 }, () => new Uint8Array()), { observer: emptyFrames }), 64, 15),
  'timed out')
  assert.ok(emptyFrames.pulls > 1, 'Exercise repeated empty frames before expiry')
  assert.ok(emptyFrames.pulls < 1_000_000, 'Zero-length chunks cannot starve the total request timeout')
  evidence.empty_chunks_yield_to_total_timeout = true

  const readError = new Error('Original reader failure')
  const cleanupError = new Error('Cleanup failure must not mask primary')
  let cleanupCalls = 0
  await rejects(request(HttpClient, async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({
      read: async () => { throw readError },
      cancel: () => { cleanupCalls++; throw cleanupError },
      releaseLock() {},
    }) },
  }), 1024), error => error === readError)
  assert.equal(cleanupCalls, 1)
  await rejects(request(HttpClient, async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({
      read: async () => { throw readError },
      cancel: () => new Promise(() => {}),
      releaseLock() {},
    }) },
  }), 1024), error => error === readError)
  evidence.non_settling_cancel_cannot_hang_main_result = true
  evidence.primary_error_survives_cancel_failure = true

  const invalid = { pulls: 0, cancels: [] }
  await rejects(request(HttpClient, async () => ({ ok: true, status: 200,
    body: { getReader: () => ({
      read: async () => ({ done: false, value: 'not binary bytes' }),
      cancel: reason => { invalid.cancels.push(reason); return Promise.resolve() },
      releaseLock() {},
    }) },
  }), 64), 'binary chunks')
  assert.equal(invalid.cancels.length, 1)
  evidence.invalid_chunk_type_does_not_bypass_limit = true

  const root = await mkdtemp(join(tmpdir(), `loom-http-stream-${label}-`))
  const identity = await Identity.open(root)
  await identity.setToken({ token: 'fixture-only-node-token' })
  const state = await State.open(root)
  const client = new NodeClient({ identity, state, http: new HttpClient({ baseUrl: 'http://fixture.invalid',
    maxResponseBytes: 8, fetch: async () => streamResponse([encoder.encode('{"assignment":{"id":"asg-must-not-arrive"}}')], { pulls: 0, cancels: [] }) }) })
  await rejects(client.poll({ waitSeconds: 0 }), 'exceeds configured limit')
  assert.deepEqual(state.data.assignments, {})
  assert.deepEqual(state.outbox, [])
  assert.equal(state.data.completions && Object.keys(state.data.completions).length, 0)
  evidence.node_oversize_does_not_create_assignment_or_outbox = true
  const preAborted = new AbortController()
  const abortError = new Error('An already cancelled caller controls the request')
  preAborted.abort(abortError)
  let fallbackReads = 0
  await rejects(request(HttpClient, async () => {
    fallbackReads++
    return { ok: true, status: 200, arrayBuffer: async () => encoder.encode('{"assignment":null}') }
  }, 1_000, 1_000, preAborted.signal), error => error === abortError)
  assert.equal(fallbackReads, 0)
  evidence.pre_cancel_never_reads_legacy_body = true

  const empty = await request(HttpClient, async () => new Response(null, { status: 204 }))
  assert.equal(empty, null)
  const oldFixture = await request(HttpClient, async () => ({ ok: true, status: 200,
    arrayBuffer: async () => encoder.encode('{"assignment":null}').buffer }))
  assert.deepEqual(oldFixture, { assignment: null })
  evidence.empty_and_legacy_arrayBuffer_preserved = true

  assert.throws(() => new HttpClient({ baseUrl: 'http://fixture.invalid', maxResponseBytes: -1 }), /non-negative safe integer/)
  const structured = await rejects(request(HttpClient, async () => new Response(JSON.stringify({ error: { code: 'outcome_unknown', message: 'bounded fixture error' } }),
    { status: 409, headers: { 'content-type': 'application/json' } })), error => error.status === 409 && error.code === 'outcome_unknown')
  assert.equal(structured, undefined)
  evidence.structured_http_failure_stays_distinct = true
  return evidence
}

const results = [
  await prove('shared', SharedHttp, LoomNodeClient, NodeIdentity, NodeState),
  await prove('vendored', VendoredHttp, VendoredNodeClient, VendoredNodeIdentity, VendoredNodeState),
]
console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.http-stream.regression.v1', results,
  boundaries: 'Real byte counts and abort-races; synthetic Web streams plus genuine NodeIdentity/NodeState files.',
  not_claimed: ['physical network cancellation', 'remote effect rollback', 'new server API', 'exactly-once'], background_jobs: 0 }, null, 2))
