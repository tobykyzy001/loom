#!/usr/bin/env node
// Real standalone Edge -> production Vue -> Rust Concierge installation binding proof.
// This file owns its temporary roots and descendants, never a DSH/user profile/service.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { NodeState } from '../../packages/node-client/src/state.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LoomNodeClient } from '../../packages/node-client/src/client.js'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '../..')
const playwright = JSON.parse(await readFile(join(here, 'node_modules/playwright-core/package.json'), 'utf8'))
assert.equal(playwright.version, '1.65.1', 'The local exact Playwright runtime is required')
const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
assert.equal(await access(executable).then(() => true, () => false), true, `Standalone Edge is missing: ${executable}`)
await realpath(executable)
const flags = new Set(process.argv.slice(2))
assert.ok([...flags].every(flag => flag === '--headed'), 'Usage: node tests/browser/installation-ui.mjs [--headed]')
const trackedSources = ['apps/web/src/components/ProjectBindingDialog.vue', 'apps/web/src/App.vue', 'apps/web/src/binding-input.ts']
async function sourceHashes() {
  const hashes = {}
  for (const relative of trackedSources) {
    const path = join(repository, relative)
    if (await access(path).then(() => true, () => false)) hashes[relative.split('/').pop()] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  return hashes
}
const root = await testingRoot()
const evidence = await mkdtemp(join(tmpdir(), 'loom-installation-ui-proof-'))
const secrets = []
const checks = []
const consoleErrors = []
const consoleResponses = []
const unexpectedResponses = []
const blockedRequests = []
const owned = { browserProcess: null, build: null }
let center, admin, context, browser, page
let finishing = false
const report = {
  schema: 'loom.browser.installation-binding.v1', overall: 'NOT RUN', phase: 'startup', checks,
  target: 'standalone Edge + production Vue apps/web/dist + real Rust Concierge; two logical Installations share one Node identity',
  browser: { executable, playwright_core: playwright.version, personal_profile_used: false, dsh_gui_profile_or_service_used: false },
  command: 'node tests/browser/installation-ui.mjs',
  live_llm: false, compose_1_plus_3: false, second_physical_host: false, grant_ui_submitted: false,
  console_errors: consoleErrors, blocked_browser_requests: blockedRequests,
  results: {},
}
const sleep = ms => new Promise(ok => setTimeout(ok, ms))
function redact(value) {
  let text = String(value)
  for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[redacted-test-secret]')
  return text.slice(-24000)
}
async function bounded(promise, label, timeoutMs = 30000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const exited = new Promise(ok => child.once('exit', ok))
  child.kill('SIGTERM')
  if (!await Promise.race([exited.then(() => true), sleep(4000)])) { child.kill('SIGKILL'); await bounded(exited, 'owned child hard stop', 5000) }
}
async function checked(command, args) {
  const child = spawn(command, args, { cwd: repository, shell: false, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
  owned.build = child
  const output = []
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output.push(String(bytes)); if (output.length > 30) output.shift() })
  try {
    await bounded(new Promise((ok, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? ok() : reject(new Error(`${command} failed (${code}): ${output.join('')}`))) }), 'production Vue build', 150000)
  } finally { await stopChild(child); owned.build = null }
}
async function phase(name, action) {
  report.phase = name
  await action()
  checks.push({ name, status: 'PASS' })
  console.log(`PASS ${name}`)
}
function db(action) {
  const connection = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'), { readOnly: true })
  try { return action(connection) } finally { connection.close() }
}
function count(table) {
  assert.ok(['project_bindings', 'grants', 'tickets', 'assignments', 'reports', 'artifacts', 'effects', 'audits'].includes(table))
  return db(connection => connection.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)
}
const bindingAudits = () => db(connection => connection.prepare("SELECT count(*) AS count FROM audits WHERE action='project.binding.approved'").get().count)
async function pollBoolean(evaluate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.evaluate(evaluate)) return
    await sleep(100)
  }
  throw new Error(`DOM boolean did not become true: ${label}`)
}
async function confirmInstallation() {
  await page.getByRole('button', { name: '确认绑定此位置', exact: true }).click()
}
async function launchBrowser() {
  const profile = join(root, 'standalone-edge-profile')
  await mkdir(profile, { mode: 0o700 })
  context = await bounded(chromium.launchPersistentContext(profile, {
    executablePath: executable, headless: !flags.has('--headed'), viewport: { width: 1100, height: 850 },
    args: ['--no-first-run', '--no-default-browser-check', '--no-default-search', '--disable-sync', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'xdg'), TMPDIR: root }, timeout: 25000,
  }), 'owned Edge launch', 30000)
  browser = context.browser()
  assert.ok(browser?.isConnected())
  const pages = context.pages()
  assert.equal(pages.length, 1)
  assert.equal(pages[0].url(), 'about:blank')
  page = pages[0]
  page.setDefaultTimeout(15000)
  const browserProcess = typeof browser.process === 'function' ? browser.process() : null
  owned.browserProcess = browserProcess
  const argument = owned.browserProcess?.spawnargs.find(value => value.startsWith('--user-data-dir='))
  if (argument) assert.equal(await realpath(argument.slice('--user-data-dir='.length)), await realpath(profile))
  report.browser = { ...report.browser, version: browser.version(), owned_profile_argument_verified: Boolean(argument), persistent_browser_isConnected_supported: typeof browser.isConnected === 'function', profile_is_under_owned_root: true }
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== center.baseUrl) {
      blockedRequests.push(`${url.protocol}//${url.hostname}:${url.port}`)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${redact(error.message)}`))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(redact(message.text()).slice(0, 1400)) })
  page.on('response', response => {
    if (response.status() >= 400) {
      const url = new URL(response.url())
      const record = { method: response.request().method(), path: url.pathname, status: response.status() }
      consoleResponses.push(record)
      if (!(response.status() === 401 && record.method === 'GET' && url.pathname === '/api/v1/bootstrap' && report.browser_requests === undefined)
        && !(response.status() === 403 && record.method === 'POST' && url.pathname === '/api/v1/project-bindings')) unexpectedResponses.push(record)
    }
  })
  page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) consoleErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`) })
}
async function registerAndDeclare(identity, { worker, projectRoot, index, projectId }) {
  // The same real HTTP transport and independent persistent identity stores are
  // intentional; a Node token is never installed on the administrative client.
  const http = new LoomHttpClient({ baseUrl: center.baseUrl, timeoutMs: 10000 })
  const client = new LoomNodeClient({ http, identity, state: new NodeState() })
  const code = await admin.post('/api/v1/enrollment-codes', {})
  secrets.push(code.code)
  await client.enroll({ enrollmentCode: code.code, capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], workerId: worker, harnessKind: 'bare-rust-deterministic', profileId: `controlled-fixture-${index}` })
  secrets.push(identity.token)
  const receipt = await client.heartbeat({
    status: 'online', capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }],
    workers: [{ worker_id: worker, harness_kind: 'bare-rust-deterministic', profile_id: `controlled-fixture-${index}`, status: 'online', capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], observed_at: new Date().toISOString() }],
    inventory: { project_roots: { [projectId]: projectRoot } },
  })
  assert.equal(receipt.accepted, true)
  return { nodeId: identity.nodeId, installationId: identity.installationId }
}
async function openProjectBinding(projectId) {
  await page.locator('.main-nav').getByRole('button', { name: '项目', exact: true }).click()
  const card = page.locator('.project-card').filter({ has: page.locator('.project-id', { hasText: projectId }) })
  await card.getByRole('button', { name: '绑定本地节点资源', exact: true }).click()
  await page.locator('#binding-dialog').waitFor()
}
async function closeBindingAndConfirmation() {
  if (await page.locator('.confirm-modal').count()) {
    await page.getByRole('button', { name: '返回检查', exact: true }).click()
    await pollBoolean(() => document.getElementById('binding-dialog')?.inert !== true, 'binding dialog restored after returning from denial')
  }
  if (await page.locator('#binding-dialog').count()) await page.getByRole('button', { name: '关闭绑定本地节点资源', exact: true }).click()
  await page.locator('#binding-dialog').waitFor({ state: 'hidden' })
}
function nodeRow(installation) {
  return db(connection => connection.prepare('SELECT id,installation_id,inventory,revoked_at FROM nodes WHERE installation_id=?').get(installation))
}

try {
  await phase('build-the-current-production-Vue', async () => {
    const before = await sourceHashes()
    await checked('npm', ['run', 'build', '--prefix', 'apps/web'])
    const built = await sourceHashes()
    assert.deepEqual(built, before, 'Sources must not change while the production proof is built')
    report.built_source_sha256 = built
  })
  await phase('random-loopback-Rust-and-shared-node-installations', async () => {
    const serverRoot = join(root, 'server')
    await mkdir(serverRoot, { mode: 0o700 })
    const wrapper = join(root, 'serve.mjs')
    await writeFile(wrapper, `import {spawn} from 'node:child_process';const child=spawn(${JSON.stringify(join(repository, 'target/debug/loom'))},[...process.argv.slice(2),'--web-dir',${JSON.stringify(join(repository, 'apps/web/dist'))}],{shell:false,stdio:'inherit'});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',(code,signal)=>process.exit(code??(signal?0:1)));`, { mode: 0o700 })
    center = await startRustConcierge({ root: serverRoot, env: { ...process.env, LOOM_SERVER_CMD: `${process.execPath} ${wrapper}` } })
    admin = new LoomHttpClient({ baseUrl: center.baseUrl, clientToken: center.clientToken, timeoutMs: 10000 })
    secrets.push(center.clientToken)
    assert.equal((await admin.get('/api/v1/health')).status, 'ok')
    const rootA = await realpath(await mkdir(join(root, 'root-a'), { recursive: true, mode: 0o700 }).then(() => join(root, 'root-a')))
    const rootB = await realpath(await mkdir(join(root, 'root-b'), { recursive: true, mode: 0o700 }).then(() => join(root, 'root-b')))
    const project = await admin.post('/api/v1/projects', { name: 'Owned explicit installation Project B', root: rootB, mode: 'read_write' })
    report.results.project = { id: project.project.id, root: rootB, root_unmodified: true }
    const first = await NodeIdentity.open(join(root, 'identity-a'))
    const second = new NodeIdentity(join(root, 'identity-b', 'identity.json'), { ...first.data, installation_id: `${randomUUID()}-installation-b` })
    assert.equal(first.nodeId, second.nodeId)
    const a = await registerAndDeclare(first, { worker: 'worker-a', projectRoot: rootA, index: 'a', projectId: project.project.id })
    const b = await registerAndDeclare(second, { worker: 'worker-b', projectRoot: rootB, index: 'b', projectId: project.project.id })
    assert.notEqual(a.installationId, b.installationId)
    assert.notEqual(first.token, second.token)
    // A raw first Node token cannot be upgraded into admin authority for the later declaration.
    const rawNodeAdmin = await fetch(`${center.baseUrl}/api/v1/enrollment-codes`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${first.token}` }, body: '{}' })
    assert.ok([401, 403].includes(rawNodeAdmin.status))
    await rawNodeAdmin.arrayBuffer()
    report.results.fixture = { project_id: project.project.id, node_id: a.nodeId, a: { node_id: a.nodeId, installation_id: a.installationId, worker_id: 'worker-a', root: rootA }, b: { node_id: b.nodeId, installation_id: b.installationId, worker_id: 'worker-b', root: rootB }, distinct_credentials: true, raw_node_token_used_as_admin: false, raw_node_token_admin_status: rawNodeAdmin.status }
    report.project_id = project.project.id
    assert.equal(count('project_bindings'), 0)
  })
  await phase('real-standalone-Edge-visible-token-login', async () => {
    await launchBrowser()
    await page.goto(center.baseUrl)
    await page.locator('.loom-app').waitFor()
    await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
    await page.locator('#client-token').fill(center.clientToken)
    await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
    await page.locator('#project-select').waitFor()
    const script = await page.locator('script[type="module"]').getAttribute('src')
    assert.ok(script?.startsWith('/assets/'))
    const asset = await page.evaluate(async path => { const response = await fetch(path); return { status: response.status, type: response.headers.get('content-type') } }, script)
    assert.equal(asset.status, 200)
    assert.match(asset.type, /javascript/)
    report.browser_requests = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin === center.baseUrl && url.pathname === '/api/v1/project-bindings' && request.method() === 'POST') report.browser_requests.push({ request })
    })
    report.results.production_asset_loaded = true
  })
  await phase('explicit-tuple-selection-narrow-DOM-and-real-B-confirmation', async () => {
    const { project_id, a, b } = { project_id: report.project_id, ...report.results.fixture }
    const valueB = JSON.stringify([b.node_id, b.installation_id])
    const valueA = JSON.stringify([a.node_id, a.installation_id])
    assert.equal(valueA, JSON.stringify([report.results.fixture.node_id, report.results.fixture.a.installation_id]))
    await openProjectBinding(project_id)
    assert.equal(await page.locator('#binding-node').inputValue(), '', 'A pair must not be silently chosen')
    assert.equal(await page.locator('#binding-dialog button[type=submit]').isDisabled(), true)
    const choices = await page.locator('#binding-node option').evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent })))
    const apiNodes = await admin.get('/api/v1/nodes')
    report.results.authenticated_node_snapshot = apiNodes.nodes.map(node => ({ id: node.id, installation_id: node.installation_id, inventory_roots: node.inventory?.project_roots }))
    for (const value of [valueA, valueB]) assert.ok(choices.some(option => option.value === value), `Tuple missing from actual select: ${value}; actual choices=${JSON.stringify(choices)}; authenticated nodes=${JSON.stringify(report.results.authenticated_node_snapshot)}`)
    assert.equal(new Set(choices.map(option => option.value).filter(Boolean)).size, 2)
    await page.setViewportSize({ width: 390, height: 844 })
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, scroll_width: document.documentElement.scrollWidth }))
    assert.ok(geometry.scroll_width <= 390, `Actual narrow DOM overflows: ${JSON.stringify(geometry)}`)
    report.results.narrow_viewport_with_both_valid_choices = { ...geometry, no_horizontal_overflow: true, viewport_only_not_a_phone: true }
    await page.locator('#binding-node').selectOption(valueB)
    await page.locator('#binding-worker').fill('  worker-b  ')
    assert.equal(await page.locator('#binding-root').inputValue(), b.root)
    assert.equal(await page.locator('#binding-root').getAttribute('readonly'), '')
    assert.equal(report.browser_requests.length, 0)
    assert.equal(count('project_bindings'), 0)
    assert.equal(bindingAudits(), 0)
    await page.getByRole('button', { name: '检查绑定范围', exact: true }).click()
    const confirmation = page.locator('.confirm-modal')
    await confirmation.waitFor()
    for (const text of [b.installation_id, 'worker-b', b.root]) assert.ok((await confirmation.innerText()).includes(text), `Confirmation must include ${text}`)
    assert.equal(report.browser_requests.length, 0, 'Inspection is not a POST')
    assert.equal(count('project_bindings'), 0)
    const narrowHitTest = await page.locator('.confirm-modal button.primary').evaluate(button => {
      const bounds = button.getBoundingClientRect()
      const x = bounds.x + bounds.width / 2
      const y = bounds.y + bounds.height / 2
      const hit = document.elementFromPoint(x, y)
      return { point: { x, y }, button: button.outerHTML, hit: hit?.outerHTML, hit_is_confirm: hit === button || button.contains(hit) }
    })
    report.results.narrow_confirmation_hit_test = narrowHitTest
    await page.setViewportSize({ width: 1100, height: 850 })
    const desktopHitTest = await page.locator('.confirm-modal button.primary').evaluate(button => {
      const bounds = button.getBoundingClientRect()
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      return { hit: hit?.outerHTML, hit_is_confirm: hit === button || button.contains(hit) }
    })
    report.results.desktop_confirmation_hit_test = desktopHitTest
    report.results.frontend_pointer_submission = { narrow_hit_is_confirm: narrowHitTest.hit_is_confirm === true, desktop_hit_is_confirm: desktopHitTest.hit_is_confirm === true, method: 'actual Playwright pointer click on the visible confirmation button' }
    assert.equal(narrowHitTest.hit_is_confirm, true, 'The real narrow confirm must receive pointer hit tests')
    assert.equal(desktopHitTest.hit_is_confirm, true, 'The real desktop confirm must receive pointer hit tests')
    await page.setViewportSize({ width: 390, height: 844 })
    await confirmInstallation()
    await confirmation.waitFor({ state: 'hidden' })
    assert.equal(report.browser_requests.length, 1)
    const entry = report.browser_requests[0]
    const requestBody = entry.request.postDataJSON()
    const response = await entry.request.response()
    assert.ok(response && response.status() >= 200 && response.status() < 300)
    const returned = await response.json()
    assert.deepEqual(requestBody, { project_id, node_id: b.node_id, installation_id: b.installation_id, worker_id: 'worker-b', root_scope: b.root })
    assert.equal(returned.id && returned.installation_id, b.installation_id)
    assert.equal(returned.worker_id, 'worker-b')
    entry.http = { method: entry.request.method(), path: new URL(entry.request.url()).pathname, status: response.status(), request: requestBody, response: returned }
    delete entry.request
    const persisted = db(connection => connection.prepare('SELECT id,project_id,node_id,installation_id,worker_id,root_scope FROM project_bindings WHERE id=?').get(returned.id))
    assert.deepEqual({ ...persisted }, { id: returned.id, project_id, node_id: b.node_id, installation_id: b.installation_id, worker_id: 'worker-b', root_scope: b.root })
    assert.equal(JSON.parse(nodeRow(a.installation_id).inventory).project_roots[project_id], a.root)
    assert.equal(JSON.parse(nodeRow(b.installation_id).inventory).project_roots[project_id], b.root)
    assert.equal(bindingAudits(), 1)
    report.results.explicit_browser_binding = { metadata: entry.http, exact_post_tuple: true, exact_db_binding: true, sibling_inventory_unchanged: true, no_post_before_confirmation: true, binding_count: 1, binding_audit_count: 1, final_confirmation_viewport: '390x844 actual pointer click after both measured hit tests' }
    report.results.binding_id = returned.id
    await page.setViewportSize({ width: 1100, height: 850 })
  })
  await phase('separate-authorized-admin-read-grant-on-returned-binding', async () => {
    const { project_id, b, binding_id } = { project_id: report.project_id, ...report.results.fixture, binding_id: report.results.binding_id }
    // Deliberately NOT an Access-page Grant submission: this is an authenticated
    // admin API consumer of the browser-returned project_binding_id.
    const granted = await admin.post('/api/v1/grants', { project_id, node_id: b.node_id, worker_id: 'worker-b', project_binding_id: binding_id, operations: ['read'] })
    const grant = granted.grant
    assert.equal(grant.project_binding_id, binding_id)
    assert.equal(grant.installation_id, b.installation_id)
    assert.equal(grant.worker_id, 'worker-b')
    assert.deepEqual(grant.operations, ['read'])
    const executionCounts = {}
    for (const table of ['tickets', 'assignments', 'reports', 'artifacts', 'effects']) executionCounts[table] = count(table)
    report.results.admin_grant_execution_counts = executionCounts
    assert.ok(Object.values(executionCounts).every(value => value === 0))
    report.results.admin_grant = { path: '/api/v1/grants', separate_authorized_admin_call_not_access_ui: true, exact_binding_id: grant.project_binding_id === binding_id, exact_B_installation: grant.installation_id === b.installation_id, exact_B_worker: grant.worker_id === 'worker-b', operations: grant.operations, execution_tables_zero: true }
  })
  await phase('genuine-A-denial-preserves-selection-and-makes-no-audit', async () => {
    const { project_id, a, b } = { project_id: report.project_id, ...report.results.fixture }
    const before = { bindings: count('project_bindings'), audits: count('audits'), approval_audits: bindingAudits() }
    await openProjectBinding(project_id)
    await page.locator('#binding-node').selectOption(JSON.stringify([a.node_id, a.installation_id]))
    await page.locator('#binding-worker').fill('  worker-a  ')
    await page.getByRole('button', { name: '检查绑定范围', exact: true }).click()
    await page.locator('.confirm-modal').waitFor()
    await confirmInstallation()
    await pollBoolean(() => document.querySelector('.confirm-modal [role="alert"]')?.textContent?.trim().length > 0, 'visible real A denial')
    assert.equal(report.browser_requests.length, 2)
    const entry = report.browser_requests[1]
    const payload = entry.request.postDataJSON()
    const response = await entry.request.response()
    assert.equal(response.status(), 403)
    const denied = await response.json()
    assert.equal(denied.error?.code, 'binding_not_declared_by_host')
    report.results.a_denial_visible_text = await page.locator('.confirm-modal [role="alert"]').innerText()
    assert.deepEqual(payload, { project_id, node_id: a.node_id, installation_id: a.installation_id, worker_id: 'worker-a', root_scope: b.root })
    assert.equal(count('project_bindings'), before.bindings)
    assert.equal(count('audits'), before.audits)
    assert.equal(bindingAudits(), before.approval_audits)
    assert.equal(await page.locator('#binding-node').inputValue(), JSON.stringify([a.node_id, a.installation_id]))
    assert.equal(await page.locator('#binding-worker').inputValue(), '  worker-a  ', 'Pending user input is preserved; only the request is trimmed')
    assert.equal(JSON.parse(nodeRow(a.installation_id).inventory).project_roots[project_id], a.root)
    entry.http = { method: 'POST', path: '/api/v1/project-bindings', status: response.status(), request: payload, error_code: denied.error.code }
    delete entry.request
    report.results.negative_A = { ...entry.http, backend_denial: true, backend_code: denied.error.code, visible_explanation: true, no_automatic_correction_to_B: true, pending_UI_selection_preserved: true, counts_unchanged: true }
    await closeBindingAndConfirmation()
  })
  await phase('controlled-single-usable-installation-legacy-payload', async () => {
    const { project_id, a, b } = { project_id: report.project_id, ...report.results.fixture }
    // A controlled negative DB setup ONLY, not a claimed per-Installation revoke API.
    const control = new DatabaseSync(join(center.dataDir, 'loom.sqlite3'))
    try { control.prepare("UPDATE nodes SET revoked_at=?,status='revoked' WHERE id=? AND installation_id=?").run(new Date().toISOString(), a.node_id, a.installation_id) }
    finally { control.close() }
    await pollBoolean(() => { const button = document.querySelector('button[aria-label="重新读取工作空间"]'); return button && !button.disabled }, 'public workspace refresh available')
    await page.getByRole('button', { name: '重新读取工作空间', exact: true }).click()
    await pollBoolean(() => document.querySelector('button[aria-label="重新读取工作空间"]')?.disabled === true, 'public workspace refresh started')
    await pollBoolean(() => document.querySelector('button[aria-label="重新读取工作空间"]')?.disabled === false, 'public workspace refresh completion')
    await openProjectBinding(project_id)
    const legacyChoices = await page.locator('#binding-node option').evaluateAll(options => options.map(option => ({ value: option.value, disabled: option.disabled })))
    const tupleB = JSON.stringify([b.node_id, b.installation_id])
    const legacyB = legacyChoices.find(option => option.value && !option.disabled && [b.node_id, tupleB].includes(option.value))
    assert.ok(legacyB, `B is not the sole usable choice: ${JSON.stringify(legacyChoices)}`)
    assert.ok(legacyChoices.filter(option => option.value && !option.disabled).length === 1, 'Only one usable Installation remains')
    await page.locator('#binding-node').selectOption(legacyB.value)
    report.results.legacy_dom_choice = legacyB.value
    await page.locator('#binding-worker').fill(' worker-b ')
    await page.getByRole('button', { name: '检查绑定范围', exact: true }).click()
    await confirmInstallation()
    await page.locator('.confirm-modal').waitFor({ state: 'hidden' })
    assert.equal(report.browser_requests.length, 3)
    const entry = report.browser_requests[2]
    const payload = entry.request.postDataJSON()
    assert.equal(Object.hasOwn(payload, 'installation_id'), false, 'Exactly one usable Installation retains the legacy payload')
    assert.deepEqual(payload, { project_id, node_id: b.node_id, worker_id: 'worker-b', root_scope: b.root })
    const response = await entry.request.response()
    assert.ok(response && response.status() >= 200 && response.status() < 300)
    const returned = await response.json()
    assert.equal(returned.installation_id, b.installation_id)
    assert.equal(returned.worker_id, 'worker-b')
    const persisted = db(connection => connection.prepare('SELECT installation_id,node_id,worker_id,root_scope FROM project_bindings WHERE id=?').get(returned.id))
    assert.deepEqual({ ...persisted }, { installation_id: b.installation_id, node_id: b.node_id, worker_id: 'worker-b', root_scope: b.root })
    assert.equal(count('project_bindings'), 2)
    assert.equal(bindingAudits(), 2)
    entry.http = { method: 'POST', path: '/api/v1/project-bindings', status: response.status(), request: payload, response: returned }
    delete entry.request
    report.results.legacy_payload = { ...entry.http, own_installation_id_property_omitted: true, returned_and_persisted_exact_B: true, setup: 'controlled SQL revoked_at on A, not a production per-Installation revocation protocol' }
  })
  report.phase = 'success'
} catch (error) {
  report.error = redact(error.stack || error)
} finally {
  if (finishing) throw new Error('Unexpected duplicate cleanup')
  finishing = true
  const actions = []
  if (context) await bounded(context.close(), 'owned persistent browser context close', 15000).catch(error => { report.cleanup_error = redact(error) })
  else if (browser) await bounded(browser.close(), 'owned browser close', 15000).catch(error => { report.cleanup_error = redact(error) })
  await stopChild(owned.browserProcess)
  if (browser || context) actions.push('owned Edge context/process closed')
  await stopChild(owned.build)
  if (center) await bounded(center.stop(), 'owned Rust stop', 10000).catch(error => { report.cleanup_error = redact(error) })
  if (center) actions.push('owned Rust wrapper/server stopped')
  const actualRoot = await realpath(root)
  assert.equal(dirname(actualRoot), await realpath(tmpdir()), 'Refuse to delete a non-temp root')
  await rm(actualRoot, { recursive: true, force: true })
  assert.equal(await access(actualRoot).then(() => true, () => false), false)
  actions.push('owned project, identity, SQL, state and browser profile root removed; evidence retained')
  let healthError = ''
  const guard = async assertion => { try { await assertion() } catch (error) { healthError ||= redact(error.stack || error) } }
  await guard(() => assert.deepEqual(blockedRequests, [], 'No destination other than the owned loopback Rust server'))
  await guard(() => assert.deepEqual(unexpectedResponses, [], 'Only the initial-auth 401 and asserted 403 are expected'))
  await guard(() => assert.deepEqual(consoleErrors.filter(text => !text.includes('401 (Unauthorized)') && !text.includes('403 (Forbidden)')), [], 'Unexpected production console/page/transport errors'))
  if (browser && typeof browser.isConnected === 'function') await guard(() => assert.equal(browser.isConnected(), false, 'Owned standalone browser is disconnected'))
  if (center) await guard(async () => assert.equal(await fetch(`${center.baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true), true, 'Owned Rust loopback is stopped'))
  report.cleanup = { actions, context_close_completed: !report.cleanup_error, browser_disconnection_check_supported: report.browser.persistent_browser_isConnected_supported !== false, all_owned_resources_stopped: !report.cleanup_error && !healthError, evidence_retained: true }
  report.error ||= healthError
  report.http_error_responses = consoleResponses
  report.overall = report.error || report.cleanup_error ? 'FAIL' : 'PASS'
  if (!report.error) report.phase = 'complete'
  report.console_errors_relevant = consoleErrors
  report.source_sha256 = await sourceHashes()
  report.source_changed_during_browser_run = Boolean(report.built_source_sha256 && JSON.stringify(report.built_source_sha256) !== JSON.stringify(report.source_sha256))
  if (report.source_changed_during_browser_run) { report.error ||= 'A production source concurrently changed during the proof; built and final hashes are both recorded.'; report.overall = 'FAIL' }
  if (report.results.frontend_pointer_submission?.pass === false) { report.error ||= 'Frontend pointer confirmation was blocked by the production modal stacking; HTTP assertions used the separately recorded keyboard activation path.'; report.overall = 'FAIL' }
  report.driver_sha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')
  report.http_request_metadata = report.browser_requests?.map(entry => entry.http)
  delete report.browser_requests
  report.scope_limits = [
    'The post-binding Grant is a separate authenticated admin API call, not an Access UI Grant submission.',
    'Two Installations are logical local fixtures sharing a legitimate public key; no second physical host or DSH installation is claimed.',
    'Manual SQL revocation is only a legacy negative setup, not an administrative per-Installation revocation protocol.',
    'No optional selected-then-revoked stale-modal test is included; the whole-Node stale-refresh path is not asserted here.',
    'No task execution, tickets, assignments, reports, artifacts, effects, real LLM, Compose 1+3 or mobile device is exercised.',
    'The 390px measurement is a real DOM viewport check only, not a physical mobile test.',
  ]
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ overall: report.overall, phase: report.phase, evidence, error: report.error, cleanup: report.cleanup }, null, 2))
  if (report.overall !== 'PASS') process.exitCode = 1
}
