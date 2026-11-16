import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LoomHttpClient, LoomHttpError } from '../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../packages/node-client/src/runner.js'
import { ControlledFileExecutor } from '../packages/node-client/src/executor.js'
import { sha256 } from '../packages/node-client/src/util.js'
import { assertLoopback, prepareProject, startRustConcierge, testingRoot } from './fixtures/rust-server.mjs'

const sleepHealthy = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function waitTicket(admin, ticket, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await admin.get(`/api/v1/tickets/${ticket}`)
    if (['succeeded', 'failed', 'cancelled', 'reconciling'].includes(value.status)) return value
    await sleepHealthy(80)
  }
  throw new Error(`Ticket ${ticket} did not settle within ${timeoutMs}ms`)
}
function redact(value, secrets) {
  let result = String(value)
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted-test-token]')
  return result.slice(0, 3000)
}
function denyNodeTransport(node, token) {
  return node.http.post('/api/v1/nodes/heartbeat', { protocol: 'loom.node.v1', node_id: node.nodeId,
    installation_id: node.installationId, request_id: randomUUID(), status: 'online', workers: [] }, { token })
    .then(() => { throw new Error('The client credential must never be accepted on a node route') },
      (error) => { assert.equal(error instanceof LoomHttpError || /Client credential/.test(error.message), true)
        if (error instanceof LoomHttpError) assert.equal(error.status, 401); return 'Client token cannot become a node credential' })
}

/** This driver speaks only HTTP; no center database or fixture report is mutated directly. */
export async function runRealIntegration({ env = process.env, console: output = console } = {}) {
  const server = env.LOOM_BASE_URL ? {
    baseUrl: assertLoopback(env.LOOM_BASE_URL).origin, clientToken: env.LOOM_CLIENT_TOKEN || '', external: true,
    stop: async () => {},
  } : await startRustConcierge({ env })
  assert.ok(server.clientToken, 'LOOM_CLIENT_TOKEN is required with LOOM_BASE_URL; the test never reads a profile/bootstrap file')
  const root = server.dataDir ? join(server.dataDir, '..') : await testingRoot()
  const secrets = [server.clientToken]
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 10000 })
  const checks = []
  let node
  const record = async (name, fn) => {
    try {
      const evidence = await fn(); checks.push({ name, status: 'PASS', evidence })
      output.log(`PASS real: ${name}`); return evidence
    } catch (error) {
      checks.push({ name, status: 'FAIL', evidence: redact(error.stack || error, [...secrets, server.clientToken] ) })
      output.error(`FAIL real: ${name}: ${redact(error.message, secrets)}`)
      throw Object.assign(new Error(redact(error.message, secrets)), { cause: undefined })
    }
  }
  let failed = null
  try {
    await record('foreground real Rust Concierge health, no SyntheticCoordinator', async () => {
      const health = await admin.get('/api/v1/health')
      assert.equal(health.status, 'ok'); assert.equal(health.protocol, 'loom.node.v1')
      return { foreground_child: !server.external, server: 'Rust HTTP', base_url: server.baseUrl }
    })
    const projectRoot = await prepareProject(root)
    const project = await admin.post('/api/v1/projects', { name: 'Real isolated HTTP integration', root: projectRoot, mode: 'read_write' })
    const projectId = project.project.id
    assert.ok(projectId)
    const enrollment = await admin.post('/api/v1/enrollment-codes', {})
    const stateDir = join(root, 'node-state'), artifactDir = join(root, 'node-artifacts')
    const projectRoots = { [projectId]: projectRoot }
    let node
    await record('default worker registration carries host-owned root mapping in heartbeat', async () => {
      node = await LocalNodeRunner.create({ baseUrl: server.baseUrl, stateDir, artifactDir,
        enrollmentCode: enrollment.code, projectRoots,
        registration: { workerId: 'default', harnessKind: 'deterministic-local-http', profileId: 'real-integration-temp' } })
      const nodes = await admin.get('/api/v1/nodes')
      const registered = nodes.nodes.find((entry) => entry.id === node.nodeId)
      assert.equal(registered.workers[0].worker_id, 'default')
      assert.equal(registered.inventory.project_roots[projectId], projectRoot)
      return { worker_id: registered.workers[0].worker_id, registration_token_persisted: true, root_declared: true }
    })
    await record('node transport does not reuse the administrative credential', () => denyNodeTransport(node, server.clientToken))
    await record('binding requires exactly the root declared by the host', async () => {
      await assert.rejects(() => admin.post('/api/v1/project-bindings', {
        project_id: projectId, node_id: node.nodeId, worker_id: 'default', root_scope: join(root, 'different-location'),
      }), (error) => error.status === 403 && error.code === 'binding_not_declared_by_host')
      const binding = await admin.post('/api/v1/project-bindings', {
        project_id: projectId, node_id: node.nodeId, worker_id: 'default', root_scope: projectRoot,
      })
      assert.ok(binding.id); return { binding_approved: true, foreign_root_denied: true }
    })
    const grantResponse = await admin.post('/api/v1/grants', { project_id: projectId, node_id: node.nodeId,
      worker_id: 'default', operations: ['read', 'write'] })
    const grantId = grantResponse.grant.id
    const create = (kind, details = {}) => admin.post('/api/v1/tickets', { project_id: projectId, grant_id: grantId,
      worker_id: 'default', node_id: node.nodeId, objective: `Real HTTP ${kind}`, kind, ...details })
    let read, write
    await record('authenticated ordinary read produces actual input-derived artifact bytes', async () => {
      read = await create('read_summary', { relative_path: 'input.txt' })
      assert.equal(read.assignments[0].worker_id, 'default')
      await node.pollAndRun()
      await node.client.dispatchOutbox().then(() => node.client.dispatchOutbox())
      if (node.state.outbox.length) throw new Error(`Real outbox is deferred: ${JSON.stringify(node.state.outbox.map(({ kind, attempts, next_attempt_at, last_error, body }) => ({ kind, attempts, next_attempt_at, last_error, artifact_ids: body.artifact_ids, evidence: body.evidence })))}`)
      const detail = await admin.get(`/api/v1/tickets/${read.id}`)
      assert.equal(detail.status, 'succeeded'); assert.equal(detail.reports.length, 1)
      assert.equal(detail.reports[0].state, 'succeeded'); assert.match(detail.reports[0].summary, /without calling a model/)
      assert.equal(detail.assignments.length, 1)
      const artifactMeta = detail.artifacts[0]; assert.equal(artifactMeta.origin_node_id, node.nodeId)
      const downloaded = await admin.get(`/api/v1/tickets/${read.id}/artifacts/${artifactMeta.id}`)
      const summary = JSON.parse(downloaded.content)
      assert.deepEqual(summary.lines, ['Real isolated project input.', 'No LLM, DSH host or network model was called.'])
      assert.equal(downloaded.artifact.sha256, sha256(downloaded.content))
      return { artifact_id: artifactMeta.id, state: 'succeeded', content: summary.lines, model_calls: 0 }
    })
    await record('write has actual on-disk effect and reruns no completed Assignment or Effect', async () => {
      const expected = 'Written through a real Rust assignment, not a coordinator fixture.\n'
      write = await create('edit_file', { relative_path: 'nested/result.txt', content: expected })
      const before = Object.keys(node.state.data.completions)
      assert.ok(node.state.data.assignments[read.assignments[0].id])
      await node.pollAndRun()
      await node.client.dispatchOutbox().then(() => node.client.dispatchOutbox())
      const detail = await admin.get(`/api/v1/tickets/${write.id}`)
      assert.equal(detail.status, 'succeeded'); assert.equal(await readFile(join(projectRoot, 'nested/result.txt'), 'utf8'), expected)
      assert.equal(detail.effects.length, 1); assert.equal(detail.effects[0].status, 'confirmed')
      assert.deepEqual(Object.keys(node.state.data.completions).sort(), [...before, write.assignments[0].id].sort())
      assert.equal(Object.hasOwn(node.state.data.completions, read.assignments[0].id), true, 'Completed durable evidence must remain intact')
      assert.equal((await node.client.poll({ lastAssignmentId: write.assignments[0].id, waitSeconds: 0 })).assignment, null, 'Settled center work must not be replayed')
      assert.ok(!(await readdir(join(projectRoot, 'nested'))).some((name) => name.startsWith('.loom-')))
      return { state: 'succeeded', bytes: Buffer.byteLength(expected), effects: 1, repeated_jobs: 0 }
    })
    await record('exact persistent Report replay cannot duplicate an Effect, Report or Artifact', async () => {
      const delivered = node.state.data.deliveries.find((item) => item.kind === 'report' && item.body.assignment_id === write.assignments[0].id)
      assert.ok(delivered)
      await node.http.post('/api/v1/nodes/reports', delivered.body, { token: node.client.token })
      await node.state.enqueue('report', delivered.body)
      assert.equal(node.state.outbox.length, 0, 'Persisted duplicate delivery should not retransmit the same logical body')
      const detail = await admin.get(`/api/v1/tickets/${write.id}`)
      assert.equal(detail.reports.length, 1); assert.equal(detail.artifacts.length, 1); assert.equal(detail.effects.length, 1)
      return { repeated_http_reports: 1, reports: 1, artifacts: 1, effects: 1 }
    })
    await record('host read failure is reported failed, not promoted to success', async () => {
      const failure = await create('read_summary', { relative_path: 'missing.txt' })
      await node.pollAndRun()
      const deliveries = await node.client.dispatchOutbox()
      if (deliveries.some((item) => item.status === 'deferred')) throw new Error(`Failed host execution was not delivered: ${JSON.stringify(deliveries)}`)
      const detail = await admin.get(`/api/v1/tickets/${failure.id}`)
      assert.equal(detail.status, 'failed'); assert.equal(detail.reports.at(-1).state, 'failed')
      assert.equal(detail.artifacts.length, 0)
      return { state: 'failed', artifacts: 0, cause: 'genuine missing input read error' }
    })
    await record('cancellation intent causes cancel_acknowledged, no file write and no replay', async () => {
      const cancel = await create('edit_file', { relative_path: 'cancelled.txt', content: 'must not be written' })
      await admin.post(`/api/v1/tickets/${cancel.id}/cancel`, {})
      assert.equal((await admin.get(`/api/v1/tickets/${cancel.id}`)).status, 'cancel_requested')
      const result = await node.pollAndRun(); assert.equal(result.status, 'cancel_acknowledged')
      await node.client.dispatchOutbox()
      const detail = await waitTicket(admin, cancel.id)
      assert.equal(detail.status, 'cancelled'); assert.equal(Boolean(detail.reports.at(-1).cancel_acknowledged), true)
      assert.equal(detail.artifacts.length, 0)
      assert.equal((await node.client.poll({ lastAssignmentId: cancel.assignments[0].id, waitSeconds: 0 })).assignment, null)
      const replay = await node.pollAndRun()
      assert.equal(replay.status, 'idle', 'Cancellation must not be replayed after its report is delivered')
      try { await lstat(join(projectRoot, 'cancelled.txt')); assert.fail('Cancellation wrote a file') } catch (error) { assert.equal(error.code, 'ENOENT') }
      return { state: 'cancelled', cancel_acknowledged: true, artifacts: 0, file_absent: true, replayed: false }
    })
    await record('node cannot successfully finish the real cancelled Assignment', async () => {
      const cancellation = await waitTicket(admin, (await admin.get('/api/v1/tickets')).tickets.find((ticket) => ticket.relative_path === 'cancelled.txt').id)
      const delivered = node.state.data.deliveries.find((item) => item.kind === 'report' && item.body.assignment_id === cancellation.assignments[0].id)
      assert.ok(delivered)
      const body = { ...delivered.body, request_id: randomUUID(), requested_state: 'succeeded', cancel_acknowledged: false,
        summary: 'Invalid late success, deliberately rejected.', artifact_ids: [randomUUID()] }
      await assert.rejects(() => node.http.post('/api/v1/nodes/reports', body, { token: node.client.token }),
        (error) => error.status === 409)
      assert.equal((await waitTicket(admin, cancellation.id)).status, 'cancelled')
      return { late_succeeded_report_rejected: true, genuine_cancel_preserved: true }
    })
    await record('Artifact immutable ID rejects different bytes or lineage, without mutating content', async () => {
      const detail = await waitTicket(admin, write.id); const artifact = detail.artifacts[0]
      const original = await admin.get(`/api/v1/tickets/${write.id}/artifacts/${artifact.id}`)
      const body = node.state.data.deliveries.find((item) => item.kind === 'artifact' && item.body.assignment_id === write.assignments[0].id).body
      const duplicate = await node.http.post('/api/v1/nodes/artifacts', body, { token: node.client.token })
      assert.equal(duplicate.duplicate, true)
      const conflict = { ...body, request_id: randomUUID(), bytes_base64: Buffer.from('changed immutable content').toString('base64'),
        metadata: { ...body.metadata, size_bytes: 24, sha256: sha256(Buffer.from('changed immutable content')) } }
      await assert.rejects(() => node.http.post('/api/v1/nodes/artifacts', conflict, { token: node.client.token }),
        (error) => error.status === 409 && error.code === 'artifact_conflict')
      const after = await admin.get(`/api/v1/tickets/${write.id}/artifacts/${artifact.id}`)
      assert.deepEqual(after, original)
      return { identical_replay: true, mutation_rejected: 'artifact_conflict', bytes_and_lineage_unchanged: true }
    })
    await record('Grant root and local executor mapping fail closed before any effect', async () => {
      const rootDeniedState = join(root, 'root-denied-state')
      await assert.rejects(() => LocalNodeRunner.create({ baseUrl: server.baseUrl, stateDir: rootDeniedState,
        artifactDir: join(root, 'root-denied-artifacts'), enrollmentCode: enrollment.code }), /single-use|enrollment|denied/i)
      const assignment = node.state.data.assignments[read.assignments[0].id]
      assert.ok(assignment)
      await assert.rejects(() => node.assertApprovedRoot({ ...assignment, project_id: 'project_unmapped' }, assignment.grant), /No locally configured/)
      await assert.rejects(() => node.assertApprovedRoot(assignment, { ...assignment.grant, project_root: join(root, 'unconfigured') }), /does not match/)
      const foreign = new ControlledFileExecutor({ artifactDir, projectRoots: { [projectId]: join(root, 'unconfigured') } })
      await assert.rejects(() => foreign.execute(read, assignment.grant), /do not match/)
      await assert.rejects(() => foreign.execute({ ...read, project_id: 'different-project' }, assignment.grant), /no exact local root/)
      const lastCompletion = Object.values(node.state.data.completions).at(-1)
      assert.equal(lastCompletion.state, 'cancelled', 'A completed shell of a negative scenario must not be fabricated as a real Execution')
      return { unauthorized_mapping_rejected: true, executor_mismatch_rejected: true, no_file_effect: true }
    })
    await record('remote coordinator URL is never auto-configured', () => {
      assert.throws(() => assertLoopback('http://example.invalid'), /loopback/)
      assert.throws(() => assertLoopback('http://user:secret@127.0.0.1:1234'), /loopback/)
      return { remote_auto_configuration: false, profile_read_or_mutated: false }
    })
    return { schema: 'loom.rust_node.real_integration.v1', overall: 'PASS', base_url: server.baseUrl,
      foreground_child: !server.external, temporary_data_isolated: true, dsh_host: 'NOT RUN', live_llm: 'NOT RUN', checks }
  } catch (error) { failed = redact(error.message, secrets) } finally {
    await server.stop()
    if (node) await node.client.dispatchOutbox().catch(() => {})
  }
  return { schema: 'loom.rust_node.real_integration.v1', overall: 'FAIL', error: failed, foreground_child: !server.external, checks }
}
