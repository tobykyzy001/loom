import { assertObject } from './util.js'

export class LoomHttpError extends Error {
  constructor(status, body, requestId) {
    const detail = body?.error
    super(`Loom HTTP ${status}${detail?.code ? ` ${detail.code}` : ''}${detail?.message ? `: ${detail.message}` : ''}`)
    this.name = 'LoomHttpError'
    this.status = status
    this.code = detail?.code || 'http_error'
    this.requestId = requestId
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500
  }
}

/** Small, dependency-free outbound HTTP core. No client-token fallback for node routes. */
export class LoomHttpClient {
  constructor({ baseUrl, clientToken, fetch: fetcher = globalThis.fetch, timeoutMs = 15_000, maxResponseBytes = 1_048_576 } = {}) {
    if (typeof baseUrl !== 'string') throw new TypeError('baseUrl is required')
    this.baseUrl = new URL(baseUrl)
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)) throw new TypeError('baseUrl must be HTTP(S)')
    this.clientToken = clientToken || ''
    this.fetch = fetcher
    if (typeof this.fetch !== 'function') throw new TypeError('A fetch implementation is required')
    this.timeoutMs = timeoutMs
    this.maxResponseBytes = maxResponseBytes
  }
  async request(method, route, body, { token, noAuth = false, signal, timeoutMs = this.timeoutMs } = {}) {
    if (noAuth && token) throw new TypeError('noAuth cannot be combined with token')
    if (route.startsWith('/api/v1/nodes/') && token === this.clientToken && this.clientToken) {
      throw new Error('Client credential cannot be sent on the node transport')
    }
    if (!/^\/api\/v1\/[A-Za-z0-9/_?&=.-]*$/.test(route)) throw new TypeError('Invalid Loom API route')
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason || new Error('Request cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('Loom HTTP request timed out')), timeoutMs)
    try {
      const response = await this.fetch(new URL(route, this.baseUrl), {
        method, redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(!noAuth && (token || this.clientToken) ? { authorization: `Bearer ${token || this.clientToken}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const content = await response.arrayBuffer()
      if (content.byteLength > this.maxResponseBytes) throw new Error('Loom HTTP response exceeds configured limit')
      const source = new TextDecoder().decode(content)
      let data = null
      if (source) { try { data = JSON.parse(source) } catch { throw new Error('Loom HTTP response is not JSON') } }
      if (!response.ok) throw new LoomHttpError(response.status, data, body?.request_id)
      return data
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  get(route, options) { return this.request('GET', route, undefined, options) }
  post(route, body = {}, options) { assertObject(body, 'body'); return this.request('POST', route, body, options) }
  patch(route, body = {}, options) { assertObject(body, 'body'); return this.request('PATCH', route, body, options) }
}
