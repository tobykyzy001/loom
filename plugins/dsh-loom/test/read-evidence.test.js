import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { boundedReadArtifact, fixtureReadAssignment } from '../lib/read-evidence.js'

const PRIVATE = 'SYNTHETIC-ONLY-NOT-A-CREDENTIAL-341fed9921'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('bounded real file and ordinary tool events issue only provable source metadata, never source text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loom-read-proof-'))
  const project = join(root, 'project'); await mkdir(project)
  const bytes = Buffer.from(PRIVATE)
  const sha = hash(bytes)
  await writeFile(join(project, 'input.txt'), bytes)
  const assignment = { id: 'assignment-real-read', node_id: 'actual-node', kind: 'read_summary', relative_path: 'input.txt', objective: 'LOOM_FIXTURE_READ' }
  const tracked = {
    read_calls: new Map([['read-call', { name: 'loom_fixture_inspect', args: { mode: 'read', relative_path: 'input.txt' }, seq: 10 }]]),
    read_records: [{ call_id: 'read-call', result_id: 'result-actual', result_seq: 11, is_error: false,
      result: { schema: 'loom.fixture-read.v1', path: 'input.txt', sha256: sha, size_bytes: bytes.length, read: true },
      session: { harness: 'dsh', session_id: 'c774fd84-9496-45e8-862d-ba6c1cb74c6d', protocol: 'dsh-session-log', host_api: '0.2.2-rc.5', observed_seq: 11 } }],
  }
  const result = await boundedReadArtifact(assignment, project, tracked)
  assert.equal(result.state, 'succeeded')
  assert.deepEqual(result.effects, [])
  assert.equal(result.artifact.metadata.origin_node_id, 'actual-node')
  assert.equal(result.metadata.artifact_id, result.artifact.artifact_id)
  const body = JSON.parse(result.artifact.bytes.toString())
  assert.equal(body.source.bytes, sha)
  assert.deepEqual(body.proof, { schema: 'loom.read-proof.v1', name: 'loom_fixture_inspect', call_id: 'read-call', call_seq: 10, result_id: 'result-actual', result_seq: 11,
    session: { session_id: 'c774fd84-9496-45e8-862d-ba6c1cb74c6d', protocol: 'dsh-session-log' } })
  assert.equal(JSON.stringify(body).includes(PRIVATE), false)
  assert.equal(JSON.stringify(result.artifact.metadata).includes(PRIVATE), false)

  for (const value of [undefined, {}]) assert.equal(await boundedReadArtifact(assignment, project, value), null)
  for (const value of [{ ...tracked, read_invalid: true }, { ...tracked, read_records: [...tracked.read_records, tracked.read_records[0]] }]) {
    const rejected = await boundedReadArtifact(assignment, project, value)
    assert.equal(rejected.state, 'unknown')
    assert.deepEqual(rejected.artifacts, [])
  }
  tracked.session_ref = tracked.read_records[0].session
  for (const mutate of [
    value => { value.read_records[0].session.session_id = 'fake' },
    value => { value.read_records[0].result.sha256 = hash('other') },
    value => { value.read_records[0].result.size_bytes = 0 },
  ]) {
    const current = structuredClone(tracked)
    mutate(current)
    const rejected = await boundedReadArtifact(assignment, project, current)
    assert.equal(rejected.state, 'unknown')
    if (current.read_records[0].session.session_id === tracked.session_ref.session_id) assert.equal(rejected.session_ref.session_id, tracked.session_ref.session_id)
    else assert.equal(rejected.session_ref, undefined)
    assert.equal(JSON.stringify(rejected).includes(PRIVATE), false)
    assert.equal(rejected.artifact, undefined)
    assert.deepEqual(rejected.artifacts, [])
  }
  await writeFile(join(project, 'input.txt'), '')
  const empty = await boundedReadArtifact(assignment, project, tracked)
  assert.equal(empty.state, 'unknown')
  assert.equal(empty.artifact, undefined)
  assert.deepEqual(empty.artifacts, [])
  assert.equal(JSON.stringify(empty).includes(PRIVATE), false)
})

test('the read proof never applies to another path or ordinary unmarked DSH conversation', () => {
  for (const objective of ['LOOM_FIXTURE_RESUME', 'Review arbitrary prior conversation', 'LOOM_FIXTURE_READ_ONLY']) {
    assert.equal(fixtureReadAssignment({ id: 'assignment', node_id: 'node', kind: 'read_summary', relative_path: 'input.txt', objective }), null)
  }
  assert.equal(fixtureReadAssignment({ id: 'assignment', node_id: 'node', kind: 'edit_file', relative_path: 'input.txt', objective: 'LOOM_FIXTURE_READ' }), null)
  assert.equal(fixtureReadAssignment({ id: 'assignment', node_id: 'node', kind: 'read_summary', relative_path: 'private.txt', objective: 'LOOM_FIXTURE_READ' }), null)
  assert.notEqual(fixtureReadAssignment({ id: 'assignment', node_id: 'node', kind: 'read_summary', relative_path: 'input.txt', objective: 'LOOM_FIXTURE_READ' }), null)
})
