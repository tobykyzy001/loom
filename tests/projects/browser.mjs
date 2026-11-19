#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, rename, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

try { execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch {
  console.log(JSON.stringify({ overall: 'NOT RUN', reason: 'Git executable is unavailable on this host' }))
  process.exit(0)
}
if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ overall: 'NOT RUN', reason: 'the fixed project-browser fixture currently validates macOS, not this platform' }))
  process.exit(0)
}
const root = await testingRoot()
const output = process.env.LOOM_TEST_OUTPUT || '/tmp/loom-project-facts-proof.json'
const keep = process.env.LOOM_TEST_KEEP_EVIDENCE === '1'
const repository = join(root, 'project')
const documents = join(root, 'documents')
await mkdir(repository, { recursive: true, mode: 0o700 })
await mkdir(documents, { recursive: true, mode: 0o700 })
await writeFile(join(repository, 'input.txt'), 'owned fixture\n', { mode: 0o600 })
const git = (args) => execFileSync('git', ['-c', 'init.defaultBranch=fixture', '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: repository, timeout: 10000, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(root, 'empty-home'), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
})
git(['init', '--quiet', '.'])
git(['remote', 'add', 'origin', 'https://user:must-not-appear@example.invalid/team/repo.git'])
git(['add', '--', 'input.txt'])
git(['-c', 'user.name=ProjectFixture', '-c', 'user.email=fixture@invalid', 'commit', '--quiet', '-m', 'owned seed'])

const secrets = ['user:must-not-appear', 'must-not-appear', 'https://user:must-not-appear@example.invalid/team/repo.git']
const checks = [], requests = []
let server, context, preview, admin
const result = overall => ({ schema: 'loom.project-facts-proof.v1', overall, checks, clone_or_fetch: false, credential_lookup: false, model_invocation: false, second_physical_host: 'NOT RUN', mobile: 'NOT RUN', output })
// Local native-only Git fixture, not a shell accepting arbitrary repository paths.
try {
  server = await startRustConcierge({ root: join(root, 'rust') })
  process.env.LOOM_TEST_CONCIERGE_URL = server.baseUrl
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const gitResponse = await admin.post('/api/v1/projects', { name: 'Owned Git worktree', root: repository, mode: 'read_only' })
  const project = gitResponse.project
  const id = project.id
  const expectedRevision = git(['rev-parse', 'HEAD']).trim()
  assert.match(expectedRevision, /^[a-f0-9]{40,64}$/)
  assert.equal(project.inventory.revision, expectedRevision)
  assert.equal(await realpath(project.root), await realpath(repository))
  assert.equal(project.inventory.form, 'working_tree')
  assert.equal(project.inventory.dirty, false)
  assert.equal(project.inventory.canonical_remote, 'https://example.invalid/team/repo.git')
  assertPublic(project.inventory)
  const probed_at = project.inventory.probed_at
  const unauthenticated = await fetch(`${server.baseUrl}/api/v1/projects/${encodeURIComponent(id)}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(unauthenticated.status, 401)
  await unauthenticated.arrayBuffer()
  const document = await admin.post('/api/v1/projects', { name: 'Plain document folder', root: documents, mode: 'read_only' })
  assert.equal(document.project.inventory.form, 'documents')
  assert.equal(document.project.inventory.dirty, null)
  assert.equal(document.project.inventory.revision, null)
  const first = checks.push({ name: 'actual independent owned Git and document projects, invalid-token rejection, sanitized remote and root classification', state: 'PASS' })
  assert.equal(first, 1)

  const appRoot = resolve('apps/web')
  const { preview: startPreview } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
  preview = await startPreview({ root: appRoot, configFile: resolve('tests/browser/vite.config.mjs'), logLevel: 'error', cacheDir: join(root, 'vite-cache'),
    preview: { host: '127.0.0.1', port: 0, strictPort: true }, build: { outDir: join(appRoot, 'dist') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/api': { target: server.baseUrl, changeOrigin: true } } } })
  const origin = `http://127.0.0.1:${preview.httpServer.address().port}`
  const { chromium } = await import('../browser/node_modules/playwright-core/index.mjs')
  context = await chromium.launchPersistentContext(join(root, 'owned-browser-profile'), {
    executablePath: process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true,
    viewport: { width: 1280, height: 960 },
    args: ['--no-first-run', '--no-default-browser-check', '--no-default-search', '--disable-sync', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--no-service-autorun', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'xdg'), TMPDIR: root }, timeout: 30000,
  })
  const page = context.pages()[0]
  page.setDefaultTimeout(25000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    assert.equal(url.protocol, 'http:')
    assert.equal(url.hostname, '127.0.0.1')
    assert.ok([origin, server.baseUrl].includes(url.origin), 'Browser must remain on owned origins')
    requests.push({ method: request.method(), path: url.pathname })
  })
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.locator('.loom-app').waitFor()
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(server.clientToken)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
  await page.locator('.main-nav').getByRole('button', { name: '项目', exact: true }).click()
  const card = page.locator('.project-card').filter({ has: page.locator('.project-id', { hasText: id }) })
  await card.waitFor()
  assert.equal(await card.count(), 1)
  assertPublicText(await card.innerText())
  assert.equal(await card.locator('.inventory-facts .mono').filter({ hasText: expectedRevision }).count(), 1)
  assert.ok((await card.innerText()).includes('Git 工作树'))
  assert.ok((await card.innerText()).includes('https://example.invalid/team/repo.git'))
  const documentCard = page.locator('.project-card').filter({ has: page.locator('.project-id', { hasText: document.project.id }) })
  await documentCard.waitFor()
  assert.equal(await documentCard.count(), 1)
  await documentCard.getByText('普通资料目录（非 Git）', { exact: true }).waitFor()
  assert.ok(!(await documentCard.innerText()).includes('HEAD（基线'))
  checks.push({ name: 'real Edge shows the initial auth-backed Git/public-remote and non-Git readings without raw secret metadata', state: 'PASS' })

  await writeFile(join(repository, 'input.txt'), 'owned modified source\n', { mode: 0o600 })
  const probe = card.locator('[data-project-probe]')
  let releaseProbe
  const held = new Promise(resolve => { releaseProbe = resolve })
  await page.route(`**/api/v1/projects/${id}/probe`, async route => { await held; return route.continue() })
  await probe.click({ noWaitAfter: true })
  await page.waitForFunction(id => document.querySelector(`[data-project-probe="${id}"]`)?.disabled === true, id)
  await probe.evaluate(element => element.click())
  assert.equal(requests.filter(r => r.method === 'POST' && r.path === `/api/v1/projects/${id}/probe`).length, 1)
  releaseProbe()
  await page.getByText('有未提交的修改', { exact: true }).waitFor()
  assert.equal(requests.filter(r => r.method === 'POST' && r.path === `/api/v1/projects/${id}/probe`).length, 1)
  const dirty = await admin.get('/api/v1/projects')
  assert.equal(dirty.projects.find(p => p.id === id).inventory.dirty, true)
  assert.notEqual(dirty.projects.find(p => p.id === id).inventory.probed_at, probed_at)
  checks.push({ name: 'an actual write to a tracked fixture is observed by exactly one explicit same-project probe; concurrent duplicate click stays one read', state: 'PASS' })

  git(['remote', 'set-url', 'origin', 'ssh://private-login@example.invalid/team/repo.git'])
  secrets.push('private-login')
  await probe.click()
  await page.getByText('已排除不安全或含凭据的远端地址，不以原文替代', { exact: true }).waitFor()
  const redacted = await admin.get('/api/v1/projects')
  const redactedInventory = redacted.projects.find(p => p.id === id).inventory
  assert.equal(redactedInventory.canonical_remote, null)
  assert.equal(redactedInventory.canonical_remote_status, 'unsupported_or_redacted')
  assert.equal(redactedInventory.redacted_remote, true)
  assertPublic(redactedInventory)
  assertPublicText(await card.innerText())
  checks.push({ name: 'a newly unsafe remote needs review, while the previous HEAD/dirty facts stay present and secret URL is not published', state: 'PASS' })

  const gitRoot = join(repository, '.git')
  const saved = join(root, 'saved-journal-of-git')
  await rename(gitRoot, saved)
  try {
    await writeFile(gitRoot, 'not a git directory; an owned malformed marker\n', { mode: 0o600 })
    await probe.click()
    await page.getByText('本次未获得工作树修改状态', { exact: true }).waitFor()
    const unknown = await admin.get('/api/v1/projects')
    assert.equal(unknown.projects.find(p => p.id === id).inventory.dirty, null)
    assert.equal(unknown.projects.find(p => p.id === id).inventory.source, 'controller_probe')
    assert.ok(Date.parse(unknown.projects.find(p => p.id === id).inventory.probed_at) >= Date.parse(redactedInventory.probed_at))
    assertPublicText(await card.innerText())
    checks.push({ name: 'actual failed git command stays unknown, not clean, and other raw facts remain bounded', state: 'PASS' })
  } finally {
    await rename(gitRoot, join(root, 'malformed-marker'))
    await rename(saved, gitRoot)
  }
  assert.ok(git(['diff', '--', 'input.txt']).includes('owned modified source'))

  const sameUrl = server.baseUrl, sameToken = server.clientToken, sameDataDir = server.dataDir
  await server.stop(); server = null
  const removed = new DatabaseSync(join(sameDataDir, 'loom.sqlite3'))
  const original = removed.prepare('SELECT * FROM projects WHERE id=?').get(id)
  assert.ok(original)
  removed.prepare('DELETE FROM projects WHERE id=?').run(id)
  removed.close()
  server = await startRustConcierge({ root, dataDir: sameDataDir, baseUrl: sameUrl, env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: sameToken } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: sameToken })
  const lost = await admin.post(`/api/v1/projects/${id}/probe`, {}).catch(error => {
    assert.equal(error.status, 400)
    return error
  })
  assert.equal(lost.status, 400)
  assert.equal((await admin.get('/api/v1/projects')).projects.find(p => p.id === id), undefined)
  await probe.click()
  await page.locator('.project-refresh [role="alert"]').waitFor()
  assert.ok((await card.innerText()).includes('刷新未完成，保留原已知观测'))
  assertPublicText(await card.innerText())
  assertPublicText(await documentCard.innerText())
  const restoration = new DatabaseSync(join(sameDataDir, 'loom.sqlite3'))
  restoration.exec('BEGIN IMMEDIATE')
  restoration.prepare('INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES(?,?,?,?,?,?,?)').run(original.id, original.name, original.root, original.mode, original.version, original.created_at, original.inventory)
  restoration.exec('COMMIT')
  restoration.close()
  assert.equal((await admin.get('/api/v1/projects')).projects.length, 2)
  checks.push({ name: 'the actual missing-project probe fails with a real error while the visible old snapshot and document observations are not erased; original fixture row restored', state: 'PASS' })

  await page.screenshot({ path: join(root, 'project-facts-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 1050 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  assert.ok((await card.boundingBox()).width <= 390)
  await card.screenshot({ path: join(root, 'project-facts-narrow.png') })
  assert.deepEqual(errors, [])
  const audits = await admin.get('/api/v1/audit/verify')
  assert.equal(audits.valid, true)
  const beforeRestart = structuredClone((await admin.get('/api/v1/projects')).projects.find(p => p.id === id).inventory)
  const oldBaseUrl = server.baseUrl, oldToken = server.clientToken, oldDir = server.dataDir
  await server.stop(); server = null
  server = await startRustConcierge({ root: join(root, 'rust'), dataDir: oldDir, baseUrl: oldBaseUrl, env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: oldToken } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: oldToken })
  const reopened = await admin.get('/api/v1/projects')
  assert.equal(server.clientToken, oldToken)
  assert.equal(server.dataDir, oldDir)
  assert.ok(reopened.projects.find(p => p.id === id))
  assert.equal(reopened.projects.length, 2)
  const reopenedProject = reopened.projects.find(p => p.id === id)
  assert.deepEqual(reopenedProject.inventory, beforeRestart)
  for (const key of ['root', 'mode', 'version', 'created_at']) assert.equal(reopenedProject[key], original[key])
  checks.push({ name: 'same-database origin/controller reopen preserves both root types and old probe snapshot without creating new registry rights', state: 'PASS' })
  await writeFile(output, JSON.stringify(result('PASS'), null, 2), { mode: 0o600 })
  console.log(JSON.stringify(result('PASS'), null, 2))
} catch (error) {
  const message = secrets.concat([server?.clientToken || '']).filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(error?.stack || error))
  console.error(JSON.stringify({ ...result('FAIL'), error: message }, null, 2))
  if (keep) console.error(`Owned project diagnostic root: ${root}`)
  process.exitCode = 1
} finally {
  if (context) await context.close().catch(() => {})
  if (preview?.httpServer) await new Promise(resolve => preview.httpServer.close(resolve))
  if (server) await server.stop().catch(() => {})
  if (keep) console.log(`RETAINED_PROJECT_FACTS_ROOT=${root}`)
  else {
    const owned = await realpath(root)
    const temporary = await realpath(tmpdir())
    assert.equal(dirname(owned), temporary)
    assert.ok(basename(owned).startsWith('loom-real-http-'))
    await rm(owned, { recursive: true, force: true })
  }
}
function assertPublic(value) {
  assert.equal(value.source, 'controller_probe')
  assert.equal(value.credential_lookup_performed, false)
  assert.equal(value.credential_available, 'unknown')
  assert.equal(value.credential_location, null)
  assert.equal(value.git_available, true)
}
function assertPublicText(text) {
  for (const value of secrets) assert.ok(!text.includes(value))
}
