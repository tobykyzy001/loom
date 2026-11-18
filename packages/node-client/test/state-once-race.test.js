import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { NodeState } from '../src/state.js'

const digestFor = value => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'loom-node-state-first-claim-'))
  return { root, state: await NodeState.open(root) }
}

test('Concurrent identical first once claims share one real operation and preserve its actual unknown result', async () => {
  const { state, root } = await fixture()
  const input = digestFor('one logical source task')
  const path = join(root, 'effect.txt')
  const calls = []
  const work = async label => {
    // Both callbacks instrument the same actual logical operation; the second label is negative proof.
    calls.push(label)
    await writeFile(path, 'first controlled operation, not an inferred SDK outcome', 'utf8')
    await Promise.resolve()
    return { state: 'unknown', summary: 'Outward result still requires reconciliation even though the local file was actually written.', effects: [], artifacts: [] }
  }
  const [first, duplicate] = await Promise.all([
    state.once('asg-first-claim', input, () => work('first-operation')),
    state.once('asg-first-claim', input, () => work('forbidden-second-operation')),
  ])
  assert.equal(calls.length, 1, 'Same Node State + assignment + digest must claim only one first operation, not merely dedupe a completed cached row')
  assert.equal(first.state, 'unknown')
  assert.equal(duplicate.state, 'unknown', 'An in-flight duplicate waits for the signed-up operation, without fabricating a successful outcome')
  assert.equal(duplicate.duplicate, true)
  assert.equal(first.duplicate, undefined)
  assert.equal(await readFile(path, 'utf8'), 'first controlled operation, not an inferred SDK outcome')
  assert.deepEqual(calls, ['first-operation'])
  assert.equal(state.data.completions['asg-first-claim'].state, 'unknown')
  assert.equal(state.data.completions['asg-first-claim'].digest, input)
  assert.equal(state.onceInFlight.size, 0, 'The ephemeral map clears after actual durable completion')

  const replay = await state.once('asg-first-claim', input, () => work('a-third-operation'))
  assert.equal(replay.duplicate, true)
  assert.equal(calls.length, 1, 'Cached completed result remains replayable without new side effects')
  const reopened = await NodeState.open(root)
  assert.equal(reopened.data.completions['asg-first-claim'].state, 'unknown')
  assert.equal(reopened.data.completions['asg-first-claim'].digest, input)
  const afterReopen = await reopened.once('asg-first-claim', input, () => work('a-fourth-operation'))
  assert.equal(afterReopen.state, 'unknown')
  assert.equal(afterReopen.duplicate, true)
  assert.equal(calls.length, 1, 'Durable unknown evidence remains for reconciliation, not a new a posteriori execution')
})

test('Conflicting concurrent input and immutable results are fenced, while independent work is not blocked', async () => {
  const { state, root } = await fixture()
  const input = digestFor('first actual input')
  const otherDigest = digestFor('a different caller input')
  const calls = []
  const failFirst = await state.once('first-key', input, async () => {
    calls.push('several-input-failure')
    throw new Error('genuine deterministic operation failure')
  })
  assert.equal(failFirst.state, 'failed', 'Original error-to-completion behavior remains intact')
  const failedReplay = await state.once('first-key', input, async () => {
    calls.push('forbidden-failed-retry')
    return { state: 'succeeded', effects: [], artifacts: [] }
  })
  assert.equal(failedReplay.state, 'failed')
  assert.equal(state.onceInFlight.size, 0, 'An ordinary operation failure does not poison later in-flight ownership')
  assert.deepEqual(calls, ['several-input-failure'])
  await assert.rejects(() => state.once('first-key', otherDigest, async () => {
    calls.push('forbidden-different-digest')
  }), error => error.fenced === true && /different input/.test(error.message))

  state.onceInFlight.clear()
  await state.mutate(data => { delete data.completions['first-key']; data.outbox = []; data.rejections = {} })
  let release
  let announce
  const started = new Promise(resolve => { announce = resolve })
  const pause = new Promise(resolve => { release = resolve })
  const first = state.once('same-key', input, async () => {
    calls.push('current-first')
    announce()
    await pause
    await writeFile(join(root, 'current.txt'), 'current first operation', 'utf8')
    return { state: 'succeeded', summary: 'First operation actually persisted', effects: [], artifacts: [] }
  })
  const pendingOtherDigest = state.once('same-key', otherDigest, async () => {
    calls.push('forbidden-before-claim-other-digest')
  })
  await assert.rejects(pendingOtherDigest, error => error.fenced === true && /different input/.test(error.message))
  assert.equal(state.onceInFlight.has('same-key'), true, 'Competing digests must not delete the first in-flight owner')
  const duplicate = state.once('same-key', input, async () => {
    calls.push('forbidden-concurrent-second')
  })
  await started
  const unrelated = await state.once('independent-assignment', otherDigest, async () => {
    calls.push('independent-work')
    await writeFile(join(root, 'independent.txt'), 'independent permitted operation', 'utf8')
    return { state: 'succeeded', summary: 'Another Assignment is not globally serialized behind the first', effects: [], artifacts: [] }
  })
  assert.equal(unrelated.state, 'succeeded')
  release()
  const [original, repeated] = await Promise.all([first, duplicate])
  assert.equal(original.state, 'succeeded')
  assert.equal(repeated.duplicate, true)
  assert.equal(repeated.summary, original.summary)
  assert.equal(state.onceInFlight.size, 0)
  assert.deepEqual(calls, ['several-input-failure', 'current-first', 'independent-work'])
  assert.equal(await readFile(join(root, 'current.txt'), 'utf8'), 'current first operation')
  assert.equal(await readFile(join(root, 'independent.txt'), 'utf8'), 'independent permitted operation')
})
