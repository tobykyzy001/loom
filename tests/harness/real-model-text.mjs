import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureRoot, installBundles, isolatedEnv, installation, redact, sleep } from './environment.mjs'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

const root = await fixtureRoot(process.env.LOOM_MODEL_TEXT_ROOT)
let host, server, admin
const secrets = []
const checks = []
const log = (name, evidence) => { checks.push({ name, status: 'PASS', evidence }); console.log('PASS model_text: ' + name) }
try {
  const { executable, cli } = installation()
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  server = await startRustConcierge({ root: join(root, 'rust') })
  secrets.push(server.clientToken)
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const project = await admin.post('/api/v1/projects', { name: 'Signed bounded text-model calling', root: join(root, 'project'), mode: 'read_write' })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  secrets.push(enrollment.code)
  const env = isolatedEnv(root, { LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl, LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code,
    LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [projectId]: join(root, 'project') }), LOOM_FIXTURE_MODEL_TEXT_TASKS: 'true' })
  await installBundles({ env, root, cli, executable, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
  host = new FixtureHost(root, env, secrets)
  await host.writePatch()
  await host.start()
  const deadline = Date.now() + 45_000
  let node
  while (!node && Date.now() < deadline) {
    const snapshot = await admin.get('/api/v1/nodes')
    node = snapshot.nodes.find((entry) => entry.status === 'online' && entry.inventory?.project_roots?.[projectId])
    if (!node) await sleep(200)
  }
  assert.ok(node)
  await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: join(root, 'project') })
  const grantPermission = async operations => (await admin.post('/api/v1/grants', { project_id: projectId, node_id: node.id, worker_id: 'default', operations })).grant
  const invoke = await grantPermission(['invoke_text'])
  const grantOnlyReading = await grantPermission(['read'])
  const grantOnlyWriting = await grantPermission(['write'])
  const request = (grant_id, override = {}) => admin.post('/api/v1/tickets', { project_id: projectId, node_id: node.id, worker_id: 'default',
    grant_id, kind: 'model_text', provider: 'loom-stub', model: 'loom-stub-v1', objective: 'Use one bounded text operation for a synthetic flow.', ...override })
  for (const grant of [grantOnlyReading, grantOnlyWriting]) {
    await assert.rejects(() => request(grant.id), (error) => error.status === 403 && error.code === 'operation_scope')
  }
  await assert.rejects(() => request(invoke.id, { model: 'not-registered-or-approved' }), (error) => error.status === 501 && error.code === 'model_unavailable')
  await assert.rejects(() => request(invoke.id, { provider: 'deepseek' }), (error) => error.status === 501 && error.code === 'model_unavailable')
  log('different Grant/permission/reverse-model paths are rejected before SDK or file effects', { read_grant_denied: true, write_grant_denied: true, foreign_provider_denied: true, no_live_invocation: true })
  const created = await request(invoke.id)
  assert.equal(created.kind, 'model_text')
  const taskId = created.id
  const completed = await waitTicket(admin, taskId, ['succeeded', 'failed', 'reconciling', 'cancelled'], 75_000)
  assert.equal(completed.status, 'succeeded', JSON.stringify({ reports: completed.reports, artifacts: completed.artifacts }))
  assert.equal(completed.assignments.length, 1)
  assert.equal(completed.reports.length, 1)
  assert.equal(completed.artifacts.length, 1)
  assert.deepEqual(completed.effects, [])
  const supplied = completed.artifacts[0]
  assert.ok(supplied.sha256)
  const download = await admin.get(`/api/v1/tickets/${taskId}/artifacts/${supplied.id}`)
  assert.equal(download.artifact.sha256, createHash('sha256').update(download.content).digest('hex'))
  const content = JSON.parse(download.content)
  assert.equal(content.schema, 'loom.model-text-result.v1')
  assert.equal(content.source, 'dsh_llm_stream')
  assert.equal(content.text.trim().length > 0, true)
  assert.match(content.text, /Loom real DSH isolated Stub turn/)
  const mapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json')))
  const sessionId = mapping.assignments.find((entry) => entry.assignment_id === completed.assignments[0].id).session_id
  assert.ok(sessionId)
  const reflections = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json')))
  const artifactUpload = reflections.deliveries.filter((entry) => entry.kind === 'artifact' && entry.body.assignment_id === completed.assignments[0].id)
  assert.equal(artifactUpload.length, 1)
  const meta = artifactUpload[0].body.metadata
  assert.equal(meta.model_ref.provider, 'loom-stub')
  assert.equal(meta.model_ref.model, 'loom-stub-v1')
  assert.deepEqual(meta.model_ref.input_modalities, ['text'])
  assert.equal(meta.model_ref.kind, 'model_ref')
  assert.equal(meta.model_ref.kind_name, 'deterministic_fixture_text')
  assert.equal(meta.model_ref.not_live_llm, true)
  assert.equal(meta.model_ref.source, 'host_reported')
  assert.equal(meta.model_ref.output_observed, true)
  assert.equal(meta.model_ref.execution_observed, true)
  assert.equal(meta.model_ref.grant.id, invoke.id)
  assert.equal(meta.model_ref.grant.operation, 'invoke_text')
  assert.equal(meta.model_ref.artifact_sha256, supplied.sha256)
  const sourceNodes = (await admin.get('/api/v1/nodes')).nodes.find((entry) => entry.id === node.id)
  assert.equal(sourceNodes.revoked_at, null)
  const callers = readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(callers.some((entry) => entry.type === 'models-listed' && entry.provider === 'loom-stub'))
  assert.ok(callers.some((entry) => entry.type === 'model-resolved' && entry.model === 'loom-stub-v1'))
  assert.ok(callers.some((entry) => entry.type === 'model-prepared' && entry.model === 'loom-stub-v1'))
  assert.ok(callers.some((entry) => entry.type === 'request' && entry.session_id === sessionId))
  assert.ok(host.sessionEvents(sessionId, ['assistant/message']).length > 0)
  assert.ok(host.sessionEvents(sessionId, ['turn/end']).some((entry) => entry.event.data.reason.kind === 'completed'))
  const endpointBefore = await admin.get('/api/v1/models').catch(error => error)
  assert.equal(endpointBefore.status, 501, 'No observation-to-registry shortcut is permitted')
  await host.stop(); host = null
  const firstBytes = Buffer.from(download.content)
  const sleepUntilDelivery = sleep(1500)
  env.LOOM_FIXTURE_ENROLLMENT_CODE = ''
  host = await new FixtureHost(root, env, secrets).start()
  await sleepUntilDelivery
  const list = await admin.get(`/api/v1/tickets/${taskId}`)
  assert.equal(list.reports.length, 1)
  assert.equal(list.artifacts.length, 1)
  assert.deepEqual(list.effects, [])
  assert.equal((await admin.get(`/api/v1/tickets/${taskId}/artifacts/${supplied.id}`)).content, firstBytes.toString('utf8'))
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')).assignments.filter((entry) => entry.assignment_id === completed.assignments[0].id).map((entry) => entry.session_id), [sessionId])
  log('actual SDK catalogue + exact generation + real text Artifact and session recovered without new invocation', {
    task_id: taskId, assignment_id: completed.assignments[0].id, artifact_id: supplied.id, sha256: supplied.sha256,
    session_id: sessionId, model: 'loom-stub-v1', provider: 'loom-stub', operation: 'invoke_text',
    no_file_effects: true, no_actual_llm: true, software_invocation_observed: true,
    model_registry: 'NOT IMPLEMENTED (this proof does not silently enable it)',
  })
  console.log(JSON.stringify({ overall: 'PASS', checks, facts: { model_text_invocation: 'PASS', permission_fencing: 'PASS', actual_dsh_llm_adapter: true, live_llm: 'NOT RUN', image_generation: 'NOT RUN', registry_lifecycle: 'NOT RUN' }, root }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: redact(error.stack, secrets), host_diagnostics: redact(host?.diagnostics() || 'No host launched', secrets), checks, root }, null, 2))
  process.exitCode = 1
} finally {
  if (host) await host.stop().catch(() => {})
  if (server) await server.stop().catch(() => {})
}
function waitTicket(admin, ticket, acceptable, timeout) {
  return new Promise(async (resolve, reject) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const detail = await admin.get(`/api/v1/tickets/${ticket}`)
      if (acceptable.includes(detail.status)) return resolve(detail)
      await sleep(200)
    }
    reject(new Error(`model_text did not reach a terminal state: ${JSON.stringify(await admin.get(`/api/v1/tickets/${ticket}`))}`))
  })
}
