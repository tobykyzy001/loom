import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { prepareProject, startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const binary = join(repository, 'target/debug/loom-node')
const root = await testingRoot()
const evidence = await mkdtemp(join(tmpdir(), 'loom-bare-descriptor-proof-'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
let center
let sourceBefore
const children = new Set()
async function admin(route, method = 'GET', body = undefined) {
  const response = await fetch(`${center.baseUrl}/api/v1${route}`, {
    method, headers: { authorization: `Bearer ${center.clientToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await response.json()
  if (!response.ok) {
    const error = new Error(`${method} ${route}: ${response.status}: ${JSON.stringify(json.error)}`)
    error.status = response.status
    error.code = json.error?.code
    throw error
  }
  return json
}
const argsFor = state => [
  'start', '--coordinator', center.baseUrl, '--state-dir', state.path, '--artifact-dir', state.artifacts,
  '--project-root', `${state.projectId}=${state.project}`,
]
async function bare(state, extra = []) {
  const child = spawn(binary, [...argsFor(state), '--once', ...extra], {
    cwd: root, env: { PATH: process.env.PATH || '' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const output = []
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    output.push(String(chunk).replaceAll(center.clientToken, '<redacted>'))
  })
  const code = await new Promise(resolve => child.once('exit', code => resolve(code)))
  children.delete(child)
  if (code !== 0) throw new Error(`actual Rust bare process failed: ${output.slice(-4000)}`)
  return JSON.parse(output.join('').trim().split('\n')[0])
}
let checks = 0
function pass(name) {
  checks += 1
  console.log(`PASS ${name}`)
}
try {
  await promisify(execFile)('cargo', ['build', '--locked', '-p', 'loom-node', '--bin', 'loom-node'], {
    cwd: repository, timeout: 120000,
  })
  center = await startRustConcierge({ root })
  const project = await prepareProject(root)
  const source = JSON.stringify({
    schema: 'loom.model-descriptor.v1', provider: 'fixture-local-text', revision: 'v1',
    input_modalities: ['text'], local_only: true,
  }) + '\n'
  await writeFile(join(project, 'model.json'), source, { mode: 0o600 })
  sourceBefore = await readFile(join(project, 'model.json'))
  const created = await admin('/projects', 'POST', { name: 'Rust bare descriptor only', root: project, mode: 'read_write' })
  const state = { path: join(root, 'rust-bare-state'), artifacts: join(root, 'rust-bare-artifacts'), projectId: created.project.id, project }
  const enrollment = await admin('/enrollment-codes', 'POST', {})
  const registration = await bare(state, ['--enrollment-code', enrollment.code])
  const { node_id: node, installation_id: installation } = registration
  assert.ok(/^[a-f0-9]{64}$/.test(node))
  await admin('/project-bindings', 'POST', { project_id: state.projectId, node_id: node, installation_id: installation, worker_id: 'default', root_scope: project })
  const grant = await admin('/grants', 'POST', { project_id: state.projectId, node_id: node, worker_id: 'default', operations: ['read'] })
  const grantId = grant.grant.id
  pass('actual rust bare binary enrolled with its exact installation and bounded read Grant')

  const create = (relative_path = 'model.json', grant_id = grantId) => admin('/tickets', 'POST', {
    project_id: state.projectId, node_id: node, worker_id: 'default', kind: 'model_descriptor',
    relative_path, grant_id, objective: 'Read authorized descriptor metadata only; never invoke a model',
  })
  await assert.rejects(create('private.txt'), error => error.status === 400)
  const invokeGrant = await admin('/grants', 'POST', {
    project_id: state.projectId, node_id: node, worker_id: 'default', operations: ['invoke_text'],
  })
  await assert.rejects(create('model.json', invokeGrant.grant.id), error => {
    assert.equal(error.status, 403)
    assert.equal(error.code, 'operation_scope')
    return true
  })
  pass('private path and invoke_text grant cannot become a descriptor read execution')

  const ticket = await create()
  await bare(state)
  const detail = await admin(`/tickets/${ticket.id}`)
  assert.equal(detail.status, 'succeeded')
  assert.equal(detail.kind, 'model_descriptor')
  assert.equal(detail.artifacts.length, 1)
  const descriptorArtifact = detail.artifacts[0]
  const retrieved = await admin(`/tickets/${ticket.id}/artifacts/${descriptorArtifact.id}`)
  const bytes = Buffer.from(retrieved.content)
  const proof = JSON.parse(bytes)
  const sourceHash = sha256(sourceBefore)
  assert.deepEqual(proof, {
    schema: 'loom.model-descriptor.v1', provider: 'fixture-local-text', revision: 'v1',
    input_modalities: ['text'], local_only: true,
    relative_path: 'model.json', source_kind: 'explicit_local_artifact_descriptor',
    source_sha256: sourceHash, source_document: source,
  })
  assert.equal(descriptorArtifact.sha256, sha256(bytes))
  assert.notEqual(descriptorArtifact.sha256, sourceHash)
  assert.deepEqual(await readFile(join(project, 'model.json')), sourceBefore)
  assert.equal(retrieved.artifact.assignment_id, ticket.assignments[0].id)
  assert.ok(detail.effects.some(effect => effect.status === 'confirmed' && effect.artifacts.includes(descriptorArtifact.id)))
  pass('real bare assignment/read/proof/report/download preserve source bytes and two distinct hashes')
  const registered = await admin('/models', 'POST', {
    schema: 'loom.model-registry.v1', source_ticket_id: ticket.id,
    source_artifact_id: descriptorArtifact.id, worker_id: 'default', reviewed_sha256: descriptorArtifact.sha256,
  })
  assert.equal(registered.model.status, 'registered')
  assert.equal(registered.model.activation, false)
  assert.equal(registered.model.source_ticket_id, ticket.id)
  assert.equal(registered.model.source_assignment_id, ticket.assignments[0].id)
  pass('the native proof is accepted by the existing model registry, registered without activation')

  await writeFile(join(project, 'model.json'), '{"schema":"loom.model-descriptor.v1","schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true}\n', { mode: 0o600 })
  const malformed = await create()
  await bare(state)
  const undecided = await admin(`/tickets/${malformed.id}`)
  assert.equal(undecided.status, 'reconciling')
  assert.equal(undecided.artifacts.length, 0)
  assert.equal(undecided.reports.at(-1).state, 'unknown')
  const original = await admin(`/tickets/${ticket.id}/artifacts/${descriptorArtifact.id}`)
  assert.equal(original.artifact.id, descriptorArtifact.id)
  assert.equal(original.artifact.sha256, descriptorArtifact.sha256)
  assert.equal(original.content, retrieved.content)
  pass('duplicate JSON members remain unknown with no descriptor artifact, while prior proof stays immutable')

  const base = source.trimEnd()
  await writeFile(join(project, 'model.json'), base + ' '.repeat(8192 - Buffer.byteLength(base)), { mode: 0o600 })
  const overBudget = await create()
  await bare(state)
  const unresolved = await admin(`/tickets/${overBudget.id}`)
  assert.equal(unresolved.status, 'reconciling')
  assert.equal(unresolved.artifacts.length, 0)
  assert.equal(await readFile(join(project, 'model.json'), 'utf8'), base + ' '.repeat(8192 - Buffer.byteLength(base)))
  pass('source can still meet only its raw cap while the complete registry proof exceeds 8 KiB; never upload a bad artifact')

  const reportedIds = unresolved.reports.map(report => report.id).sort()
  await bare(state)
  const reopened = await admin(`/tickets/${overBudget.id}`)
  assert.equal(reopened.status, 'reconciling')
  assert.deepEqual(reopened.artifacts, [])
  assert.deepEqual(reopened.reports.map(report => report.id).sort(), reportedIds)
  const persistent = await admin(`/tickets/${ticket.id}/artifacts/${descriptorArtifact.id}`)
  assert.equal(persistent.content, retrieved.content)
  pass('reopening actual bare state does not create an extra report or descriptor artifact for ambiguous input')

  const result = {
    schema: 'loom.bare-descriptor-proof.v1', overall: 'PASS', checks,
    runner: 'actual local Rust loom-node process; no TypeScript executor stand-in',
    ticket_id: ticket.id, artifact_id: descriptorArtifact.id,
    source_sha256: sourceHash, artifact_sha256: descriptorArtifact.sha256,
    source_bytes_unchanged: true, bad_descriptor_state: undecided.status,
    limits: ['one current local OS host', 'not model resolve, download, activation or inference', 'not a real Provider, DSH Profile, second Host or mobile', 'this proof does not cover arbitrary JSON paths/content'],
  }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ...result, evidence: join(evidence, 'result.json') }, null, 2))
} finally {
  for (const child of children) child.kill('SIGTERM')
  if (center) await center.stop().catch(() => {})
  const ownedRoot = await realpath(root)
  assert.equal(dirname(ownedRoot), await realpath(tmpdir()), 'only the exact test root may be deleted')
  await rm(ownedRoot, { recursive: true, force: true })
}
