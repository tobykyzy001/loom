#!/usr/bin/env node
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LoomNodeClient } from '../../packages/node-client/src/client.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { chromium } from '../browser/node_modules/playwright-core/index.mjs'

// One registered fixture on this physical computer. No second host, actual
// network disconnection, mobile device, real DSH profile or model is claimed.
const root = await testingRoot()
const output = process.env.LOOM_TEST_OUTPUT || '/tmp/loom-node-staleness-proof.json'
const keep = process.env.LOOM_TEST_KEEP_EVIDENCE === '1'
const oldHeartbeat = '2000-01-01T00:00:00Z'
const checks = []
let server, admin, node, context, preview
const pass = (message) => { checks.push({ name: message, state: 'PASS' }); console.log(`PASS ${message}`) }
const report = overall => ({ schema: 'loom.device-staleness.v1', overall, checks, physical_host_count: 1, network_outage: 'NOT SIMULATED', mobile: 'NOT RUN', actual_dsh_profile: 'NOT RUN', output })
try {
  await mkdir(join(root, 'node'), { recursive: true, mode: 0o700 })
  server = await startRustConcierge({ root: join(root, 'rust') })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const identity = await NodeIdentity.open(join(root, 'node'))
  node = new LoomNodeClient({ http: admin, identity, state: {} })
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  await node.enroll({ enrollmentCode: enrollment.code, capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], harnessKind: 'dsh-loom', workerId: 'default' })
  assert.ok(identity.token, 'registered Node owns a nonblank transport credential')
  const worker = { worker_id: 'default', harness_kind: 'dsh-loom', profile_id: 'owned-presence-fixture', status: 'online', capabilities: [] }
  await node.heartbeat({ capabilities: [], workers: [worker], inventory: { project_roots: {}, resources: [] } })
  const initial = await admin.get('/api/v1/nodes')
  assert.equal(initial.nodes.length, 1)
  assert.equal(initial.nodes[0].online, true)
  assert.equal(initial.nodes[0].freshness, 'fresh')
  assert.equal(initial.nodes[0].installation_id, identity.installationId)
  const anonymous = await fetch(`${server.baseUrl}/api/v1/nodes`)
  assert.equal(anonymous.status, 401)
  await anonymous.arrayBuffer()
  pass('real signed enrolment and fresh authenticated heartbeat produce online true; anonymous read is 401')

  const dataDir = server.dataDir, baseUrl = server.baseUrl, token = server.clientToken
  await server.stop(); server = null
  const db = new DatabaseSync(join(dataDir, 'loom.sqlite3'))
  try {
    db.exec('BEGIN IMMEDIATE')
    const before = db.prepare("SELECT status,revoked_at,capabilities,workers,inventory,registered_at FROM nodes WHERE id=? AND installation_id=?").get(identity.nodeId, identity.installationId)
    assert.equal(before.status, 'online')
    assert.equal(before.revoked_at, null)
    const changed = db.prepare("UPDATE nodes SET last_heartbeat=?1 WHERE id=?2 AND installation_id=?3 AND revoked_at IS NULL").run(oldHeartbeat, identity.nodeId, identity.installationId)
    assert.equal(changed.changes, 1)
    db.exec('COMMIT')
    const after = db.prepare("SELECT status,revoked_at,capabilities,workers,inventory,registered_at FROM nodes WHERE id=? AND installation_id=?").get(identity.nodeId, identity.installationId)
    assert.deepEqual(after, before, 'only this fixture heartbeat timestamp may change')
    for (const table of ['grants', 'tickets', 'assignments', 'artifacts']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
    }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  } finally { db.close() }
  server = await startRustConcierge({ root: join(root, 'rust'), dataDir, baseUrl, env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: token } })
  assert.equal(server.dataDir, dataDir)
  assert.equal(server.clientToken, token)
  const stale = await admin.get('/api/v1/nodes')
  assert.equal(stale.nodes[0].online, false)
  assert.equal(stale.nodes[0].freshness, 'stale_offline')
  assert.equal(stale.nodes[0].status, 'online')
  assert.equal(stale.nodes[0].source, 'host_heartbeat')
  assert.equal(stale.nodes[0].last_heartbeat, oldHeartbeat)
  assert.equal(stale.nodes[0].revoked_at, null)
  pass('aging only this fixture timestamp and same-data-dir restart yields authoritative stale_offline without revoking or creating grant')

  process.env.LOOM_TEST_CONCIERGE_URL = server.baseUrl
  const appRoot = resolve('apps/web')
  const { preview: startPreview } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
  preview = await startPreview({ root: appRoot, configFile: resolve('tests/browser/vite.config.mjs'), logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: true } })
  const origin = `http://127.0.0.1:${preview.httpServer.address().port}`
  context = await chromium.launchPersistentContext(join(root, 'owned-edge-presence'), {
    executablePath: process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    headless: true, viewport: { width: 1280, height: 960 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--default-apps=none', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
    env: { PATH: process.env.PATH, TMPDIR: root }, timeout: 30000,
  })
  const page = context.pages()[0]
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message)))
  const summary = expected => page.waitForFunction(expected => document.querySelector('.summary-number strong')?.textContent?.trim() === expected, String(expected))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.locator('.loom-app').waitFor()
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(token)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '设备', exact: true }).click()
  await summary(0)
  const card = page.locator('.node-item').filter({ hasText: identity.nodeId })
  await card.locator('[data-device-presence="offline"]').waitFor()
  assert.match(await card.innerText(), /离线[\s\S]*心跳陈旧/)
  assert.ok((await card.innerText()).includes('2000'))
  assert.ok((await card.innerText()).includes('这是末次心跳快照'))
  assert.ok(!(await page.locator('body').innerText()).includes('节点在线'))
  await page.screenshot({ path: join(root, 'stale-device.png'), fullPage: true })
  pass('production Edge and top badge render zero online nodes, stale evidence and the actual last heartbeat without fake network response')
  await context.close(); context = null
  context = await chromium.launchPersistentContext(join(root, 'owned-edge-presence'), {
    executablePath: process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    headless: true, viewport: { width: 390, height: 960 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--default-apps=none', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'], env: { PATH: process.env.PATH, TMPDIR: root }, timeout: 30000,
  })
  const reopened = context.pages()[0]
  reopened.on('pageerror', e => errors.push(String(e.message)))
  await reopened.goto(origin, { waitUntil: 'domcontentloaded' })
  await reopened.locator('.loom-app').waitFor()
  await reopened.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await reopened.locator('#client-token').fill(token)
  await reopened.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await reopened.locator('#connection-dialog').waitFor({ state: 'hidden' })
  await reopened.getByRole('button', { name: '设备', exact: true }).click()
  await reopened.waitForFunction(() => document.querySelector('.summary-number strong')?.textContent?.trim() === '0')
  assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth), 390)
  await reopened.screenshot({ path: join(root, 'stale-device-390.png'), fullPage: true })
  assert.deepEqual(errors, [])
  pass('same owned Edge profile reopens offline evidence at 390px without claiming mobile lifecycle')
  await context.close(); context = null

  // An authenticated management action uses the existing client identity;
  // the following request independently uses this fixture's own Node token.
  const revocation = await fetch(`${server.baseUrl}/api/v1/nodes/${encodeURIComponent(identity.nodeId)}/revoke`, {
    method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(revocation.status, 200)
  assert.equal((await revocation.json()).revoked, true)
  const revoked = await admin.get('/api/v1/nodes')
  assert.ok(revoked.nodes[0].revoked_at)
  assert.equal(revoked.nodes[0].online, false)
  assert.equal(revoked.nodes[0].last_heartbeat, oldHeartbeat)
  await admin.post('/api/v1/nodes/heartbeat', {
    node_id: identity.nodeId, installation_id: identity.installationId,
    request_id: crypto.randomUUID(), protocol: 'loom.node.v1',
    status: 'online', capabilities: [], workers: [worker], inventory: {},
    timestamp: new Date().toISOString(),
  }, { token: identity.token }).then(
    () => assert.fail('revoked node heartbeat must not be accepted'),
    error => {
      assert.equal(error.status, 401)
      assert.equal(error.code, 'unauthorized')
    },
  )
  pass('explicit revoke is not confused with staleness and an active installation cannot regain liveness through another heartbeat')
  await writeFile(output, JSON.stringify(report('PASS'), null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report('PASS'), null, 2))
} catch (error) {
  console.error(JSON.stringify({ ...report('FAIL'), error: String(error?.stack || error) }, null, 2))
  process.exitCode = 1
} finally {
  if (context) await context.close().catch(() => {})
  if (preview) await new Promise(resolve => preview.httpServer.close(resolve)).catch(() => {})
  if (server) await server.stop().catch(() => {})
  if (keep) console.log(`OWNED_PRESENCE_ROOT=${root}`)
  else {
    const owned = await realpath(root)
    const temporary = await realpath(tmpdir())
    assert.equal(dirname(owned), temporary)
    assert.ok(basename(owned).startsWith('loom-real-http-'))
    await rm(owned, { recursive: true, force: true })
  }
}
