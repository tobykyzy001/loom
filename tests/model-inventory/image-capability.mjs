#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LoomNodeClient } from '../../packages/node-client/src/client.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { testingClientToken, startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { chromium } from '../browser/node_modules/playwright-core/index.mjs'
import { IMAGE_HARDWARE_EXAMPLE, placementResult } from '../../apps/web/src/lib/imageAvailability.ts'

const root = process.env.LOOM_TEST_ROOT
  ? await realpath(process.env.LOOM_TEST_ROOT)
  : await mkdtemp(join(tmpdir(), 'loom-image-capability-'))
const keep = process.env.LOOM_TEST_KEEP_EVIDENCE === 'true'
if (keep) console.log(`CAPABILITY_OWNED_TEST_ROOT=${root}`)
const output = resolve(process.env.LOOM_TEST_OUTPUT || '/tmp/loom-image-capability-proof.json')
const secret = 'SYNTHETIC-INVENTORY-PROBE-NOT-CREDENTIAL'
const secrets = [], checks = [], requests = []
let server, admin, identity, clientToken, enrollment, preview, context, projectId, projectRoot, binding, grant
const record = (name, evidence = {}) => { checks.push({ name, status: 'PASS', evidence }); console.log(`PASS capability-report: ${name}`) }
const result = state => ({
  schema: 'loom.image-preconditions-proof.v1', overall: state, checks,
  physical_host: 'one explicitly inspected macOS machine', second_physical_host: 'NOT RUN', real_model: 'NOT RUN', image_generation: 'NOT RUN', download_or_activation: 'NOT RUN',
  production_browser: false, real_dsh_profile: 'not used in this bare/local probe',
  not_claimed: ['image generation', 'general model installation or activation', 'all GPU operations', 'physical mobile or second Host', 'live Provider credentials'],
  output,
})
const invoke = async (installationId, enabled, inspector = 'mac_system_profiler', thisHost = true) => {
  const args = ['run', '--quiet', '--locked', '-p', 'loom-concierge', '--bin', 'loom', '--',
    '--data-dir', server.dataDir, 'inventory-probe', '--node-id', identity.nodeId,
    '--installation-id', installationId, '--inspector', inspector, ...(thisHost ? ['--this-controller-host'] : [])]
  return promisify(execFile)('cargo', args, {
    cwd: resolve('.'), timeout: 30000, env: { PATH: process.env.PATH, LOOM_ENABLE_LOCAL_HARDWARE_PROBE: enabled ? '1' : '0' }, encoding: 'utf8',
  }).then(result => ({ ...result, returncode: 0 }))
    .catch(error => ({ returncode: Number.isInteger(error.code) ? error.code : 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) }))
}
const storedInventory = () => {
  const db = new DatabaseSync(server.dataDir + '/loom.sqlite3', { readOnly: true })
  try { return db.prepare('SELECT inventory FROM nodes WHERE id=? AND installation_id=?').get(identity.nodeId, identity.installationId).inventory } finally { db.close() }
}
const trustedRecord = () => {
  const db = new DatabaseSync(server.dataDir + '/loom.sqlite3', { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(`hardware_probe:${identity.nodeId}:${identity.installationId}`)
    return row ? JSON.parse(row.value) : null
  } finally { db.close() }
}
const permissionCounts = () => {
  const db = new DatabaseSync(server.dataDir + '/loom.sqlite3', { readOnly: true })
  try {
    return { grants: db.prepare('SELECT COUNT(*) total FROM grants').get().total,
      tickets: db.prepare('SELECT COUNT(*) total FROM tickets').get().total,
      hardware_audit: db.prepare("SELECT COUNT(*) total FROM audits WHERE action='inventory.hardware_probe'").get().total,
      heartbeat: db.prepare('SELECT last_heartbeat FROM nodes WHERE id=?').get(identity.nodeId).last_heartbeat,
      schema: db.prepare('PRAGMA user_version').get().user_version,
    }
  } finally { db.close() }
}

try {
  await mkdir(root, { recursive: true, mode: 0o700 })
  clientToken = testingClientToken(); secrets.push(clientToken)
  server = await startRustConcierge({ root, env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: clientToken } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken })
  process.env.LOOM_TEST_CONCIERGE_URL = server.baseUrl
  await mkdir(join(root, 'project'), { mode: 0o700 })
  projectRoot = await realpath(join(root, 'project'))
  const project = await admin.post('/api/v1/projects', { name: 'Resource-only small image precondition', root: projectRoot, mode: 'read_only' })
  projectId = project.project.id
  enrollment = (await admin.post('/api/v1/enrollment-codes', {})).code
  secrets.push(enrollment)
  identity = await NodeIdentity.open(join(root, 'node'))
  secrets.push(identity.token)
  const node = new LoomNodeClient({ http: admin, identity, state: {} })
  await node.enroll({ enrollmentCode: enrollment, capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], harnessKind: 'dsh-loom', workerId: 'default' })
  await node.heartbeat({ capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], workers: [{ worker_id: 'default', harness_kind: 'dsh-loom', profile_id: 'owner-probe', status: 'online', capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }] }],
    inventory: { project_roots: { [projectId]: projectRoot }, resources: [] },
  })
  binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: identity.nodeId, installation_id: identity.installationId, worker_id: 'default', root_scope: projectRoot })
  grant = (await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: identity.nodeId, installation_id: identity.installationId, worker_id: 'default', operations: ['read'] })).grant
  const before = permissionCounts(), beforeStored = storedInventory()
  const disabled = await invoke(identity.installationId, false)
  assert.notEqual(disabled.returncode, 0)
  assert.match(disabled.stderr, /local_hardware_disabled/)
  assert.equal(storedInventory(), beforeStored)
  const wrong = await invoke('other-installation', true)
  assert.notEqual(wrong.returncode, 0)
  assert.match(wrong.stderr, /unknown_installation/)
  assert.equal(storedInventory(), beforeStored)
  assert.deepEqual(permissionCounts(), before)
  const missingLocality = await invoke(identity.installationId, true, 'mac_system_profiler', false)
  assert.notEqual(missingLocality.returncode, 0)
  assert.match(missingLocality.stderr, /--this-controller-host/)
  assert.equal(storedInventory(), beforeStored)
  assert.equal(trustedRecord(), null)
  const badInspector = await invoke(identity.installationId, true, 'custom-download-command')
  assert.equal(badInspector.returncode, 2)
  assert.equal(storedInventory(), beforeStored)
  record('disabled, wrong Installation and executable-shaped inputs are denied before native inspection or any state change', { enabled_disabled: true, wrong_installation: true, bad_inspector: true, missing_local_declaration_rejected: true, unauthorized_ticket_or_grant: 0 })

  const actual = await invoke(identity.installationId, true, 'mac_system_profiler')
  assert.equal(actual.returncode, 0, actual.stderr)
  const report = JSON.parse(actual.stdout)
  assert.equal(report.schema, 'loom.local-hardware-probe.v1')
  assert.equal(report.permission_granted, false)
  assert.ok(!actual.stdout.includes('SPDisplaysDataType'))
  assert.ok(!actual.stdout.includes(secret))
  assert.ok(!actual.stderr.includes(secret))
  assert.ok(report.facts.every(fact => fact.resource.startsWith('hardware.') || fact.resource === 'models'))
  assert.equal(storedInventory(), beforeStored)
  const probe = trustedRecord()
  assert.ok(probe)
  assert.equal(probe.schema, 'loom.local-hardware-probe.v1')
  assert.equal(probe.node_id, identity.nodeId)
  assert.equal(probe.installation_id, identity.installationId)
  assert.equal(probe.source, 'controller_probed')
  assert.equal(probe.permission_granted, false)
  assert.equal(probe.inspector, 'system_profiler')
  assert.ok(Number.isFinite(Date.parse(probe.observed_at)))
  assert.deepEqual(report, probe)
  const afterwards = permissionCounts()
  assert.deepEqual({ ...afterwards, hardware_audit: afterwards.hardware_audit }, { ...before, hardware_audit: 1 })
  record('explicit one-host CLI associates fixed hardware facts with exactly the registered identity, without refreshing admission/model authority', { schema: afterwards.schema, permission_granted: false, hardware_probe: probe.inspector, source: probe.source, preserved_heartbeat: afterwards.heartbeat === before.heartbeat, original_ticket_count: before.tickets, original_grant_count: before.grants })

  const publicNode = async () => (await admin.get('/api/v1/nodes')).nodes.find(value => value.id === identity.nodeId && value.installation_id === identity.installationId)
  assert.ok(await publicNode(), 'exact registered Node must be returned by the protected client route')
  const current = await publicNode()
  assert.equal(current.inventory.hardware_probe.observed_at, probe.observed_at)
  assert.equal(current.inventory.hardware_probe.source, 'controller_probed')
  assert.equal(current.inventory.hardware_probe.permission_granted, false)
  assert.ok(!Object.hasOwn(current.inventory, 'model_catalog') || current.inventory.model_catalog === null)
  const memory = current.inventory.facts.find(fact => fact.resource === 'hardware.memory_bytes')
  assert.ok(memory && typeof memory.value === 'number'
    && memory.source === 'controller_probed'
    && memory.confidence === 'available'
    && memory.freshness === 'fresh')
  const placementInput = (nodeId = identity.nodeId) => ({
    project_id: grant.project_id, grant_id: grant.id, project_binding_id: grant.project_binding_id,
    worker_id: grant.worker_id, node_id: nodeId, capability: 'read_summary', hardware: IMAGE_HARDWARE_EXAMPLE,
  })
  const expected = await admin.post('/api/v1/placement/evaluate', placementInput())
  assert.ok(placementResult(expected))
  assert.equal(expected.selected, null)
  assert.ok(expected.waiting.some(row => row.code === 'hardware_incompatible'))
  assert.ok(!expected.waiting.some(row => row.code === 'existing_grant_matching_failed'))
  const incompatible = expected.waiting.filter(row => row.code === 'hardware_incompatible')
  assert.equal(incompatible.length, 1)
  assert.equal(incompatible[0].resource, 'hardware.memory_bytes')
  assert.equal(incompatible[0].source, 'controller_probed')
  assert.equal(incompatible[0].confidence, 'incompatible')
  assert.ok(expected.waiting.some(row => row.code === 'hardware_requirement_unknown' && ['hardware.os', 'hardware.arch'].includes(row.resource)))
  const wrongScope = await admin.post('/api/v1/placement/evaluate', placementInput('0'.repeat(64)))
  assert.equal(wrongScope.selected, null)
  assert.ok(wrongScope.waiting.some(row => row.code === 'preferred_node_mismatch'))
  record('real placement rejects this example hardware requirement/wrong Node instead of turning a GPU or read Grant into image permission', { minimum_memory_bytes: IMAGE_HARDWARE_EXAMPLE.minimum_memory_bytes, actual_memory_bytes: memory.value, waiting: expected.waiting.map(wait => wait.code), grant_matching_before_evaluation: expected.existing_grant_matching_passed })

  const worker = { worker_id: 'default', harness_kind: 'dsh-loom', profile_id: 'owner-probe', status: 'online', capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }] }
  const forgedFact = { schema: 'loom.inventory.v1', resource: 'hardware.memory_bytes', value: Number.MAX_SAFE_INTEGER, source: 'controller_probed', observed_at: new Date().toISOString(), freshness: 'fresh', confidence: 'available', location: 'local_only' }
  await node.heartbeat({ capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], workers: [worker], inventory: {
    project_roots: { [projectId]: projectRoot }, resources: [forgedFact],
    hardware_probe: { ...probe, source: 'controller_probed', inspector: 'self-reported-untrusted-probe', observed_at: '2099-12-31T00:00:00.000Z', permission_granted: true },
  } })
  const afterForgery = await publicNode()
  const rawAfterForgery = await admin.get('/api/v1/inventory')
  const publicInventoryText = JSON.stringify(rawAfterForgery)
  assert.ok(!publicInventoryText.includes('self-reported-untrusted-probe'))
  assert.ok(!publicInventoryText.includes('2099-12-31'))
  assert.ok(!publicInventoryText.includes(String(Number.MAX_SAFE_INTEGER)))
  assert.ok(!JSON.stringify(afterForgery).includes('self-reported-untrusted-probe'))
  assert.deepEqual(afterForgery.inventory.hardware_probe, { schema: probe.schema, inspector: probe.inspector, observed_at: probe.observed_at, source: 'controller_probed', permission_granted: false })
  assert.equal(afterForgery.inventory.facts.find(fact => fact.resource === 'hardware.memory_bytes').value, memory.value)
  const afterForgeryAssessment = await admin.post('/api/v1/placement/evaluate', placementInput())
  assert.equal(afterForgeryAssessment.selected, null)
  assert.ok(afterForgeryAssessment.waiting.some(wait => wait.code === 'hardware_incompatible' && wait.source === 'controller_probed'))
  assert.equal(trustedRecord().permission_granted, false)
  assert.equal(trustedRecord().observed_at, probe.observed_at)
  await node.heartbeat({ status: 'busy', capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], workers: [{ ...worker, status: 'busy' }], inventory: {
    project_roots: { [projectId]: projectRoot }, resources: [forgedFact], hardware_probe: { ...probe, permission_granted: true, observed_at: '2099-12-31T00:00:00.000Z' },
  } })
  assert.equal(afterForgery.inventory.hardware_probe.observed_at, probe.observed_at)
  const afterBusyAssessment = await admin.post('/api/v1/placement/evaluate', placementInput())
  assert.equal(afterBusyAssessment.selected, null)
  assert.ok(afterBusyAssessment.waiting.some(wait => wait.code === 'node_busy'))
  assert.deepEqual(trustedRecord(), probe)
  const afterHeartbeats = permissionCounts()
  record('malicious heartbeat cannot stamp the private controller probe or promote fake memory/permission; current busy state remains distinct', { actual_controller_source_preserved: true, fake_probe_suppressed: true, busy_reported: true, original_probe_observed_at_preserved: true, new_grants: 0, new_tickets: 0, private_probe_snapshot_unchanged: true })

  const appRoot = resolve('apps/web')
  const { preview: startPreview } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
  preview = await startPreview({ root: appRoot, configFile: resolve('tests/browser/vite.config.mjs'), logLevel: 'error', cacheDir: join(root, 'vite-cache'),
    preview: { host: '127.0.0.1', port: 0, strictPort: true }, build: { outDir: join(appRoot, 'dist') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/api': { target: server.baseUrl, changeOrigin: true } } } })
  const appOrigin = `http://127.0.0.1:${preview.httpServer.address().port}`
  context = await chromium.launchPersistentContext(join(root, 'browser-profile'), {
      executablePath: process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true,
      viewport: { width: 1280, height: 1100 }, timeout: 30_000,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--no-proxy-server'],
      env: { PATH: process.env.PATH, TMPDIR: root },
  })
  const page = context.pages()[0]
  page.setDefaultTimeout(25000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (![appOrigin, server.baseUrl].includes(url.origin)) throw new Error('Browser escaped owned hardware-evaluator fixture')
    requests.push({ url: url.pathname, method: request.method() })
  })
  await page.goto(appOrigin, { waitUntil: 'domcontentloaded' })
  await page.locator('.loom-app').waitFor()
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(clientToken)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '设备', exact: true }).click()
  const card = page.locator('.image-assessment[data-node-assessment]')
  await card.waitFor()
  await card.locator('select').selectOption(grant.id)
  await card.getByRole('button', { name: '评估此节点的图片生成前提', exact: false }).click()
  await card.locator('.assessment-result').waitFor()
  assert.equal(await card.locator('select').inputValue(), grant.id)
  assert.ok((await card.innerText()).includes(probe.observed_at))
  const uiCodes = await card.locator('[data-wait-code]').evaluateAll(rows => rows.map(row => row.dataset.waitCode))
  assert.deepEqual(uiCodes, afterBusyAssessment.waiting.map(row => row.code))
  assert.ok((await card.innerText()).includes('没有图片模型存在性、下载完成或真实已生成图片的证明'))
  assert.ok((await card.innerText()).includes('未得到该节点的其它文本任务适配器证明'))
  assert.equal(requests.filter(row => row.method === 'PUT').length, 0)
  assert.equal(requests.filter(row => (row.url.startsWith('/api/v1/models') || row.url.startsWith('/api/v1/tickets')) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method)).length, 0)
  assert.equal(requests.filter(row => row.url === '/api/v1/grants' && row.method === 'POST').length, 0)
  assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: join(root, 'capability-assessment-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 1000 })
  assert.equal(await page.locator('.loom-app').count(), 1)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await card.screenshot({ path: join(root, 'capability-assessment-narrow.png') })
  const narrowCardBox = await card.boundingBox()
  assert.ok(narrowCardBox && narrowCardBox.width <= 390)
  assert.deepEqual(pageErrors, [])
  record('production Edge chooses an existing read Grant and shows conditional reasons, observed hardware, and no fake image/activation side effects', { actual_wait_codes: uiCodes, viewport_widths: [1280, 390], post_grants: 0, model_lifecycle_requests: 0, real_phone: false })

  const audit = await admin.get('/api/v1/audit/verify')
  assert.equal(audit.valid, true)
  assert.deepEqual(permissionCounts(), afterHeartbeats)
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, 0)
  assert.equal((await admin.get('/api/v1/grants')).grants.length, 1)
  const originalToken = server.clientToken
  const dataDir = server.dataDir, origin = server.baseUrl
  await server.stop(); server = null
  server = await startRustConcierge({ root, env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: originalToken }, dataDir, baseUrl: origin })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: originalToken })
  assert.deepEqual(trustedRecord(), probe)
  assert.equal((await publicNode()).inventory.hardware_probe.observed_at, probe.observed_at)
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '设备', exact: true }).click()
  await page.locator('.image-assessment').waitFor()
  assert.ok((await page.locator('.image-assessment').innerText()).includes(probe.observed_at))
  await page.screenshot({ path: join(root, 'capability-after-controller-restart.png'), fullPage: true })
  record('probe snapshot survives same-data-dir/port/token controller restart with audit and no new permission work', { data_dir_unchanged: true, audit_valid: true, transport_reopened: true, new_ticket_or_grant: 0 })
  const proof = { ...result('PASS'), production_browser: true }
  proof.viewports = [1280, 390]
  proof.observed_memory_bytes = memory.value
  proof.evaluated_minimum_memory_bytes = IMAGE_HARDWARE_EXAMPLE.minimum_memory_bytes
  await writeFile(output, JSON.stringify(proof, null, 2), { mode: 0o600 })
  checks.push({ name: 'detailed result file written without credentials or opaque host/config objects', status: 'PASS' })
} catch (error) {
  if (context?.pages().length) {
    const page = context.pages()[0]
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth).slice(0, 12).map(element => ({
      tag: element.tagName, class: typeof element.className === 'string' ? element.className.slice(0, 140) : '',
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width,
      parent: typeof element.parentElement?.className === 'string' ? element.parentElement.className.slice(0, 100) : '',
      content: element.textContent?.trim().slice(0, 100) || '', outer: element.outerHTML.slice(0, 320),
    }))).catch(() => [])
    await page.screenshot({ path: join(root, 'capability-failure.png'), fullPage: true }).catch(() => {})
    console.error('OWNED-VIEWPORT-DIAGNOSTICS', secrets.filter(Boolean).reduce((text, value) => text.replaceAll(String(value), '[redacted]'), JSON.stringify({ root, overflow })))
  }
  const safeMessage = secrets.filter(Boolean).reduce((message, value) => message.replaceAll(String(value), '[redacted]'), String(error.stack || error))
  console.error(JSON.stringify({ ...result('FAIL'), error: safeMessage }, null, 2))
  process.exitCode = 1
} finally {
  if (context) await context.close().catch(() => {})
  if (preview?.httpServer) await new Promise(resolve => preview.httpServer.close(resolve)).catch(() => {})
  if (server) await server.stop().catch(() => {})
  if (!keep && !process.env.LOOM_TEST_ROOT) await rm(root, { recursive: true, force: true })
}
