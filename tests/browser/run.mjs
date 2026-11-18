import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { prepareProject, startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { sha256 } from '../../packages/node-client/src/util.js'

// The supported path is only the local Loom app with Playwright's canonical
// isolated browser context. Raw stock-executable spawning / global updater
// hand wrangling is not used. No DSH browser, session or profile is attached.
const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '../..')
const dependency = JSON.parse(await readFile(join(here, 'node_modules/playwright-core/package.json'), 'utf8'))
assert.equal(dependency.version, '1.65.1', 'Local exact Playwright must be installed with the documented command')
const flags = new Set(process.argv.slice(2))
const allowed = ['--headed', '--keep-evidence', '--vite', '--narrow-viewport']
assert.ok([...flags].every((flag) => allowed.includes(flag)), `Usage: node tests/browser/run.mjs [${allowed.join('] [--')}]`)
if (flags.has('--headed')) assert.ok(process.platform === 'darwin' || process.env.DISPLAY, 'Headed mode needs a desktop display')
const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
assert.ok(await access(executable).then(() => true, () => false), `No installed standalone browser: ${executable}`)
await realpath(executable)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function redact(value, secrets) {
  let text = String(value)
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted-test-secret]')
  return text.slice(-20000)
}
async function checked(command, argv, timeoutMs = 120000) {
  const child = spawn(command, argv, { cwd: repository, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } })
  const output = []; let timedOut = false
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output.push(String(chunk)); if (output.length > 20) output.shift() })
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM') } catch {} }, timeoutMs)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    if (timedOut || code !== 0) throw new Error(`${command} failed (code=${code}, timeout=${timedOut}): ${output.join('')}`)
  } finally { clearTimeout(timer); await terminateOwnedProcess(child) }
}
async function terminateOwnedProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const signal = (name) => { try { if (process.platform === 'win32') child.kill(name); else process.kill(-child.pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  signal('SIGTERM')
  if (!await Promise.race([exited.then(() => true), sleep(4000)])) {
    signal('SIGKILL'); await Promise.race([exited, bounded(sleep(4000), 'hard child termination')])
  }
}
async function bounded(promise, label, timeoutMs = 30000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'loom-browser-owned-'))
  const evidence = await mkdtemp(join(tmpdir(), 'loom-browser-evidence-'))
  const secrets = []
  const result = { schema: 'loom.browser.desktop_e2e.v1', overall: 'NOT RUN', phase: 'environment',
    browser: { executable: basename(executable), playwright_core: dependency.version, dsh_profile_used: false, personal_profile_used: false, new_owned_temp_profile: true },
    dsh_electron_reuse: 'NOT RUN: DSH app wrapper rejects --remote-debugging-port=0 (bad option); no DSH app/profile/session/cookies loaded',
    target: 'Standalone desktop Edge + native Rust + real production Vue + existing TypeScript LocalNodeRunner',
    mobile_viewport: 'NOT RUN (use --narrow-viewport for viewport-only check)', live_llm: 'NOT RUN (no model called)', checks: [], commands: [], screenshots: [] }
  let server, admin, node, browser, context, page, vite
  let appOrigin, projectId, projectRoot, heartbeatCount = 0
  let browserLog = '', processLog = '', finishing = false
  const ownedGroups = new Map()
  const verifyGroup = async (label, child) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) {
        if (process.platform === 'win32') return
        try { process.kill(-child.pid, 0); await sleep(100); continue }
        catch (error) { if (error.code === 'ESRCH') return; throw error }
      }
      await sleep(100)
    }
    throw new Error(`Owned ${label} process group still running / zombie: ${child.pid}`)
  }
  const trackOwnedGroup = (child, label) => {
    if (ownedGroups.has(label)) throw new Error(`Duplicate owned process group: ${label}`)
    ownedGroups.set(label, child)
  }
  const phase = async (name, body) => { result.phase = name; await body(); result.checks.push({ name, status: 'PASS' }); console.log(`PASS ${name}`) }
  async function screenshot(name) {
    assert.ok(page && !page.isClosed())
    assert.equal(await page.locator('#client-token, .enrollment-code').count(), 0, 'Token/code inputs must not be captured')
    const body = await page.locator('body').innerText()
    for (const secret of secrets) assert.ok(!body.includes(secret), 'Secret in DOM: screenshot prohibited')
    const path = join(evidence, `${name}.png`)
    await page.screenshot({ path, fullPage: true })
    result.screenshots.push({ file: `${name}.png`, bytes: (await stat(path)).size, sha256: sha256File(await readFile(path)) })
  }
  function sha256File(bytes) { return sha256(bytes) }
  async function cleanup(error) {
    if (finishing) return
    finishing = true
    const cleaned = []
    if (browser) {
      await bounded(browser.close(), 'owned child browser close', 12000).catch((closeError) => { browserLog += `\n${redact(closeError, secrets)}` })
    } else if (context) { await context.close().catch(() => {}) }
    if (ownedGroups.has('browser')) await terminateOwnedProcess(ownedGroups.get('browser'))
    if (browser || ownedGroups.has('browser')) cleaned.push('owned browser contexts/process-group closed')
    if (vite) await terminateOwnedProcess(vite)
    if (server) await bounded(server.stop(), 'Rust stop', 8000)
    for (const [label, child] of ownedGroups) {
      await verifyGroup(label, child)
      cleaned.push(`verified owned ${label} process-group gone (PID captured from this run)`)
    }
    // Lease/poll loops are bounded function calls and no persistent Node child.
    // All browser profile, node private key, localStorage and temporary fixture
    // content go away; only the opted-in separate evidence tree may persist.
    await rm(root, { recursive: true, force: true })
    assert.equal(await access(root).then(() => true, () => false), false, 'Owned temporary fixture/browser profile must be deleted')
    result.cleanup = { fixture_and_browser_profile_deleted: true, credentials_evidence_stored: false, actions: cleaned,
      browser_session_closed_by_playwright: true, process_group_termination: 'explicitly owned children only; no profile/name matching', local_node_process_children: 0 }
    result.overall = error ? 'FAIL' : 'PASS'
    if (error) { result.error = redact(error.stack || error, secrets); result.phase = result.phase }
    else result.phase = 'complete'
    await writeFile(join(evidence, 'process.log'), redact(browserLog + '\n' + processLog, secrets), { mode: 0o600 })
    await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
    if (!flags.has('--keep-evidence') && !error) await rm(evidence, { recursive: true, force: true })
    else console.log(`SAFE_EVIDENCE ${evidence}`)
    console.log(JSON.stringify({ overall: result.overall, phase: result.phase, screenshots: result.screenshots.length, evidence: flags.has('--keep-evidence') || error ? evidence : undefined }))
    process.exitCode = error ? 1 : 0
  }
  const abort = new AbortController()
  const timeout = setTimeout(() => { result.phase ||= 'watchdog'; browserLog += '\nTotal driver watchdog triggered'; void cleanup(new Error('Total test watchdog after 175s')).finally(() => process.exit(1)) }, 175000)
  const signal = () => { abort.abort(); void cleanup(new Error('Signal received')).finally(() => process.exit(130)) }
  process.once('SIGINT', signal); process.once('SIGTERM', signal)
  try {
    await phase('production-build-and-installed-browser', async () => {
      assert.equal((await stat(executable)).isFile(), true)
      await checked('pnpm', ['--dir', 'apps/web', 'build'])
      result.commands.push('pnpm --dir apps/web build')
    })
    await phase('temporary-concierge-node-binding-grant', async () => {
      projectRoot = await prepareProject(root)
      const serverRoot = join(root, 'rust'); await mkdir(serverRoot, { mode: 0o700 })
      assert.ok(await access(join(repository, 'target/debug/loom')).then(() => true, () => false), 'Existing fixture must produce the current Rust executable')
      const wrapper = join(root, 'serve.mjs')
      const script = `import { spawn } from 'node:child_process';const child=spawn(${JSON.stringify(join(repository, 'target/debug/loom'))},[...process.argv.slice(2),'--web-dir',${JSON.stringify(join(repository, 'apps/web/dist'))}],{shell:false,stdio:'inherit'});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));child.on('exit',(code,signal)=>{console.log('OWNED_LOOM_EXIT '+code+' '+signal);process.exit(code??(signal?0:1))});`
      await writeFile(wrapper, script, { mode: 0o700 })
      server = await startRustConcierge({ root: serverRoot, env: { ...process.env, LOOM_SERVER_CMD: `${process.execPath} ${wrapper}` } })
      secrets.push(server.clientToken)
      result.commands.push('Rust fixture helper: cargo build --locked -p loom-concierge --bin loom; <owned-dir>/serve.mjs --data-dir <temp> serve --listen 127.0.0.1:<ephemeral> --web-dir apps/web/dist')
      admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 10000 })
      assert.equal((await admin.get('/api/v1/health')).status, 'ok')
      const project = await admin.post('/api/v1/projects', { name: 'Synthetic browser Project', root: projectRoot, mode: 'read_write' })
      projectId = project.project.id
      const enrollment = await admin.post('/api/v1/enrollment-codes', {})
      secrets.push(enrollment.code)
      node = await LocalNodeRunner.create({ baseUrl: server.baseUrl, stateDir: join(root, 'node-state'), artifactDir: join(root, 'node-artifacts'), enrollmentCode: enrollment.code,
        projectRoots: { [projectId]: projectRoot }, registration: { workerId: 'default', harnessKind: 'deterministic-local-http', profileId: 'desktop-test-temporary' } })
      heartbeatCount++
      const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.nodeId, worker_id: 'default', root_scope: projectRoot })
      const grant = await admin.post('/api/v1/grants', { project_id: projectId, node_id: node.nodeId, worker_id: 'default', operations: ['read', 'write'] })
      assert.ok(binding.id && grant.grant.id)
      await assert.rejects(() => LocalNodeRunner.create({ baseUrl: server.baseUrl, stateDir: join(root, 'duplicate-state'), artifactDir: join(root, 'duplicate-artifacts'), enrollmentCode: enrollment.code,
        projectRoots: { [projectId]: projectRoot }, registration: { workerId: 'default', harnessKind: 'deterministic-local-http', profileId: 'rejected-reused-code' } }), /single-use|enrollment|denied/i)
      result.fixture = { synthetic_project_root_in_temp: true, exact_binding: true, binding_id: binding.id, explicit_read_write_grant: true, single_use_code_reuse_rejected: true, worker_id: 'default', node_id: node.nodeId }
      appOrigin = server.baseUrl
    })
    if (flags.has('--vite')) await phase('temporary-vite-only-when-requested', async () => {
      appOrigin = await bounded((async () => {
        vite = spawn(process.execPath, [join(repository, 'apps/web/node_modules/vite/bin/vite.js'), '--config', resolve(here, 'vite.config.mjs'), '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
          cwd: join(repository, 'apps/web'), env: { PATH: process.env.PATH, LOOM_TEST_CONCIERGE_URL: server.baseUrl }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        })
        ownedGroups.set('vite', vite)
        let text = ''
        return new Promise((resolveUrl, reject) => {
          const timer = setTimeout(() => reject(new Error(`Vite no owned URL: ${text}`)), 18000)
          const collect = (chunk) => {
            text += chunk
            const match = text.match(/http:\/\/127\.0\.0\.1:\d+\//)
            if (match) { clearTimeout(timer); resolveUrl(new URL(match[0]).origin) }
          }
          vite.stdout.on('data', collect); vite.stderr.on('data', collect)
          vite.once('error', reject); vite.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Vite exited ${code}: ${text}`)) })
        })
      })(), 'Vite start', 23000)
      result.commands.push('pnpm --dir apps/web exec vite --config tests/browser/vite.config.mjs --host 127.0.0.1 --port 0 --strictPort')
    })
    await phase('new-standalone-browser-and-native-production-DOM', async () => {
      const profile = join(root, 'browser-profile')
      await mkdir(profile, { mode: 0o700 })
      context = await bounded(chromium.launchPersistentContext(profile, {
        executablePath: executable, headless: !flags.has('--headed'), viewport: { width: 1440, height: 1000 },
        args: ['--no-first-run', '--no-default-browser-check', '--no-default-search', '--disable-sync', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
        env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'xdg'), TMPDIR: root }, timeout: 25000 }), 'canonical temporary Edge browser', 30000)
      browser = context.browser()
      assert.ok(browser?.isConnected(), 'Real Chromium required, not static HTML')
      result.browser = { ...result.browser, engine: 'chromium', version: browser.version(), environment_names: ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR'], canonical_launcher: true }
      const pages = context.pages()
      assert.equal(pages.length, 1)
      const child = pages[0].context().browser()?.process?.()
      if (child) { ownedGroups.set('browser', child); result.browser.pid = child.pid }
      const profileArg = child?.spawnargs.find((argument) => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
      if (profileArg) assert.equal(await realpath(profileArg), await realpath(profile))
      result.browser.exact_profile_argument_verified = Boolean(profileArg)
      page = pages[0]
      page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(25000)
      const blockedRequests = []
      result.browser.blocked_external_requests = blockedRequests
      assert.equal(pages[0].url(), 'about:blank', 'No existing tab/session may be reused')
      page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(25000)
      const expectedOrigins = new Set([server.baseUrl, appOrigin])
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !expectedOrigins.has(url.origin)) {
          blockedRequests.push(`${url.protocol}//${url.hostname}:${url.port}`)
          browserLog += `\nBlocked non-loopback/foreign browser request: ${url.protocol}//${url.hostname}:${url.port}`
          return route.abort('blockedbyclient')
        }
        return route.continue()
      })
      await context.setOffline(false)
      page.on('pageerror', (error) => { browserLog += `\nPage error: ${error.message}` })
      page.on('console', (message) => { if (message.type() === 'error') browserLog += `\nConsole: ${message.text().slice(0, 1200)}` })
      page.on('requestfailed', (request) => { browserLog += `\nRequest failed: ${request.url()} ${request.failure()?.errorText}` })
      await page.goto(appOrigin)
      await page.waitForSelector('.loom-app')
      assert.equal(context.pages().length, 1)
      result.browser.dom_mount = true
      assert.deepEqual(blockedRequests, [], 'Any external browser request must FAIL the guarded test')
      result.browser.window_count = 1
      if (!flags.has('--vite')) {
        const assetPath = await page.locator('script[type="module"]').getAttribute('src')
        assert.ok(assetPath?.startsWith('/assets/'))
      assert.ok(assetPath.length < 512, 'Build must emit a bounded local JS path')
        const module = await page.evaluate(async (path) => { const response = await fetch(path); return { url: response.url, status: response.status, type: response.headers.get('content-type'), text: (await response.text()).slice(0, 100) } }, assetPath)
        assert.equal(module.status, 200); assert.match(module.type, /javascript/); assert.ok(!module.text.trim().toLowerCase().startsWith('<!doctype html>'))
        result.native_web_dir = { resource_path: assetPath, javascript_status: module.status, content_type: module.type, body_not_html_spa_index: true }
      }
    })
    await phase('activeAuth-real-read-and-artifact-expanded', async () => {
      await loginWithSyntheticToken()
      assert.match(await page.locator('#project-select').innerText(), /Synthetic browser Project · 读写/)
      assert.match(await page.locator('.identity-button').innerText(), /single-user/)
      const readId = await createTask({ objective: 'Synthetic browser actual read', path: 'input.txt' })
      await tick('succeeded'); await reloadSuccess()
      await page.locator('.artifact-card').click()
      const summary = JSON.parse(await page.locator('.artifact-content').innerText())
      assert.deepEqual(summary.lines, ['Real isolated project input.', 'No LLM, DSH host or network model was called.'])
      const geometry = await desktopTicketIsUsable()
      result.desktop_geometry = geometry
      if (!(geometry.detailWidth > geometry.workspaceWidth * 0.45 && !geometry.helpfulUnrelatedViewVisible)) {
        await screenshot('diagnostic-read-actually-visible-views')
      }
      assert.ok(geometry.detailWidth > geometry.workspaceWidth * 0.45, `Desktop Ticket column collapsed in actual browser: ${JSON.stringify(geometry)}`)
      assert.equal(geometry.helpfulUnrelatedViewVisible, false, `Task view contains unrelated Help layout: ${JSON.stringify(geometry)}`)
      await page.locator('.report-section summary').click()
      assert.equal(await page.locator('.report-section details').evaluate((element) => element.open), true)
      assert.match(await page.locator('.report-section').innerText(), /effect_id|target_sha256/)
      await page.locator('.report-section summary').click()
      await screenshot('01-desktop-read-artifact')
      const detail = await admin.get(`/api/v1/tickets/${readId}`)
      assert.equal(detail.artifacts.length, 1); assert.equal(detail.effects.length, 1)
      result.checks.push({ name: 'DOM read source lines verified from actual artifact; no fixed golden HTML', status: 'PASS', detail: { ticket_id: readId, content_lines: summary.lines } })
    })
    await phase('actual-Grant-and-Node-visible', async () => {
      await page.locator('.main-nav').getByRole('button', { name: '权限', exact: true }).click()
      const grant = await page.locator('.grant-item').innerText()
      assert.match(grant, /Synthetic browser Project/); assert.match(grant, /读取/); assert.match(grant, /写入/)
      assert.ok(grant.includes(node.nodeId)); assert.equal(await page.locator('.grant-item .status-badge').innerText(), '有效')
      await page.locator('.main-nav').getByRole('button', { name: '设备', exact: true }).click()
      assert.ok((await page.locator('.node-heading h3').innerText()).includes(node.nodeId)); assert.match(await page.locator('.node-heading').innerText(), /在线/)
      await screenshot('02-desktop-node-and-permission-scope')
    })
    await phase('actual-Node-write-artifact-effect-and-lease-expanded', async () => {
      await page.locator('.main-nav').getByRole('button', { name: '对话', exact: true }).click()
      const writeText = `Synthetic Node file write ${randomUUID()}\nNo model was called.\n`
      const writeId = await createTask({ objective: 'Synthetic browser actual file write', kind: 'edit_file', path: 'nested/browser-result.txt', content: writeText })
      await tick('succeeded'); await reloadSuccess()
      await page.locator('.artifact-card').click()
      const artifact = JSON.parse(await page.locator('.artifact-content').innerText())
      assert.equal(artifact.path, 'nested/browser-result.txt'); assert.equal(artifact.kind, 'edit_file'); assert.equal(artifact.operation, 'replaced_project_file')
      assert.equal(artifact.target_hash, sha256(writeText))
      assert.match(await page.locator('.effect-list').innerText(), /副作用对账/); assert.match(await page.locator('.effect-list').innerText(), /已确认/)
      const bytes = await readFile(join(projectRoot, 'nested/browser-result.txt'))
      assert.equal(bytes.toString('utf8'), writeText); assert.equal(sha256(bytes), artifact.target_hash)
      const detail = await admin.get(`/api/v1/tickets/${writeId}`)
      assert.equal(detail.effects[0].status, 'confirmed')
      const evidence = JSON.parse(detail.effects[0].evidence)
      assert.equal(evidence.target_sha256, artifact.target_hash); assert.equal(detail.effects[0].id, evidence.effect_id)
      await page.locator('.report-section summary').click()
      assert.equal(await page.locator('.report-section details').evaluate((element) => element.open), true)
      assert.match(await page.locator('.report-section').innerText(), /target_sha256|effect_id/)
      await page.locator('details.technical-details summary').click()
      assert.match(await page.locator('details.technical-details').innerText(), /lease_epoch|grant_version/)
      await page.locator('details.technical-details summary').click(); await page.locator('.report-section summary').click()
      await page.locator('.page-view.help-view').waitFor({ state: 'hidden' })
      const writeLayout = await desktopTicketIsUsable()
      assert.ok(writeLayout.detailWidth > writeLayout.workspaceWidth * 0.45, `Write Ticket collapsed after opening actual Artifact: ${JSON.stringify(writeLayout)}`)
      await screenshot('03-desktop-write-artifact-confirmed-effect')
      result.actual_write = { byte_length: bytes.length, content_sha256: artifact.target_hash, effect_state: detail.effects[0].status, effect_id: evidence.effect_id, ticket_id: writeId }
    })
    await phase('process-display-preferences-keep-global-and-ticket-distinct', async () => {
      await verifyDisplayPreferences({ page, admin, node, server, projectRoot, result, refreshTicket: reloadSuccess })
    })
    await phase('real-cancel-intent-before-Node-acknowledgement', async () => {
      const cancelId = await createTask({ objective: 'Synthetic browser stop intent', kind: 'edit_file', path: 'must-not-write.txt', content: 'No effect allowed.' })
      await page.getByRole('button', { name: '取消任务', exact: true }).click(); await page.getByRole('button', { name: '确认取消任务', exact: true }).click()
      await page.waitForSelector('.neutral-note')
      assert.match(await page.locator('.neutral-note').innerText(), /取消意图已记录。等待执行节点响应，不会强迫任务显示为已取消。/)
      assert.equal((await admin.get(`/api/v1/tickets/${cancelId}`)).status, 'cancel_requested')
      await screenshot('04-desktop-cancel-intent-before-node-ack')
      await tick('cancel_acknowledged'); await page.reload()
      await page.waitForFunction(() => document.querySelector('.next-action-card.neutral-action')?.textContent.includes('任务已取消'))
      assert.equal(await page.locator('.artifact-card').count(), 0)
      const cancelled = await admin.get(`/api/v1/tickets/${cancelId}`)
      assert.equal(cancelled.status, 'cancelled'); assert.ok([1, true].includes(cancelled.reports.at(-1).cancel_acknowledged))
      assert.equal(await stat(join(projectRoot, 'must-not-write.txt')).then(() => false, (error) => { assert.equal(error.code, 'ENOENT'); return true }), true)
      result.cancel = { ticket_id: cancelId, visible_cancel_intent: true, final_cancelled: true, file_effect_absent: true }
    })
    await phase('real-ui-grant-revocation-before-first-Node-poll', async () => {
      await verifyGrantRevocationBeforeAdmission({ page, admin, node, server, projectRoot, result, createTask, tick })
    })
    await phase('confirm-then-revoke-never-creates-a-retry', async () => {
      await verifyGrantLossDuringRetryConfirmation({ page, admin, node, projectRoot, projectId, result, createTask, tick, capture: screenshot })
    })
    await phase('authentication-expiry-and-verified-workspace-recovery', async () => {
      // The prior permission proof intentionally finishes on AccessView; restore
      // the conversation before exercising the existing new-task/auth controls.
      await page.locator('.main-nav').getByRole('button', { name: '对话', exact: true }).click()
      const retainedId = result.cancel.ticket_id
      const replacement = 'browser-replacement-client-credential'
      const rejected = 'browser-rejected-client-credential'
      secrets.push(replacement, rejected)
      const dbFile = join(server.dataDir, 'loom.sqlite3')
      const credentialRecord = (token) => {
        const db = new DatabaseSync(dbFile)
        try {
          const update = db.prepare('UPDATE settings SET value = ?1 WHERE key = ?2').run(sha256(token), 'client_token_hash')
          assert.equal(update.changes, 1)
          assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?1').get('client_token_hash').value, sha256(token))
        } finally { db.close() }
      }
      const ticketCount = () => {
        const db = new DatabaseSync(dbFile, { readOnly: true })
        try { return Number(db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count) } finally { db.close() }
      }
      const before = ticketCount()
      credentialRecord(replacement)
      admin.clientToken = replacement
      await page.getByRole('button', { name: '新的任务', exact: true }).click()
      await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
      await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
      await page.locator('#connection-dialog .form-error').waitFor()
      await page.locator('.auth-warning').waitFor()
      await page.getByRole('button', { name: '关闭连接设置', exact: true }).click()
      await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
      assert.match(await page.locator('.auth-warning').innerText(), /只是上次读取的数据/)
      assert.equal(await page.locator('.connection-pill').innerText(), '需要认证')
        await page.locator('#task-objective').fill('Credentials expired: this must not create a new task')
      await page.getByRole('button', { name: '开始任务', exact: true }).click()
      await page.locator('.composer .form-error').waitFor()
      assert.match(await page.locator('.composer .form-error').innerText(), /请先完成连接认证/)
      assert.equal(ticketCount(), before, 'The expired UI credential must not dispatch a new Ticket behind the stale list')

      await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
      await page.locator('#client-token').fill(rejected)
      await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
      await page.locator('#connection-dialog .form-error').waitFor()
      assert.match(await page.locator('#connection-dialog .form-error').innerText(), /凭据已失效/)
      assert.equal(await page.locator('#connection-dialog').count(), 1, 'A failed credential attempt must not claim a closed, restored connection')
      assert.equal(await page.evaluate(() => localStorage.getItem('loom.client-token')), server.clientToken,
        'Replacing a candidate must not overwrite the stored token before protected reads pass')
      credentialRecord(server.clientToken)
      admin.clientToken = server.clientToken
      await page.locator('#client-token').fill(server.clientToken)
      await page.getByRole('button', { name: '保存并验证连接', exact: true }).click()
      await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
      await page.locator('.auth-warning').waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => localStorage.getItem('loom.client-token')), server.clientToken)
      if (await page.locator('.ticket-id').count() && (await page.locator('.ticket-id').innerText()).includes(retainedId)) {
        assert.match(await page.locator('.ticket-detail h1').innerText(), /Synthetic browser stop intent/,
          'The already opened retained Ticket must remain exactly the same cancelled work')
      } else {
        // Auth recovery may restore the newest reconciling revoked Ticket. Use
        // the existing new-task action to reveal its list, then explicitly reopen
        // the original cancelled ticket instead of treating that detail as the same work.
        await page.getByRole('button', { name: '新的任务', exact: true }).click()
        const historicalCancel = page.locator('.ticket-item').filter({ hasText: 'Synthetic browser stop intent' })
        await historicalCancel.waitFor()
        assert.equal(await historicalCancel.count(), 1)
        await historicalCancel.click()
      }
      await page.waitForFunction(expected => document.querySelector('.ticket-id')?.textContent.includes(expected), retainedId)
      const restored = await admin.get(`/api/v1/tickets/${retainedId}`)
      assert.equal(restored.status, 'cancelled', 'Client credential recovery must not rewrite the existing Ticket state')
      await page.locator('.report-section summary').click()
      assert.match(await page.locator('.report-section').innerText(), /已取消报告/)
      const cancelReport = restored.reports.at(-1)
      assert.equal(cancelReport.state, 'cancelled')
      assert.ok([1, true].includes(cancelReport.cancel_acknowledged), 'The actual controller Report must include its real cancellation acknowledgement')
      assert.equal(restored.artifacts.length, 0)
      assert.equal(restored.effects.length, 0, 'The never-started cancellation cannot invent effects or artifact rows')
      assert.equal((await admin.get('/api/v1/tickets')).tickets.length, before)
      const nodes = await admin.get('/api/v1/nodes')
      assert.equal(nodes.nodes.filter(item => item.id === node.nodeId && item.status === 'online').length, 1, 'Credential update does not create or revoke a Worker')
      result.authentication_recovery = {
        actual_center_401: true, prior_snapshot_explicitly_stale: true, old_ticket_selection_preserved_during_warning: true,
        failed_candidate_not_saved: true, new_ticket_posts_blocked: ticketCount() - before,
        valid_refresh_then_saved: true, restored_ticket_id: retainedId, restored_ticket_status: restored.status, worker_not_recreated: true,
        simulation: 'owned SQLite client_token_hash replacement and restoration; Node credentials/Grant/Ticket left intact',
      }
      await screenshot('06-restored-authenticated-workspace')
    })
    if (flags.has('--narrow-viewport')) await phase('fallback-narrow-viewport-only', async () => {
      await page.getByRole('button', { name: '新的任务', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForSelector('.mobile-tabs')
      await page.getByRole('navigation', { name: '移动端工作空间' }).getByRole('button', { name: '更多', exact: true }).click()
      await page.getByRole('navigation', { name: '更多工作空间' }).getByRole('button', { name: '权限', exact: true }).click()
      await page.waitForSelector('.grant-item')
      const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      assert.ok(layout.document <= layout.viewport + 1, `Narrow viewport horizontal overflow: ${JSON.stringify(layout)}`)
      await screenshot('05-narrow-simulated-viewport-permissions')
      result.mobile_viewport = `PASS 390x844 Chromium viewport only (${layout.document}px scroll width); NOT phone, lockscreen, network-switch or accessibility`
    })
    assert.equal(heartbeatCount, 8, 'Initial heartbeat plus normal tasks, two empty revoking polls, one failed read and one post-revoke idle check')
    result.heartbeat = { calls: heartbeatCount, meaning: 'one initial + one bounded call before ordinary executions, two revoked-before-admission checks, a genuine failed read and a permission-loss idle check; no open-loop heartbeat' }
    await bounded(node.client.dispatchOutbox(), 'final outbox drain')
    result.exclusions = ['No real phone, lockscreen, network switching, accessibility audit', 'No Tauri/live paid LLM/multi-node delivery/host DSH Plugin claimed', 'No DSH/Desktop profile, live user browser session or credentials', 'No shared DSH GUI port or existing browser CDP endpoint attached']
    await cleanup()
  } catch (error) { await cleanup(error) }
  finally { clearTimeout(timeout); process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal) }

  async function loginWithSyntheticToken() {
    await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
    await page.locator('#client-token').fill(server.clientToken)
    await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await page.waitForSelector('.connection-banner', { state: 'hidden' })
    await page.locator('#task-objective').waitFor()
  }
  async function createTask({ objective, kind = 'read_summary', path, content }) {
    if (await page.locator('.ticket-detail').count()) await page.getByRole('button', { name: '新的任务', exact: true }).click()
    await page.locator('#task-objective').fill(objective)
    if (kind === 'edit_file') await page.getByRole('button', { name: '写入文件', exact: true }).click()
    await page.locator(kind === 'edit_file' ? '#relative-path' : '#read-relative-path').fill(path)
    if (content !== undefined) await page.locator('#edit-content').fill(content)
    await page.getByRole('button', { name: '开始任务', exact: true }).click()
    await page.waitForFunction((expected) => document.querySelector('.ticket-detail h1')?.textContent === expected, objective)
    return (await page.locator('.ticket-id').innerText()).split('/').pop().trim()
  }
  async function tick(expected) {
    await bounded(node.client.heartbeat({ capabilities: node.capabilities, workers: [{ worker_id: 'default' }], inventory: { project_roots: { [projectId]: projectRoot } } }), 'Node heartbeat')
    heartbeatCount++
    const pollOutcome = await bounded(node.pollAndRun(), 'Node pull and run')
    if (expected === 'cancel_acknowledged' && pollOutcome.status !== expected) {
      const localAssignments = Object.entries(node.state.data.assignments).map(([id, assignment]) => ({
        assignment_id: id, ticket_id: assignment.ticket_id, lease_epoch: assignment.lease_epoch,
        has_cancel_requested: Boolean(assignment.cancel_requested),
      }))
      const rejection = pollOutcome.rejection && {
        assignment_id: pollOutcome.rejection.assignment_id, ticket_id: pollOutcome.rejection.ticket_id,
        reason: pollOutcome.rejection.reason, acknowledgement: pollOutcome.rejection.acknowledgement?.outcome,
      }
      throw new Error(`Stop acknowledgement capture returned ${JSON.stringify({ status: pollOutcome.status, rejection, last_assignment_id: node.lastAssignmentId, local_assignments: localAssignments })}`)
    }
    assert.equal(pollOutcome.status, expected)
    await bounded(node.client.dispatchOutbox(), 'deferred outbox delivery')
    await bounded(node.client.dispatchOutbox(), 'terminal deferred outbox delivery')
  }
  async function desktopTicketIsUsable() {
    const layout = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect()
      return { detailWidth: rect('.ticket-detail')?.width, workspaceWidth: rect('.workspace-content')?.width,
        helpfulUnrelatedViewVisible: !!document.querySelector('.help-view')?.getBoundingClientRect().width,
        visibleViews: [...document.querySelectorAll('.workspace-content > section, .workspace-content > .page-view')]
          .map((element) => ({ tag: element.tagName, width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }))
          .filter((view) => view.width > 0) }
    })
    return layout
  }
  async function reloadSuccess() { await page.reload(); await page.waitForFunction(() => document.querySelector('.next-action-card.success-action')?.textContent.includes('收到成功报告')) }
}
async function verifyDisplayPreferences({ page, admin, node, server, projectRoot, result, refreshTicket }) {
  // Individual/global expected routes are asserted at their own PUT responses below,
  // without forbidding the legitimate global (null ticket_id) write.
  const ticketId = result.actual_write.ticket_id
  const ticketBefore = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.equal(ticketBefore.status, 'succeeded')
  assert.equal(ticketBefore.assignments.length, 1)
  // Exact response scope/payload is asserted below; no sensitive HTTP headers
  // or transcript contents need to be emitted to the browser evidence log.
  const owner = ticketBefore.assignments[0]
  assert.equal(owner.lease_epoch, 1)
  const sessionId = randomUUID()
  const content = 'Node-authored bounded process message for display preference verification.'
  const sessionRef = { harness: 'deterministic-local-node', host_api: 'loom.node.v1', protocol: 'loom.node.v1', session_id: sessionId, observed_seq: 1 }
  await node.client.event({ ticketId, assignmentId: owner.id, leaseEpoch: owner.lease_epoch,
    kind: 'session_link', sessionRef, summary: content })
  const delivered = await node.client.dispatchOutbox()
  assert.ok(delivered.some(item => item.kind === 'event' && item.status === 'delivered'), 'The actual node event must reach the authenticated Rust coordinator')
  const withMessage = await admin.get(`/api/v1/tickets/${ticketId}`)
  const matching = withMessage.messages.filter(message => message.kind === 'session_link' && message.content === content)
  assert.equal(matching.length, 1)
  assert.equal(matching[0].sender, 'worker')
  const reference = typeof matching[0].session_ref === 'string' ? JSON.parse(matching[0].session_ref) : matching[0].session_ref
  assert.deepEqual(reference, sessionRef)
  await refreshTicket()

  const activityTabs = page.getByRole('tablist', { name: '任务过程视图', exact: true })
  await activityTabs.getByRole('tab', { name: '协作', exact: true }).click()
  const localToggle = page.getByRole('checkbox', { name: '展开过程消息', exact: true })
  // Switch labels are the real click targets: their native inputs are intentionally
  // transparent and must not be treated as ordinary large clickable checkboxes.
  assert.equal(await localToggle.isChecked(), false, 'The default selected ticket must keep process collapsed')
  assert.equal(await page.locator('.collab-message').count(), 0)
  await page.getByText('过程已折叠', { exact: true }).waitFor()
  const oldGlobal = (await admin.get('/api/v1/preferences')).expanded
  assert.equal(await localToggle.isChecked(), oldGlobal, 'A newly selected ticket follows the global default until it gets its own local choice')

  const preferenceWrites = []
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname === '/api/v1/preferences' && response.request().method() === 'PUT') {
      preferenceWrites.push({ id: url.searchParams.get('ticket_id'), expanded: response.request().postDataJSON().expanded, status: response.status() })
    }
  })
  const readyForToggle = async () => {
    await page.waitForFunction(() => document.querySelector('.display-settings input[type="checkbox"]')?.disabled === false)
  }
  const expectPut = async (expanded, scopeId) => {
    await readyForToggle()
    const pending = page.waitForResponse(response => {
      if (response.request().method() !== 'PUT') return false
      const url = new URL(response.url())
      return url.pathname === '/api/v1/preferences' && url.searchParams.get('ticket_id') === scopeId
    })
    // Wait for the actual enabled checkbox, then click its visible switch label.
    if ((await localToggle.isChecked()) !== expanded) await localToggle.locator('xpath=parent::label').click()
    assert.equal(await localToggle.isChecked(), expanded, 'The task checkbox and intended persist state must agree')
    // The pending response must still arrive from the exact expected save scope.
    const response = await pending
    assert.equal(response.status(), 200)
    const payload = response.request().postDataJSON()
    assert.equal(payload.expanded, expanded)
    assert.equal(payload.sender_filter, null)
  }
  const assertMessageCount = async (count) => {
    assert.equal(await page.locator('.collab-message').count(), count)
    if (count) assert.match(await page.locator('.collab-message').innerText(), /bounded process message for display preference verification/)
    else await page.getByText('过程已折叠', { exact: true }).waitFor()
  }
  await expectPut(true, ticketId)
  await localToggle.waitFor({ state: 'visible' })
  await page.locator('.collab-message').waitFor()
  await assertMessageCount(1)
  await expectPut(false, ticketId)
  await assertMessageCount(0)
  await expectPut(true, ticketId)
  await assertMessageCount(1)
  await page.locator('.main-nav').getByRole('button', { name: '项目', exact: true }).click()
  const globalToggle = page.getByRole('checkbox', { name: '默认展开过程消息', exact: true })
  assert.equal(await globalToggle.isChecked(), false, 'A task-level override must not change the global default checkbox')
  const globalPut = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/preferences' && new URL(response.url()).searchParams.get('ticket_id') === null)
  await globalToggle.locator('xpath=parent::label').click()
  assert.equal((await globalPut).status(), 200, 'The explicit global preference request must complete its real persist step')
  await page.locator('.main-nav').getByRole('button', { name: '对话', exact: true }).click()
  await activityTabs.getByRole('tab', { name: '协作', exact: true }).click()
  assert.equal(await localToggle.isChecked(), true, 'Global expansion cannot erase an explicit task expansion')
  await assertMessageCount(1)
  await page.locator('.main-nav').getByRole('button', { name: '项目', exact: true }).click()
  await globalToggle.locator('xpath=parent::label').click()
  await page.locator('.main-nav').getByRole('button', { name: '对话', exact: true }).click()
  await activityTabs.getByRole('tab', { name: '协作', exact: true }).click()
  assert.equal(await localToggle.isChecked(), true)
  await assertMessageCount(1)
  await refreshTicket()
  await activityTabs.getByRole('tab', { name: '协作', exact: true }).click()
  assert.equal(await localToggle.isChecked(), true, 'A reload must restore task preference from authorized persistence, not shared UI state')
  await assertMessageCount(1)
  await expectPut(false, ticketId)
  await assertMessageCount(0)

  const db = new DatabaseSync(join(server.dataDir, 'loom.sqlite3'), { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT value FROM settings WHERE key=?1').get('global_expanded').value, 'false', 'Global default was never modified by the task-only override')
    assert.equal(db.prepare('SELECT expanded FROM preferences WHERE ticket_id=?1').get(ticketId).expanded, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE ticket_id=?1 AND kind=?2').get(ticketId, 'session_link').count, 1, 'Collapsing a view never deletes authorized collaboration messages')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reports WHERE ticket_id=?1').get(ticketId).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE ticket_id=?1').get(ticketId).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM effects WHERE ticket_id=?1').get(ticketId).count, 1)
  } finally { db.close() }
  const ticketAfter = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.deepEqual(ticketAfter.reports.map(row => row.id), withMessage.reports.map(row => row.id))
  assert.deepEqual(ticketAfter.artifacts.map(row => row.id), withMessage.artifacts.map(row => row.id))
  assert.deepEqual(ticketAfter.effects.map(row => row.effect_id || row.id), withMessage.effects.map(row => row.effect_id || row.id))
  const bytes = await readFile(join(projectRoot, 'nested/browser-result.txt'))
  assert.equal(sha256(bytes), result.actual_write.content_sha256, 'Display preferences cannot change the real file effect')
  assert.equal(preferenceWrites.filter(row => row.id === ticketId).length, 4)
  assert.equal(preferenceWrites.filter(row => row.id === null).length, 2)
  assert.ok(preferenceWrites.every(row => row.status === 200 && typeof row.expanded === 'boolean'))
  result.checks.push({
    name: 'global folded default, per-Ticket expansion/collapse/reload preserve messages and file effects',
    status: 'PASS',
    detail: {
      ticket_id: ticketId, session_id: sessionId, event_kind: 'session_link', sender: 'worker',
      initial_global: false, explicit_ticket_expansion: true, final_task_expanded: false,
      reports: ticketAfter.reports.length, artifacts: ticketAfter.artifacts.length, effects: ticketAfter.effects.length,
      process_message_count: withMessage.messages.length, file_sha256: result.actual_write.content_sha256,
      scoped_preference_put_responses: preferenceWrites,
      event_provenance: `actual node-authored event through node.client.event for assignment=${owner.id}, not a claimed DSH transcript`,
    },
  })
}
async function verifyGrantRevocationBeforeAdmission({ page, admin, node, server, projectRoot, result, createTask, tick }) {
  result.revocation_before_first_poll ||= {}
  const path = 'nested/revoked-before-first-poll.txt'
  const ticketId = await createTask({ objective: 'Synthetic browser pending revoked grant', kind: 'edit_file', path, content: 'This unclaimed assignment must not execute after its Grant is revoked.\n' })
  const pending = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.equal(pending.status, 'running', 'Create the pending ticket but do not poll the Node yet')
  assert.ok([false, 0].includes(pending.cancel_requested))
  assert.equal(pending.assignments.length, 1)
  const admitted = pending.assignments[0]
  assert.equal(admitted.acknowledged_at, null)
  assert.equal(admitted.last_report_at, null)
  assert.equal(pending.reports.length + pending.artifacts.length + pending.effects.length, 0)
  assert.equal(node.state.data.assignments[admitted.id], undefined, 'The Node must not have admitted this Assignment before the UI revocation')

  const grantsBefore = (await admin.get('/api/v1/grants')).grants
  assert.equal(grantsBefore.length, 1)
  const grantBefore = grantsBefore.find(grant => grant.id === pending.grant_id)
  assert.ok(grantBefore)
  assert.equal(grantBefore.version, 1)
  assert.equal(grantBefore.revoked_at, null)
  await page.locator('.main-nav').getByRole('button', { name: '权限', exact: true }).click()
  const grantCard = page.locator('.grant-item').filter({ hasText: grantBefore.id })
  await grantCard.getByRole('button', { name: '撤销授权', exact: true }).click()
  await page.getByRole('button', { name: '确认撤销授权', exact: true }).waitFor()
  const revoking = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/grants/${grantBefore.id}/revoke`)
  const refreshed = page.waitForResponse(async response => {
    if (response.request().method() !== 'GET' || new URL(response.url()).pathname !== '/api/v1/grants') return false
    const payload = await response.json()
    const current = Array.isArray(payload.grants) && payload.grants.find(grant => grant.id === grantBefore.id)
    return Boolean(current && current.version === 2 && current.revoked_at !== null && current.revoked_at !== undefined)
  })
  await page.getByRole('button', { name: '确认撤销授权', exact: true }).click()
  const [revokeResponse] = await Promise.all([revoking, refreshed])
  assert.equal(revokeResponse.status(), 200)
  const accepted = await revokeResponse.json()
  assert.equal(accepted.revoked, true)
  assert.equal(accepted.grant_id, grantBefore.id)
  assert.deepEqual(revokeResponse.request().postDataJSON(), {})
  const authorization = revokeResponse.request().headers().authorization
  assert.ok(authorization?.startsWith('Bearer '), 'The UI must send the actual client authentication')
  assert.equal(sha256(authorization.slice('Bearer '.length)), sha256(server.clientToken), 'This is the UI client credential, never a forged Node identity')

  await grantCard.locator('.status-badge').filter({ hasText: '已撤销', exact: true }).waitFor()
  assert.equal(await grantCard.locator('.status-badge').innerText(), '已撤销', 'Actual revoked_at must determine the displayed state, not a missing status field')
  assert.equal(await grantCard.getByRole('button', { name: '撤销授权', exact: true }).count(), 0)
  const revoked = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.equal(revoked.status, 'reconciling', 'Revocation is not a fabricated cancellation/completion of the unclaimed task')
  assert.ok([false, 0].includes(revoked.cancel_requested))
  assert.equal(revoked.reports.length + revoked.artifacts.length + revoked.effects.length, 0)
  const originalAssignment = revoked.assignments.find(assignment => assignment.id === admitted.id)
  assert.ok(originalAssignment)
  assert.equal(originalAssignment.acknowledged_at, null)
  assert.equal(originalAssignment.last_report_at, null)
  assert.equal(originalAssignment.lease_id, admitted.lease_id)
  assert.equal(originalAssignment.lease_epoch, admitted.lease_epoch)
  assert.equal(revoked.grant_digest, pending.grant_digest)
  assert.ok(Date.parse(originalAssignment.lease_expires_at) <= Date.parse(admitted.lease_expires_at), 'Revocation cannot renew the old Lease')
  const revokedGrants = (await admin.get('/api/v1/grants')).grants
  const currentGrant = revokedGrants.find(grant => grant.id === grantBefore.id)
  assert.equal(currentGrant.version, 2)
  assert.ok(currentGrant.revoked_at)
  assert.equal(currentGrant.digest, grantBefore.digest)

  const localBefore = JSON.stringify({ assignments: node.state.data.assignments, completions: node.state.data.completions })
  const post = node.http.post.bind(node.http)
  const polls = []
  node.http.post = async (route, body, options) => {
    const response = await post(route, body, options)
    if (route === '/api/v1/nodes/assignments/poll') {
      if (!response || typeof response !== 'object' || !Object.hasOwn(response, 'assignment')) throw new Error('Revocation poll must return an explicit assignment field')
      polls.push({ assignment: response.assignment, node_id: body.node_id })
    }
    return response
  }
  let executorCalls = 0
  const originalExecutor = node.executor
  node.executor = { execute: async () => { executorCalls++; throw new Error('FAIL: a revoked unclaimed Assignment reached the executor') } }
  try {
    await tick('idle')
    await tick('idle')
  } finally {
    node.executor = originalExecutor
    node.http.post = post
  }
  assert.equal(polls.length, 2, 'Both genuine Node polling attempts must return no Assignment')
  assert.ok(polls.every(call => call.assignment === null && call.node_id === node.nodeId))
  assert.equal(executorCalls, 0, 'The test executor would throw on any actual attempt to execute after revocation')
  assert.equal(JSON.stringify({ assignments: node.state.data.assignments, completions: node.state.data.completions }), localBefore, 'Idle revoked polling cannot create an admission, completion or rejection')
  assert.equal(node.state.data.outbox.length, 0, 'No artifact/report/cancel acknowledgements should be produced for this pending Task')

  const afterPolls = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.equal(afterPolls.status, 'reconciling')
  assert.ok([false, 0].includes(afterPolls.cancel_requested))
  assert.equal(afterPolls.reports.length + afterPolls.artifacts.length + afterPolls.effects.length, 0)
  assert.equal(afterPolls.assignments[0].acknowledged_at, null)
  await stat(join(projectRoot, path)).then(() => { throw new Error('Forbidden file was created by revoked pending work') }, error => { assert.equal(error.code, 'ENOENT') })
  const totalTickets = (await admin.get('/api/v1/tickets')).tickets
  await assert.rejects(admin.post('/api/v1/tickets', { project_id: pending.project_id, objective: 'Cannot reuse revoked Grant', kind: pending.kind,
    relative_path: 'nested/revoke-cannot-replay.txt', content: 'Forbidden replacement execution', grant_id: grantBefore.id,
    node_id: pending.node_id, worker_id: pending.worker_id }), error => {
    assert.equal(error.status, 403)
    assert.equal(error.code, 'grant_scope')
    return true
  })
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, totalTickets.length, 'Rejected reuse cannot create another ticket or assignment')

  const audit = (await admin.get('/api/v1/audit')).audit
  const grantAudit = audit.filter(entry => entry.action === 'grant.revoked' && (typeof entry.evidence === 'string' ? JSON.parse(entry.evidence) : entry.evidence).evidence.grant_id === grantBefore.id)
  assert.equal(grantAudit.length, 1, 'Keep the real central revocation evidence')
  assert.equal(grantAudit[0].ticket_id, null, 'A Grant revocation audit is not the pending Ticket cancellation')
  const ticketAudit = (await admin.get(`/api/v1/audit?ticket_id=${ticketId}`)).audit
  assert.equal(ticketAudit.filter(entry => ['assignment.acknowledged', 'cancel.requested', 'report.accepted', 'artifact.indexed'].includes(entry.action)).length, 0)
  const auditVerification = await admin.get('/api/v1/audit/verify')
  assert.equal(auditVerification.valid, true)
  assert.equal(auditVerification.algorithm, 'sha256_chain_v1')
  const currentBefore = await admin.get(`/api/v1/tickets/${result.actual_write.ticket_id}`)
  assert.equal(currentBefore.artifacts.length, 1)
  assert.equal(currentBefore.effects[0].status, 'confirmed')

  const freshGrants = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/grants')
  await page.reload()
  assert.equal((await freshGrants).status(), 200)
  const reloadedCard = page.locator('.grant-item').filter({ hasText: grantBefore.id })
  await reloadedCard.locator('.status-badge').filter({ hasText: '已撤销', exact: true }).waitFor()
  assert.equal(await reloadedCard.locator('.status-badge').innerText(), '已撤销', 'Reload must recover the persisted revocation, not an optimistic UI reset')
  assert.equal(await reloadedCard.getByRole('button', { name: '撤销授权', exact: true }).count(), 0)

  // Reconciliation is not a valid retry offer even when the central ticket is visible.
  await page.locator('.main-nav').getByRole('button', { name: '对话', exact: true }).click()
  if (!(await page.locator('.ticket-detail h1').count()) || !(await page.locator('.ticket-detail h1').innerText()).includes('Synthetic browser pending revoked grant')) {
    if (await page.getByRole('button', { name: '新的任务', exact: true }).count()) {
      await page.getByRole('button', { name: '新的任务', exact: true }).click()
    }
    await page.locator('.ticket-item').filter({ hasText: 'Synthetic browser pending revoked grant' }).click()
  }
  await page.locator('.ticket-detail').getByText('执行结果未知，需要对账', { exact: true }).waitFor()
  const unavailableRetry = page.getByRole('button', { name: '先处理对账', exact: true })
  assert.equal(await unavailableRetry.isDisabled(), true)
  const retryRequests = []
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/tickets/${ticketId}/retry`) retryRequests.push(request.url())
  })
  await unavailableRetry.click({ force: true })
  assert.equal(retryRequests.length, 0)
  assert.equal(await page.locator('.confirm-modal').count(), 0)
  await assert.rejects(admin.post(`/api/v1/tickets/${ticketId}/retry`, {}), error => {
    assert.equal(error.status, 400)
    assert.match(error.message, /reconciliation/)
    return true
  })
  const nonRetried = await admin.get(`/api/v1/tickets/${ticketId}`)
  assert.equal(nonRetried.status, 'reconciling')
  assert.equal(nonRetried.attempt, pending.attempt)
  assert.equal(nonRetried.assignments.length, 1)
  assert.equal(nonRetried.assignments[0].id, admitted.id)
  assert.equal(nonRetried.reports.length + nonRetried.artifacts.length + nonRetried.effects.length, 0)
  assert.ok([false, 0].includes(nonRetried.cancel_requested))
  result.revocation_before_first_poll.reconciling_ui_no_retry_offer = true
  result.revocation_before_first_poll.reconciling_retry_browser_posts = retryRequests.length
  result.revocation_before_first_poll.direct_reconciling_retry = { status: 400, new_assignment: false }
  result.revocation_before_first_poll = {
    ...result.revocation_before_first_poll,
    ticket_id: ticketId, grant_id: grantBefore.id, assignment_id: admitted.id,
    before_status: 'running', after_status: revoked.status, grant_version: currentGrant.version,
    revoked_at: currentGrant.revoked_at, original_digest_retained: true,
    cancel_requested: revoked.cancel_requested, acknowledged_at: originalAssignment.acknowledged_at,
    lease_id_preserved: originalAssignment.lease_id === admitted.lease_id, lease_epoch: originalAssignment.lease_epoch,
    two_real_node_empty_polls: polls, executor_calls: executorCalls,
    reports: afterPolls.reports.length, artifacts: afterPolls.artifacts.length, effects: afterPolls.effects.length,
    file_effect_absent: true, failed_reuse_status: 403, new_ticket_on_rejected_reuse: false,
    persisted_revoked_badge: true, original_successful_artifact_hash: result.actual_write.content_sha256,
  }
  // The emitted proof must retain the exact negative control facts we actually asserted,
  // not overwrite them with the broader revoking summary object.
  assert.equal(result.revocation_before_first_poll.reconciling_ui_no_retry_offer, true)
  assert.equal(result.revocation_before_first_poll.reconciling_retry_browser_posts, 0)
  assert.deepEqual(result.revocation_before_first_poll.direct_reconciling_retry, { status: 400, new_assignment: false })
}
async function verifyGrantLossDuringRetryConfirmation({ page, admin, node, projectRoot, projectId, result, createTask, tick, capture }) {
  // Separate freshly authorized Grant for this negative fixture. It never replaces
  // the authority of any previously revoked Ticket, nor revives its pending work.
  const independentGrant = await admin.post('/api/v1/grants', { project_id: projectId,
    project_binding_id: result.fixture.binding_id, node_id: node.nodeId, worker_id: 'default', operations: ['read', 'write'] })
  const grantId = independentGrant.grant.id
  assert.notEqual(grantId, result.revocation_before_first_poll.grant_id)
  const inputPath = join(projectRoot, 'input.txt')
  const hiddenPath = join(projectRoot, 'retry-confirmation-held-input.txt')
  const originalBytes = await readFile(inputPath)
  // Ticket summaries do not carry each immutable Report/Artifact/Effect collection.
  // Fetch those separately through the authenticated detail API before moving the fixture file.
  const ticketSummaries = (await admin.get('/api/v1/tickets')).tickets
  const olderTickets = await Promise.all(ticketSummaries.map(ticket => admin.get(`/api/v1/tickets/${ticket.id}`)))
  const historyBefore = new Map(olderTickets.map(ticket => [ticket.id, {
    status: ticket.status, attempt: ticket.attempt,
    reports: ticket.reports.map(report => report.id).sort(),
    artifacts: ticket.artifacts.map(artifact => ({ id: artifact.id, sha256: artifact.sha256 })).sort((a, b) => a.id.localeCompare(b.id)),
    effects: ticket.effects.map(effect => effect.id ?? effect.effect_id).sort(),
  }]))
  await rename(inputPath, hiddenPath)
  let failedId
  try {
    failedId = await createTask({ objective: 'Synthetic failed read awaiting late Grant revocation', kind: 'read_summary', path: 'input.txt' })
    await tick('failed')
  } finally {
    await rename(hiddenPath, inputPath)
    assert.deepEqual(await readFile(inputPath), originalBytes, 'The driver restores its explicit clean baseline, not an Agent rollback')
  }
  const failedBeforeRevocation = await admin.get(`/api/v1/tickets/${failedId}`)
  assert.equal(failedBeforeRevocation.status, 'failed')
  assert.equal(failedBeforeRevocation.attempt, 1)
  assert.equal(failedBeforeRevocation.assignments.length, 1)
  assert.equal(failedBeforeRevocation.reports.length, 1)
  assert.equal(failedBeforeRevocation.reports[0].state, 'failed')
  assert.equal(failedBeforeRevocation.artifacts.length, 0)
  assert.equal(failedBeforeRevocation.effects.length, 0)
  assert.equal(failedBeforeRevocation.grant_id, grantId)
  const firstAssignment = failedBeforeRevocation.assignments[0]
  assert.ok(firstAssignment.acknowledged_at)
  assert.ok(firstAssignment.last_report_at)
  // The failed Ticket is explicitly selected through the real task list before opening its retry confirmation.
  if ((await page.locator('.ticket-detail h1').count())) await page.getByRole('button', { name: '新的任务', exact: true }).click()
  const failedRow = page.locator('.ticket-item').filter({ hasText: 'Synthetic failed read awaiting late Grant revocation' })
  await failedRow.click()
  await page.locator('.ticket-detail').getByText('这项任务未能完成', { exact: true }).waitFor()
  await page.getByRole('button', { name: '明确新尝试', exact: true }).click()
  await page.getByRole('button', { name: '创建新尝试', exact: true }).waitFor()
  const stageBefore = await page.evaluate(() => ({
    retry_confirmation_open: Boolean(document.querySelector('.confirm-modal')),
    selected_ticket: localStorage.getItem('loom.selected-ticket'),
  }))
  assert.equal(stageBefore.retry_confirmation_open, true)
  assert.equal(stageBefore.selected_ticket, failedId)
  const revocation = await admin.post(`/api/v1/grants/${grantId}/revoke`, {})
  assert.equal(revocation.revoked, true)
  assert.equal(revocation.grant_id, grantId)
  const subsequentGrant = (await admin.get('/api/v1/grants')).grants.find(grant => grant.id === grantId)
  assert.equal(subsequentGrant.version, 2)
  assert.ok(subsequentGrant.revoked_at)
  const failedResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/tickets/${failedId}/retry`)
  await page.getByRole('button', { name: '创建新尝试', exact: true }).click()
  const refused = await failedResponse
  assert.equal(refused.status(), 400)
  const message = (await refused.json()).error?.message ?? ''
  assert.match(message, /Grant revoked/)
  const modal = await page.locator('.confirm-modal').innerText()
  assert.match(modal, /Grant revoked/, 'The real confirmation must show the current revoked-grant failure, not retain an optimistic success')
  const modalErrors = await page.getByRole('alert').allTextContents()
  assert.ok(modalErrors.some(text => text.includes('Grant revoked')))
  await capture('07-late-grant-revocation-in-retry-confirm')

  const rejectedDetail = await admin.get(`/api/v1/tickets/${failedId}`)
  assert.equal(rejectedDetail.status, 'failed', 'Permission loss does not turn a known failed operation into a new successful / unknown retried state')
  assert.equal(rejectedDetail.attempt, 1)
  assert.equal(rejectedDetail.assignments.length, 1)
  assert.equal(rejectedDetail.assignments[0].id, firstAssignment.id)
  assert.equal(rejectedDetail.assignments[0].lease_epoch, firstAssignment.lease_epoch)
  assert.equal(rejectedDetail.grant_digest, failedBeforeRevocation.grant_digest)
  assert.equal(rejectedDetail.reports.length, 1)
  assert.deepEqual(rejectedDetail.reports.map(report => report.id), failedBeforeRevocation.reports.map(report => report.id))
  assert.equal(rejectedDetail.artifacts.length + rejectedDetail.effects.length, 0)
  assert.ok([false, 0].includes(rejectedDetail.cancel_requested))
  const pendingActionAfter = await page.locator('.confirm-modal').count()
  assert.equal(pendingActionAfter, 1, 'The error must remain visible, without pretending to hide a failed auth attempt as accepted')
  await page.getByRole('button', { name: '返回检查', exact: true }).click()
  assert.equal(await page.locator('.confirm-modal').count(), 0)
  const oldExecutor = node.executor
  const localBefore = JSON.stringify({ assignments: node.state.data.assignments, completions: node.state.data.completions })
  let calls = 0
  node.executor = { execute: async () => { calls++; throw new Error('Failed Grant revocation reached the worker despite the server refusal') } }
  try { await tick('idle') } finally { node.executor = oldExecutor }
  assert.equal(calls, 0)
  assert.equal(JSON.stringify({ assignments: node.state.data.assignments, completions: node.state.data.completions }), localBefore)
  assert.equal(node.state.data.outbox.length, 0)
  await page.locator('.main-nav').getByRole('button', { name: '权限', exact: true }).click()
  const revokedCard = page.locator('.grant-item').filter({ hasText: grantId })
  await revokedCard.locator('.status-badge').filter({ hasText: '已撤销', exact: true }).waitFor()
  assert.equal(await revokedCard.getByRole('button', { name: '撤销授权', exact: true }).count(), 0)
  const finalTicketSummaries = (await admin.get('/api/v1/tickets')).tickets
  const finalTickets = await Promise.all(finalTicketSummaries.map(ticket => admin.get(`/api/v1/tickets/${ticket.id}`)))
  assert.equal(finalTickets.length, historyBefore.size + 1, 'Only the deliberately failed read is added; no silent replacement or missing historical Tickets')
  const finalIds = new Set(finalTickets.map(ticket => ticket.id))
  assert.equal(finalIds.size, finalTickets.length, 'Every final Ticket has its own immutable ID, not aliases reused across scope')
  assert.ok(finalIds.has(failedId), 'The single failed fixture is still present after the revocation and denial')
  for (const oldId of historyBefore.keys()) {
    assert.ok(finalIds.has(oldId), `Historical Ticket ${oldId} must remain queryable after the grant loss; it may not be deleted or hidden from the history junction`)
  }
  for (const ticket of finalTickets) {
    if (ticket.id === failedId) continue
    const old = historyBefore.get(ticket.id)
    assert.ok(old, 'No extra hidden replacement Ticket may be created for a denied retry')
    assert.equal(ticket.status, old.status)
    assert.equal(ticket.attempt, old.attempt)
    assert.deepEqual(ticket.reports.map(report => report.id).sort(), old.reports)
    assert.deepEqual(ticket.artifacts.map(artifact => ({ id: artifact.id, sha256: artifact.sha256 })).sort((a, b) => a.id.localeCompare(b.id)), old.artifacts,
      'Older byte-backed Artifact IDs and hashes remain immutable')
    assert.deepEqual(ticket.effects.map(effect => effect.id ?? effect.effect_id).sort(), old.effects)
  }
  const audit = (await admin.get('/api/v1/audit/verify'))
  assert.equal(audit.valid, true)
  await capture('08-revoked-grant-after-confirm-refusal')
  result.failed_late_revocation = {
    ticket_id: failedId, grant_id: grantId,
    confirmation_open_before_revocation: stageBefore.retry_confirmation_open,
    grant_version: subsequentGrant.version, revoked_at: subsequentGrant.revoked_at,
    denial_status: refused.status(), reason: message,
    same_ticket: true, same_assignment: rejectedDetail.assignments[0].id === firstAssignment.id,
    attempt_preserved: rejectedDetail.attempt, grant_digest_preserved: rejectedDetail.grant_digest === failedBeforeRevocation.grant_digest,
    report_ids: rejectedDetail.reports.map(report => report.id),
    no_new_artifacts_or_effects: rejectedDetail.artifacts.length + rejectedDetail.effects.length === 0,
    node_executor_calls_after_denial: calls,
    historical_records_unchanged: true, audit_chain_verified: true,
    separate_grant_not_substituting_old_revoked_ticket: true,
  }
}
await run()
