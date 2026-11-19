import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, symlink, unlink, writeFile, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { ControlledFileExecutor, NodeIdentity, validateAssignment } from '../src/index.js'
import { modelDescriptorProof } from '../src/model-descriptor.js'

const validSource = JSON.stringify({ schema: 'loom.model-descriptor.v1', provider: 'fixture-local-text',
  revision: 'v1', input_modalities: ['text'], local_only: true }) + '\n'
const identity = { node_id: 'a'.repeat(64), installation_id: 'descriptor-test-install' }
const grantRoot = { id: 'descriptor-grant', project_id: 'project-descriptor', worker_id: 'default', version: 1,
  operations: ['read'], digest: 'descriptor-grant-digest' }
async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'loom-descriptor-'))
  const project = join(root, 'project'); await mkdir(project, { mode: 0o700 })
  return { root, project, executor: new ControlledFileExecutor({ artifactDir: join(root, 'artifacts') }),
    write: async (source, path = 'model.json') => { await writeFile(join(project, path), source, { mode: 0o600 }) } }
}
function assignment(project, overrides = {}) {
  return { id: 'descriptor-assignment', ticket_id: 'descriptor-ticket', node_id: identity.node_id,
    installation_id: identity.installation_id, project_id: 'project-descriptor', worker_id: 'default', lease_epoch: 1,
    attempt: 1, lease_id: 'descriptor-lease', lease_expires_at: new Date(Date.now() + 60000).toISOString(),
    grant_version: 1, grant_digest: 'descriptor-grant-digest', kind: 'model_descriptor', relative_path: 'model.json', ...overrides }
}
test('descriptor reads a tiny explicit source, preserves its byte hash separately from artifact hash', async () => {
  const { project, executor, write } = await environment()
  await write(validSource)
  const grant = { ...grantRoot, project_root: project }
  assert.equal(validateAssignment(assignment(project), grant, identity).kind, 'model_descriptor')
  const result = await executor.execute(assignment(project), grant)
  const sourceHash = createHash('sha256').update(validSource).digest('hex')
  assert.deepEqual(JSON.parse(result.artifact.bytes), { ...JSON.parse(validSource), source_kind: 'explicit_local_artifact_descriptor', relative_path: 'model.json', source_sha256: sourceHash, source_document: validSource })
  assert.equal(result.artifact.metadata.sha256, createHash('sha256').update(result.artifact.bytes).digest('hex'))
  assert.notEqual(result.artifact.metadata.sha256, sourceHash)
  assert.equal(result.state, 'succeeded'); assert.equal(result.effect.status, 'confirmed')
  assert.equal(await readFile(join(project, 'model.json'), 'utf8'), validSource)
  assert.throws(() => validateAssignment(assignment(project), { ...grant, operations: ['write', 'invoke_text'] }, identity))
  assert.throws(() => validateAssignment(assignment(project, { kind: 'read_summary' }), { ...grant, operations: ['place_model'] }, identity))
})
test('schema, permissions, local type, dimensions and paths cannot manufacture a model descriptor', async () => {
  const { project, executor, write } = await environment()
  const bad = [
    { ...JSON.parse(validSource), additional_metadata: 'disallowed' },
    { ...JSON.parse(validSource), revision: 'v0' },
    { ...JSON.parse(validSource), provider: 'remote-seller' },
    { ...JSON.parse(validSource), local_only: 'true' },
    { ...JSON.parse(validSource), local_only: false },
    { ...JSON.parse(validSource), input_modalities: ['text', 'image'] },
    { ...JSON.parse(validSource), input_modalities: 'text' },
    { ...JSON.parse(validSource), activated: true },
  ]
  for (const value of bad) {
    await write(JSON.stringify(value))
    await assert.rejects(() => executor.execute(assignment(project), { ...grantRoot, project_root: project }))
  }
  await write(validSource.replace('"schema":"loom.model-descriptor.v1"', '"schema":"loom.model-descriptor.v1","schema":"loom.model-descriptor.v1"'))
  const duplicated = await readFile(join(project, 'model.json'))
  assert.throws(() => modelDescriptorProof(duplicated), /exactly five/)
  assert.throws(() => modelDescriptorProof(Buffer.alloc(8193, ' ')), /8192/)
  assert.throws(() => modelDescriptorProof(Buffer.from([0xff, 1, 2])), /UTF-8/)
  const base = validSource.trimEnd()
  const padded = Buffer.from(base + ' '.repeat(8192 - Buffer.byteLength(base)))
  assert.equal(padded.length, 8192)
  assert.throws(() => modelDescriptorProof(padded), /proof.*8192/)
  for (const path of ['../a.json', '/etc/passwd', 'secrets/model.json', 'other.json']) {
    await assert.rejects(() => executor.execute(assignment(project, { relative_path: path }), { ...grantRoot, project_root: project }))
  }
  assert.deepEqual((await readdir(join(project)).catch(() => [])), ['model.json'])
})
test('symlink/hardlink source and pending invalid source do not create artifact bytes', async () => {
  const { root, project, executor, write } = await (await environment())
  await write(validSource)
  await link(join(project, 'model.json'), join(root, 'source.json'))
  await assert.rejects(() => executor.execute(assignment(project), { ...grantRoot, project_root: project }), /unique/)
  await unlink(join(root, 'source.json'))
  await write(validSource, 'source.txt')
  await unlink(join(project, 'model.json'))
  await symlink(join(project, 'source.txt'), join(project, 'model.json'))
  await assert.rejects(() => executor.execute(assignment(project), { ...grantRoot, project_root: project }), /unique/)
})
