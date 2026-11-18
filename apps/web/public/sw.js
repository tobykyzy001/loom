'use strict'

const SHELL_CACHE_VERSION = 2
const SHELL_CACHE = `loom-shell-v${SHELL_CACHE_VERSION}`
const PENDING_SHELL_CACHE = `${SHELL_CACHE}-pending`
const SHELL_PREFIX = 'loom-shell-'
let installedShellReceipt = null
const SHELL_PATH = '/'
const PUBLIC_SHELL_FILES = ['/manifest.webmanifest', '/favicon.svg']
const MAX_PUBLIC_RESPONSE_BYTES = 2 * 1024 * 1024
const PUBLIC_CONTENT_TYPES = {
  manifest: /^application\/(?:manifest\+json|json)(?:\s*;|\s*$)/i,
  favicon: /^image\/svg\+xml(?:\s*;|\s*$)/i,
  javascript: /^(?:text|application)\/javascript(?:\s*;|\s*$)/i,
  stylesheet: /^text\/css(?:\s*;|\s*$)/i,
}

function isBasicSuccess(response) {
  return response && response.type === 'basic' && response.status === 200
}

function isHtmlResponse(response) {
  if (!isBasicSuccess(response)) return false
  const contentType = response.headers.get('Content-Type') || ''
  return /^text\/html(?:\s*;|\s*$)/i.test(contentType)
}

function isPublicResponse(response, pathname) {
  return isBasicSuccess(response) && expectedContentType(pathname).test(response.headers.get('Content-Type') || '')
}

function shellKey(pathname) {
  return new URL(pathname, self.location.origin).href
}

function staticPath(pathname) {
  return pathname === '/manifest.webmanifest' || pathname === '/favicon.svg' || isHashedAssetPath(pathname)
}

function isHashedAssetPath(pathname) {
  return /^\/assets\/[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]+\.(?:js|mjs|css)$/i.test(pathname)
}

function expectedContentType(pathname) {
  if (pathname === '/manifest.webmanifest') return PUBLIC_CONTENT_TYPES.manifest
  if (pathname === '/favicon.svg') return PUBLIC_CONTENT_TYPES.favicon
  if (/\.css$/i.test(pathname)) return PUBLIC_CONTENT_TYPES.stylesheet
  return PUBLIC_CONTENT_TYPES.javascript
}

function isAssetReference(tagUrl) {
  if (!tagUrl || tagUrl.startsWith('//') || !/[/]assets\//.test(tagUrl)) return false
  if (/^\s*\\/i.test(tagUrl)) return false
  const asset = new URL(tagUrl, self.registration.scope)
  if (asset.origin !== self.location.origin || asset.username || asset.password || asset.hash) return false
  return isHashedAssetPath(asset.pathname)
}

function referencedAssets(html) {
  const assets = new Set()
  const tagPattern = /<(?:script|link)\b[^>]*>/gi
  let tag
  while ((tag = tagPattern.exec(html)) !== null) {
    const attribute = /(?:^|\s)(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag[0])
    if (!attribute) continue
    const tagUrl = attribute[2] || attribute[3] || attribute[4] || ''
    if (isAssetReference(tagUrl)) {
      const asset = new URL(tagUrl, self.registration.scope)
      assets.add(asset.pathname + asset.search)
    }
  }
  return Array.from(assets)
}

async function putHtml(cache, response) {
  if (!isHtmlResponse(response)) return false
  const originalUrl = response.url ? new URL(response.url) : null
  if (!originalUrl || originalUrl.href !== shellKey(SHELL_PATH) ||
      originalUrl.username || originalUrl.password) return false
  const html = new TextDecoder('utf-8', { fatal: true }).decode(await readPublicBytes(response))
  if (!/<html[\s>]/i.test(html)) return false
  // Preserve the actual same-origin response and its source URL. A synthesized
  // Response loses that provenance and cannot pass the next candidate read-back.
  await cache.put(shellKey(SHELL_PATH), response.clone())
  return true
}

function expectedShellUrl(path) {
  const url = new URL(shellKey(path))
  if (url.origin !== self.location.origin || url.username || url.password || url.hash || url.search ||
      url.pathname.startsWith('/api/') || url.pathname === '/api') {
    throw new Error('Invalid shell path')
  }
  return url
}

function isExactResponseUrl(response, expected) {
  if (!response.url) return false
  let url
  try {
    url = new URL(response.url)
  } catch {
    return false
  }
  return url.href === expected.href && !url.username && !url.password
}

async function readPublicBytes(response) {
  const stream = response?.clone().body
  if (!stream) throw new Error('Public shell response has no readable body')
  const reader = stream.getReader()
  const chunks = []
  let size = 0
  let complete = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        complete = true
        break
      }
      size += value.byteLength
      if (size > MAX_PUBLIC_RESPONSE_BYTES) throw new Error('Public shell response exceeds the size limit')
      chunks.push(value)
    }
  } finally {
    // A clone branch's cancel can remain pending while its other branch is
    // deliberately retained for CacheStorage. Do not deadlock candidate exit
    // awaiting it; the original fetch is aborted below on this failure too.
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function bytesDigest(bytes) {
  return crypto.subtle.digest('SHA-256', bytes)
    .then(hash => [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''))
}

async function responseDigest(response) {
  return bytesDigest(await readPublicBytes(response))
}

function receiptDigestKey(path) {
  const url = expectedShellUrl(path)
  return url.pathname + url.search
}

async function readValidatedHtml(response) {
  if (!isHtmlResponse(response) || !isExactResponseUrl(response, expectedShellUrl(SHELL_PATH))) {
    throw new Error('Invalid app-shell document')
  }
  const html = new TextDecoder('utf-8', { fatal: true }).decode(await readPublicBytes(response))
  if (!/<html[\s>]/i.test(html)) throw new Error('Invalid app-shell document')
  return html
}

async function shellReceipt(html, responses) {
  const digests = {}
  for (const { path, bytes } of responses) {
    digests[receiptDigestKey(path)] = await bytesDigest(bytes)
  }
  // The ephemeral handoff concerns public path and digest metadata alone.
  return Object.freeze({
    paths: Object.freeze([...referencedAssets(html), ...PUBLIC_SHELL_FILES, SHELL_PATH]),
    digests: Object.freeze(digests),
  })
}

function receiptPaths(receipt) {
  let paths
  try {
    paths = receipt.paths.map(path => expectedShellUrl(path).href)
  } catch {
    throw new Error('Invalid shell receipt')
  }
  const rootCount = receipt.paths.filter(path => path === SHELL_PATH).length
  if (rootCount !== 1 || paths.length !== new Set(paths).size ||
      receipt.paths.some(path => {
        if (path !== SHELL_PATH && !staticPath(new URL(shellKey(path)).pathname)) return true
        return typeof receipt.digests?.[receiptDigestKey(path)] !== 'string'
      })) {
    throw new Error('Invalid shell receipt')
  }
  return paths
}

async function verifyPublicResponse(response, path) {
  if (!response) throw new Error('Missing shell response')
  const expected = expectedShellUrl(path)
  if (!isExactResponseUrl(response, expected) || !isBasicSuccess(response)) {
    throw new Error('Invalid shell response URL')
  }
  if (expected.pathname === SHELL_PATH) {
    const html = await readValidatedHtml(response)
    return referencedAssets(html)
  }
  if (!staticPath(expected.pathname) || !isPublicResponse(response, expected.pathname)) {
    throw new Error('Invalid public shell response')
  }
  return null
}

async function fetchShellCandidate(cache) {
  // A plain same-origin GET is sufficient; no service-worker Request.cache
  // workaround is substituted for the explicit response validation below.
  // Abort actually stops a stalled fetch/stream; candidate rejection cannot
  // delete an already working release. The deadline applies to each read,
  // not to any authorization/work deadline for an external agent.
  const readOne = async path => {
    const deadline = new AbortController()
    const timeout = setTimeout(() => deadline.abort(new Error('Shell candidate request timed out')), 15000)
    try {
      const response = await fetch(expectedShellUrl(path).href, {
        credentials: 'same-origin',
        signal: deadline.signal,
      })
      await verifyPublicResponse(response, path)
      const bytes = await readPublicBytes(response)
      return { path, response, bytes }
    } catch (error) {
      deadline.abort(error)
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
  const responses = []
  // Fully read one source before advancing, keeping a bounded candidate
  // stream resident and allowing the next response to make progress.
  const root = await readOne(SHELL_PATH)
  const html = await readValidatedHtml(root.response)
  for (const path of [...referencedAssets(html), ...PUBLIC_SHELL_FILES]) {
    responses.push(await readOne(path))
  }
  const receipt = await shellReceipt(html, [root, ...responses])
  for (const { path, response } of [root, ...responses]) {
    await cache.put(shellKey(path), response.clone())
  }
  // The original basic 200 responses retain their type and URL in CacheStorage.
  return receipt
}

async function fillShellCacheV2() {
  // Do not delete a prior working release or the just-filled new release here.
  const pendingDeleted = await caches.delete(PENDING_SHELL_CACHE)
  if (!pendingDeleted) await deletePendingShell()
  let candidate
  try {
    candidate = await caches.open(PENDING_SHELL_CACHE)
  } catch (error) {
    await deletePendingShell()
    throw error
  }
  try {
    const receipt = await fetchShellCandidate(candidate)
    // Candidate validation covers the exact complete set before skipWaiting.
    await verifyCandidate(candidate, receipt)
    installedShellReceipt = receipt
  } catch (error) {
    try {
      await deletePendingShell()
    } catch {
      // Preserve the original install rejection; do not assert cleanup finished.
    }
    installedShellReceipt = null
    // Remain fail-closed without treating network/SDK cancellation as a completed Task state.
    throw error
  }
  await self.skipWaiting()
}

// Every URL's basic 200 response, MIME, bounded public bytes, and digest are
// checked against the receipt. Entries are copied independently; no OS-atomic
// multi-entry transaction is implied. A same-version update also has its own
// validation/read-back boundary before it may claim to control the shell.
async function verifyCandidate(cache, receipt) {
  const expected = receiptPaths(receipt)
  const keys = await cache.keys()
  const entries = await Promise.all(keys.map(async request => {
    const response = await cache.match(request)
    return { request, response }
  }))
  const seen = new Set()
  let rootHtml = null
  for (const { request, response } of entries) {
    if (request.method !== 'GET' || request.headers.has('Authorization')) {
      throw new Error('Invalid candidate request')
    }
    const requestUrl = new URL(request.url)
    const match = requestUrl.origin === self.location.origin && !requestUrl.username && !requestUrl.password &&
      !requestUrl.hash && expected.includes(requestUrl.href) ? requestUrl.href : null
    if (!match || seen.has(match)) throw new Error('Unexpected or duplicate candidate entry')
    const assetPaths = await verifyPublicResponse(response, match)
    if (await responseDigest(response) !== receipt.digests[receiptDigestKey(match)]) {
      throw new Error('Candidate body differs from its receipt')
    }
    if (assetPaths !== null) {
      if (rootHtml !== null) throw new Error('Duplicate candidate root')
      rootHtml = new TextDecoder('utf-8', { fatal: true }).decode(await readPublicBytes(response))
    }
    seen.add(match)
  }
  if (seen.size !== expected.length || rootHtml === null) throw new Error('Incomplete candidate cache')
  const paths = referencedAssets(rootHtml).sort()
  const expectedAssets = receipt.paths.filter(path => path !== SHELL_PATH && isHashedAssetPath(new URL(shellKey(path)).pathname)).sort()
  if (paths.length !== expectedAssets.length || paths.some((path, index) => path !== expectedAssets[index])) {
    throw new Error('Root does not match candidate assets')
  }
}

async function deletePendingShell() {
  const names = await caches.keys()
  if (!names.includes(PENDING_SHELL_CACHE)) return
  if (!await caches.delete(PENDING_SHELL_CACHE)) throw new Error('Could not remove pending shell cache')
}

async function publishCandidate(candidate, target, receipt) {
  const expected = receiptPaths(receipt)
  // Both actual caches were enumerated above: foreign/API entries, aliases,
  // wrong queries, and extras are rejected rather than silently ignored.
  for (const path of expected) {
    const response = await candidate.match(path)
    const assets = await verifyPublicResponse(response, path)
    if (await responseDigest(response) !== receipt.digests[receiptDigestKey(path)]) {
      throw new Error('Publication body differs from its receipt')
    }
    if (assets !== null) {
      const actual = referencedAssets(new TextDecoder('utf-8', { fatal: true }).decode(await readPublicBytes(response))).sort()
      const expectedAssets = receipt.paths.filter(item => item !== SHELL_PATH && isHashedAssetPath(new URL(shellKey(item)).pathname)).sort()
      if (actual.length !== expectedAssets.length || actual.some((item, index) => item !== expectedAssets[index])) {
        throw new Error('Publication root changed from candidate')
      }
    }
    // One explicit request/Response copy per URL; no cache.addAll or copying
    // an arbitrary whole cache is treated as an atomic operation.
    await target.put(path, response.clone())
  }
  return target
}

async function activateShell() {
  // A restarted worker without this in-memory receipt fails closed rather than
  // treating an arbitrary cache as release authority.
  if (!installedShellReceipt) throw new Error('Missing installed shell receipt')
  const names = await caches.keys()
  const candidate = await caches.open(PENDING_SHELL_CACHE)
  try {
    // Verify actual pending CacheStorage immediately before publication.
    await verifyCandidate(candidate, installedShellReceipt)
    const target = await caches.open(SHELL_CACHE)
    // Publish only into an empty release namespace. A nonempty same-version
    // release is immutable: its full source and bytes must match this candidate.
    // Otherwise a later update must use a new version, not damage the current
    // release by writing first and discovering mismatches after copying.
    if ((await target.keys()).length === 0) {
      await publishCandidate(candidate, target, installedShellReceipt)
    }
    await verifyCandidate(target, installedShellReceipt)
    installedShellReceipt = null
  } catch (error) {
    // A failed new copy may not overwrite or delete the release this existing
    // worker still depends on. `skipWaiting` is not promotion until read-back
    // succeeds. Pending entries alone are discarded here; CacheStorage cannot
    // promise an OS-atomic multi-entry rollback or allocation transaction.
    const cleanupErrors = []
    try { await deletePendingShell() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
    installedShellReceipt = null
    // Pending alone is cleaned here; a failed candidate must not erase the current release.
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], 'Shell publication and cleanup failed')
    }
    throw error
  }
  // Promotion means all expected target read-backs have verified, so this
  // worker knows it did not publish half a candidate. If mandatory pending
  // cleanup fails, activate rejects without claiming; the old release remains.
  // Only then may older exact loom-shell-v<N> namespaces be removed; unrelated
  // caches, other domains, current v2, and newer releases are never matched.
  if (!names.includes(PENDING_SHELL_CACHE) || !await caches.delete(PENDING_SHELL_CACHE)) {
    installedShellReceipt = null
    throw new Error('Could not discard verified pending cache')
  }
  const oldNames = names.filter(name => {
    if (!name.startsWith(SHELL_PREFIX) || name === SHELL_CACHE || name === PENDING_SHELL_CACHE) return false
    return /^loom-shell-v\d+$/.test(name) && Number(name.slice(`${SHELL_PREFIX}v`.length)) < SHELL_CACHE_VERSION
  })
  for (const name of oldNames) {
    if (!await caches.delete(name)) throw new Error(`Could not delete old shell cache: ${name}`)
  }
  await self.clients.claim()
}

self.addEventListener('install', event => {
  event.waitUntil(fillShellCacheV2())
})

self.addEventListener('activate', event => {
  event.waitUntil(activateShell())
})

self.addEventListener('fetch', event => {
  const request = event.request
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  // Never intercept application data, bearer-backed calls, or foreign-origin traffic.
  if (url.origin !== self.location.origin || request.method !== 'GET' ||
      request.headers.has('Authorization') || url.pathname === '/api' || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE)
      try {
        const response = await fetch(request)
        if (isHtmlResponse(response)) await putHtml(cache, response)
        return response
      } catch {
        const cached = await cache.match(shellKey(SHELL_PATH))
        if (cached) return cached
        return new Response('Offline app shell is unavailable. Connect online for the first load.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
    })())
    return
  }

  if (!staticPath(url.pathname)) return
  const cacheKey = shellKey(url.pathname) + url.search
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE)
    const cached = await cache.match(cacheKey)
    if (cached) return cached
    const response = await fetch(request)
    if (isPublicResponse(response, url.pathname)) {
      if (url.pathname === '/manifest.webmanifest' || url.pathname === '/favicon.svg') {
        const finalUrl = response.url ? new URL(response.url) : null
        if (finalUrl && finalUrl.origin === self.location.origin && finalUrl.pathname === url.pathname &&
            finalUrl.search === url.search && !finalUrl.username && !finalUrl.password) {
          await cache.put(cacheKey, response.clone())
        }
      } else if (isHashedAssetPath(url.pathname)) {
        // Only Vite's content-addressed build output is eligible for cache-first storage.
        await cache.put(cacheKey, response.clone())
      }
    }
    return response
  })())
})
