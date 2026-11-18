#!/usr/bin/env node
/** A deliberately tiny, real DSH code-edit + fixed node:test worker fixture.
 * No external model/upload/network, generic shell or production file-tool route.
 * This scenario is offline zero-network stub Agent execution with actual DSH sessions.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { installation, isolatedEnv, fixtureRoot, installBundles, redact, sleep } from './environment.mjs'
import { pathToFileURL } from 'node:url'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { CODE_FIXTURE_SOURCE, CODE_FIXTURE_TEST } from './fixtures/stub-provider/code-tools.js'
import { sha256 } from '../../packages/node-client/src/util.js'
import { chromium } from '../browser/node_modules/playwright-core/index.mjs'

const output = process.env.LOOM_TEST_OUTPUT
const execute = promisify(execFile)
const expected = CODE_FIXTURE_SOURCE.replace('return a - b;', 'return a + b;')
const initialSha = sha256(Buffer.from(CODE_FIXTURE_SOURCE))
let server, host, context, preview
let settled = false
const browserReports = []
let root
const checks = []
const pass = (name, evidence = {}) => { checks.push({ name, status: 'PASS', evidence }); console.log(`PASS ${name}`) }
const report = (overall, diagnostics = '') => ({
  schema: 'loom.real-code-task.v1', overall, checks,
  target: 'one owned clean Git source + isolated real DSH Agent + bounded public source/test tools + actual node:test',
  restricted_protocol: 'existing edit_file; current exact write Grant; no new Ticket type or Permission',
  real_dsh: 'session/logs/providers/ctx.tools.register observed; zero-network loom-stub only',
  browser: browserReports,
  framework_scope: 'Only the explicit local fixture code listener is available; no stock model editor or arbitrary command execution is enabled.',
  external_llm: 'NOT RUN', external_services: 'NOT RUN', production_profile_used: false,
  not_claimed: ['arbitrary LLM programming quality', 'arbitrary Shell/tool execution', 'automatic worktree preservation outside this fixture',
    'git remote/network', 'multi-host or mobile lifecycle', 'generic Pipeline/Reviewer model', 'distributed exactly-once'],
  diagnostics: diagnostics.slice(-5000),
})

try {
  root = await realpath(await fixtureRoot())
  await mkdir(join(root, 'project', 'src')); await mkdir(join(root, 'project', 'test'))
  const projectRoot = await realpath(join(root, 'project'))
  const envGit = { PATH: '/usr/bin:/bin', HOME: projectRoot, TMPDIR: projectRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = async (...args) => {
    try { return await execute('/usr/bin/git', ['--no-pager', '-c', 'diff.external=', ...args], { cwd: projectRoot, env: envGit, shell: false, timeout: 10_000 }) }
    catch (error) { throw new Error(`Bounded fixture Git step ${args.join(' ')} failed: ${String(error.stdout || '')}\n${String(error.stderr || '')}\n${String(error.message)}`) }
  }
  const newProject = async ({ failingAfterFix = false } = {}) => {
    await mkdir(join(projectRoot, 'src'), { recursive: true, mode: 0o700 })
    await mkdir(join(projectRoot, 'test'), { recursive: true, mode: 0o700 })
    await writeFile(join(projectRoot, 'package.json'), '{"name":"loom-isolated-code-example","private":true,"type":"module"}\n', { mode: 0o600 })
    await writeFile(join(projectRoot, 'src', 'calc.js'), CODE_FIXTURE_SOURCE, { mode: 0o600 })
    const testBytes = failingAfterFix ? CODE_FIXTURE_TEST.replace('assert.equal(add(2, 3), 5)', 'assert.equal(add(2, 3), 3)') : CODE_FIXTURE_TEST
    await writeFile(join(projectRoot, 'test', 'calc.test.js'), testBytes, { mode: 0o600 })
    await runTests(false)
    await git('init', '--quiet', '.')
    await git('add', '--', 'package.json', 'src/calc.js', 'test/calc.test.js')
    await git('-c', 'user.name=Loom Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Intentional source-bug fixture')
    assert.equal((await git('status', '--porcelain=v1', '--untracked-files=all')).stdout, '')
  }
  const runTests = async (expectPass) => {
    const result = await execute(process.execPath, ['--test', 'test/calc.test.js'], { cwd: projectRoot,
      env: { PATH: '/usr/bin:/bin', TMPDIR: projectRoot }, shell: false, maxBuffer: 8192, timeout: 10_000 }).then(out => ({ ...out, code: 0 }), error => ({ ...error, code: error.code }))
    assert.equal(result.code, expectPass ? 0 : 1, `Actual baseline/final test must be ${expectPass ? 'success' : 'failure'}: ${result.stderr || result.stdout}`)
    return result
  }
  await newProject()
  pass('actual owned example Git repo is clean and the unmodified source test genuinely fails', { initial_sha256: initialSha, command: ['node', '--test', 'test/calc.test.js'] })
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  server = await startRustConcierge({ root: join(root, 'rust'), env: { PATH: process.env.PATH } })
  let admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
  const project = await admin.post('/api/v1/projects', { name: 'Bounded source code example, not a real user repo', root: projectRoot, mode: 'read_write' })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const env = isolatedEnv(root, { LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl,
    LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code, LOOM_FIXTURE_CODE_TOOLS: 'true',
    LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [projectId]: projectRoot }) })
  const { executable, cli } = installation()
  await installBundles({ env, root, cli, executable, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
  host = await new FixtureHost(root, env, [server.clientToken, enrollment.code]).start()
  const deadline = Date.now() + 45_000
  let node
  while (!node) {
    const snapshot = await admin.get('/api/v1/nodes')
    node = snapshot.nodes.find(value => value.status === 'online' && value.inventory?.project_roots?.[projectId] === projectRoot)
    if (!node && Date.now() > deadline) throw new Error('The actual DSH Node never registered the exact source-code project root')
    if (!node) await sleep(200)
  }
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: projectRoot })
  const grant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id,
    node_id: node.id, worker_id: 'default', operations: ['read', 'write'], grant_id: undefined })
  pass('actual isolated DSH Node registration and exact current write Grant, not automatic code execution', { node_id: node.id, fixed_project_binding: binding.id })
  const task = objective => admin.post('/api/v1/tickets', { project_id: projectId, node_id: node.id, worker_id: 'default',
    grant_id: grant.grant.id, kind: 'edit_file', relative_path: 'src/calc.js', content: expected,
    objective: `Fix the small mathematical defect in the existing example program, preserving its API. LOOM_FIXTURE_CODE_TASK ${objective}` })
  const terminal = async ticket => {
    const expires = Date.now() + 75_000
    while (Date.now() < expires) {
      const detail = await admin.get(`/api/v1/tickets/${ticket.id}`)
      if (['succeeded', 'failed', 'reconciling', 'cancelled'].includes(detail.status)) return detail
      await sleep(150)
    }
    const final = await admin.get(`/api/v1/tickets/${ticket.id}`)
    const persisted = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
    const pending = persisted.outbox.filter(item => item.body.ticket_id === ticket.id).map(item => ({
      kind: item.kind, attempts: item.attempts, last_error: item.last_error,
      requested_state: item.body.requested_state, cancel_acknowledged: item.body.cancel_acknowledged,
      effects: item.body.effects?.map(effect => ({ id: effect.effect_id, status: effect.status, assignment_id: effect.assignment_id })),
    }))
    const memory = final.assignments?.[0] ? persisted.completions[final.assignments[0].id] : undefined
    if (process.env.LOOM_TEST_OUTPUT) await writeFile(join(dirname(process.env.LOOM_TEST_OUTPUT), 'cancel-debug.log'), redact(host.stderr.join('')), { mode: 0o600 })
    throw new Error(redact(`Code Ticket ${ticket.id} did not reach a definite evidence state: ${JSON.stringify({ status: final.status, cancel: final.cancel_requested, reports: final.reports?.length, completion: memory?.state, summary: memory?.summary, acknowledgement: memory?.cancel_acknowledged, pending })}`))
  }
  const assertion = async ({ failedTest = false, resetFixture = false } = {}) => {
    const ticket = await task('with real tests')
    const done = await terminal(ticket)
    assert.equal(done.status, failedTest ? 'failed' : 'succeeded', JSON.stringify(done.reports))
    assert.equal(done.reports.length, 1)
    assert.equal(done.reports[0].state, failedTest ? 'failed' : 'succeeded')
    assert.equal(done.effects.length, 1)
    assert.equal(done.effects[0].status, 'confirmed')
    assert.equal(done.assignments.length, 1)
    assert.equal(done.artifacts.length, 2)
    const diffMeta = done.artifacts.find(entry => entry.media_type === 'text/x-diff')
    const verifyMeta = done.artifacts.find(entry => entry.media_type === 'application/json')
    assert.ok(diffMeta && verifyMeta)
    // `diffMeta.sha256` belongs to the unified-diff bytes. It is not a malformed self-hash of its hex string,
    // and must not be confused with the source file digest. Downloaded bytes are checked below.
    const [diffDownload, reportDownload, directDiff, reportNative] = await Promise.all([
      admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${diffMeta.id}`),
      admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${verifyMeta.id}`),
      git('diff', '--no-ext-diff', '--no-color', '--unified=3', '--', 'src/calc.js'),
      runTests(!failedTest),
    ])
    assert.equal(diffDownload.artifact.sha256, sha256(Buffer.from(diffDownload.content)))
    assert.equal(reportDownload.artifact.sha256, sha256(Buffer.from(reportDownload.content)))
    assert.equal(diffDownload.content, directDiff.stdout)
    assert.match(diffDownload.content, /-  return a - b;/)
    assert.match(diffDownload.content, /\+  return a \+ b;/)
    const verification = JSON.parse(reportDownload.content)
    assert.equal(verification.schema, 'loom.code-verification.v1')
    assert.equal(verification.exit_code, failedTest ? 1 : 0)
    assert.equal(verification.passed, !failedTest)
    assert.equal(verification.previous_test_exit_code, 1)
    assert.equal(verification.sha256, sha256(Buffer.from(expected)))
    assert.deepEqual(verification.command, { file: 'node', args: ['--test', 'test/calc.test.js'] })
    assert.equal(verification.source_change_artifact_id, diffMeta.id)
    assert.ok(verification.dsh_session?.session_id)
    assert.equal(reportDownload.artifact.sha256, sha256(Buffer.from(reportDownload.content)))
    const mapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
    const sessionId = mapping.assignments.find(entry => entry.assignment_id === done.assignments[0].id)?.session_id
    assert.equal(sessionId, verification.dsh_session.session_id)
    const codeCalls = host.sessionEvents(sessionId, ['tool/call'])
    assert.equal(codeCalls.filter(entry => entry.event.data.name === 'loom_fixture_code_edit').length, 1)
    assert.equal(codeCalls.filter(entry => entry.event.data.name === 'loom_fixture_verify').length, 1)
    assert.equal(host.sessionEvents(sessionId, ['tool/result']).filter(entry => entry.event.data.message?.isError === true).length, 0)
    assert.equal(host.sessionEvents(sessionId, ['turn/end']).at(-1).event.data.reason.kind, 'completed')
    assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), Buffer.from(expected))
    assert.equal((await runTests(!failedTest)).code, failedTest ? 1 : 0)
    let sessionLinked = false
    let sessionMessages = []
    for (let attempt = 0; attempt < 30 && !sessionLinked; attempt++) {
      sessionMessages = (await admin.get(`/api/v1/tickets/${ticket.id}`)).messages
      sessionLinked = sessionMessages.some(message => {
        if (message.kind !== 'session_link') return false
        const reference = typeof message.session_ref === 'string' ? JSON.parse(message.session_ref) : message.session_ref
        return reference?.session_id === sessionId
      })
      if (!sessionLinked) await sleep(150)
    }
    if (!sessionLinked) console.error('CODE_SESSION_LINK', JSON.stringify(sessionMessages.map(message => ({ kind: message.kind, visibility: message.visibility, session_ref: message.session_ref }))))
    assert.equal(sessionLinked, true, 'The real node session_link must reach the controller, not only the local Session mapping')
    pass('actual DSH Agent emits one scoped edit and one scoped test; actual diff and test Artifact match bytes', { ticket: ticket.id, session_id: sessionId,
      effect: done.effects[0].id, status: done.status, test_exit_code: verification.exit_code, artifact_ids: done.artifacts.map(entry => entry.id) })
    return { ticket, done, sessionId, diffMeta, verification }
  }

  // Do not silently classify the initial failing fixture change as a passing task.
  await rm(join(projectRoot, 'src'), { recursive: true, force: true })
  await rm(join(projectRoot, 'test'), { recursive: true, force: true })
  await rm(join(projectRoot, '.git'), { recursive: true, force: true })
  await rm(join(projectRoot, 'package.json'), { force: true })
  await newProject({ failingAfterFix: true })
  const first = await assertion({ failedTest: true })
  assert.equal(first.done.effects[0].artifacts.length, 1)
  assert.equal(first.done.effects[0].artifacts[0], first.diffMeta.id, 'The verification Artifact is not a second file Effect')
  pass('real test failure preserves its confirmed source effect and precise nonzero verification, not an invented rollback', { ticket: first.ticket.id, failed_report: first.done.reports[0].state })
  // The test fixture itself, not a hidden Agent rollback, restores a fresh known baseline before explicit retry.
  // Prepare a second clean fixture commit from scratch inputs, preserving
  // the test repository instead of claiming an automatic rollback or new authority.
  await writeFile(join(projectRoot, 'src', 'calc.js'), CODE_FIXTURE_SOURCE, { mode: 0o600 })
  await writeFile(join(projectRoot, 'test', 'calc.test.js'), CODE_FIXTURE_TEST, { mode: 0o600 })
  await git('add', '--', 'package.json', 'src/calc.js', 'test/calc.test.js')
  await git('-c', 'user.name=Loom Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Explicit new clean fixture baseline; not an Agent rollback')
  // One coherent baseline commit, no invisible driver rollback or repeated history generation.
  assert.equal((await git('status', '--porcelain=v1', '--untracked-files=all')).stdout, '')
  assert.equal((await runTests(false)).code, 1)
  // The driver restores the observed test baseline outside the Agent and retains the first history.
  const retry = await admin.post(`/api/v1/tickets/${first.ticket.id}/retry`, {})
  const second = await terminal(retry)
  assert.equal(second.status, 'succeeded')
  assert.equal(second.assignments.length, 2)
  assert.notEqual(second.assignments[0].id, second.assignments[1].id)
  assert.equal(second.reports.length, 2)
  assert.deepEqual(second.reports.map(report => report.state).sort(), ['failed', 'succeeded'])
  assert.equal(second.artifacts.length, 4, 'Each of the two genuine attempts yields a separate diff and verification Artifact')
  assert.equal(new Set(second.artifacts.map(artifact => artifact.id)).size, 4)
  for (const assignment of second.assignments) {
    assert.equal(second.artifacts.filter(artifact => artifact.assignment_id === assignment.id).length, 2)
    assert.equal(second.effects.some(effect => effect.assignment_id === assignment.id && effect.status === 'confirmed'), true)
  }
  const latestAssignmentId = second.assignments[1].id
  const latestArtifacts = second.artifacts.filter(artifact => artifact.assignment_id === latestAssignmentId)
  const latestVerificationMetadata = latestArtifacts.find(entry => entry.media_type === 'application/json')
  assert.ok(latestVerificationMetadata)
  const latestVerify = JSON.parse((await admin.get(`/api/v1/tickets/${second.id}/artifacts/${latestVerificationMetadata.id}`)).content)
  assert.equal(latestVerify.source_change_artifact_id, latestArtifacts.find(entry => entry.media_type === 'text/x-diff').id)
  assert.equal(latestVerify.exit_code, 0)
  assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), Buffer.from(expected))
  pass('explicit retry is a fresh legal Assignment, does not rewrite the earlier failed source/test evidence', { assignments: second.assignments.map(entry => entry.id), reports: 2 })

  const browserEvidence = await showArtifactsInVue({ server, admin, root, ticket: second })
  browserReports.push(browserEvidence)
  pass('production Vue opens the real diff and verification Artifacts from this DSH Ticket', { desktop: 1280, desktop_viewport_only_narrow: 390 })

  // The next owned baseline is explicitly constructed by the driver, not Agent rollback.
  // A user may stop after a real completed source edit and before verification begins.
  await rm(join(projectRoot, 'src'), { recursive: true, force: true })
  await rm(join(projectRoot, 'test'), { recursive: true, force: true })
  await rm(join(projectRoot, '.git'), { recursive: true, force: true })
  await rm(join(projectRoot, 'package.json'), { force: true })
  await newProject()
  const pending = await task('stop before verification LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY')
  await host.waitFor(() => {
    if (!host.diagnostics().includes(`"assignment_id":"${pending.assignments[0].id}"`)) return undefined
    let candidate
    try { candidate = JSON.parse(readFileSync(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    const sessionId = candidate.assignments.find(entry => entry.assignment_id === pending.assignments[0].id)?.session_id
    const verifyCall = host.sessionEvents(sessionId, ['tool/call']).some(call => call.event.data.name === 'loom_fixture_verify')
    return sessionId && verifyCall ? candidate : undefined
  }, 12_000, 'real verification ToolCall held before its test subprocess').catch(async error => {
    const map = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
    const id = map.assignments.find(entry => entry.assignment_id === pending.assignments[0].id)?.session_id
    const details = host.sessionEvents(id, ['tool/call', 'tool/result', 'turn/end']).map(item => ({ type: item.event.type, seq: item.event.seq,
      name: item.event.data.name, result: item.event.data.message?.content?.[0]?.text?.slice(0, 200), reason: item.event.data.reason }))
    throw new Error(`${error.message}\n${JSON.stringify(details)}`)
  })
  const pendingMap = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
  const interruptedSessionId = pendingMap.assignments.find(entry => entry.assignment_id === pending.assignments[0].id)?.session_id
  assert.ok(interruptedSessionId)
  assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), Buffer.from(expected))
  assert.notEqual(sha256(await readFile(join(projectRoot, 'src', 'calc.js'))), initialSha)
  const heldVerifyCall = host.sessionEvents(interruptedSessionId, ['tool/call']).find(call => call.event.data.name === 'loom_fixture_verify')
  assert.ok(heldVerifyCall, 'The exact verifier ToolCall is held before its test subprocess')
  assert.equal(host.sessionEvents(interruptedSessionId, ['tool/result']).some(result => result.event.data.message?.toolCallId === heldVerifyCall.event.data.callId), false, 'No actual test ToolResult exists before user cancellation')
  const interruptedResponse = await admin.post(`/api/v1/tickets/${pending.id}/cancel`, {})
  assert.equal(interruptedResponse.status, 'cancel_requested')
  const interrupted = await terminal(pending)
  assert.equal(interrupted.status, 'reconciling', JSON.stringify(interrupted))
  assert.equal(interrupted.reports.length, 1)
  assert.equal(interrupted.reports[0].state, 'unknown')
  assert.ok([true, 1].includes(interrupted.reports[0].cancel_acknowledged))
  assert.equal(interrupted.effects.length, 1)
  assert.equal(interrupted.effects[0].status, 'confirmed')
  assert.equal(interrupted.artifacts.length, 1)
  assert.equal(interrupted.artifacts[0].media_type, 'text/x-diff')
  assert.equal(interrupted.effects[0].artifacts[0], interrupted.artifacts[0].id)
  const interruptedArtifact = await admin.get(`/api/v1/tickets/${pending.id}/artifacts/${interrupted.artifacts[0].id}`)
  assert.equal(interruptedArtifact.artifact.sha256, sha256(Buffer.from(interruptedArtifact.content)))
  assert.equal(interruptedArtifact.content, (await git('diff', '--no-ext-diff', '--no-color', '--unified=3', '--', 'src/calc.js')).stdout)
  assert.equal(interruptedArtifact.artifact.code_evidence.kind, 'change')
  assert.equal(interruptedArtifact.artifact.code_evidence.path, 'src/calc.js')
  const aborted = host.sessionEvents(interruptedSessionId, ['turn/end']).at(-1)
  assert.equal(aborted.event.data.reason.kind, 'aborted')
  assert.equal(aborted.event.data.reason.reason?.kind, 'user')
  const verifierCalls = host.sessionEvents(interruptedSessionId, ['tool/call']).filter(call => call.event.data.name === 'loom_fixture_verify')
  assert.equal(verifierCalls.length, 1, 'There must be exactly the one verification invocation which was stopped before its test subprocess')
  const verifierResults = host.sessionEvents(interruptedSessionId, ['tool/result'])
  assert.equal(verifierResults.filter(result => result.event.data.message?.toolCallId === verifierCalls[0].event.data.callId).length, 1)
  const abortedResult = verifierResults.find(result => result.event.data.message?.toolCallId === verifierCalls[0].event.data.callId)
  assert.equal(abortedResult.event.data.message.isError, true)
  assert.match(abortedResult.event.data.message.content[0]?.text || '', /Fixture verification cancelled before its test subprocess/)
  assert.equal(interrupted.artifacts.some(artifact => artifact.media_type === 'application/json'), false)
  await pass('completed source edit stays reconciling with its actual byte effect before any test, after real user cancellation', { ticket: pending.id, session_id: interruptedSessionId, effect: interrupted.effects[0].id })

  await host.stop(); host = null
  await server.stop()
  server = await startRustConcierge({ root: join(root, 'rust'), env: { PATH: process.env.PATH } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
  env.LOOM_FIXTURE_ENROLLMENT_CODE = ''
  env.LOOM_FIXTURE_COORDINATOR_URL = server.baseUrl
  host = await new FixtureHost(root, env, [server.clientToken]).start()
  const recoveryDeadline = Date.now() + 10_000
  let interruptedRecovered, recoveryError
  while (!interruptedRecovered && Date.now() < recoveryDeadline) {
    try { interruptedRecovered = await admin.get(`/api/v1/tickets/${pending.id}`) }
    catch (error) {
      recoveryError = error
      const transient = error?.cause?.code === 'ECONNREFUSED' || /fetch failed|ECONNRESET|socket hang up/i.test(String(error?.cause?.message || error?.message || error))
      if (!transient) throw error
      await sleep(100)
    }
  }
  if (!interruptedRecovered) throw new Error(`${server.baseUrl} unavailable after the real restart: ${recoveryError?.cause?.code || recoveryError?.message}`)
  assert.equal(interruptedRecovered.status, 'reconciling')
  assert.deepEqual(interruptedRecovered.reports.map(report => report.id), interrupted.reports.map(report => report.id))
  assert.deepEqual(interruptedRecovered.effects.map(effect => effect.id), interrupted.effects.map(effect => effect.id))
  assert.deepEqual(interruptedRecovered.artifacts.map(artifact => artifact.id), interrupted.artifacts.map(artifact => artifact.id))
  assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), Buffer.from(expected))
  // A fresh Host has no required in-memory copy of the prior Host's EventEmitter
  // array. Either way, no post-abort ToolCall may be introduced by reopening state.
  assert.equal(host.sessionEvents(interruptedSessionId, ['tool/call']).some(call => call.event.seq > aborted.event.seq), false, 'No new source or verifier ToolCall may follow the restored aborted Session')
  await pass('cancelled source diff, unknown report and confirmed source Effect survive center and Host reopen without new execution', { ticket: pending.id, report: interrupted.reports[0].id })

  // A reconciling Cancel Intent is not a fresh authorization to replay the old task.
  const refusedRetry = await fetch(`${server.baseUrl}/api/v1/tickets/${pending.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${server.clientToken}`, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(refusedRetry.status, 400)
  assert.equal((await refusedRetry.json()).error.code, 'invalid_request')
  const noNewAssignment = await admin.get(`/api/v1/tickets/${pending.id}`)
  assert.equal(noNewAssignment.status, 'reconciling')
  assert.equal(noNewAssignment.assignments.length, 1, 'Stopped/reconciling entries cannot automatically mint a new Assignment')
  await rm(join(projectRoot, 'src'), { recursive: true, force: true })
  await rm(join(projectRoot, 'test'), { recursive: true, force: true })
  await rm(join(projectRoot, '.git'), { recursive: true, force: true })
  await rm(join(projectRoot, 'package.json'), { force: true })
  await newProject()
  const fresh = await task('explicit fresh assignment after stopping an earlier edit')
  const freshDone = await terminal(fresh)
  assert.equal(freshDone.status, 'succeeded')
  assert.equal(freshDone.assignments.length, 1)
  assert.equal(freshDone.reports.length, 1)
  assert.equal(freshDone.reports[0].state, 'succeeded')
  assert.equal(freshDone.effects.length, 1)
  assert.equal(freshDone.artifacts.length, 2)
  const freshVerificationMetadata = freshDone.artifacts.find(artifact => artifact.media_type === 'application/json')
  const freshVerification = JSON.parse((await admin.get(`/api/v1/tickets/${fresh.id}/artifacts/${freshVerificationMetadata.id}`)).content)
  assert.equal(freshVerification.passed, true)
  assert.equal(freshVerification.exit_code, 0)
  assert.notEqual(fresh.assignments[0].id, pending.assignments[0].id)
  const freshMapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
  const freshSession = freshMapping.assignments.find(entry => entry.assignment_id === fresh.assignments[0].id)?.session_id
  assert.notEqual(freshSession, interruptedSessionId)
  const stillInterrupted = await admin.get(`/api/v1/tickets/${pending.id}`)
  assert.equal(stillInterrupted.status, 'reconciling')
  assert.deepEqual(stillInterrupted.effects.map(effect => effect.id), interrupted.effects.map(effect => effect.id))
  assert.deepEqual(stillInterrupted.artifacts.map(artifact => artifact.id), interrupted.artifacts.map(artifact => artifact.id))
  await pass('a separately authorized fresh Task completes source editing and real node test without altering interrupted evidence', { old_ticket: pending.id, new_ticket: fresh.id, session_id: freshSession, exit_code: freshVerification.exit_code })

  // Reopen the same center and DSH identity; a completed task must not execute a second editor/test.
  const sourceBytes = await readFile(join(projectRoot, 'src', 'calc.js'))
  const mappingBeforeRestart = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
  const lastSessionSeq = new Map()
  for (const row of mappingBeforeRestart.assignments) {
    lastSessionSeq.set(row.session_id, Math.max(0, ...host.sessionEvents(row.session_id).map(event => event.event.seq || 0)))
  }
  await host.stop(); host = null
  await server.stop()
  server = await startRustConcierge({ root: join(root, 'rust'), env: { PATH: process.env.PATH } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
  env.LOOM_FIXTURE_ENROLLMENT_CODE = ''
  env.LOOM_FIXTURE_COORDINATOR_URL = server.baseUrl
  host = await new FixtureHost(root, env, [server.clientToken]).start()
  await sleep(2200)
  const restored = await new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken }).get(`/api/v1/tickets/${second.id}`)
  assert.equal(restored.status, 'succeeded')
  assert.deepEqual(restored.assignments.map(assignment => assignment.id), second.assignments.map(assignment => assignment.id))
  assert.equal(restored.reports.length, 2)
  assert.equal(restored.effects.length, 2)
  assert.equal(restored.artifacts.length, 4)
  assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), sourceBytes)
  for (const assignment of restored.assignments) {
    const sessionId = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')).assignments.find(entry => entry.assignment_id === assignment.id)?.session_id
    assert.ok(sessionId)
    const freshCalls = host.sessionEvents(sessionId, ['tool/call']).filter(event => event.event.seq > (lastSessionSeq.get(sessionId) || 0)
      && ['loom_fixture_code_edit', 'loom_fixture_verify'].includes(event.event.data?.name))
    assert.equal(freshCalls.length, 0, 'Replaying persisted SDK history cannot become another source edit/test execution')
  }
  pass('real controller and local DSH reopen preserve source, effect lineage, Session mapping and no second execution')
  const db = new DatabaseSync(join(server.dataDir, 'loom.sqlite3'), { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 3)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 4)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 4)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 7)
    assert.deepEqual(second.artifacts.map(entry => entry.id).sort(), restored.artifacts.map(entry => entry.id).sort())
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effects').get().n, 4)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { db.close() }
  const audit = await new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken }).get('/api/v1/audit/verify')
  assert.equal(audit.valid, true)
  assert.equal(audit.algorithm, 'sha256_chain_v1')
  pass('actual durable counts, SQLite integrity and validated audit chain', {
    tickets: 3, assignments: 4, reports: 4, artifacts: 7, effects: 4, stage: 'before_grant_revocation_fixture',
  })
  await scoped_revocation_boundary({ admin, root, projectRoot, grant, env, git, runTests, historicalTickets: [second.id, pending.id, fresh.id], resetProject: async () => {
    await rm(join(projectRoot, 'src'), { recursive: true, force: true })
    await rm(join(projectRoot, 'test'), { recursive: true, force: true })
    await rm(join(projectRoot, '.git'), { recursive: true, force: true })
    await rm(join(projectRoot, 'package.json'), { force: true })
    await newProject()
  } })
  settled = true
  console.log(JSON.stringify(report('PASS'), null, 2))
} catch (error) {
  console.error(error.stack || error)
  console.log(JSON.stringify(report('FAIL', host?.diagnostics?.() || redact(error.message)), null, 2))
  process.exitCode = 1
} finally {
  if (context) await context.close().catch(() => {})
  if (preview) { await new Promise((resolve, reject) => preview.httpServer.close(error => error ? reject(error) : resolve())); preview = null }
  if (host) await host.stop().catch(() => {})
  if (server) await server.stop().catch(() => {})
  if (output) {
    const outputDirectory = join(output, '..')
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
    for (const evidence of browserReports) {
      for (const kind of ['desktop', 'narrow']) {
        const source = evidence[`${kind}_screenshot`]
        if (source) {
          const preserved = output.replace(/\.json$/u, '') + `-${kind}.png`
          await copyFile(source, preserved)
          evidence[`${kind}_screenshot`] = preserved
        }
      }
    }
    if (!settled) await copyFile(join(root, 'node-state', 'node-state.json'), join(dirname(output), 'cancel-node-state.json')).catch(() => {})
    await writeFile(output, JSON.stringify(report(settled ? 'PASS' : 'FAIL'), null, 2), { mode: 0o600 })
  }
  // The target is constructed and canonicalized once from our own mkdtemp fixtureRoot.
  if (root) {
    assert.ok(root.split('/').at(-1).startsWith('loom-dsh-'))
    assert.equal(await realpath(root), root)
    await rm(root, { recursive: true, force: true })
  }
}
async function scoped_revocation_boundary({ admin, root, projectRoot, grant, env, git, runTests, historicalTickets, resetProject }) {
  const record = (name, evidence) => checks.push({ scope: 'grant_revocation_before_subprocess', name, pass: true, evidence })
  const previousSessions = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')).assignments
  const previousSeq = new Map(previousSessions.map(row => [row.session_id,
    Math.max(0, ...host.sessionEvents(row.session_id).map(entry => entry.event.seq || 0))]))
  const countsBefore = await scopedDurableCounts()
  assert.deepEqual(countsBefore, { tickets: 3, assignments: 4, reports: 4, artifacts: 7, effects: 4 })
  const historyBefore = new Map()
  for (const id of historicalTickets) {
    const history = await admin.get(`/api/v1/tickets/${id}`)
    historyBefore.set(id, {
      reports: history.reports.map(row => row.id).sort(),
      artifacts: history.artifacts.map(row => row.id).sort(),
      effects: history.effects.map(row => row.id ?? row.effect_id).sort(),
    })
  }
  const quarantinedAt = new Date(864e13).toISOString()
  assert.equal(Date.parse(quarantinedAt) >= Date.parse('3000-01-01T00:00:00.000Z'), true)
  await resetProject()
  record('fourth revocation fixture is an explicitly driver-owned clean failing Git baseline', { initial_sha256: initialSha })

  const revoked = await admin.post('/api/v1/tickets', { project_id: grant.grant.project_id, node_id: grant.grant.node_id,
    worker_id: 'default', grant_id: grant.grant.id, kind: 'edit_file', relative_path: 'src/calc.js', content: expected,
    objective: 'Revoke authority after the completed scoped edit, before verification; do not rollback. LOOM_FIXTURE_CODE_TASK LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY' })
  assert.equal(revoked.assignments.length, 1)
  const assignmentId = revoked.assignments[0].id
  // Wait for the actual native Agent phase, not only center acknowledged_at.
  // That acknowledgement can arrive while DSH attachment/preflight is still finishing.
  await host.waitFor(async () => {
    const center = await admin.get(`/api/v1/tickets/${revoked.id}`)
    if (!center.assignments[0].acknowledged_at) return undefined
    if (!host.diagnostics().includes(`code-pause-before-verify {"assignment_id":"${assignmentId}"`)) return undefined
    let mapping
    try { mapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    const sessionId = mapping.assignments.find(row => row.assignment_id === assignmentId)?.session_id
    const calls = host.sessionEvents(sessionId, ['tool/call'])
    const editCalls = calls.filter(row => row.event.data.name === 'loom_fixture_code_edit')
    const verifyCalls = calls.filter(row => row.event.data.name === 'loom_fixture_verify')
    if (editCalls.length !== 1 || verifyCalls.length !== 1) return undefined
    const editResult = host.sessionEvents(sessionId, ['tool/result']).find(row => row.event.data.message?.toolCallId === editCalls[0].event.data.callId)
    if (editResult?.event.data.message?.isError !== false) return undefined
    if (host.sessionEvents(sessionId, ['tool/result']).some(row => row.event.data.message?.toolCallId === verifyCalls[0].event.data.callId)) return undefined
    if (!host.diagnostics().includes(`code-pause-before-verify {"assignment_id":"${assignmentId}","session_id":"${sessionId}","phase":"before-test-subprocess"}`)) return undefined
    return { mapping, sessionId }
  }, 12_000, 'fourth original assignment ack and held verifier before its subprocess')
  const mapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
  const sessionId = mapping.assignments.find(row => row.assignment_id === assignmentId)?.session_id
  assert.ok(sessionId)
  assert.equal(previousSessions.some(row => row.assignment_id === assignmentId || row.session_id === sessionId), false)
  assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), Buffer.from(expected))
  const calls = host.sessionEvents(sessionId, ['tool/call'])
  const verifyCall = calls.find(row => row.event.data.name === 'loom_fixture_verify')
  assert.ok(verifyCall)
  const originalRequests = stubRequests(root).filter(row => row.session_id === sessionId)
  const originalCalls = calls.filter(row => ['loom_fixture_code_edit', 'loom_fixture_verify'].includes(row.event.data.name))
  assert.equal(originalCalls.length, 2)
  assert.equal(originalRequests.length, 2, 'Exactly the editor and verifier model requests precede the held test boundary')
  const response = await admin.post('/api/v1/grants/' + grant.grant.id + '/revoke', {})
  assert.equal(response.revoked, true)
  const currentGrant = (await admin.get('/api/v1/grants')).grants.find(row => row.id === grant.grant.id)
  assert.equal(currentGrant.version, grant.grant.version + 1)
  assert.ok(currentGrant.revoked_at)
  assert.equal(currentGrant.digest, grant.grant.digest)
  const revokedDetail = await admin.get(`/api/v1/tickets/${revoked.id}`)
  assert.equal(revokedDetail.status, 'reconciling')
  assert.equal(revokedDetail.cancel_requested, false)
  assert.equal(Boolean(revokedDetail.assignments[0].cancel_requested), false)
  assert.equal(revokedDetail.assignments[0].acknowledged_at !== null, true)
  assert.equal(revokedDetail.assignments[0].last_report_at, null)
  assert.equal(revokedDetail.grant_digest, currentGrant.digest)

  await host.waitFor(() => host.sessionEvents(sessionId, ['turn/end'])
    .some(row => row.event.data.reason?.kind === 'aborted' && row.event.data.reason?.reason?.kind === 'user'), 15_000,
  'native user abort following Grant revocation, not the verifier gate timeout')
  const aborted = host.sessionEvents(sessionId, ['turn/end'])
    .findLast(row => row.event.data.reason?.kind === 'aborted' && row.event.data.reason?.reason?.kind === 'user')
  assert.ok(aborted, 'The real Agent aborted its bound turn with the native user cause captured above')
  assert.ok(aborted.event.seq > verifyCall.event.seq)
  const abortedResult = host.sessionEvents(sessionId, ['tool/result'])
    .find(row => row.event.data.message?.toolCallId === verifyCall.event.data.callId)
  assert.ok(abortedResult)
  assert.equal(abortedResult.event.data.message.isError, true)
  assert.match(abortedResult.event.data.message.content[0]?.text || '', /Fixture verification cancelled before its test subprocess/)
  assert.equal(abortedResult.event.seq < aborted.event.seq, true)
  assert.equal(host.sessionEvents(sessionId, ['tool/result']).some(row => JSON.stringify(row.event.data.message).includes('loom.fixture-code-verification.v1')), false)
  assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), Buffer.from(expected))
  assert.equal((await runTests(true)).code, 0, 'The edited source actually passes; retaining bytes is not a fake failing fixture')

  const readFence = async () => {
    const detail = await admin.get(`/api/v1/tickets/${revoked.id}`)
    const state = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
    const entries = state.outbox.filter(row => row.body.assignment_id === assignmentId && ['artifact', 'report'].includes(row.kind))
    const artifact = entries.find(row => row.kind === 'artifact')
    const report = entries.find(row => row.kind === 'report')
    return artifact?.attempts >= 1 && report?.attempts >= 1 &&
      artifact.next_attempt_at === quarantinedAt && report.next_attempt_at === quarantinedAt
  }
  await host.waitFor(readFence, 15_000, 'real Artifact and original Report HTTP rejection with durable quarantine')
  const detail = await admin.get(`/api/v1/tickets/${revoked.id}`)
  const state = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
  const localEntries = state.outbox.filter(row => row.body.assignment_id === assignmentId && ['artifact', 'report'].includes(row.kind))
  const artifact = localEntries.find(row => row.kind === 'artifact')
  const report = localEntries.find(row => row.kind === 'report')
  assert.ok(artifact && report)
  assert.equal(artifact.body.metadata.name, `code-change-${assignmentId}.diff`)
  assert.equal(Buffer.from(artifact.body.bytes_base64, 'base64').toString(),
    (await git('diff', '--no-ext-diff', '--no-color', '--unified=3', '--', 'src/calc.js')).stdout)
  assert.equal(detail.status, 'reconciling')
  assert.equal(detail.cancel_requested, false)
  assert.deepEqual(detail.reports, [])
  assert.deepEqual(detail.effects, [])
  assert.deepEqual(detail.artifacts, [])
  for (const entry of [artifact, report]) {
    const status = Number(entry.last_error.match(/^Loom HTTP (\d{3}) /)?.[1])
    assert.ok(status >= 400, entry.last_error)
    assert.equal(entry.next_attempt_at, quarantinedAt)
    assert.equal(entry.delivery_at, undefined)
    assert.equal(entry.body.ticket_id, revoked.id)
    assert.equal(entry.body.assignment_id, assignmentId)
    assert.equal(entry.body.lease_epoch, revoked.assignments[0].lease_epoch)
    assert.equal(entry.body.node_id, grant.grant.node_id)
    assert.ok(/^[a-f0-9]{64}$/.test(entry.digest))
    assert.equal(entry.body.request_id, entry.digest)
  }
  assert.match(artifact.last_error, /^Loom HTTP 409 outcome_unknown\b/)
  assert.match(report.last_error, /^Loom HTTP (?:409 effect_unknown|403 artifact_lineage)\b/)
  assert.equal(state.completions[assignmentId].assignment_id, assignmentId)
  assert.equal(state.completions[assignmentId].state, 'unknown')
  assert.equal(state.assignments[assignmentId].revocation.schema, 'loom.local-revocation-view.v1')
  assert.equal(state.assignments[assignmentId].revocation.authority, false)
  assert.equal(state.assignments[assignmentId].revocation.version, currentGrant.version)
  assert.equal(state.assignments[assignmentId].revocation.grant_status, false)
  assert.equal(state.assignments[assignmentId].grant_version, grant.grant.version)
  assert.equal(state.assignments[assignmentId].cancel_requested, true, 'Local adapter/native stop intent is not a center Ticket acknowledgement')
  assert.equal(state.completions[assignmentId].cancel_acknowledged, true)
  assert.equal(report.body.cancel_acknowledged, true)
  const stop = state.completions[assignmentId].stop_boundary
  assert.equal(stop.type, 'dsh-tool-abort')
  assert.equal(stop.phase, 'before-test-subprocess')
  assert.equal(stop.reason, 'user')
  assert.equal(stop.session.session_id, sessionId)
  assert.equal(stop.abort_seq, aborted.event.seq)
  assert.equal(state.outbox.filter(row => row.body.assignment_id === assignmentId && row.kind === 'report').length, 1)
  assert.equal(state.deliveries?.some(row => row.body.assignment_id === assignmentId && ['artifact', 'report'].includes(row.kind)), false)
  assert.equal(state.outbox.filter(row => row.body.assignment_id === assignmentId && row.kind === 'report'
    && row.body.request_id === report.body.request_id).length, 1)
  const fourthAudit = (await admin.get(`/api/v1/audit?ticket_id=${revoked.id}`)).audit
  assert.equal(fourthAudit.some(row => ['report.accepted', 'artifact.indexed'].includes(row.action)), false)
  record('Grant revocation cancels only the active original Agent; its diff and Report remain locally quarantined', {
    ticket: revoked.id, assignment: assignmentId, session_id: sessionId,
    artifact_last_error: artifact.last_error, report_last_error: report.last_error, quarantined_at: quarantinedAt,
    center_stop_intent: detail.cancel_requested, native_stop_observed: aborted.event.data.reason.reason.kind,
  })

  const failedRetry = await fetch(new URL(`/api/v1/tickets/${revoked.id}/retry`, server.baseUrl), { method: 'POST',
    headers: { Authorization: `Bearer ${server.clientToken}`, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(failedRetry.status, 400)
  assert.equal((await failedRetry.json()).error.code, 'invalid_request')
  const failedTask = await fetch(new URL('/api/v1/tickets', server.baseUrl), { method: 'POST',
    headers: { Authorization: `Bearer ${server.clientToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: grant.grant.project_id, node_id: grant.grant.node_id,
      worker_id: 'default', grant_id: grant.grant.id, kind: 'edit_file', relative_path: 'src/calc.js', content: expected,
      objective: 'Forbidden authority replay; LOOM_FIXTURE_CODE_TASK' }) })
  assert.ok([400, 403].includes(failedTask.status))
  assert.ok(['invalid_request', 'grant_revoked', 'grant_scope'].includes((await failedTask.json()).error.code))
  const frozen = state.outbox.filter(row => row.body.assignment_id === assignmentId && ['artifact', 'report'].includes(row.kind))
    .map(row => ({ kind: row.kind, digest: row.digest, request_id: row.body.request_id, next_attempt_at: row.next_attempt_at }))
  const originalAborts = host.sessionEvents(sessionId, ['turn/end']).filter(row => row.event.data.reason?.kind === 'aborted')
  await host.waitFor(async () => Date.parse((await admin.get('/api/v1/nodes')).nodes.find(row => row.id === grant.grant.node_id)?.last_heartbeat) >= Date.now() - 5000, 5000, 'continued genuine coordinator poll/heartbeats')
  const unchangedState = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
  assert.deepEqual(unchangedState.outbox.filter(row => row.body.assignment_id === assignmentId && ['artifact', 'report'].includes(row.kind))
    .map(row => ({ kind: row.kind, digest: row.digest, request_id: row.body.request_id, next_attempt_at: row.next_attempt_at })), frozen)
  assert.deepEqual(stubRequests(root).filter(row => row.session_id === sessionId), originalRequests)
  assert.deepEqual(host.sessionEvents(sessionId, ['tool/call']).filter(row => ['loom_fixture_code_edit', 'loom_fixture_verify'].includes(row.event.data.name)), originalCalls)
  assert.equal(host.sessionEvents(sessionId, ['turn/end']).filter(row => row.event.data.reason?.kind === 'aborted').length, originalAborts.length)
  assert.equal(originalAborts.filter(row => row.event.data.reason.reason?.kind === 'user').length, 1)
  for (const [oldSession, seq] of previousSeq) {
    assert.equal(host.sessionEvents(oldSession, ['tool/call']).some(row => row.event.seq > seq && ['loom_fixture_code_edit', 'loom_fixture_verify'].includes(row.event.data.name)), false)
  }
  assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), Buffer.from(expected))
  assert.equal((await admin.get(`/api/v1/tickets/${revoked.id}`)).assignments.length, 1)
  const listings = await admin.get('/api/v1/tickets')
  assert.equal(listings.tickets.length, 4)
  assert.deepEqual(listings.tickets.map(row => row.id).sort(), [...historicalTickets, revoked.id].sort())
  for (const id of historicalTickets) {
    const history = await admin.get(`/api/v1/tickets/${id}`)
    assert.equal(history.grant_id, currentGrant.id)
    assert.equal(history.reports.length > 0 && history.artifacts.length > 0 && history.effects.length > 0, true)
  }
  const globalAudit = (await admin.get('/api/v1/audit')).audit
  const revocations = globalAudit.filter(row => row.action === 'grant.revoked')
  assert.equal(revocations.length, 1)
  const revocationEvidence = JSON.parse(revocations[0].evidence)
  assert.equal(revocationEvidence.evidence.grant_id, currentGrant.id)
  assert.equal(revocationEvidence.evidence.fencing, 'old_leases_expired')
  assert.equal(fourthAudit.some(row => row.action === 'cancel.requested'), false)

  await host.stop(); host = null
  await server.stop()
  server = await startRustConcierge({ root: join(root, 'rust'), env: { PATH: process.env.PATH } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
  env.LOOM_FIXTURE_ENROLLMENT_CODE = ''
  env.LOOM_FIXTURE_COORDINATOR_URL = server.baseUrl
  host = await new FixtureHost(root, env, [server.clientToken]).start()
  await sleep(1200)
  const reopenedState = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
  const retained = reopenedState.outbox.filter(row => row.body.assignment_id === assignmentId && ['artifact', 'report'].includes(row.kind))
  assert.equal(retained.length, 2)
  assert.ok(retained.every(row => row.next_attempt_at === quarantinedAt && row.attempts >= 1))
  assert.deepEqual(reopenedState.deliveries?.filter(row => row.body.assignment_id === assignmentId && ['artifact', 'report'].includes(row.kind)), [])
  const reopenedCenter = await admin.get(`/api/v1/tickets/${revoked.id}`)
  assert.equal(reopenedCenter.status, 'reconciling')
  assert.equal(reopenedCenter.cancel_requested, false)
  assert.deepEqual([reopenedCenter.reports, reopenedCenter.effects, reopenedCenter.artifacts], [[], [], []])
  assert.deepEqual(stubRequests(root).filter(row => row.session_id === sessionId), originalRequests)
  assert.deepEqual(host.sessionEvents(sessionId, ['tool/call']).filter(row => ['loom_fixture_code_edit', 'loom_fixture_verify'].includes(row.event.data.name)), [])
  assert.deepEqual(await readFile(join(projectRoot, 'src', 'calc.js')), Buffer.from(expected))
  for (const [id, before] of historyBefore) {
    const history = await admin.get(`/api/v1/tickets/${id}`)
    assert.deepEqual({ reports: history.reports.map(row => row.id).sort(),
      artifacts: history.artifacts.map(row => row.id).sort(),
      effects: history.effects.map(row => row.id ?? row.effect_id).sort() }, before)
  }
  const finalCounts = await scopedDurableCounts()
  assert.deepEqual(finalCounts, { tickets: countsBefore.tickets + 1, assignments: countsBefore.assignments + 1,
    reports: countsBefore.reports, artifacts: countsBefore.artifacts, effects: countsBefore.effects })
  pass('grant revocation stops only the attached Agent, keeps local byte evidence fenced and never authorizes another execution', {
    report_request_id: report.body.request_id, artifact_request_id: artifact.body.request_id,
    native_stop_observed: 'user', center_stop_intent: false, center_fenced: true,
    fourth_ticket: revoked.id, ...finalCounts,
  })
}
async function scopedDurableCounts() {
  const db = new DatabaseSync(join(server.dataDir, 'loom.sqlite3'), { readonly: true })
  const counts = {}
  try {
    for (const table of ['tickets', 'assignments', 'reports', 'artifacts', 'effects']) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { db.close() }
  const audit = await new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken }).get('/api/v1/audit/verify')
  assert.equal(audit.valid, true)
  assert.equal(audit.algorithm, 'sha256_chain_v1')
  return counts
}
function stubRequests(root) {
  return readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.type === 'request')
}
async function showArtifactsInVue({ server, admin, root, ticket }) {
  process.env.LOOM_TEST_CONCIERGE_URL = server.baseUrl
  const appRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url))
  const repository = fileURLToPath(new URL('../../', import.meta.url))
  await execute('pnpm', ['--dir', 'apps/web', 'build'], { cwd: repository, env: { PATH: process.env.PATH }, shell: false, timeout: 120_000 })
  const { preview: createPreview } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
  preview = await createPreview({ root: appRoot, configFile: join(repository, 'tests/browser/vite.config.mjs'), logLevel: 'error',
    cacheDir: join(root, 'code-preview-cache'), preview: { host: '127.0.0.1', port: 0, strictPort: true }, build: { outDir: join(appRoot, 'dist') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false,
      proxy: { '/api': { target: server.baseUrl, changeOrigin: true } } } })
  const appOrigin = `http://127.0.0.1:${preview.httpServer.address().port}`
  const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  context = await chromium.launchPersistentContext(join(root, 'code-browser-profile'), {
    executablePath: executable, headless: true, viewport: { width: 1280, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-component-update', '--disable-background-networking', '--disable-default-apps', '--no-service-autorun', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
    env: { PATH: process.env.PATH, TMPDIR: root }, timeout: 30_000,
  })
  const page = context.pages()[0]
  assert.ok(page)
  page.setDefaultTimeout(20_000)
  page.on('request', request => {
    const url = new URL(request.url())
    if (![appOrigin, server.baseUrl].includes(url.origin)) throw new Error(`Browser requested a non-owned origin ${url.origin}`)
  })
  const errors = []
  let initialAnonymousBootstrap = 0
  let initialBootstrapConsole = 0
  let authenticated = false
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => errors.push(`REQUEST_FAILED ${new URL(request.url()).pathname}`))
  page.on('console', message => {
    if (message.type() !== 'error') return
    if (!authenticated && initialAnonymousBootstrap > initialBootstrapConsole && message.text().includes('401 (Unauthorized)')) {
      initialBootstrapConsole++
      return
    }
    errors.push(message.text())
  })
  page.on('response', response => {
    const url = new URL(response.url())
    const initial401 = response.status() === 401 && url.pathname === '/api/v1/bootstrap' && !response.request().headers().authorization && !authenticated
    if (initial401) { initialAnonymousBootstrap++; return }
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${url.pathname}`)
  })
  await page.goto(appOrigin, { waitUntil: 'domcontentloaded' })
  await page.locator('.loom-app').waitFor()
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(server.clientToken)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
  authenticated = true
  await page.locator('.ticket-detail').getByText('收到成功报告', { exact: true }).waitFor()
  for (const assignment of ticket.assignments) {
    const diffArtifact = ticket.artifacts.find(artifact => artifact.assignment_id === assignment.id && artifact.media_type === 'text/x-diff')
    const verificationArtifact = ticket.artifacts.find(artifact => artifact.assignment_id === assignment.id && artifact.media_type === 'application/json')
    const effect = ticket.effects.find(effect => effect.assignment_id === assignment.id && effect.status === 'confirmed')
    assert.ok(diffArtifact && verificationArtifact && effect)
    const effectId = effect.id ?? effect.effect_id
    assert.ok(effectId, 'The authoritative raw Effect must retain its immutable identity')
    const sourceArtifactId = diffArtifact.id ?? diffArtifact.artifact_id
    assert.ok(sourceArtifactId, 'The real source Artifact must maintain its immutable UUID')
    const report = ticket.reports.find(report => report.assignment_id === assignment.id)
    assert.equal(report?.state, assignment.attempt === 1 ? 'failed' : 'succeeded')
    const bodies = new Map()
    for (const entry of [diffArtifact, verificationArtifact]) {
      const card = page.locator('.artifact-card').filter({ hasText: entry.name })
      const fetched = page.waitForResponse(response => response.url().includes(`/artifacts/${entry.id}`) && response.request().method() === 'GET')
      await card.click()
      const download = await fetched
      assert.equal(download.status(), 200)
      const evidence = (await download.json()).artifact.code_evidence
      assert.equal(evidence.schema, 'loom.code-provenance.v1')
      assert.equal(evidence.kind, entry.media_type === 'text/x-diff' ? 'change' : 'verification')
      assert.equal(evidence.name, undefined)
      assert.deepEqual(Object.keys(evidence.session).sort(), ['harness', 'host_api', 'observed_seq', 'protocol', 'session_id'])
      await page.locator('.artifact-content').waitFor({ state: 'attached' })
      const text = await page.locator('.artifact-content').textContent()
      assert.equal(sha256(Buffer.from(text)), entry.sha256)
      bodies.set(entry.id, text)
    }
    for (const entry of [diffArtifact, verificationArtifact]) {
      const text = bodies.get(entry.id)
      await page.locator('.artifact-card').filter({ hasText: entry.name }).click()
      await page.locator('.artifact-content').waitFor({ state: 'attached' })
      if (entry.media_type === 'text/x-diff') {
        assert.match(text, /-  return a - b;/)
        assert.match(text, /\+  return a \+ b;/)
/* The real timeout reports the absent dependent evidence plainly. */        await page.locator('.code-diff-line.removed').first().waitFor({ state: 'visible' })
        await page.locator('.code-diff-line.added').first().waitFor({ state: 'visible' })
        const facts = await page.locator('.code-artifact .facts').innerText()
        assert.ok(facts.includes(assignment.id) && facts.includes(effectId) && facts.includes('src/calc.js'))
      } else {
        const proof = JSON.parse(text)
        const expectedExit = assignment.attempt === 1 ? 1 : 0
        assert.equal(proof.schema, 'loom.code-verification.v1')
        assert.equal(proof.exit_code, expectedExit)
        assert.equal(proof.passed, expectedExit === 0)
        assert.deepEqual(proof.command, { file: 'node', args: ['--test', 'test/calc.test.js'] })
        const result = page.locator('.code-verification-result')
        await result.waitFor({ state: 'visible' })
        assert.equal(await result.getAttribute('data-exit-code'), String(expectedExit))
        assert.equal(await result.getAttribute('data-report-status'), report?.state)
        assert.equal(await result.getAttribute('data-assignment-id'), assignment.id)
        const facts = await page.locator('.code-artifact .facts').innerText()
        assert.ok(facts.includes('node --test test/calc.test.js') && facts.includes(effectId) && facts.includes(sourceArtifactId))
        assert.equal(await result.locator('pre').first().textContent(), proof.stdout)
        assert.equal(await result.locator('pre').nth(1).textContent(), proof.stderr)
      }
    }
    const afterView = await admin.get(`/api/v1/tickets/${ticket.id}`)
    assert.equal(afterView.artifacts.filter(artifact => artifact.assignment_id === assignment.id).length, 2)
    assert.equal(afterView.effects.length, 2)
    assert.equal(afterView.reports.length, 2)
  }
  const latestVerification = ticket.artifacts.findLast(artifact => artifact.media_type === 'application/json')
  await page.locator('.artifact-card').filter({ hasText: latestVerification.name }).click()
  await page.locator('.code-verification-result').waitFor({ state: 'visible' })
  const geometry = async () => {
    const columns = await page.locator('.conversation-column').evaluate(element => ({ width: element.getBoundingClientRect().width, scrollWidth: document.documentElement.scrollWidth }))
    const body = await page.locator('body').innerText()
    assert.equal(body.includes(server.clientToken), false)
    assert.ok(columns.width > 200)
    assert.equal(columns.scrollWidth, await page.evaluate(() => window.innerWidth))
    return columns
  }
  const desktopGeometry = await geometry()
  const desktop_screenshot = join(root, 'code-artifacts-desktop.png')
  await page.screenshot({ path: desktop_screenshot, fullPage: true })
  await context.close(); context = null
  context = await chromium.launchPersistentContext(join(root, 'code-browser-profile-narrow'), {
    executablePath: executable, headless: true, viewport: { width: 390, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--no-proxy-server'],
    env: { PATH: process.env.PATH, TMPDIR: root }, timeout: 30_000,
  })
  const narrow = context.pages()[0]
  await narrow.goto(appOrigin, { waitUntil: 'domcontentloaded' })
  await narrow.locator('.loom-app').waitFor()
  await narrow.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await narrow.locator('#client-token').fill(server.clientToken)
  await narrow.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await narrow.locator('#connection-dialog').waitFor({ state: 'hidden' })
  await narrow.locator('.ticket-detail').getByText('收到成功报告', { exact: true }).waitFor()
  for (const artifact of ticket.artifacts) {
    await narrow.locator('.artifact-card').filter({ hasText: artifact.name }).click()
    await narrow.locator('.artifact-content').waitFor({ state: 'attached' })
  }
  await narrow.locator('.artifact-card').filter({ hasText: latestVerification.name }).click()
  await narrow.locator('.code-verification-result').waitFor({ state: 'visible' })
  assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth), 390)
  const narrow_screenshot = join(root, 'code-artifacts-narrow.png')
  await narrow.screenshot({ path: narrow_screenshot, fullPage: true })
  assert.deepEqual(errors, [])
  await stopCodeView()
  const desktopResult = output ? join(dirname(output), 'result-desktop.png') : desktop_screenshot
  const narrowResult = output ? join(dirname(output), 'result-narrow.png') : narrow_screenshot
  if (output) {
    await copyFile(desktop_screenshot, desktopResult)
    await copyFile(narrow_screenshot, narrowResult)
  }
  return { desktop_screenshot: desktopResult, narrow_screenshot: narrowResult, desktop_geometry: desktopGeometry, narrow_viewport_no_overflow: true,
    shared_existing_ticket_artifact_ui: true, actual_download_text_validation: true, no_new_ticket_or_grant: true,
    mobile_device: 'NOT RUN (390px desktop Edge viewport only)', owned_profile_closed: true }
}
async function stopCodeView() {
  if (context) { await context.close(); context = null }
  if (preview) { await new Promise((resolve, reject) => preview.httpServer.close(error => error ? reject(error) : resolve())); preview = null }
}
