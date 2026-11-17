import { assertObject } from './util.js'

/** Read only the configured JSON bytes. Never use a claimed content-length as proof of size. */
async function readJsonBytes(response, { limit, callerSignal, controller }) {
  if (typeof response.body?.getReader !== 'function') return response.arrayBuffer()
  const reader = response.body.getReader()
  const cancelled = () => {
    if (callerSignal?.aborted) throw callerSignal.reason instanceof Error
      ? callerSignal.reason : new Error('Loom HTTP response body read aborted')
    if (controller.signal.aborted) throw controller.signal.reason
  }
  cancelled()
  const stop = async (reason) => {
    try { cancelled() } catch (cause) { reason = cause }
    if (!controller.signal.aborted) controller.abort(reason)
    try { void Promise.resolve(reader.cancel(reason)).catch(() => {}) } catch { /* Cleanup failure never masks the actual primary reason. */ }
    throw reason
  }
  const read = async () => {
    cancelled()
    let aborted
    const whenAborted = new Promise((_, reject) => {
      aborted = () => reject(callerSignal?.aborted ? (callerSignal.reason instanceof Error
        ? callerSignal.reason : new Error('Loom HTTP response body read aborted')) : controller.signal.reason)
      controller.signal.addEventListener('abort', aborted, { once: true })
    })
    try { return await Promise.race([whenAborted, reader.read()]) }
    finally { controller.signal.removeEventListener('abort', aborted) }
  }
  const chunks = []
  let length = 0
  try {
    for (;;) {
      let step
      try { step = await read() } catch (error) { await stop(error) }
      if (!step || typeof step !== 'object' || typeof step.done !== 'boolean') await stop(new Error('Loom HTTP response stream returned an invalid chunk frame'))
      cancelled()
      if (step.done) break
      const value = step.value
      if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
        await stop(new Error('Loom HTTP response stream must contain binary chunks'))
      }
      const chunk = value instanceof ArrayBuffer ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      if (chunk.byteLength > limit - length) await stop(new Error('Loom HTTP response exceeds configured limit'))
      if (chunk.byteLength === 0) {
        // Empty frames are not payload and must not starve the total timeout in a resolved-promise loop.
        await new Promise(resolve => setTimeout(resolve, 0))
        cancelled()
        continue
      }
      chunks.push(chunk)
      length += chunk.byteLength
    }
    cancelled()
  } finally {
    try { reader.releaseLock() } catch { /* Lock release is best effort after abort/stop, never a delivery outcome. */ }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

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
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 0) {
      throw new TypeError('maxResponseBytes must be a non-negative safe integer')
    }
  }
  async request(method, route, body, { token, noAuth = false, signal, timeoutMs = this.timeoutMs } = {}) {
    if (noAuth && token) throw new TypeError('noAuth cannot be combined with token')
    const nodeRoute = route.startsWith('/api/v1/nodes/')
    if (nodeRoute && token === this.clientToken && this.clientToken) {
      throw new Error('Client credential cannot be sent on the node transport')
    }
    const anonymousNodeRoute = ['/api/v1/nodes/challenge', '/api/v1/nodes/register'].includes(route)
    if (nodeRoute && !noAuth && !(typeof token === 'string' && token.trim())) {
      throw new Error('Node transport requires its own nonblank credential; no client-token fallback')
    }
    if (nodeRoute && noAuth && !anonymousNodeRoute) {
      throw new Error('Anonymous node access is restricted to challenge and initial registration')
    }
    if (!/^\/api\/v1\/[A-Za-z0-9/_?&=.-]*$/.test(route)) throw new TypeError('Invalid Loom API route')
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Loom HTTP request aborted before fetch')
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
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Loom HTTP request aborted after fetch')
      const content = await readJsonBytes(response, { limit: this.maxResponseBytes, callerSignal: signal, controller })
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Loom HTTP request aborted while reading the response body')
      if (content.byteLength > this.maxResponseBytes) throw new Error('Loom HTTP response exceeds configured limit')
      const source = new TextDecoder().decode(content)
      let data = null
      if (source) { try { data = JSON.parse(source) } catch { throw new Error('Loom HTTP response is not JSON') } }
      if (!response.ok) throw new LoomHttpError(response.status, data, body?.request_id)
      return data
    } catch (error) {
      // A caller stop remains authoritative even if a reader, custom fetch or cleanup reports another reason.
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Loom HTTP request aborted')
      throw error
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  get(route, options) { return this.request('GET', route, undefined, options) }
  post(route, body = {}, options) { assertObject(body, 'body'); return this.request('POST', route, body, options) }
  patch(route, body = {}, options) { assertObject(body, 'body'); return this.request('PATCH', route, body, options) }
}
