'use strict'

const SHELL_CACHE = 'loom-shell-v1'
const SHELL_PREFIX = 'loom-shell-'
const SHELL_PATH = '/'
const PUBLIC_SHELL_FILES = ['/manifest.webmanifest', '/favicon.svg']
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
  if (originalUrl && (originalUrl.origin !== self.location.origin || originalUrl.pathname !== SHELL_PATH ||
      originalUrl.username || originalUrl.password)) return false
  const html = await response.clone().text()
  if (!/<html[\s>]/i.test(html)) return false
  await cache.put(shellKey(SHELL_PATH), new Response(html, {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }))
  return true
}

async function fillShellCache() {
  const cache = await caches.open(SHELL_CACHE)
  const indexResponse = await fetch(new Request(shellKey(SHELL_PATH), {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
  }))
  if (!isHtmlResponse(indexResponse)) throw new Error('Invalid app-shell document')
  const html = await indexResponse.clone().text()
  if (!/<html[\s>]/i.test(html)) throw new Error('Invalid app-shell document')

  const paths = referencedAssets(html)
  const responses = await Promise.all(paths.concat(PUBLIC_SHELL_FILES).map(async path => {
    const response = await fetch(new Request(shellKey(path), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    }))
    const pathname = new URL(path, self.location.origin).pathname
    if (!isPublicResponse(response, pathname)) {
      throw new Error('Invalid public shell response')
    }
    const finalUrl = response.url ? new URL(response.url) : null
    if (finalUrl && (finalUrl.origin !== self.location.origin || finalUrl.pathname !== pathname ||
        finalUrl.search !== new URL(path, self.location.origin).search || finalUrl.username || finalUrl.password)) {
      throw new Error('Unexpected public shell response URL')
    }
    return { path, response }
  }))
  // `cache.addAll` accepts RequestInfo, not these already fetched Responses.
  // Preserve each validated path/body association explicitly, and discard a
  // partial install rather than publishing a shell with missing or invalid assets.
  try {
    for (const { path, response } of responses) await cache.put(shellKey(path), response)
    if (!await putHtml(cache, indexResponse)) throw new Error('Invalid app-shell document')
  } catch (error) {
    await caches.delete(SHELL_CACHE)
    throw error
  }
  await self.skipWaiting()
}

self.addEventListener('install', event => {
  event.waitUntil(fillShellCache())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter(name => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE)
      .map(name => caches.delete(name)))
    await self.clients.claim()
  })())
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
