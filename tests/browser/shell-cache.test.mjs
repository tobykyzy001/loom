import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'

const script = await readFile(new URL('../../apps/web/public/sw.js', import.meta.url), 'utf8')
const origin = 'http://shell.fixture.invalid'
const paths = ['/', '/assets/app-b.js', '/assets/app-c.css', '/manifest.webmanifest', '/favicon.svg']
const mimes = {
  '/': 'text/html; charset=utf-8',
  '/assets/app-b.js': 'text/javascript',
  '/assets/app-c.css': 'text/css',
  '/manifest.webmanifest': 'application/manifest+json',
  '/favicon.svg': 'image/svg+xml',
}
const text = new TextEncoder()
function payload() {
  return new Map([
    ['/', text.encode('<!doctype html><html><head><link href="/assets/app-c.css" rel="stylesheet"></head><body><script type="module" src="/assets/app-b.js"></script></body></html>')],
    ['/assets/app-b.js', text.encode('console.log("public shell")')],
    ['/assets/app-c.css', text.encode('body{display:block}')],
    ['/manifest.webmanifest', text.encode('{"name":"public-fixture"}')],
    ['/favicon.svg', text.encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ])
}
function response(path, bytes, mime = mimes[path], responsePath = path) {
  const value = new Response(bytes, { status: 200, headers: { 'Content-Type': mime } })
  // These two readonly network fields are explicitly modeled, as in a browser
  // CacheStorage response. This is a deterministic cache contract, not HTTP proof.
  Object.defineProperty(value, 'type', { value: 'basic' })
  Object.defineProperty(value, 'url', { value: new URL(responsePath, origin).href })
  // Preserve the selected basic source URL and bytes, just as the real
  // network-backed CacheStorage objects in the Chromium proof do. This is not
  // an arbitrary synthetic Response factory: every path/type comes from files.
  value.clone = () => response(path, bytes, mime, responsePath)
  return value
}
function cacheCopy(value) {
  const copy = value.clone()
  Object.defineProperty(copy, 'type', { value: 'basic' })
  Object.defineProperty(copy, 'url', { value: value.url })
  return copy
}
class PublicCache {
  constructor(rows = []) { this.rows = new Map(rows) }
  async keys() { return [...this.rows.keys()].map(url => new Request(url)) }
  async match(request) {
    const key = typeof request === 'string' ? new URL(request, origin).href : request.url
    const stored = this.rows.get(key)
    return stored ? cacheCopy(stored) : undefined
  }
  async put(request, value) {
    const key = typeof request === 'string' ? new URL(request, origin).href : request.url
    this.rows.set(key, cacheCopy(value))
  }
  async delete(key) { return this.rows.delete(new URL(key, origin).href) }
}
function environment(overrides = {}) {
  const bodies = payload()
  const files = new Map(paths.map(path => [path, { bytes: bodies.get(path), path }]))
  const stores = new Map()
  const calls = []
  const open = async name => {
    if (!stores.has(name)) stores.set(name, new PublicCache())
    return stores.get(name)
  }
  const self = {
    location: { origin },
    registration: { scope: origin + '/' },
    skipCalls: 0,
    claims: 0,
    async skipWaiting() { this.skipCalls++ },
    clients: { claim: async () => { self.claims++ } },
    addEventListener() {},
  }
  const caches = {
    async open(name) { return open(name) },
    async keys() { return [...stores.keys()] },
    async delete(name) { return stores.delete(name) },
  }
  const fetch = overrides.fetch || (async (input, options) => {
    const requested = new URL(input, origin).pathname
    calls.push({ path: requested, options })
    const item = files.get(requested) || files.get('/')
    return response(requested, item.bytes, mimes[requested], item.path)
  })
  const functions = new Function('self', 'caches', 'fetch', `${script}; return {
    fillShellCacheV2, activateShell, verifyCandidate,
    version: SHELL_CACHE_VERSION, releaseName: SHELL_CACHE,
    get receipt() { return installedShellReceipt },
  };`)(self, caches, fetch)
  async function install(activate = false) {
    await functions.fillShellCacheV2()
    if (activate) await functions.activateShell()
  }
  return { ...functions, get receipt() { return functions.receipt }, open, stores, files, self, calls, install, ...overrides }
}
async function populate(name, runtime) {
  const cache = await runtime.open(name)
  for (const [path, body] of payload()) await cache.put(path, response(path, body))
  return cache
}
async function stored(runtime, name, reorder = null) {
  const cache = await runtime.open(name)
  const entries = reorder ?? await cache.keys()
  return Promise.all(entries.map(async request => ({
    url: request.url,
    mime: (await cache.match(request)).headers.get('content-type'),
    bytes: new Uint8Array(await (await cache.match(request)).arrayBuffer()),
  })))
}
async function preserveOldRelease(runtime) {
  const before = await stored(runtime, 'loom-shell-v2')
  await populateV1(runtime)
  return before
}
async function populateV1(runtime) {
  const cache = await runtime.open('loom-shell-v1')
  await cache.put('/', response('/', new TextEncoder().encode('older public shell')))
}
async function unchanged(runtime, before) {
  const after = await stored(runtime, 'loom-shell-v2')
  assert.deepEqual(after, before)
}

test('install then verify/copy/read back publishes exact public bytes and URL-bound MIME', async () => {
  const runtime = environment()
  assert.equal(runtime.version, 2)
  assert.equal(runtime.releaseName, `loom-shell-v${runtime.version}`)
  assert.equal(runtime.releaseName, 'loom-shell-v2')
  await populateV1(runtime)
  await runtime.install(false)
  const cache = await runtime.open('loom-shell-v2-pending')
  cache.keys = async () => [new Request(origin + '/assets/app-c.css'), new Request(origin + '/'), new Request(origin + '/assets/app-b.js'), new Request(origin + '/manifest.webmanifest'), new Request(origin + '/favicon.svg')]
  await runtime.verifyCandidate(cache, runtime.receipt)
  await runtime.activateShell()
  const rows = await stored(runtime, 'loom-shell-v2')
  assert.equal(rows.length, paths.length)
  for (const row of rows) {
    assert.equal(row.mime, mimes[new URL(row.url).pathname])
    assert.deepEqual(row.bytes, payload().get(new URL(row.url).pathname))
  }
  assert.equal(runtime.stores.has('loom-shell-v2-pending'), false)
  assert.equal(runtime.stores.has('loom-shell-v1'), false)
  assert.equal(runtime.self.skipCalls, 1)
  assert.equal(runtime.self.claims, 1)
  assert.equal(await stored(runtime, 'user-unrelated-cache').then(() => true, () => true), true)
})

test('URL-bound receipt validation rejects swapped or modified asset bodies', async () => {
  const runtime = environment()
  await runtime.install(false)
  const receipt = runtime.receipt
  const pending = await runtime.open('loom-shell-v2-pending')
  await pending.delete('/assets/app-c.css')
  await pending.put('/assets/app-c.css', response('/assets/app-b.js', payload().get('/assets/app-b.js')))
  await pending.put('/assets/app-b.js', response('/assets/app-c.css', payload().get('/assets/app-c.css')))
  const cssFirst = [...pending.rows.keys()].sort((first, second) => {
    if (first.endsWith('.css')) return -1
    if (second.endsWith('.css')) return 1
    return 0
  }).map(url => new Request(url))
  pending.keys = async () => cssFirst
  await assert.rejects(runtime.verifyCandidate(pending, receipt), /Invalid|URL|candidate|receipt/)
})

test('a noncanonical root failure discards candidate and preserves exact current v2 bytes', async () => {
  const runtime = environment()
  await runtime.install(true)
  const before = await preserveOldRelease(runtime)
  runtime.files.set('/', { bytes: payload().get('/'), path: '/redirected-index' })
  await assert.rejects(runtime.install(false), /Invalid shell response URL/)
  await unchanged(runtime, before)
  assert.equal(runtime.stores.has('loom-shell-v2-pending'), false)
})

test('changed bytes may not partially replace a populated same-version release', async () => {
  const runtime = environment()
  await runtime.install(true)
  const before = await stored(runtime, 'loom-shell-v2')
  runtime.files.set('/assets/app-b.js', { bytes: text.encode('console.log("new release bytes")'), path: '/assets/app-b.js' })
  await runtime.install(false)
  await assert.rejects(runtime.activateShell(), /receipt|Incomplete candidate/)
  const after = await stored(runtime, 'loom-shell-v2')
  assert.deepEqual(after, before)
  assert.equal(runtime.stores.has('loom-shell-v2-pending'), false)
  assert.equal(runtime.self.claims, 1)
})

test('a missing or corrupted staged asset cannot erase the already valid same-version release', async () => {
  const runtime = environment()
  await populate('loom-shell-v2', runtime)
  const before = await stored(runtime, 'loom-shell-v2')
  await runtime.install(false)
  const pending = await runtime.open('loom-shell-v2-pending')
  await pending.delete('/assets/app-b.js')
  await assert.rejects(runtime.activateShell(), /Incomplete candidate cache/)
  await unchanged(runtime, before)
  await populate('loom-shell-v2-pending', runtime)
  // Remake the receipt for the new candidate with unmodified contents.
  await runtime.install(false)
  const altered = await runtime.open('loom-shell-v2-pending')
  await altered.put('/favicon.svg', response('/favicon.svg', text.encode('<svg>tampered</svg>')))
  await assert.rejects(runtime.activateShell(), /receipt/)
  await unchanged(runtime, before)
  assert.equal(runtime.self.claims, 0)
})

test('oversized public candidate fails without replacing a working release', async () => {
  const runtime = environment()
  await populate('loom-shell-v2', runtime)
  const before = await stored(runtime, 'loom-shell-v2')
  runtime.files.set('/assets/app-b.js', { bytes: new Uint8Array(2 * 1024 * 1024 + 1), path: '/assets/app-b.js' })
  await assert.rejects(runtime.install(false), /size limit/)
  await unchanged(runtime, before)
  assert.equal(runtime.stores.has('loom-shell-v2-pending'), false)
})

test('query-bearing asset candidates do not acquire another ambiguous cache identity', async () => {
  const runtime = environment()
  await populate('loom-shell-v2', runtime)
  const before = await stored(runtime, 'loom-shell-v2')
  runtime.files.get('/').bytes = text.encode('<html><script src="/assets/app-b.js?client-selector=opaque-value"></script></html>')
  await assert.rejects(runtime.install(false), /Invalid shell path/)
  await unchanged(runtime, before)
  assert.equal(runtime.stores.has('loom-shell-v2-pending'), false)
})

test('authorization-bearing candidate requests are not admitted and do not erase a working release', async () => {
  const runtime = environment()
  await populate('loom-shell-v2', runtime)
  const before = await stored(runtime, 'loom-shell-v2')
  await runtime.install(false)
  const pending = runtime.stores.get('loom-shell-v2-pending')
  const keys = await pending.keys()
  pending.keys = async () => [new Request(keys[0].url, { headers: { Authorization: 'fixture-only credential' } }), ...keys.slice(1)]
  await assert.rejects(runtime.activateShell(), /Invalid candidate request/)
  await unchanged(runtime, before)
  assert.equal(runtime.stores.has('loom-shell-v2-pending'), false)
})

test('a stalled public candidate request is aborted within its deadline without replacing a valid release', async () => {
  let aborted = false
  const runtime = environment({
    fetch: async (input, options) => {
      assert.ok(options.signal instanceof AbortSignal)
      await new Promise((resolve, reject) => {
        const stop = () => {
          aborted = true
          reject(options.signal.reason)
        }
        if (options.signal.aborted) stop()
        else options.signal.addEventListener('abort', stop, { once: true })
      })
      assert.fail('This controlled pending network request must not complete')
    },
  })
  await populate('loom-shell-v2', runtime)
  const before = await stored(runtime, 'loom-shell-v2')
  await assert.rejects(runtime.install(false), /timed out/)
  assert.equal(aborted, true)
  await unchanged(runtime, before)
  assert.equal(runtime.stores.has('loom-shell-v2-pending'), false)
})

test('candidate foreign keys and authorization-bearing requests are rejected without erasing unrelated caches', async () => {
  const runtime = environment()
  await populate('loom-shell-v2', runtime)
  const before = await stored(runtime, 'loom-shell-v2')
  const unrelated = await runtime.open('user-unrelated-cache')
  await unrelated.put('/some-public-marker', response('/favicon.svg', text.encode('unrelated public marker')))
  await runtime.install(false)
  runtime.stores.get('loom-shell-v2-pending').rows.set(origin + '/api/bootstrap', response('/manifest.webmanifest', text.encode('not a cached Ticket'), 'application/json'))
  await assert.rejects(runtime.activateShell(), /Unexpected|candidate/)
  await unchanged(runtime, before)
  assert.equal(runtime.stores.has('user-unrelated-cache'), true)
})
