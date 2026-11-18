#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const dependency = JSON.parse(await readFile(join(repository, 'tests/browser/node_modules/playwright-core/package.json'), 'utf8'))
assert.equal(dependency.version, '1.65.1')
assert.equal((await stat(executable)).isFile(), true)
await realpath(executable)
const dist = join(repository, 'apps/web/dist')
const root = await mkdtemp(join(tmpdir(), 'loom-shell-browser-owned-'))
const evidence = await mkdtemp(join(tmpdir(), 'loom-shell-proof-'))
const report = { overall: 'NOT RUN', scope: 'same-origin built public app-shell once prepared online, then truly offline', browser: {}, limits: ['not a physical phone or OS lifecycle', 'not cold first offline discovery', 'not business/API/Ticket/Grant/Artifact/token caching', 'not offline approvals/background execution', 'not a DSH Host plugin/Web GUI deployment'] }
const contexts = []
let server
let watchdog
let closing = false
let activePage
const browserDiagnostics = []
async function cleanup(reason) {
  if (closing) return
  closing = true
  if (reason) {
    report.overall = 'FAIL'
    report.error = String(reason.stack || reason).replaceAll(server?.clientToken || '\u0000', '[fixture-credential]')
  }
  clearTimeout(watchdog)
  const closeErrors = []
  for (const context of contexts) await bounded(context.close(), 'Close owned browser context', 12000).catch(error => closeErrors.push(error.message))
  await bounded(server?.stop() || Promise.resolve(), 'Stop owned Rust fixture', 8000).catch(error => closeErrors.push(error.message))
  assert.equal(root.startsWith(join(tmpdir(), 'loom-shell-browser-owned-')), true, 'Only this driver owned profile/server may be removed')
  await rm(root, { recursive: true, force: true })
  report.cleanup = { temporary_profile_deleted: true, production_or_DSH_profile_untouched: true, close_errors: closeErrors }
  if (closeErrors.length) report.overall = 'FAIL'
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
}
async function bounded(promise, label, milliseconds = 25000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function checked(command, args) {
  const child = spawn(command, args, { cwd: repository, shell: false, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => chunks.push(String(chunk)))
  const code = await bounded(new Promise((ok, reject) => { child.once('error', reject); child.once('exit', ok) }), 'Build current native Vue app', 120000)
  assert.equal(code, 0, chunks.join(''))
  return chunks.join('')
}
async function launchContext(label) {
  const profile = join(root, label)
  await mkdir(profile, { mode: 0o700 })
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: executable, headless: true, viewport: { width: 390, height: 844 },
    args: ['--no-first-run', '--no-default-browser-check', '--no-default-search', '--disable-sync', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server'],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, timeout: 25000,
  })
  contexts.push(context)
  return context
}
async function cachedState(page, origin) {
  return page.evaluate(async targetOrigin => {
    const result = []
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) {
        const url = new URL(request.url)
        if (url.origin !== targetOrigin) throw new Error('Foreign cached origin violates the static shell boundary')
        const response = await cache.match(request)
        const body = await response.text()
        if (url.pathname.startsWith('/api/')) throw new Error('An API response must not be put into the shell cache')
        result.push({ cache: name, pathname: url.pathname, sha256: await hash(body), bytes: new TextEncoder().encode(body).byteLength, type: response.headers.get('content-type') })
      }
    }
    return result
  }, origin)
}
async function appVisible(page, origin) {
  await page.locator('.workspace-heading h1').waitFor({ state: 'visible' })
  const structure = await page.evaluate(() => {
    const root = document.getElementById('app')
    const heading = document.querySelector('.workspace-heading h1')
    return {
      content: root?.textContent?.includes('你的工作空间'),
      appChildren: root?.children.length,
      heading: heading?.textContent,
      display: getComputedStyle(heading).display,
      stylesheetCount: [...document.styleSheets].filter(sheet => {
        try { return sheet.cssRules.length > 0 } catch { return false }
      }).length,
      viewport: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
    }
  })
  assert.equal(structure.content, true)
  assert.ok(structure.appChildren > 0)
  assert.equal(structure.heading.includes('你的工作空间'), true)
  assert.notEqual(structure.display, 'none')
  assert.ok(structure.stylesheetCount > 0, 'The actual cached CSS has parsed, not merely a downloaded HTML line')
  assert.ok(structure.contentWidth <= structure.viewport + 1, JSON.stringify(structure))
  assert.equal(new URL(page.url()).origin, origin)
  return structure
}

try {
  watchdog = setTimeout(() => {
    void cleanup(new Error('offline-shell driver exceeded the bounded test window')).finally(() => process.exit(1))
  }, 120000)
  const buildOutput = await checked('pnpm', ['--dir', 'apps/web', 'build'])
  report.commands = ['pnpm --dir apps/web build', 'real Rust Concierge --web-dir apps/web/dist on an owned loopback port', 'canonical Playwright persistent contexts launched from the installed Edge executable']
  const serverDir = join(root, 'server')
  const wrapper = join(root, 'serve.mjs')
  await mkdir(serverDir, { mode: 0o700 })
  const script = `import {spawn} from 'node:child_process';const child=spawn(${JSON.stringify(join(repository, 'target/debug/loom'))},[...process.argv.slice(2),'--web-dir',${JSON.stringify(dist)}],{shell:false,stdio:'inherit'});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',(code,signal)=>{console.log('OWNED_LOOM_EXIT '+code+' '+signal);process.exit(code??(signal?0:1))});`
  await writeFile(wrapper, script, { mode: 0o700 })
  server = await startRustConcierge({ root: serverDir, env: { ...process.env, LOOM_SERVER_CMD: `${process.execPath} ${wrapper}` } })
  const origin = server.baseUrl
  report.origin = origin
  const indexBytes = await readFile(join(dist, 'index.html'))
  const builtIndex = indexBytes.toString('utf8')
  const { createHash } = await import('node:crypto')
  report.built_index_sha256 = createHash('sha256').update(indexBytes).digest('hex')
  const expectedAssets = [...builtIndex.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]).filter(value => new URL(value, origin).pathname.startsWith('/assets/'))
  assert.ok(expectedAssets.some(value => value.endsWith('.js')))
  assert.ok(expectedAssets.some(value => value.endsWith('.css')))
  const manifestResponse = await fetch(`${origin}/manifest.webmanifest`, { cache: 'no-store' })
  assert.equal(manifestResponse.status, 200)
  assert.match(manifestResponse.headers.get('content-type') || '', /(?:application\/manifest\+json|application\/json)/)
  const swResponse = await fetch(`${origin}/sw.js`, { cache: 'no-store' })
  assert.equal(swResponse.status, 200)
  assert.match(swResponse.headers.get('content-type') || '', /javascript/)
  report.public_entry = { manifest_http: 200, sw_http: 200, manifest_content_type: manifestResponse.headers.get('content-type'), sw_content_type: swResponse.headers.get('content-type') }

  const context = await launchContext('warm-profile')
  const browserVersion = context.browser()?.version()
  report.browser = { executable: 'Microsoft Edge', version: browserVersion, playwright_core: dependency.version, new_owned_profile: true, dsh_profile_used: false, viewport: { width: 390, height: 844 } }
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => browserDiagnostics.push({ type: 'pageerror', message: error.message }))
  page.on('console', message => {
    if (message.type() === 'error') browserDiagnostics.push({ type: 'console', message: message.text() })
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/api/')) workspaceResponses.push({ path, status: response.status() })
    if (response.status() >= 400) browserDiagnostics.push({ type: 'http', path, status: response.status() })
  })
  const unexpectedExternal = []
  const offlineNavigationResponses = []
  const failedApi = []
  const workspaceResponses = []
  let observeOfflineNavigation = false
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) unexpectedExternal.push(`${url.protocol}//${url.hostname}`)
  })
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) failedApi.push(request.failure()?.errorText)
  })
  page.on('response', response => {
    if (!observeOfflineNavigation || response.request().resourceType() !== 'document') return
    offlineNavigationResponses.push({ url: response.url(), fromServiceWorker: response.fromServiceWorker() })
  })
  await page.goto(origin, { waitUntil: 'load' })
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(server.clientToken)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.querySelector('.connection-pill')?.textContent.includes('未注册节点'))
  const [registration, jsMime] = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    const scripts = [...document.querySelectorAll('script[type=module][src]')].map(element => element.src)
    return [{ scope: registration.scope, active: registration.active?.state, scripts, controller: navigator.serviceWorker.controller?.scriptURL }, document.querySelector('link[rel="manifest"]')?.href]
  })
  assert.equal(registration.scope, `${origin}/`)
  assert.equal(registration.active, 'activated')
  assert.equal(jsMime, `${origin}/manifest.webmanifest`)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const controlled = await page.evaluate(() => ({ controller: navigator.serviceWorker.controller?.scriptURL, cachesAvailable: 'caches' in window, controllerState: navigator.serviceWorker.controller?.state }))
  assert.equal(controlled.controller, `${origin}/sw.js`)
  assert.equal(controlled.cachesAvailable, true)
  assert.equal(controlled.controllerState, 'activated')
  await appVisible(page, origin)
  const initialCache = await cachedState(page, origin)
  const cachePaths = new Set(initialCache.map(entry => entry.pathname))
  for (const asset of expectedAssets) {
    assert.equal(cachePaths.has(new URL(asset, origin).pathname), true, `Actual Vite asset missing from prepared cache: ${asset}`)
    assert.equal(initialCache.find(entry => entry.pathname === new URL(asset, origin).pathname).sha256, createHash('sha256').update(await readFile(join(dist, asset.replace(/^\//, '')))).digest('hex'))
  }
  const cachedIndex = initialCache.find(entry => entry.pathname === '/')
  assert.equal(cachedIndex?.sha256, report.built_index_sha256)
  assert.equal([...cachePaths].filter(path => path.startsWith('/api/')).length, 0)
  assert.equal([...cachePaths].some(path => path.includes('client-token') || path.includes('bootstrap')), false)
  assert.deepEqual(initialCache.length, new Set(initialCache.map(entry => entry.pathname)).size, 'No duplicate cached paths across duplicate runtime caches')
  report.preloaded = { ...controlled, cache: initialCache, asset_count: initialCache.length, built_asset_hashes_verified_with_actual_CacheStorage: true }

  // A separate never-visited BrowserContext has no earlier shell or registration.
  // Close its real network-error page before using the prepared context offline.
  const cold = await context.browser().newContext({ offline: true, viewport: { width: 390, height: 844 } })
  contexts.push(cold)
  const coldPage = await cold.newPage()
  const error = await coldPage.goto(origin, { timeout: 15000 }).then(() => null, error => error)
  assert.ok(error && String(error.message).includes('ERR_INTERNET_DISCONNECTED'), `Cold first offline must not be a fake shell success: ${String(error)}`)
  report.cold_first_offline_without_prior_visit_is_not_supported = String(error.message).split('\n')[0]
  await cold.close()

  await context.setOffline(true)
  observeOfflineNavigation = true
  await page.reload({ waitUntil: 'load' })
  const offlineDom = await appVisible(page, origin)
  await page.waitForFunction(() => document.querySelector('.connection-pill')?.textContent.includes('未连接'))
  const stale = page.getByTestId('client-read-stale')
  await stale.waitFor({ state: 'visible' })
  assert.match(await stale.innerText(), /读取已中断|此前快照|不保证是最新/)
  assert.match(await stale.innerText(), /不等同于Worker离线|不是Host|不是节点/)
  const apiOutcome = await page.evaluate(async () => {
    try { const response = await fetch('/api/v1/bootstrap', { cache: 'no-store' }); return { type: 'response', status: response.status } }
    catch (error) { return { type: 'network_failure', name: error.name } }
  })
  assert.equal(apiOutcome.type, 'network_failure', 'Protected API reads must remain a real network failure; never synthesize cached business success')
  const offlineCache = await cachedState(page, origin)
  assert.deepEqual(offlineCache.map(item => item.pathname).sort(), [...cachePaths].sort(), 'The offline state cannot silently add task/Grant/Artifact data')
  assert.equal(failedApi.some(Boolean), true)
  assert.ok(offlineNavigationResponses.some(item => item.fromServiceWorker), 'The actual browser must load the offline navigation from the real ServiceWorker, not static HTML')
  assert.deepEqual(unexpectedExternal, [])
  assert.equal(await page.locator('body').innerText().then(text => text.includes(server.clientToken)), false)
  await page.screenshot({ path: join(evidence, 'offline-shell.png'), fullPage: true })
  report.offline = { dom: offlineDom, controller_served_navigation: offlineNavigationResponses, api_failure: apiOutcome, cache_count: offlineCache.length, network_failure_banner: true, no_api_or_token_cache: true, viewport_390: true, screenshot: 'offline-shell.png' }

  await context.setOffline(false)
  const beforeRecovery = workspaceResponses.length
  await page.getByRole('button', { name: '重新读取最新状态', exact: true }).click()
  // A bootstrap response alone precedes the Projects/Tickets/Nodes/Grants/preferences reads.
  // Observe the actual completed workspace state instead of racing the first JSON arrival.
  await page.waitForFunction(() => document.querySelector('.connection-pill')?.textContent === '未注册节点')
  await page.waitForFunction(() => !document.querySelector('[data-testid="client-read-stale"]'))
  const restoredReads = workspaceResponses.slice(beforeRecovery)
  const paths = new Set(restoredReads.filter(row => row.status === 200).map(row => row.path))
  for (const path of ['/api/v1/bootstrap', '/api/v1/projects', '/api/v1/tickets', '/api/v1/nodes', '/api/v1/grants']) {
    assert.equal(paths.has(path), true, `Restoration must include the real ${path} read: ${JSON.stringify(restoredReads)}`)
  }
  assert.equal(restoredReads.some(row => row.status === 401), false, 'The fixture token accepted before the outage must remain the valid current token')
  report.online_recovery = { real_bootstrap_read: true, workspace_reads: restoredReads, connection_pill: await page.locator('.connection-pill').innerText(), cached_shell_does_not_replace_authoritative_read: true }
  report.overall = 'PASS'
} catch (error) {
  report.error = String(error.stack || error).replaceAll(server?.clientToken || '\u0000', '[fixture-credential]')
  if (activePage && !activePage.isClosed()) {
    try {
      report.failure_dom = (await activePage.locator('body').innerText()).slice(0, 2200)
      report.browser_diagnostics = browserDiagnostics
    } catch (diagnosticError) {
      report.failure_diagnostics_error = diagnosticError.message
    }
  }
  console.error(error)
  process.exitCode = 1
} finally {
  await cleanup(report.overall === 'PASS' ? null : new Error(report.error || 'Offline shell proof did not complete'))
  if (report.overall !== 'PASS') process.exitCode = 1
  console.log(JSON.stringify({ overall: report.overall, evidence, error: report.error }, null, 2))
}
