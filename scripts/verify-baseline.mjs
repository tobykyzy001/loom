#!/usr/bin/env node
/**
 * Deterministic, single-host Loom baseline.
 *
 * SyntheticCoordinator is deliberately not part of this runner. The center is a
 * real foreground Rust process and every task is created through authenticated
 * HTTP. DSH unit tests here are source/mock tests, not host installation.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { LoomHttpClient, LoomHttpError } from '../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../packages/node-client/src/runner.js'
import { ControlledFileExecutor } from '../packages/node-client/src/executor.js'
import { sha256 } from '../packages/node-client/src/util.js'
import { prepareProject, startRustConcierge, testingClientToken } from './fixtures/rust-server.mjs'

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SUITE_CATALOG = Object.freeze([
  { id: 'rust-completed-replay', command: 'cargo', args: ['test', '-p', 'loom-node', '--test', 'completed_replay', '--locked'], scope: 'Deterministic narrowed Native replay, authorization, cancellation and failure-fence suite.' },
  { id: 'rust-completed-security', command: 'cargo', args: ['test', '-p', 'loom-node', '--test', 'security', '--locked'], scope: 'Deterministic narrowed Native fixture security suite; no second platform.' },
  { id: 'rust-workspace', command: 'cargo', args: ['test', '--workspace', '--locked'], scope: 'Full Rust workspace; opt-in hardware probe remains ignored.' },
  { id: 'rust-ts-bare', command: process.execPath, args: ['scripts/bare-integration.mjs'], scope: 'Real Concierge and native Rust Bare process, including read/write/cancel/restart.' },
  { id: 'ts-node-client', command: 'pnpm', args: ['--dir', 'packages/node-client', 'test'], scope: 'Shared Local Node unit tests only.' },
  { id: 'dsh-loom-source-tests', command: 'pnpm', args: ['--dir', 'plugins/dsh-loom', 'test'], scope: 'DSH source and mock-adapter tests; no DSH process, installation or Profile.' },
  { id: 'web-unit', command: 'pnpm', args: ['--dir', 'apps/web', 'test'], scope: 'Vitest unit suite; no real browser, mobile device or production build.' },
])
const NOT_RUN = Object.freeze([
  ['real_dsh_host', 'Only DSH source/mock unit tests run; no DSH profile is installed, read or modified.'],
  ['live_llm', 'No model Provider, paid model, credentials or Token spend is invoked.'],
  ['compose_1_plus_3', 'No Compose or 1 Concierge + 3 Node topology is run.'],
  ['second_physical_host', 'All center, TypeScript and Bare work uses logical roles on this one machine.'],
  ['mobile_device', 'No iOS/Android device, PWA lifecycle or lock-screen behavior is exercised.'],
  ['linux_windows', `Only the current ${process.platform}/${process.arch} host is executed.`],
  ['browser_ui_production_build', 'The web selection is its unit suite, not a real Edge/browser or production build.'],
  ['system_credentials_installers', 'No OS Credential Store, signing, installer, service or remote deployment is invoked.'],
])
const OPTIONS = new Set(['--all', '--integration-only', '--suites-only', '--full', '--help', '-h'])

export async function runRealDeterministicFlow({ root, console: output = console, env = process.env } = {}) {
  assert.equal(typeof root, 'string')
  assert.ok(isAbsolute(root) && resolve(root) !== resolve(process.env.HOME || '__unset__') && resolve(root) !== '/', 'A private temporary root is required')
  const clientToken = testingClientToken()
  const clientEnv = { ...env, LOOM_CLIENT_TOKEN: clientToken }
  let center = await startRustConcierge({ root, env: clientEnv })
  const admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken, timeoutMs: 10_000 })
  const checks = []
  let failed = null
  let node
  const check = async (id, kind, fn) => {
    if (failed) { checks.push({ id, kind, status: 'NOT_RUN', evidence: { dependency_failed: failed.id } }); return null }
    const started = performance.now()
    try {
      const evidence = await fn()
      checks.push({ id, kind, status: 'PASS', duration_ms: Math.round(performance.now() - started), evidence })
      output.log(`PASS real ${id}`)
      return evidence
    } catch (error) {
      failed = { id, error: cleanText(error.stack || error.message, 6000) }
      checks.push({ id, kind, status: 'FAIL', duration_ms: Math.round(performance.now() - started), evidence: failed.error })
      throw error
    }
  }
  const settled = async (ticket, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await admin.get(`/api/v1/tickets/${ticket}`)
      if (['succeeded', 'failed', 'cancelled', 'reconciling'].includes(value.status)) return value
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Ticket ${ticket} did not settle within ${timeoutMs}ms`)
  }
  const absent = async path => {
    try { await readFile(path) } catch (error) { assert.equal(error.code, 'ENOENT'); return }
    throw new Error(`Expected an absent file: ${basename(path)}`)
  }
  try {
    const projectRoot = await prepareProject(root)
    const project = await admin.post('/api/v1/projects', { name: 'Deterministic baseline isolated project', root: projectRoot, mode: 'read_write' })
    const projectId = project.project.id
    const enrollment = await admin.post('/api/v1/enrollment-codes', {})
    const stateDir = join(root, 'node-state')
    const artifactDir = join(root, 'node-artifacts')
    await check('real_registration', 'positive', async () => {
      const health = await admin.get('/api/v1/health')
      assert.equal(health.status, 'ok')
      assert.equal(health.protocol, 'loom.node.v1')
      node = await LocalNodeRunner.create({ baseUrl: center.baseUrl, stateDir, artifactDir,
        enrollmentCode: enrollment.code, projectRoots: { [projectId]: projectRoot },
        registration: { workerId: 'default', harnessKind: 'deterministic-local-http', profileId: 'isolated-no-dsh' } })
      const nodes = await admin.get('/api/v1/nodes')
      const registered = nodes.nodes.find(item => item.id === node.nodeId && item.installation_id === node.installationId)
      assert.ok(registered)
      assert.equal(registered.workers[0].worker_id, 'default')
      assert.equal(registered.inventory.project_roots[projectId], projectRoot)
      return { rust_health: true, registered: true, project_root_declared: true, worker_count: 1 }
    })
    await check('node_and_client_authorization_are_separate', 'negative', async () => {
      await assert.rejects(() => node.http.post('/api/v1/nodes/heartbeat', { protocol: 'loom.node.v1',
        node_id: node.nodeId, installation_id: node.installationId, request_id: randomUUID(), status: 'online', workers: [] }, { token: clientToken }),
      error => error instanceof LoomHttpError ? error.status === 401 : /Client credential/.test(error.message))
      return { client_token_on_node_transport_denied: true, anonymous_or_client_fallback: false }
    })
    await check('single_use_enrollment_replay', 'negative', async () => {
      await assert.rejects(() => LocalNodeRunner.create({ baseUrl: center.baseUrl,
        stateDir: join(root, 'reuse-state'), artifactDir: join(root, 'reuse-artifacts'),
        enrollmentCode: enrollment.code, projectRoots: { [projectId]: projectRoot },
        registration: { workerId: 'default', harnessKind: 'deterministic-local-http', profileId: 'isolated-no-dsh' } }),
      error => error.status === 403 && error.code === 'enrollment_denied')
      return { used_code_new_identity_denied: true }
    })
    await check('exact_host_binding_required', 'negative', async () => {
      await assert.rejects(() => admin.post('/api/v1/project-bindings', { project_id: projectId,
        node_id: node.nodeId, worker_id: 'default', root_scope: join(root, 'unrelated-location') }),
      error => error.status === 403 && error.code === 'binding_not_declared_by_host')
      const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId,
        node_id: node.nodeId, worker_id: 'default', root_scope: projectRoot })
      assert.ok(binding.id)
      return { mismatched_root_http: 403, exact_binding_created: true }
    })
    const grantResponse = await admin.post('/api/v1/grants', { project_id: projectId,
      node_id: node.nodeId, worker_id: 'default', operations: ['read', 'write'] })
    const grantId = grantResponse.grant.id
    const create = (kind, details = {}) => admin.post('/api/v1/tickets', { project_id: projectId,
      node_id: node.nodeId, worker_id: 'default', grant_id: grantId, kind, ...details })
    let readTicket, writeTicket, cancelTicket
    await check('real_read_artifact', 'positive', async () => {
      readTicket = await create('read_summary', { objective: 'Deterministic real input', relative_path: 'input.txt' })
      const execution = await node.pollAndRun()
      await node.client.dispatchOutbox()
      assert.equal(execution.status, 'succeeded')
      assert.equal(node.state.outbox.length, 0)
      const detail = await settled(readTicket.id)
      assert.equal(detail.status, 'succeeded')
      assert.equal(detail.reports.length, 1)
      assert.equal(detail.assignments.length, 1)
      assert.equal(detail.artifacts.length, 1)
      const artifact = await admin.get(`/api/v1/tickets/${readTicket.id}/artifacts/${detail.artifacts[0].id}`)
      assert.equal(sha256(artifact.content), artifact.artifact.sha256)
      const body = JSON.parse(artifact.content)
      assert.deepEqual(body.lines, ['Real isolated project input.', 'No LLM, DSH host or network model was called.'])
      await writeFile(join(root, 'read-artifact.json'), artifact.content, { mode: 0o600 })
      return { artifact_sha_matches_bytes: true, reports: 1, assignments: 1, model_calls: 0 }
    })
    await check('real_atomic_edit', 'positive', async () => {
      const expected = 'Deterministic baseline actual file effect.\n'
      writeTicket = await create('edit_file', { objective: 'Deterministic bounded write', relative_path: 'nested/result.txt', content: expected })
      assert.equal((await node.pollAndRun()).status, 'succeeded')
      await node.client.dispatchOutbox()
      const detail = await settled(writeTicket.id)
      assert.equal(detail.status, 'succeeded')
      assert.equal(await readFile(join(projectRoot, 'nested/result.txt'), 'utf8'), expected)
      assert.equal(detail.effects.length, 1)
      assert.equal(detail.effects[0].status, 'confirmed')
      assert.ok(!(await readdir(join(projectRoot, 'nested'))).some(name => name.startsWith('.loom-')))
      assert.equal((await node.pollAndRun()).status, 'idle')
      return { target_bytes_match: true, confirmed_effects: 1, no_temporary_file: true, repeat_execution: 0 }
    })
    await check('real_host_failure', 'negative', async () => {
      const ticket = await create('read_summary', { objective: 'Missing-file failure', relative_path: 'missing.txt' })
      assert.equal((await node.pollAndRun()).status, 'failed')
      await node.client.dispatchOutbox()
      const detail = await settled(ticket.id)
      assert.equal(detail.status, 'failed')
      assert.equal(detail.reports.at(-1).state, 'failed')
      assert.equal(detail.artifacts.length, 0)
      assert.equal(detail.effects.length, 0)
      return { state: 'failed', missing_input: true, artifacts: 0, effects: 0 }
    })
    await check('cancel_before_execution', 'negative', async () => {
      cancelTicket = await create('edit_file', { objective: 'Pre-execution cancellation', relative_path: 'cancelled.txt', content: 'must not exist\n' })
      await admin.post(`/api/v1/tickets/${cancelTicket.id}/cancel`, {})
      assert.equal((await admin.get(`/api/v1/tickets/${cancelTicket.id}`)).status, 'cancel_requested')
      assert.equal((await node.pollAndRun()).status, 'cancel_acknowledged')
      await node.client.dispatchOutbox()
      const detail = await settled(cancelTicket.id)
      assert.equal(detail.status, 'cancelled')
      assert.equal(detail.reports.length, 1)
      assert.equal(detail.reports[0].state, 'cancelled')
      assert.equal(detail.artifacts.length, 0)
      assert.equal(detail.effects.length, 0)
      const delivery = node.state.data.deliveries.find(item => item.kind === 'report' && item.body.assignment_id === cancelTicket.assignments[0].id)
      assert.equal(delivery.body.cancel_acknowledged, true)
      await absent(join(projectRoot, 'cancelled.txt'))
      assert.equal((await node.pollAndRun()).status, 'idle')
      return { cancellation_report: 'cancelled', cancel_acknowledged: true, artifacts: 0, effects: 0, file_absent: true }
    })
    await check('replay_idempotence_and_conflicts', 'negative', async () => {
      const original = await settled(writeTicket.id)
      const originalArtifact = await admin.get(`/api/v1/tickets/${writeTicket.id}/artifacts/${original.artifacts[0].id}`)
      const report = node.state.data.deliveries.find(item => item.kind === 'report' && item.body.assignment_id === writeTicket.assignments[0].id)
      assert.ok(report)
      const duplicate = await node.http.post('/api/v1/nodes/reports', report.body, { token: node.identity.token })
      assert.equal(duplicate.duplicate, true)
      const persistentReplay = await node.state.enqueue('report', report.body)
      assert.equal(persistentReplay.body.request_id, report.body.request_id)
      const deliveries = await node.client.dispatchOutbox()
      assert.ok(deliveries.some(item => item.kind === 'report' && item.status === 'replay_delivered'))
      await assert.rejects(() => node.http.post('/api/v1/nodes/reports', { ...report.body, summary: 'Changed body under original request identity' }, { token: node.identity.token }), error => error.status === 409)
      const artifact = node.state.data.deliveries.find(item => item.kind === 'artifact' && item.body.assignment_id === writeTicket.assignments[0].id)
      assert.ok(artifact)
      assert.equal((await node.http.post('/api/v1/nodes/artifacts', artifact.body, { token: node.identity.token })).duplicate, true)
      const changedBytes = Buffer.from('Different immutable bytes; this is a negative fixture.\n')
      await assert.rejects(() => node.http.post('/api/v1/nodes/artifacts', { ...artifact.body, request_id: randomUUID(),
        bytes_base64: changedBytes.toString('base64'), metadata: { ...artifact.body.metadata, size_bytes: changedBytes.length, sha256: sha256(changedBytes) } },
      { token: node.identity.token }), error => error.status === 409 && error.code === 'artifact_conflict')
      const after = await settled(writeTicket.id)
      assert.deepEqual(after, original)
      assert.deepEqual(await admin.get(`/api/v1/tickets/${writeTicket.id}/artifacts/${original.artifacts[0].id}`), originalArtifact)
      assert.equal(node.state.data.completions[writeTicket.assignments[0].id].assignment_id, writeTicket.assignments[0].id)
      return { report_replays: 1, stable_request_id: true, changed_report_rejected: true, artifact_replays: 1,
        artifact_conflict: true, reports: 1, artifacts: 1, effects: 1, unchanged_completion: true }
    })
    await check('revoked_grant_fences_old_assignment', 'negative', async () => {
      const separate = await admin.post('/api/v1/grants', { project_id: projectId,
        node_id: node.nodeId, worker_id: 'default', operations: ['read', 'write'] })
      const old = await create('edit_file', { objective: 'Revoked authority negative fixture', relative_path: 'revoked-target.txt',
        content: 'This must not be written.\n', grant_id: separate.grant.id })
      const frame = await node.client.poll({ lastAssignmentId: null, waitSeconds: 0 })
      assert.equal(frame.id, old.assignments[0].id)
      const completionCount = Object.keys(node.state.data.completions).length
      const ordinaryAdmission = await node.client.acknowledge({ ticketId: old.id,
        assignmentId: frame.id, leaseEpoch: frame.lease_epoch, accepted: true })
      assert.equal(ordinaryAdmission.response.accepted, true, 'Admission is an ACK, not local file execution')
      assert.equal(Object.keys(node.state.data.completions).length, completionCount)
      const revoked = await admin.post(`/api/v1/grants/${separate.grant.id}/revoke`, {})
      assert.equal(revoked.revoked, true)
      assert.equal(revoked.grant_version, 2)
      const ticketsBeforeRevokedCreate = (await admin.get('/api/v1/tickets')).tickets.length
      await assert.rejects(() => create('edit_file', { objective: 'A fresh ticket must not use this revoked grant',
        relative_path: 'revoked-new.txt', content: 'Must not execute.\n', grant_id: separate.grant.id }),
      error => error.status === 403 && error.code === 'grant_scope')
      assert.equal((await admin.get('/api/v1/tickets')).tickets.length, ticketsBeforeRevokedCreate, 'A revoked Grant must not mint another Ticket')
      await node.client.artifact({ ticketId: old.id, assignmentId: old.assignments[0].id, leaseEpoch: old.assignments[0].lease_epoch,
        metadata: { artifact_id: randomUUID(), name: 'fenced-authorization.json', media_type: 'application/json', origin_node_id: node.nodeId },
        bytes: Buffer.from('{"deliberately_unauthorized":true}\n') })
      await node.client.report({ ticketId: old.id, assignmentId: old.assignments[0].id, leaseEpoch: old.assignments[0].lease_epoch,
        state: 'succeeded', summary: 'Deliberately unauthorized late success must not be accepted.', effects: [] })
      const delivery = await node.client.dispatchOutbox()
      assert.equal(delivery.length, 2)
      assert.ok(delivery.every(item => item.status === 'deferred'))
      const detail = await admin.get(`/api/v1/tickets/${old.id}`)
      assert.equal(detail.status, 'reconciling')
      assert.equal(detail.reports.length, 0)
      assert.equal(detail.artifacts.length, 0)
      assert.equal(detail.effects.length, 0)
      assert.equal(Object.keys(node.state.data.completions).length, completionCount, 'An ACK or revoked report must never execute the pending edit')
      assert.equal(node.state.outbox.length, 2, 'Fenced deliveries remain pending for reconciliation')
      await absent(join(projectRoot, 'revoked-target.txt'))
      await absent(join(projectRoot, 'revoked-new.txt'))
      return { grant_version: 2, new_ticket_rejected: true, late_artifact_and_report_deferred: true,
        central_reports: 0, central_artifacts: 0, central_effects: 0, file_absent: true, new_executions: 0 }
    })
    await check('local_root_mapping_fence', 'negative', async () => {
      const assignment = node.state.data.assignments[readTicket.assignments[0].id]
      assert.ok(assignment)
      await assert.rejects(() => node.assertApprovedRoot({ ...assignment, project_id: 'unmapped-project' }, assignment.grant), /No locally configured/)
      await assert.rejects(() => node.assertApprovedRoot(assignment, { ...assignment.grant, project_root: root }), /does not match/)
      const executor = new ControlledFileExecutor({ artifactDir: join(root, 'unused-artifacts'), projectRoots: { [projectId]: root } })
      await assert.rejects(() => executor.execute(assignment, assignment.grant), /do not match/)
      assert.ok(Object.hasOwn(node.state.data.completions, cancelTicket.assignments[0].id), 'Cancellation also has durable local evidence')
      assert.equal(node.state.data.completions[cancelTicket.assignments[0].id].execution_started, false)
      return { unmapped_project_rejected: true, changed_root_rejected: true, executor_mismatch_rejected: true,
        cancelled_completion_retained_without_execution: true }
    })
    await check('node_and_center_restart_preserve_history', 'positive', async () => {
      const before = {}
      for (const ticket of [readTicket, writeTicket, cancelTicket]) before[ticket.id] = await admin.get(`/api/v1/tickets/${ticket.id}`)
      const completions = Object.fromEntries(Object.entries(node.state.data.completions).map(([id, record]) => [id,
        { assignment_id: record.assignment_id, digest: record.digest, state: record.state, execution_started: record.execution_started }]))
      const completionFacts = value => Object.fromEntries(Object.entries(value).map(([id, record]) => [id,
        { assignment_id: record.assignment_id, digest: record.digest, state: record.state, execution_started: record.execution_started }]))
      const outbox = JSON.parse(JSON.stringify(node.state.data.outbox))
      const stored = JSON.parse(await readFile(join(stateDir, 'node-state.json'), 'utf8'))
      assert.deepEqual(stored.outbox, outbox, 'The durable intent/rejection state, excluding time metadata, persists literally')
      const oldIdentity = { id: node.nodeId, installation: node.installationId, token: node.identity.token }
      node = new LocalNodeRunner({ baseUrl: center.baseUrl, stateDir, artifactDir,
        projectRoots: { [projectId]: projectRoot }, registration: { workerId: 'default', harnessKind: 'deterministic-local-http', profileId: 'isolated-no-dsh' } })
      await node.start()
      assert.equal(node.nodeId, oldIdentity.id)
      assert.equal(node.installationId, oldIdentity.installation)
      assert.equal(node.identity.token, oldIdentity.token)
      await center.stop()
      center = await startRustConcierge({ root, dataDir: join(root, 'concierge'), baseUrl: center.baseUrl, env: clientEnv })
      for (const [id, original] of Object.entries(before)) assert.deepEqual(await admin.get(`/api/v1/tickets/${id}`), original)
      assert.deepEqual(completionFacts(node.state.data.completions), completions)
      assert.deepEqual(node.state.data.outbox, outbox, 'Reopening neither delivers nor modifies the fenced original outbox')
      for (const item of outbox) {
        assert.equal(typeof item.last_error, 'string', 'Revocation rejection stays attached to this exact queued evidence')
        if (item.kind === 'artifact') assert.equal(item.body.artifact_id ?? item.body.metadata.artifact_id, item.body.metadata.artifact_id)
      }
      const reconcile = await node.client.poll({ lastAssignmentId: null, waitSeconds: 0 })
      if (reconcile.assignment) {
        assert.equal(reconcile.assignment.purpose, 'reconcile')
        assert.equal(reconcile.assignment.grant_status, false)
        assert.ok(reconcile.assignment.grant.revoked_at)
      } else {
        assert.ok(reconcile.assignment == null, 'An already reconciled/evidence-only poll can remain idle; it must not create execution')
      }
      assert.deepEqual(completionFacts(node.state.data.completions), completions, 'A reconcile-only or idle poll must not execute old work')
      const audit = await admin.get('/api/v1/audit/verify')
      assert.equal(audit.valid, true)
      return { node_identity_preserved: true, node_token_preserved: true, rust_center_reopened: true,
        read_write_cancel_history_unchanged: true, audit_chain_valid: true, deferred_outbox_preserved: true,
        reconcile_requires_current_review: true, replayed_execution: 0 }
    })
    return { schema: 'loom.real-deterministic-flow.v2', overall: 'PASS', center: 'rust', physical_hosts: 1, checks }
  } catch (error) {
    return { schema: 'loom.real-deterministic-flow.v2', overall: 'FAIL', center: 'rust', physical_hosts: 1,
      checks, error: cleanText(error.stack || error, 6000) }
  } finally {
    await center.stop()
  }
}

function cleanText(value, max = 2000) {
  let text = String(value)
  // Fixtures never generate Token-shaped material in expected messages. This is
  // an additional guard for failed libraries or node identity serialization.
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  text = text.replace(/(["'])(?:node|installation|client|private|enrollment|api|access|secret)[a-z_]*(?:token|key|code|secret)[a-z_]*\1(\s*:\s*)(["']).*?\3/gi, '$1[redacted]$2$3[redacted]$3')
  text = text.replace(/(["'])(?:node|installation|client|private|enrollment|api|access|secret)[a-z_]*(?:token|key|code|secret)[a-z_]*\1(\s*:\s*)[A-Za-z0-9+/_=-]{20,}/gi, '$1[redacted]$2[redacted]')
  return text.slice(0, max)
}

function toolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 })
  return result.status === 0 ? result.stdout.trim().split('\n')[0].slice(0, 200) : `NOT RUN (exit ${result.status ?? 'unknown'})`
}

async function runSuite(suite, { outputDirectory, env }) {
  const started = performance.now()
  const streams = { stdout: '', stderr: '' }
  const truncated = { stdout: false, stderr: false }
  const outcome = await new Promise(resolveResult => {
    let child
    try {
      child = spawn(suite.command, suite.args, { cwd: REPOSITORY, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (error) {
      resolveResult({ exit_code: null, signal: null, error: cleanText(error.message) })
      return
    }
    let timedOut = false
    let forcedKill = null
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forcedKill = setTimeout(() => child.kill('SIGKILL'), 5000)
      forcedKill.unref()
    }, 300_000)
    timeout.unref()
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream.on('data', chunk => {
        if (streams[name].length >= 4_000_000) { truncated[name] = true; return }
        const remaining = 4_000_000 - streams[name].length
        const text = chunk.toString('utf8')
        streams[name] += text.slice(0, remaining)
        if (text.length > remaining) truncated[name] = true
      })
    }
    child.once('error', error => {
      streams.stderr += `\nspawn error: ${cleanText(error.message, 500)}`
    })
    child.once('close', (exit_code, signal) => {
      clearTimeout(timeout)
      if (forcedKill) clearTimeout(forcedKill)
      resolveResult({ exit_code, signal, ...(timedOut ? { timeout_ms: 300_000 } : {}) })
    })
  })
  const artifacts = []
  await mkdir(join(outputDirectory, 'logs'), { recursive: true })
  for (const name of ['stdout', 'stderr']) {
    const file = `logs/${suite.id}.${name}.log`
    await writeFile(join(outputDirectory, file), cleanText(streams[name], 4_000_000) + (truncated[name] ? '\n[log truncated at 4,000,000 characters]\n' : ''), { mode: 0o600 })
    artifacts.push(file)
  }
  const evidence = parseSuiteEvidence(suite, streams.stdout)
  if (evidence?.error && outcome.exit_code === 0) {
    outcome.exit_code = null
    outcome.error = evidence.error
  }
  return {
    id: suite.id, status: outcome.exit_code === 0 ? 'PASS' : 'FAIL',
    command: [suite.command, ...suite.args], exit_code: outcome.exit_code, signal: outcome.signal,
    duration_ms: Math.round(performance.now() - started), scope: suite.scope,
    ...(outcome.timeout_ms ? { timeout_ms: outcome.timeout_ms } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.exit_code !== 0 && !outcome.error ? { error: cleanText(streams.stderr.trim().split('\n').slice(-12).join('\n') || streams.stdout.trim().split('\n').slice(-12).join('\n')) } : {}),
    ...(evidence && !evidence.error ? { evidence } : {}), artifacts,
  }
}

function parseSuiteEvidence(suite, stdout) {
  if (suite.id === 'rust-ts-bare') {
    try {
      const report = JSON.parse(stdout)
      if (report.schema !== 'loom.native.bare.integration.v1' || report.overall !== 'PASS' || !Array.isArray(report.checks)) {
        return { error: 'Bare process exited zero without its required PASS report' }
      }
      return { schema: report.schema, overall: report.overall, checks: report.checks.map(check => ({ name: check.name })) }
    } catch { return { error: 'Bare process exited zero but did not produce its required JSON result' } }
  }
  const passing = /^\s*(?:ℹ\s+pass\s+\d+|Tests\s+\d+ passed.*)$/m.exec(stdout)
  const failures = /^\s*(?:ℹ\s+fail\s+0|Tests\s+.*0 failed.*)$/m
  const summaries = stdout.split('\n').
    filter(line => /^\s*test result:|^\s*ℹ (tests|pass|fail|ignored)|Test Files|Tests\s|^\s*running \d+ tests?/.test(line))
  return { summaries: summaries.slice(-48), ...(passing || /test result: ok/.test(stdout) ? {} : failures ? { error: 'Test suite exited zero without a recognized test summary' } : {}) }
}

export async function runBaseline({ argv = process.argv.slice(2), env = process.env, output = console } = {}) {
  const unknown = argv.filter(arg => !OPTIONS.has(arg))
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}; use --help`)
  if (argv.includes('--help') || argv.includes('-h')) {
    output.log('node scripts/verify-baseline.mjs [--integration-only|--suites-only|--full]\nReports: system temporary directory by default, or LOOM_VERIFY_OUTPUT_DIR.')
    return { help: true, overall: 'NOT_RUN', exit_code: 0 }
  }
  if ((argv.includes('--integration-only') || argv.includes('--suites-only')) && argv.includes('--full')) {
    throw new Error('--full conflicts with --integration-only/--suites-only')
  }
  const includeSuites = !argv.includes('--integration-only')
  const includeIntegration = !argv.includes('--suites-only')
  const startedAt = new Date().toISOString()
  const outputDirectory = env.LOOM_VERIFY_OUTPUT_DIR ? resolve(env.LOOM_VERIFY_OUTPUT_DIR)
    : await mkdtemp(join(tmpdir(), 'loom-baseline-verification-'))
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(outputDirectory, '.baseline-owned'), 'Loom deterministic baseline evidence directory; no credentials are stored here.\n', { mode: 0o600, flag: 'wx' })
  const localEnvironment = { ...env }
  for (const name of ['LOOM_CLIENT_TOKEN', 'LOOM_BASE_URL', 'LOOM_SERVER_CMD', 'LOOM_TARGET_BINARY',
    'DSH_HOME', 'LOOM_ENABLE_LOCAL_HARDWARE_PROBE', 'LOOM_FIXTURE_CODE_TOOL_ERROR_AFTER_EDIT']) delete localEnvironment[name]
  const result = {
    schema: 'loom.deterministic-baseline.v2', overall: 'FAIL', mode: 'deterministic',
    started_at: startedAt, finished_at: null,
    repository: { commit: toolVersion('git', ['rev-parse', 'HEAD']), dirty_worktree: true },
    environment: { platform: process.platform, arch: process.arch, node: process.version,
      cargo: toolVersion('cargo', ['--version']), pnpm: toolVersion('pnpm', ['--version']),
      fixture_isolation: 'owned temporary roots per scenario; loopback HTTP only', external_center_used: false },
    synthetic_coordinator: { status: 'NOT_RUN', reason: 'Synthetic fixture is deliberately excluded; real Rust is the sole task authority.' },
    scenarios: [], suites: [], not_run: Object.fromEntries(NOT_RUN),
    artifacts: [],
  }
  let scenarioDirectory, error
  try {
    if (includeIntegration) {
      scenarioDirectory = join(outputDirectory, 'scenario')
      await mkdir(scenarioDirectory, { mode: 0o700 })
      const started = performance.now()
      const flow = await runRealDeterministicFlow({ root: scenarioDirectory, console: output, env: localEnvironment })
      result.scenarios.push({ id: 'real-rust-ts-single-host', status: flow.overall, exit_code: flow.overall === 'PASS' ? 0 : 1,
        duration_ms: Math.round(performance.now() - started), center: 'rust', physical_hosts: 1,
        checks: flow.checks, ...(flow.error ? { error: flow.error } : {}) })
      // Preserve one real input-derived Artifact, not a hand-written success fixture.
      try {
        const artifact = await readFile(join(scenarioDirectory, 'read-artifact.json'), 'utf8')
        JSON.parse(artifact)
        const sha = sha256(artifact)
        await writeFile(join(outputDirectory, 'observed-read-artifact.json'), artifact, { mode: 0o600 })
        result.artifacts.push({ path: 'observed-read-artifact.json', sha256: sha })
      } catch (cause) {
        const failure = `Observed Artifact was not persisted by the runner: ${cleanText(cause.message)}`
        result.scenarios[0].status = 'FAIL'
        result.scenarios[0].exit_code = 1
        result.scenarios[0].checks.push({ id: 'observed_artifact_persisted', kind: 'evidence', status: 'FAIL', evidence: failure })
        result.scenarios[0].error = failure
      }
    }
    for (const suite of SUITE_CATALOG) {
      if (!includeSuites) { result.suites.push({ ...suite, command: [suite.command, ...suite.args], status: 'NOT_RUN', exit_code: null, reason: 'integration-only selected' }); continue }
      const entry = await runSuite(suite, { outputDirectory, env: localEnvironment })
      result.suites.push(entry)
      output.log(`${entry.status} ${entry.id} exit=${entry.exit_code}`)
    }
  } catch (cause) { error = cleanText(cause.stack || cause, 8000) }
  result.repository.dirty_worktree = spawnSync('git', ['status', '--porcelain'], { cwd: REPOSITORY, encoding: 'utf8' }).stdout.trim().length > 0
  result.overall = error || result.scenarios.some(item => item.status === 'FAIL') || result.suites.some(item => item.status === 'FAIL') ? 'FAIL' : 'PASS'
  result.finished_at = new Date().toISOString()
  if (error) result.error = error
  const jsonPath = join(outputDirectory, 'result.json')
  const markdownPath = join(outputDirectory, 'summary.md')
  await writeFile(jsonPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  const markdown = [
    '# Loom deterministic baseline result', '', `- Schema: \`${result.schema}\``, `- Overall: **${result.overall}**`,
    `- Started: ${result.started_at}`, `- Finished: ${result.finished_at}`, `- Commit: ${result.repository.commit}`,
    `- Dirty worktree: ${result.repository.dirty_worktree}`, '', '## Real single-host HTTP flow', '',
    ...result.scenarios.flatMap(scenario => [`### ${scenario.id}: ${scenario.status}`, '', '| Check | Kind | Status |', '| --- | --- | --- |',
      ...scenario.checks.map(check => `| ${check.id} | ${check.kind} | ${check.status} |`), '']),
    '## Commands', '', '| Suite | Command | Exit | Status | Artifact logs |', '| --- | --- | --- | --- | --- |',
    ...result.suites.map(suite => `| ${suite.id} | \`${suite.command.join(' ')}\` | ${suite.exit_code ?? 'null'} | ${suite.status} | ${suite.artifacts?.join(', ') || 'none'} |`),
    '', '## NOT RUN', '', ...Object.entries(result.not_run).map(([id, reason]) => `- **${id}**: ${reason}`),
    '', 'No SyntheticCoordinator, real DSH Profile, live model or external coordinator was used. This is one-machine evidence only.', '',
  ].join('\n')
  await writeFile(markdownPath, markdown, { mode: 0o600 })
  output.log(`OVERALL ${result.overall}`)
  output.log(`RESULT ${jsonPath}`)
  output.log(`SUMMARY ${markdownPath}`)
  return { overall: result.overall, exit_code: result.overall === 'PASS' ? 0 : 1, result }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runBaseline()
    process.exitCode = result.exit_code
  } catch (error) {
    console.error(`FAIL ${cleanText(error.stack || error, 6000)}`)
    process.exitCode = 1
  }
}
