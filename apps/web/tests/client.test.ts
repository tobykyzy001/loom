import { describe, expect, it, vi } from 'vitest'
import { ApiError, LoomClient } from '../src/api/client'

async function catchApiError(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; throw new Error('Expected a rejected request') }
  catch (error) { expect(error).toBeInstanceOf(ApiError); return error as ApiError }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('LoomClient protocol and credential boundaries', () => {
  it('sends the configured user token and JSON for structured operations', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: 'ticket-id', status: 'pending' }))
    const client = new LoomClient({ fetch, token: () => ' only-from-user ' })
    await client.post('/tickets', { project_id: 'project-id', objective: '任务', kind: 'read_summary' })
    expect(fetch).toHaveBeenCalledOnce()
    const [path, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/v1/tickets')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer only-from-user')
    expect(JSON.parse(init.body as string).project_id).toBe('project-id')
  })

  it('never invents a bearer credential', async () => {
    const fetch = vi.fn().mockResolvedValue(json([]))
    await new LoomClient({ fetch, token: () => '' }).get('/projects')
    const [, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init.headers).get('Authorization')).toBeNull()
  })

  it('returns backend error code and message without relabeling it success', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ error: { code: 'lease_expired', message: '执行租约已过期。' } }, 409))
    const error = await catchApiError(new LoomClient({ fetch, token: () => 'token' }).post('/tickets/id/cancel'))
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('lease_expired')
    expect(error.message).toBe('执行租约已过期。')
    expect(error.status).toBe(409)
  })

  it('gives actionable errors for expired credentials and offline coordinators', async () => {
    const expired = await catchApiError(new LoomClient({ fetch: vi.fn().mockResolvedValue(json({ error: { code: 'unauthorized', message: 'expired' } }, 401)), token: () => 'expired' }).get('/tickets'))
    expect(expired.status).toBe(401)
    expect(expired.message).toBe('expired')
    const offline = await catchApiError(new LoomClient({ fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')), token: () => 'token' }).get('/tickets'))
    expect(offline.status).toBe(0)
    expect(offline.code).toBe('network_error')
  })

  it('rejects malformed success responses rather than accepting arbitrary content', async () => {
    const response = new Response('<script>not-json</script>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    const error = await catchApiError(new LoomClient({ fetch: vi.fn().mockResolvedValue(response), token: () => 'token' }).get('/tickets'))
    expect(error.code).toBe('invalid_content_type')
  })

  it('uses URI-encoded ticket and artifact IDs', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ metadata: {}, content: 'file contents' }))
    const errorClient = new LoomClient({ fetch, token: () => 'token' })
    await errorClient.get(`/tickets/${encodeURIComponent('id/other')}/artifacts/${encodeURIComponent('artifact id')}`)
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/tickets/id%2Fother/artifacts/artifact%20id')
  })

  it('does not validate the replaced credential result or old 401 as current workspace data', async () => {
    let epoch = 1
    let release!: (value: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    const fetch = vi.fn().mockImplementation(async () => pending)
    const client = new LoomClient({ fetch, token: () => 'initial-credential', credentialEpoch: () => epoch })
    const read = client.get('/tickets')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    epoch++
    release(json({ tickets: [{ id: 'old-data' }] }))
    const superseded = await catchApiError(read)
    expect(superseded.code).toBe('credential_epoch_changed')
    expect(superseded.status).toBe(0)

    let failed!: (value: Response) => void
    const unauthorizing = new Promise<Response>(resolve => { failed = resolve })
    fetch.mockImplementation(async () => unauthorizing)
    const unauthenticated = client.get('/projects')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    epoch++
    failed(json({ error: { code: 'unauthorized', message: 'stale token' } }, 401))
    expect((await catchApiError(unauthenticated)).code).toBe('credential_epoch_changed')
  })

  it('also rejects a read when the underlying stored token changed without an explicit epoch', async () => {
    let epoch = 3
    let token = 'stored-before-rotation'
    let finish!: (response: Response) => void
    const changed = new Promise<Response>(resolve => { finish = resolve })
    const client = new LoomClient({ token: () => token, credentialEpoch: () => epoch,
      fetch: vi.fn().mockImplementation(async () => changed) })
    const read = client.get('/projects')
    await new Promise(resolve => setTimeout(resolve, 0))
    token = 'stored-by-another-tab'
    finish(json({ projects: [] }))
    await expect(read).rejects.toMatchObject({ code: 'credential_epoch_changed', status: 0 })
  })

  it('preserves epoch invalidation when the credential changes while decoding JSON', async () => {
    let token = 'before-decode'
    const response = json({ tickets: [{ id: 'older-owned-snapshot' }] })
    response.json = async () => {
      token = 'changed-during-json-decode'
      return { tickets: [{ id: 'older-owned-snapshot' }] }
    }
    const client = new LoomClient({ token: () => token, credentialEpoch: () => 4, fetch: vi.fn().mockResolvedValue(response) })
    await expect(client.get('/tickets')).rejects.toMatchObject({ code: 'credential_epoch_changed', status: 0 })
  })

  it('rejects a superseded response only when a condition-specific read-only POST asks for freshness', async () => {
    let epoch = 1
    let finish!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { finish = resolve })
    const client = new LoomClient({ token: () => 'before', credentialEpoch: () => epoch, fetch: vi.fn().mockResolvedValue(pending) })
    const evaluation = client.post('/placement/evaluate', { scope: 'bounded' }, { requireCurrentCredential: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    epoch++
    finish(json({ schema: 'loom.inventory.v1' }))
    await expect(evaluation).rejects.toMatchObject({ code: 'credential_epoch_changed' })
  })

  it('preserves accepted ordinary writes even when the credential epoch changes later', async () => {
    let epoch = 1
    const client = new LoomClient({ token: () => 'before', credentialEpoch: () => epoch, fetch: vi.fn().mockImplementation(async () => { epoch++; return json({ accepted: true }) }) })
    await expect(client.post('/tickets/id/cancel')).resolves.toMatchObject({ accepted: true })
  })

  it('bounds stalled reads explicitly without modifying task state, auto-retrying or inferring grant status', async () => {
    const fetch = vi.fn().mockImplementation(async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Bounded fixture read timed out', 'TimeoutError')), { once: true })
    }))
    const client = new LoomClient({ token: () => 'synthetic', fetch, readTimeoutMs: 5 })
    const failure = await catchApiError(client.get('/grants'))
    expect(failure).toMatchObject({ code: 'read_timeout', status: 0 })
    expect(failure.message).toContain('不据此改变 Grant 或任务状态')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not attach an automatic timeout to remote POST effects when caller has not provided one', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ accepted: true }))
    const client = new LoomClient({ fetch, token: () => 'synthetic' })
    await client.post('/tickets', { objective: 'write test' })
    expect(fetch.mock.calls[0][1].signal).toBeUndefined()
  })

  it('keeps a real accepted write receipt when credentials change, without inventing a rollback', async () => {
    let epoch = 0
    let release!: (value: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    const result = new LoomClient({ fetch: vi.fn().mockImplementation(async () => pending), token: () => 'operator', credentialEpoch: () => epoch })
      .post('/tickets/ticket-1/cancel', {})
    await new Promise(resolve => setTimeout(resolve, 0))
    epoch++
    release(json({ status: 'cancel_requested', effect_outcome: 'still_unresolved' }))
    await expect(result).resolves.toEqual({ status: 'cancel_requested', effect_outcome: 'still_unresolved' })
  })
})
