#!/usr/bin/env node
/** One actual isolated DSH Agent/tool execution with a real ACK response lost.
 * A separately archived pre-change bundle first proves what this repairs.
 * No production Profile, online model, provider credential or multi-Host topology.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, realpath, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { installBundles, isolatedEnv, fixtureRoot, installation, repository, sleep } from './environment.mjs'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

const execute = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function waitTicket(admin, id, states, timeout = 60_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const detail = await admin.get(`/api/v1/tickets/${id}`)
    if (states.includes(detail.status)) return detail
    await sleep(150)
  }
  throw new Error(`DSH ticket did not reach ${states.join('/')}: ${id}`)
}
function controls(root) {
  return readFile(join(root, 'private', 'fixture-control.jsonl'), 'utf8').then(value => value.split('\n').filter(Boolean).map(line => JSON.parse(line)), () => [])
}
async function readState(root) {
  return JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
}
async function installScene({ before = false } = {}) {
  const root = await realpath(await fixtureRoot())
  const projectRoot = await realpath(join(root, 'project'))
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  const server = await startRustConcierge({ root: join(root, 'rust'), env: { ...isolatedEnv(root), PATH: process.env.PATH } })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
  const project = await admin.post('/api/v1/projects', { name: 'Controlled ACK response-loss host', root: projectRoot, mode: 'read_write' })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const sourceOverrides = {}
  let sourceRevision
  if (before) {
    sourceRevision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
    const archiveRoot = join(root, 'historic-source')
    const archive = join(root, 'before-bundle.tar')
    await mkdir(archiveRoot, { mode: 0o700 })
    await execute('git', ['archive', '--format=tar', `--output=${archive}`, sourceRevision, 'plugins/dsh-loom'], { cwd: repository })
    // The archive contains only the explicitly named repository/package subtree.
    await execute('tar', ['-xf', archive, '-C', archiveRoot])
    sourceOverrides['dsh-loom'] = join(archiveRoot, 'plugins', 'dsh-loom')
  }
  const env = isolatedEnv(root, { LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl,
    LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code,
    LOOM_FIXTURE_ACK_RESPONSE_LOSS: 'hold',
    LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [projectId]: projectRoot }) })
  const { cli, executable } = installation()
  await installBundles({ env, root, cli, executable, sourceOverrides, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
  const host = await new FixtureHost(root, env, [server.clientToken, enrollment.code]).start()
  const deadline = Date.now() + 45_000
  let node
  while (!node) {
    const snapshot = await admin.get('/api/v1/nodes')
    node = snapshot.nodes.find(value => value.status === 'online' && value.inventory?.project_roots?.[projectId] === projectRoot)
    if (!node && Date.now() > deadline) throw new Error('No real registered DSH Node for this scoped file project')
    if (!node) await sleep(200)
  }
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: projectRoot })
  const grant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: node.id, worker_id: 'default', operations: ['read', 'write'] })
  const ticket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: node.id, worker_id: 'default', grant_id: grant.grant.id,
    kind: 'edit_file', relative_path: 'demo.html', objective: 'One ordinary authorized file operation after a real admission response loss. LOOM_FIXTURE_FILE_WRITE' })
  assert.equal(ticket.assignments.length, 1)
  return { root, projectRoot, server, admin, host, env, node, binding, grant, ticket, projectId, before, sourceRevision }
}

async function beforeScene(scene) {
  const { root, host, admin, ticket, before } = scene
  assert.equal(before, true)
  const assignment = ticket.assignments[0]
  const detail = await waitTicket(admin, ticket.id, ['reconciling', 'failed', 'cancelled'], 45_000)
  await host.stop()
  const state = await readState(root)
  const log = await controls(root)
  const losses = log.filter(entry => entry.type === 'ack-http-200-discarded' && entry.assignment_id === assignment.id)
  assert.equal(losses.length, 1, 'The archived bundle must actually lose the successfully read real ACK response')
  assert.equal(log.filter(entry => entry.type === 'tool-execute' && entry.name === 'loom_fixture_write').length, 0, 'The original client drops this Assignment immediately after ACK failure, before any actual SDK tool starts')
  assert.equal(state.outbox.filter(item => item.kind === 'ack').length, 0, 'The pre-change client has no recoverable ACK intent')
  assert.ok(losses[0].acknowledged_at)
  assert.equal(detail.reports.length, 1)
  assert.equal(detail.reports[0].state, 'unknown')
  await assert.rejects(() => readFile(join(scene.projectRoot, 'demo.html')), error => error.code === 'ENOENT')
  const database = new DatabaseSync(join(scene.server.dataDir, 'loom.sqlite3'), { readOnly: true })
  try {
    const audits = database.prepare("SELECT COUNT(*) AS n FROM audits WHERE ticket_id=? AND action='assignment.acknowledged'").get(ticket.id)
    assert.equal(audits.n, 1, 'The controller already has its first Admission despite the unobserved response')
    assert.equal(database.prepare('SELECT acknowledged_at FROM assignments WHERE id=?').get(assignment.id).acknowledged_at, losses[0].acknowledged_at)
  } finally { database.close() }
  return { root, outcome: 'REPRODUCED', archived_commit: scene.sourceRevision, first_ack_committed: true,
    no_durable_ack_intent: true, original_tool_terminated_after_lost_ack: true,
    actual_tool_executions: 0, report_outcome: 'unknown/reconciling_not_execution_success', ticket_status: detail.status }
}

async function repairedScene(scene) {
  const { root, admin, host, ticket, env } = scene
  const assignment = ticket.assignments[0]
  await host.waitFor(async () => {
    const state = await readState(root)
    const kinds = state.outbox.filter(item => item.body.assignment_id === assignment.id).map(item => item.kind)
    return state.completions[assignment.id]?.state === 'succeeded'
      && new Set(kinds).size === 3 && ['ack', 'artifact', 'report'].every(kind => kinds.includes(kind))
  }, 45_000, 'one original DSH file effect and ACK/artifact/report persistence')
  const beforeRestart = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.equal(beforeRestart.reports.length, 0, 'The pending ACK must not let the Report overtake delivery')
  assert.equal(beforeRestart.artifacts.length, 0)
  assert.equal(beforeRestart.effects.length, 0)
  const persisted = await readState(root)
  const pending = persisted.outbox.filter(item => item.body.assignment_id === assignment.id)
  assert.deepEqual(new Set(pending.map(item => item.kind)), new Set(['ack', 'artifact', 'report']))
  const requestId = pending.find(item => item.kind === 'ack').body.request_id
  const originalSession = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
  const sessions = originalSession.assignments.filter(entry => entry.assignment_id === assignment.id)
  assert.equal(sessions.length, 1)
  const sessionId = sessions[0].session_id
  assert.ok(sessionId)
  const originalFile = await readFile(join(scene.projectRoot, 'demo.html'))
  const lost = (await controls(root)).filter(entry => entry.type === 'ack-http-200-discarded' && entry.assignment_id === assignment.id)
  assert.equal(lost.length, 1, 'Only a genuinely successful ACK response causes the hold')
  const firstTime = lost[0].acknowledged_at
  assert.ok(firstTime)
  assert.equal(beforeRestart.assignments[0].acknowledged_at, firstTime)
  assert.equal(host.sessionEvents(sessionId, ['tool/call']).length, 1)
  const writeCalls = (await controls(root)).filter(entry => entry.type === 'tool-execute' && entry.name === 'loom_fixture_write')
  assert.equal(writeCalls.length, 1)
  await host.stop()

  const reopenedEnv = { ...env, LOOM_FIXTURE_ACK_RESPONSE_LOSS: 'replay', LOOM_FIXTURE_ENROLLMENT_CODE: '', LOOM_FIXTURE_AGENT_SESSION_ID: '' }
  const replacement = await new FixtureHost(root, reopenedEnv, [scene.server.clientToken]).start()
  let final
  try {
    final = await waitTicket(admin, ticket.id, ['succeeded', 'failed', 'reconciling', 'cancelled'], 60_000)
    assert.equal(final.status, 'succeeded', JSON.stringify(final.reports))
    assert.equal(final.reports.length, 1)
    assert.equal(final.artifacts.length, 1)
    assert.equal(final.effects.length, 1)
    assert.equal(final.effects[0].status, 'confirmed')
    const artifact = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${final.artifacts[0].id}`)
    const bytes = Buffer.from(artifact.content, 'utf8')
    assert.deepEqual(bytes, originalFile, 'The real SDK Artifact is the same bounded file, not a synthetic completion or repeated second write')
    assert.equal(artifact.artifact.sha256, sha256(bytes))
    assert.equal(artifact.size_bytes, bytes.length)
    assert.equal(sha256(bytes), sha256(originalFile))
    assert.equal(final.assignments[0].acknowledged_at, firstTime, 'Replay must return the original audited Admission timestamp')
    const reopenedState = await readState(root)
    assert.equal(reopenedState.outbox.filter(item => item.kind === 'artifact' || item.kind === 'report' || item.kind === 'ack').length, 0)
    const acceptedAck = reopenedState.deliveries.find(item => item.kind === 'ack' && item.body.assignment_id === assignment.id)
    assert.equal(acceptedAck.body.request_id, requestId, 'The pending ACK retains the original request ID through the real host restart')
    assert.equal(acceptedAck.response.acknowledged_at, firstTime)
    assert.equal(acceptedAck.response.duplicate, true)
    const replayLog = (await controls(root)).filter(entry => entry.type === 'ack-http-replay-accepted' && entry.assignment_id === assignment.id)
    assert.ok(replayLog.length > 0, 'The second real transport must be observed, not imagined from a local queue')
    assert.ok(replayLog.every(entry => entry.request_id === requestId && entry.acknowledged_at === firstTime && entry.duplicate === true))
    const afterLog = await controls(root)
    assert.equal(afterLog.filter(entry => entry.type === 'ack-http-200-discarded' && entry.assignment_id === assignment.id).length, 1)
    assert.equal(afterLog.filter(entry => entry.type === 'tool-execute' && entry.name === 'loom_fixture_write').length, 1, 'No second DSH tool effect is created by recovering ordinary ACK transport')
    const mapAfter = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
    assert.deepEqual(mapAfter.assignments.filter(entry => entry.assignment_id === assignment.id), sessions, 'Recovery reuses the same Session identity, never restarts as another task/Session')
    assert.deepEqual(await readFile(join(scene.projectRoot, 'demo.html')), originalFile)
    const database = new DatabaseSync(join(scene.server.dataDir, 'loom.sqlite3'), { readOnly: true })
    try {
      const audits = database.prepare("SELECT actor,action,evidence FROM audits WHERE ticket_id=? AND action='assignment.acknowledged'").all(ticket.id)
      assert.equal(audits.length, 1, 'Two real ACK HTTP exchanges share one original audited Admission')
      assert.equal(audits[0].actor, 'node')
      const evidence = JSON.parse(audits[0].evidence).evidence
      assert.equal(evidence.assignment_id, assignment.id)
      assert.equal(evidence.delivered_is_not_read, true)
      assert.equal(database.prepare('SELECT acknowledged_at FROM assignments WHERE id=?').get(assignment.id).acknowledged_at, firstTime)
      assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 1, 'Reopen uses the saved Node enrollment and identity, not another logical host')
    } finally { database.close() }
    assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
    return { overall: 'PASS', root, ticket_id: ticket.id, assignment_id: assignment.id, original_acknowledged_at: firstTime,
      real_dsh_tool_file_effect: true, actual_tool_execution_count: 1, first_partial_delivery_before_restart: { reports: 0, artifacts: 0, effects: 0, persisted: ['ack', 'artifact', 'report'] },
      replay_sequence: ['ack(lost response)', 'ack(original receipt after real restart)', 'artifact', 'report'],
      original_ack_audit_count: 1, final_reports: 1, final_artifacts: 1, final_effects: 1,
      original_session_preserved: true, identical_file_bytes: true, artifact_sha256: sha256(bytes), artifact_size_bytes: bytes.length,
      original_ack_request_id_preserved: true, enrolled_node_reused: true, host_restart_actual: true,
      not_claimed: ['global exactly-once', 'arbitrary mid-tool interruption exactly-once', 'additional Harness', 'live model/provider', 'physical multi-host or phone', '1 CONCIERGE + 3 Node Compose'] }
  } finally { await replacement.stop() }
}

const output = process.env.LOOM_TEST_OUTPUT ? resolve(process.env.LOOM_TEST_OUTPUT) : undefined
let first, second, outcome
try {
  first = await installScene({ before: true })
  const before = await beforeScene(first)
  second = await installScene()
  const after = await repairedScene(second)
  outcome = { schema: 'loom.dsh-ack-response-replay.v1', overall: 'PASS', scenario: 'true active DSH Host plus genuine Node HTTP/SQLite and a bounded real file effect',
    before, after, external_llm: 'NOT RUN', external_services: 'NOT RUN', production_profile_used: false }
} catch (error) {
  outcome = { schema: 'loom.dsh-ack-response-replay.v1', overall: 'FAIL', error: error.stack || error.message,
    before_root: first?.root, repaired_root: second?.root, before_host_diagnostics: first?.host?.diagnostics(), repaired_host_diagnostics: second?.host?.diagnostics() }
  process.exitCode = 1
} finally {
  if (first?.host) await first.host.stop().catch(() => {})
  if (second?.host) await second.host.stop().catch(() => {})
  if (first?.server) await first.server.stop().catch(() => {})
  if (second?.server) await second.server.stop().catch(() => {})
  if (output) await writeFile(output, JSON.stringify(outcome, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(outcome, null, 2))
}
