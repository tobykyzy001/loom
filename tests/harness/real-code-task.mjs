#!/usr/bin/env node
/** A deliberately tiny, real DSH code-edit + fixed node:test worker fixture.
 * No external model/upload/network, generic shell or production file-tool route.
 * This scenario is offline zero-network stub Agent execution with actual DSH sessions.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
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
    throw new Error(`Code Ticket ${ticket.id} did not reach a definite evidence state`)
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

  const browserEvidence = await showArtifactsInVue({ server, admin, root, ticket: { ...second, artifacts: latestArtifacts }, latestVerify })
  browserReports.push(browserEvidence)
  pass('production Vue opens the real diff and verification Artifacts from this DSH Ticket', { desktop: 1280, desktop_viewport_only_narrow: 390 })

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
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 4)
    assert.deepEqual(second.artifacts.map(entry => entry.id).sort(), restored.artifacts.map(entry => entry.id).sort())
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effects').get().n, 2)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { db.close() }
  const audit = await new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken }).get('/api/v1/audit/verify')
  assert.equal(audit.valid, true)
  assert.equal(audit.algorithm, 'sha256_chain_v1')
  pass('actual durable counts, SQLite integrity and validated audit chain')
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
    await writeFile(output, JSON.stringify(report(settled ? 'PASS' : 'FAIL'), null, 2), { mode: 0o600 })
  }
  // The target is constructed and canonicalized once from our own mkdtemp fixtureRoot.
  if (root) {
    assert.ok(root.split('/').at(-1).startsWith('loom-dsh-'))
    assert.equal(await realpath(root), root)
    await rm(root, { recursive: true, force: true })
  }
}
async function showArtifactsInVue({ server, root, ticket }) {
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
  for (const kind of ['text/x-diff', 'application/json']) {
    const entry = ticket.artifacts.find(artifact => artifact.media_type === kind)
    assert.ok(entry, `Ticket exposes exactly the expected ${kind} Artifact`)
    const card = page.locator('.artifact-card').filter({ hasText: entry.name })
    const fetched = page.waitForResponse(response => response.url().includes(`/artifacts/${entry.id}`) && response.request().method() === 'GET')
    await card.click()
    assert.equal((await fetched).status(), 200)
    await page.locator('.artifact-content').waitFor()
    const text = await page.locator('.artifact-content').textContent()
    if (kind === 'text/x-diff') {
      assert.match(text, /-  return a - b;/)
      assert.match(text, /\+  return a \+ b;/)
      assert.equal(sha256(Buffer.from(text)), entry.sha256)
    } else {
      const proof = JSON.parse(text)
      assert.equal(proof.schema, 'loom.code-verification.v1')
      assert.equal(proof.exit_code, 0)
      assert.equal(proof.passed, true)
      assert.equal(sha256(Buffer.from(text)), entry.sha256)
      assert.deepEqual(proof.command, { file: 'node', args: ['--test', 'test/calc.test.js'] })
    }
  }
  await page.locator('.artifact-card').filter({ hasText: ticket.artifacts.find(artifact => artifact.media_type === 'text/x-diff').name }).click()
  await page.locator('.artifact-content').waitFor()
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
  await narrow.locator('.artifact-card').filter({ hasText: ticket.artifacts.find(artifact => artifact.media_type === 'text/x-diff').name }).click()
  await narrow.locator('.artifact-content').waitFor()
  assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth), 390)
  const narrow_screenshot = join(root, 'code-artifacts-narrow.png')
  await narrow.screenshot({ path: narrow_screenshot, fullPage: true })
  assert.deepEqual(errors, [])
  await stopCodeView()
  return { desktop_screenshot, narrow_screenshot, desktop_geometry: desktopGeometry, narrow_viewport_no_overflow: true,
    shared_existing_ticket_artifact_ui: true, actual_download_text_validation: true, no_new_ticket_or_grant: true,
    mobile_device: 'NOT RUN (390px desktop Edge viewport only)', owned_profile_closed: true }
}
async function stopCodeView() {
  if (context) { await context.close(); context = null }
  if (preview) { await new Promise((resolve, reject) => preview.httpServer.close(error => error ? reject(error) : resolve())); preview = null }
}
