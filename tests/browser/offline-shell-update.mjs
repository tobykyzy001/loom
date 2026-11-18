#!/usr/bin/env node
import assert from 'node:assert/strict'
import {execFileSync, spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright-core'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const browserExecutable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const base = await mkdtemp(join(tmpdir(), 'loom-shell-update-owned-'))
const evidence = await mkdtemp(join(tmpdir(), 'loom-shell-update-proof-'))
const report = {
  overall: 'NOT RUN',
  scope: 'isolated legacy cache-loss control, then healthy old-to-new publication, failure preservation, and offline reopen',
  limits: [
    'Node static loopback HTTP fixture, not Rust deployment, mobile OS, or DSH Host',
    'explicit DOMException root-write fault, not proof of physical disk or quota exhaustion',
    'no Task, Grant, SDK assignment, Artifact, Effect, credential, or API cache',
    'no global atomics, signed updates, guaranteed rollback, global exactly-once, or 1+3 topology',
  ],
  scenarios: [],
}
let currentPhase = 'startup'
let servedSource = ''
let faultMode = null
let server
let browserCleanupSequence = []
let watchdog
let closing
const requests = []
const waiters = new Set()
const snapshots = []
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const bucketName = 'loom-shell-v2'
const pendingName = `${bucketName}-pending`
// Candidate label is the only selector for the intentionally rejected public root write.
const faultAdapter = `(() => {
 const originalPut = Cache.prototype.put
 Cache.prototype.put = async function(request, response) {
  const key = new URL(typeof request === 'string' ? request : request.url, self.registration.scope)
  const candidate = new URL(self.location.href).searchParams.get('candidate')
  if (key.origin === self.location.origin && key.pathname === '/' && (candidate === 'legacy-root-write' || candidate === 'v2-root-write')) {
   console.error('LOOM_ROOT_WRITE_FAULT ' + candidate)
   throw new DOMException('Explicit fixture root-write rejection', 'QuotaExceededError')
  }
  return originalPut.call(this, request, response)
 }
})()
`

async function bounded(promise, label, milliseconds = 20000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: exceeded ${milliseconds}ms`)), milliseconds)
    })])
  } finally {clearTimeout(timer)}
}

async function waitForBrowserCondition(page, label, probe, args) {
  const deadline = Date.now() + 30000
  let last = null
  while (Date.now() < deadline) {
    last = await bounded(page.evaluate(probe, args), `${label}: evaluate actual cache/controller state`, 6000)
    if (last === true) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`${label}: condition not met after 30s; last=${JSON.stringify(last)}`)
}

function recordTrace(phase, url, type, text) {
  const row = {phase, type, text, url}
  snapshots.push(row)
  for (const waiter of waiters) {
    if (waiter.phase === phase && row.text.includes(waiter.text)) waiter.resolve(row)
  }
}

async function waitForWorkerText(phase, text) {
  const existing = snapshots.find(row => row.phase === phase && row.text.includes(text))
  if (existing) return existing
  let waiter
  try {
    return await bounded(new Promise(resolve => {
      waiter = {phase, text, resolve}
      waiters.add(waiter)
    }), `${phase}: worker event ${text}`, 25000)
  } finally {
    if (waiter) waiters.delete(waiter)
  }
}

async function closedOwnedBrowser(browser, disconnected, pid) {
  const errors = []
  if (browser?.isConnected()) await bounded(browser.close(), 'Close owned Chromium', 13000).catch(error => errors.push(error.message))
  if (browser?.isConnected() && pid) {
    try {
      process.kill(pid, 'SIGTERM')
      await bounded(disconnected, 'Disconnect owned Chromium after close timeout', 5000)
    } catch (error) {
      if (error.code !== 'ESRCH') errors.push(error.message)
    }
  }
  if (browser?.isConnected() && pid) {
    try {
      process.kill(pid, 'SIGKILL')
      await bounded(disconnected, 'Close unresponsive owned Chromium', 5000)
    } catch (error) {
      if (error.code !== 'ESRCH') errors.push(error.message)
    }
  }
  if (browser && !browser.isConnected()) return errors
  if (!errors.length) errors.push('Owned Chromium did not confirm disconnection')
  return errors
}

async function cleanup(reason) {
  if (closing) return
  closing = true
  clearTimeout(watchdog)
  if (reason) {
    report.error = String(reason.stack || reason)
    report.overall = 'FAIL'
    report.recent_requests = requests.slice(-50)
  }
  const closeErrors = []
  const profileErrors = []
  for (const state of browserCleanupSequence) {
    closeErrors.push(...await closedOwnedBrowser(state.browser, state.disconnected, state.pid).catch(error => [error.message]))
    let removed = false
    let lastError = null
    const connected = state.browser?.isConnected()
    const stopped = state.disconnectedObserved || connected === false
    if (stopped) {
      for (let attempt = 0; attempt < 5 && !removed; attempt++) {
        try {
          const resolvedProfile = await realpath(state.profile)
          assert.ok(basename(resolvedProfile))
          assert.equal(basename(resolvedProfile), state.name)
          assert.equal(dirname(resolvedProfile), await realpath(base))
          assert.equal(resolvedProfile, join(await realpath(base), state.name))
          await bounded(rm(resolvedProfile, {recursive: true, force: true}), 'Remove exact owned profile', 6000)
          removed = true
          lastError = null
        } catch (error) {
          lastError = error.message
          if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
    } else {
      lastError = 'Cannot remove profile without confirmed browser disconnect'
    }
    if (!removed) profileErrors.push({profile: state.profile, error: lastError})
  }
  if (server) {
    server.closeAllConnections?.()
    await bounded(new Promise(resolve => server.close(resolve)), 'Close static loopback server', 5000).catch(error => closeErrors.push(error.message))
  }
  const errors = [...closeErrors, ...profileErrors.map(row => row.error)]
  report.driver_sha256 = sha256(await readFile(fileURLToPath(import.meta.url)))
  report.gate_states = browserCleanupSequence.map(item => ({phase: item.name, states: item.gateStates || []}))
  report.cleanup = {
    browser_process_errors: closeErrors,
    profile_errors: profileErrors,
    production_or_DSH_profile_untouched: true,
    profiles_removed: profileErrors.length === 0,
  }
  if (errors.length) report.overall = 'FAIL'
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600})
}

async function build() {
  const child = spawn('pnpm', ['--dir', 'apps/web', 'build'], {cwd: repository, shell: false, env: {PATH: process.env.PATH}, stdio: ['ignore', 'pipe', 'pipe']})
  const chunks = []
  for (const stream of [child.stdout, child.stderr]) stream.on('data', part => chunks.push(part))
  const status = await bounded(new Promise((ok, bad) => {child.once('exit', ok); child.once('error', bad)}), 'Production Vue build', 100000)
  assert.equal(status, 0, Buffer.concat(chunks).toString())
}

async function readBucket(page, name) {
  return page.evaluate(async bucket => {
    if (!await caches.has(bucket)) return null
    const cache = await caches.open(bucket)
    const entries = []
    for (const request of await cache.keys()) {
      const response = await cache.match(request)
      if (!response) throw new Error(`No response exists for ${request.url}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
      const url = new URL(request.url)
      entries.push({bucket, pathname: url.pathname, origin: url.origin, query: url.search, bytes: bytes.length, sha256: digest, mime: response.headers.get('Content-Type'), responseURL: response.url})
    }
    return entries
  }, name)
}

async function exactPublicBucket(page, name, expectedFiles, origin) {
  const entries = await readBucket(page, name)
  assert.ok(entries, `${name} should exist in this browser profile`)
  assert.deepEqual(new Set(entries.map(row => row.pathname)), new Set([...expectedFiles.keys()]))
  for (const entry of entries) {
    const body = expectedFiles.get(entry.pathname)
    assert.ok(body, `Unexpected public bucket path ${entry.pathname}`)
    assert.equal(entry.origin, origin)
    assert.equal(entry.query, '')
    assert.equal(entry.bytes, body.length)
    assert.equal(entry.sha256, sha256(body))
    if (entry.pathname === '/manifest.webmanifest') assert.equal(entry.mime, 'application/manifest+json')
    else if (entry.pathname === '/favicon.svg') assert.equal(entry.mime, 'image/svg+xml')
    else if (entry.pathname.endsWith('.css')) assert.equal(entry.mime, 'text/css')
    else if (entry.pathname.endsWith('.js')) assert.equal(entry.mime, 'text/javascript')
    else if (entry.pathname === '/') assert.ok(['text/html', 'text/html; charset=utf-8'].includes(entry.mime))
  }
  return entries
}

function publicMap(entries) {
  return Object.fromEntries(entries.map(row => [row.pathname, {sha256: row.sha256, bytes: row.bytes, mime: row.mime}]))
}

function publicBodyMap(entries) {
  return Object.fromEntries(entries.map(row => [row.pathname, {sha256: row.sha256, bytes: row.bytes}]))
}

async function hasFullShell(page, bucket, pending, expectedPaths, targetURL) {
  await waitForBrowserCondition(page, 'Complete public release publication', async ({bucket, pending, expectedPaths, targetURL}) => {
    if (!await caches.has(bucket) || await caches.has(pending)) return false
    const registration = await navigator.serviceWorker.getRegistration()
    const controller = navigator.serviceWorker.controller
    await window.recordPublicGate({registration: {active: registration?.active?.scriptURL, state: registration?.active?.state}, controller: {url: controller?.scriptURL, state: controller?.state}})
    if (registration?.active?.scriptURL !== targetURL || registration.active.state !== 'activated') return false
    if (controller?.scriptURL !== targetURL || controller.state !== 'activated') return false
    const cache = await caches.open(bucket)
    const requests = await cache.keys()
    if (requests.length !== expectedPaths.length) return false
    for (const path of expectedPaths) {
      const response = await cache.match(new URL(path, location.origin).href)
      if (!response) return false
      if (!(await response.arrayBuffer()).byteLength) return false
    }
    return true
  }, {bucket, pending, expectedPaths, targetURL})
}

async function registerPhase(page, origin, label, source, phase) {
  const url = `${origin}/sw.js?candidate=${encodeURIComponent(label)}`
  servedSource = source
  const before = await page.evaluate(() => window.proofControllerChanges.length)
  const registered = await bounded(page.evaluate(async ({url}) => {
    try {
      const registration = await navigator.serviceWorker.register(url, {scope: '/'})
      return {scope: registration.scope, active: registration.active?.scriptURL, installing: registration.installing?.scriptURL, waiting: registration.waiting?.scriptURL}
    } catch (error) {
      return {error: `${error.name}: ${error.message}`}
    }
  }, {url}), `${phase}: register ${label}`, 30000)
  assert.equal(registered.error, undefined, JSON.stringify(registered))
  assert.equal(registered.scope, `${origin}/`)
  const downloads = requests.filter(row => row.phase === phase && row.pathname === '/sw.js' && row.search === `?candidate=${encodeURIComponent(label)}`)
  assert.ok(downloads.length, `No real download for ${label}`)
  assert.ok(downloads.every(row => row.contentType === 'text/javascript'))
  return {label, phase, url, before, registered, source_sha256: sha256(source)}
}

async function appIsVisible(page, origin) {
  await page.locator('.workspace-heading h1').waitFor({state: 'visible'})
  return page.evaluate(expectedOrigin => {
    if (new URL(location.href).origin !== expectedOrigin) throw new Error('Unexpected origin')
    if (!document.querySelector('script[src^="/assets/"]')) throw new Error('The application has no real built JS')
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) throw new Error('Layout overflows the viewport')
    const parsedStyles = [...document.styleSheets].filter(sheet => {
      try {return sheet.cssRules.length > 0} catch {return false}
    })
    if (!parsedStyles.length) throw new Error('Cache did not yield CSS that actually parses')
    return {width: document.documentElement.clientWidth, contentWidth: document.documentElement.scrollWidth, stylesheetCount: parsedStyles.length}
  }, origin)
}

async function scenario(name, origin, run) {
  currentPhase = name
  const profile = join(base, name)
  const {mkdir} = await import('node:fs/promises')
  await mkdir(profile, {recursive: true, mode: 0o700})
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: browserExecutable,
    headless: true,
    timeout: 25000,
    viewport: {width: 390, height: 844},
    args: ['--enable-automation', '--no-first-run', '--no-default-browser-check', '--no-default-search', '--disable-sync', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server'],
  })
  const browser = context.browser()
  const phase = {name, browser, pid: null, profile, disconnectedObserved: false, disconnected: null, result: null}
  phase.disconnected = new Promise(resolve => browser.once('disconnected', () => {phase.disconnectedObserved = true; resolve(true)}))
  browserCleanupSequence.push(phase)
  const page = await context.newPage()
  page.setDefaultTimeout(25000)
  const cdp = await browser.newBrowserCDPSession()
  const processInfo = await cdp.send('SystemInfo.getProcessInfo')
  const owned = processInfo.processInfo.filter(item => item.type === 'browser' && Number.isSafeInteger(item.id) && item.id > 0)
  assert.equal(owned.length, 1)
  const line = await cdp.send('Browser.getBrowserCommandLine')
  const profileArg = line.arguments.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
  assert.ok(profileArg)
  assert.equal(await realpath(profileArg), await realpath(profile))
  phase.pid = owned[0].id
  context.on('serviceworker', worker => worker.on('console', message => {
    recordTrace(name, worker.url(), message.type(), message.text().slice(0, 600))
  }))
  await context.addInitScript(() => {
    window.proofControllerChanges = []
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.proofControllerChanges.push({url: navigator.serviceWorker.controller?.scriptURL, state: navigator.serviceWorker.controller?.state})
      window.recordPublicController({url: navigator.serviceWorker.controller?.scriptURL, state: navigator.serviceWorker.controller?.state})
    })
  })
  await page.exposeFunction('recordPublicController', data => {phase.controller = data})
  await page.exposeFunction('recordPublicGate', data => {
    phase.gateStates ||= []
    phase.gateStates.push(data)
  })
  await cdp.detach()
  try {
    phase.result = await run({page, browser, phase})
    phase.result.pid = phase.pid
    phase.result.browser_version = browser.version()
    report.scenarios.push(phase.result)
  } catch (error) {
    phase.error = String(error.stack || error)
    report.scenarios.push({name, outcome: 'FAIL', error: phase.error, pid: phase.pid, profile_owned: true})
    throw error
  }
}

async function startOwnedStaticServer(expectedFiles) {
  server = (await import('node:http')).createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid')
    let status = 404, body = Buffer.from('Not a public shell resource'), mime = 'text/plain'
    if (req.headers.authorization) {
      status = 401
      body = Buffer.from('Public fixture does not accept Authorization headers')
    } else if (url.pathname === '/' && faultMode === 'noncanonical-root') {
      status = 302
      body = Buffer.from('Noncanonical root; all expected public file bodies are preserved')
      res.setHeader('Location', '/redirected-index')
    } else if (url.pathname === '/' || url.pathname === '/redirected-index') {
      status = 200
      body = expectedFiles.get('/')
      mime = 'text/html'
    } else if (expectedFiles.has(url.pathname)) {
      status = 200
      body = expectedFiles.get(url.pathname)
      mime = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.webmanifest') ? 'application/manifest+json' : 'image/svg+xml'
    } else if (url.pathname === '/sw.js') {
      status = 200
      body = Buffer.from(servedSource)
      mime = 'text/javascript'
    } else if (url.pathname.startsWith('/api/')) {
      status = 503
      body = Buffer.from('{"error":"static-shell-only fixture"}')
      mime = 'application/json'
    }
    requests.push({phase: currentPhase, pathname: url.pathname, search: url.search, status, contentType: mime})
    res.writeHead(status, {'Content-Type': mime, 'Content-Length': body.length, 'Cache-Control': 'no-store', Connection: 'close'})
    res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

try {
  watchdog = setTimeout(() => {
    process.exitCode = 1
    void cleanup(new Error('Browser migration verification exceeded allowed window'))
  }, 110000)
  assert.equal((await stat(browserExecutable)).isFile(), true)
  await realpath(browserExecutable)
  const dependency = JSON.parse(await readFile(join(repository, 'tests/browser/node_modules/playwright-core/package.json'), 'utf8'))
  assert.equal(dependency.version, '1.65.1')
  await build()
  const dist = join(repository, 'apps/web/dist')
  const names = ['index.html', 'manifest.webmanifest', 'favicon.svg', ...(await readdir(join(dist, 'assets'))).filter(name => /\.(?:js|css|mjs)$/.test(name)).map(name => `assets/${name}`)]
  const expectedFiles = new Map(await Promise.all(names.map(async name => [`/${name === 'index.html' ? '' : name}`, await readFile(join(dist, name))])))
  const expectedPaths = [...expectedFiles.keys()]
  assert.equal(expectedPaths.length, 5)
  const revision = 'c833aa81c30e220f0b682f577728488cfc5da6d8'
  const archived = execFileSync('git', ['show', `${revision}:apps/web/public/sw.js`], {cwd: repository, encoding: 'utf8'})
  assert.ok(archived.includes('loom-shell-v1'))
  // The legacy fixture's scheduling is normalized to match the observed full-byte
  // read requirement, without changing its explicit install-failure cache deletion.
  const historical = archived.replaceAll("cache: 'no-store', ", '').replace('return { path, response }', 'await response.clone().arrayBuffer()\n    return { path, response }')
  assert.ok(historical.includes('await response.clone().arrayBuffer()'))
  const current = await readFile(join(repository, 'apps/web/public/sw.js'), 'utf8')
  assert.match(current, /const SHELL_CACHE_VERSION = 2\b/)
  report.sources = {
    legacy_revision: revision,
    production_current_revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim(),
    production_sha256: sha256(current),
    legacy_scheduling_only: ['default same-origin fetch mode', 'complete resource clone read before fulfillment'],
    old_failure_cleanup_retained: true,
    fixture_fault_inject_root_only: 'DOMException(QuotaExceededError) for a named candidate; every other write remains native CacheStorage',
  }
  const origin = await startOwnedStaticServer(expectedFiles)
  report.origin = origin

  // Independent negative control. Its profile is never reused for healthy migration.
  await scenario('legacy-cache-loss-control', origin, async ({page}) => {
    servedSource = historical
    await page.goto(origin, {waitUntil: 'load'})
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated')
    const initial = await exactPublicBucket(page, 'loom-shell-v1', expectedFiles, origin)
    assert.equal(initial.length, 5)
    const candidate = await registerPhase(page, origin, 'legacy-root-write', faultAdapter + historical + '\n// Value of active-cache write fault for old cleanup\n', 'legacy-cache-loss-control')
    await waitForWorkerText('legacy-cache-loss-control', 'LOOM_ROOT_WRITE_FAULT legacy-root-write')
    await waitForBrowserCondition(page, 'Legacy cache deletion cleanup', async () => !await caches.has('loom-shell-v1'))
    const entries = await readBucket(page, 'loom-shell-v1')
    assert.equal(entries, null)
    return {name: 'legacy-cache-loss-control', outcome: 'PASS', old_bucket_absent_after_observed_write_failure: true, initial_bytes: publicMap(initial), candidate, source_mode: 'historical worker with declared fetch/body-read scheduling normalization plus named root-write fault'}
  })

  // Healthy migration uses a different owned browser/profile, explicitly preventing
  // the older failed candidate's lifecycle from competing with the release verification.
  await scenario('healthy-migration-and-preservation', origin, async ({page, phase}) => {
    servedSource = historical
    await page.goto(origin, {waitUntil: 'load'})
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated')
    const v1 = await exactPublicBucket(page, 'loom-shell-v1', expectedFiles, origin)
    await page.evaluate(async () => {
      const cache = await caches.open('unrelated-public-static-shell')
      await cache.put('/public-test-marker', new Response('unrelated public fixture'))
    })
    const good = await registerPhase(page, origin, 'healthy-v2', current, 'healthy-migration-and-preservation')
    await hasFullShell(page, bucketName, pendingName, expectedPaths, good.url)
    const healthyWorker = (await page.context().serviceWorkers()).find(worker => worker.url() === good.url)
    if (healthyWorker) {
      report.healthy_worker_state = await bounded(healthyWorker.evaluate(async () => {
        const registration = self.registration
        const buckets = []
        for (const name of await caches.keys()) {
          const cache = await caches.open(name)
          buckets.push({name, keys: (await cache.keys()).map(request => request.url)})
        }
        return {location: self.location.href, receipt: typeof installedShellReceipt, verifyType: typeof verifyCandidate, fetchingType: typeof fetchShellCandidate, buckets, registration: {active: registration.active?.state, installing: registration.installing?.state, waiting: registration.waiting?.state}}
      }), 'Inspect currently healthy candidate worker', 5000)
    } else {
      report.healthy_worker_missing_before_observation = true
    }
    const published = await exactPublicBucket(page, bucketName, expectedFiles, origin)
    // Legacy manufactured its root response with a charset. The v2 worker
    // deliberately retains the validated canonical basic response and its MIME.
    // Never weaken the byte/hash or original-response-MIME checks for that metadata improvement.
    assert.deepEqual(publicBodyMap(published), publicBodyMap(v1))
    assert.equal(await readBucket(page, pendingName), null)
    assert.equal(await readBucket(page, 'loom-shell-v1'), null)
    const healthy = publicMap(published)

    faultMode = 'noncanonical-root'
    const badURL = await registerPhase(page, origin, 'bad-url-candidate', current + '\n// Deliberate invalid root URL candidate\n', 'healthy-migration-and-preservation')
    await waitForBrowserCondition(page, 'Rejected root-URL candidate cleanup', async name => !await caches.has(name), pendingName)
    await page.waitForFunction(target => navigator.serviceWorker.controller?.scriptURL === target && navigator.serviceWorker.controller?.state === 'activated', good.url)
    faultMode = null
    assert.deepEqual(publicMap(await exactPublicBucket(page, bucketName, expectedFiles, origin)), healthy)
    assert.equal(await readBucket(page, pendingName), null)
    assert.ok(requests.some(row => row.phase === 'healthy-migration-and-preservation' && row.pathname === '/redirected-index' && row.status === 200))

    const badWrite = await registerPhase(page, origin, 'v2-root-write', faultAdapter + current + '\n// Writer failure below a valid live release\n', 'healthy-migration-and-preservation')
    await waitForWorkerText('healthy-migration-and-preservation', 'LOOM_ROOT_WRITE_FAULT v2-root-write')
    await waitForBrowserCondition(page, 'Failed candidate pending cleanup', async name => !await caches.has(name), pendingName)
    await page.waitForFunction(target => navigator.serviceWorker.controller?.scriptURL === target && navigator.serviceWorker.controller?.state === 'activated', good.url)
    assert.deepEqual(publicMap(await exactPublicBucket(page, bucketName, expectedFiles, origin)), healthy)
    assert.equal(await readBucket(page, pendingName), null)
    const unrelated = await page.evaluate(async () => (await (await caches.open('unrelated-public-static-shell')).match('/public-test-marker')).text())
    assert.equal(unrelated, 'unrelated public fixture')

    const navigation = []
    page.on('response', response => {
      if (response.request().resourceType() === 'document') navigation.push({url: response.url(), fromServiceWorker: response.fromServiceWorker()})
    })
    // This concrete persistent context changes actual networking rather than stubbing an API result.
    await page.evaluate(() => navigator.serviceWorker.ready)
    const browserContext = page.context()
    await browserContext.setOffline(true)
    await page.reload({waitUntil: 'load'})
    const dom = await appIsVisible(page, origin)
    assert.equal(navigation.at(-1)?.fromServiceWorker, true)
    await page.waitForFunction(() => document.querySelector('.connection-pill')?.textContent.includes('未连接'))
    const apiStatus = await page.evaluate(async () => {try {return (await fetch('/api/v1/bootstrap')).status} catch {return 0}})
    assert.equal(apiStatus, 0)
    assert.deepEqual(publicMap(await exactPublicBucket(page, bucketName, expectedFiles, origin)), healthy)
    assert.equal((await readBucket(page, bucketName)).some(row => row.pathname.startsWith('/api/')), false)
    await page.screenshot({path: join(evidence, 'offline-after-failed-candidates.png'), fullPage: true})
    await browserContext.setOffline(false)
    await page.reload({waitUntil: 'load'})
    await appIsVisible(page, origin)
    return {
      name: 'healthy-migration-and-preservation', outcome: 'PASS',
      healthy_publication: {candidate: good, bytes: healthy, pending_absent: true, older_v1_absent_after_readback: true},
      noncanonical_root_url: {candidate: badURL, bytes_unchanged: true, pending_absent: true, actual_redirect_observed: true},
      root_write_rejection: {candidate: badWrite, bytes_unchanged: true, pending_absent: true, injected_quota_name: 'QuotaExceededError (not physical quota exhaustion)', unrelated_cache_preserved: true},
      retained_offline: {dom, from_service_worker: true, api_status: apiStatus, bytes_unchanged: true, screenshot: 'offline-after-failed-candidates.png'},
    }
  })
  report.http_requests = requests
  report.worker_trace = snapshots
  report.overall = 'PASS'
} catch (error) {
  report.error = String(error.stack || error)
  report.worker_trace = snapshots
} finally {
  await cleanup(report.overall === 'PASS' ? null : new Error(report.error || 'The migration proof did not complete'))
  console.log(JSON.stringify({overall: report.overall, evidence, error: report.error, cleanup: report.cleanup}, null, 2))
  if (report.overall !== 'PASS') process.exitCode = 1
}
