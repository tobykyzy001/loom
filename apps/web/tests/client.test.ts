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
})
