import type { ApiErrorBody } from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly path: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface LoomClientOptions {
  token: () => string
  fetch?: typeof globalThis.fetch
  /** Optional authentication revision, shared only by this workspace, not a server credential. */
  credentialEpoch?: () => number
  /** Optional upper bound only for read snapshot acquisition, not remote writes. */
  readTimeoutMs?: number
}

export class LoomClient {
  private readonly fetchFn: typeof globalThis.fetch
  constructor(private readonly options: LoomClientOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const epoch = this.options.credentialEpoch?.()
    const read = ['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())
    const token = this.options.token().trim()
    const currentCredential = () => {
      if (read && this.options.credentialEpoch
        && (epoch !== this.options.credentialEpoch() || token !== this.options.token().trim())) {
        throw new ApiError(0, 'credential_epoch_changed', '凭据已更新，这次旧读取的结果不再用于更新工作区。', path)
      }
    }
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    const timeoutMs = this.options.readTimeoutMs ?? 30000
    const signal = init.signal ?? (read && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined)
    if (read && signal) init.signal = signal
    if (init.body) headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)

    let response: Response
    try {
      response = await this.fetchFn(`/api/v1${path}`, { ...init, headers })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ApiError(0, 'read_timeout', '读取超时，未取得新的授权、项目或节点快照；不据此改变 Grant 或任务状态。', path)
      }
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiError(0, 'network_error', '无法连接协调器，请检查服务后再试。', path)
    }

    const contentType = response.headers.get('content-type') ?? ''
    currentCredential()
    if (!response.ok) {
      let code = `http_${response.status}`
      let message = response.status === 401
        ? '令牌无效或已过期。请在连接设置中更新后再试。'
        : response.status === 403
          ? '当前身份无权执行此操作。'
          : `请求未完成（HTTP ${response.status}）。`
      if (contentType.includes('application/json')) {
        try {
          const body = (await response.json()) as Partial<ApiErrorBody>
          if (typeof body.error?.code === 'string') code = body.error.code
          if (typeof body.error?.message === 'string') message = body.error.message
        } catch {
          // The status remains authoritative if the error payload is malformed.
        }
      }
      currentCredential()
      throw new ApiError(response.status, code, message, path)
    }

    if (response.status === 204) return undefined as T
    if (!contentType.includes('application/json')) {
      throw new ApiError(response.status, 'invalid_content_type', '协调器返回了非预期的响应格式。', path)
    }
    try {
      const body = (await response.json()) as T
      currentCredential()
      return body
    } catch (error) {
      if (error instanceof ApiError && error.code === 'credential_epoch_changed') throw error
      throw new ApiError(response.status, 'invalid_json', '协调器返回了无法读取的响应。', path)
    }
  }

  get<T>(path: string, signal?: AbortSignal) {
    return this.request<T>(path, { signal })
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
  }

  put<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' })
  }
}
