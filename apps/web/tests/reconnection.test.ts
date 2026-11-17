import { afterEach, describe, expect, it, vi } from 'vitest'

const TOKEN_KEY = 'loom.client-token'
const SELECTED_KEY = 'loom.selected-ticket'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

function localStore() {
  const values = new Map<string, string>()
  return { values, window: { localStorage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } } }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function renderPayload(url: string, headers: Headers, oldPrincipal = 'original-personal-profile') {
  const path = new URL(url, 'http://fixture.invalid').pathname
  const name = headers.get('Authorization') === 'Bearer replacement-user' ? 'replacement-personal-profile' : oldPrincipal
  const table: Record<string, unknown> = {
    '/api/v1/bootstrap': { client_api: 'fixture-only', principal: { display_name: name } },
    '/api/v1/projects': { projects: [] }, '/api/v1/tickets': { tickets: [] }, '/api/v1/nodes': { nodes: [] },
    '/api/v1/memories': { memories: [] }, '/api/v1/grants': { grants: [] }, '/api/v1/candidates': { candidates: [] },
    '/api/v1/preferences': { expanded: false, sender_filter: null },
  }
  return table[path] ? json(table[path]) : json({ error: { code: 'unexpected_fixture_route', message: 'Unexpected route' } }, 500)
}
interface ManagedStore { values: Map<string, string>; window: { localStorage: unknown } }
async function setup(storage: ManagedStore, fetch: typeof globalThis.fetch) {
  vi.stubGlobal('window', storage.window)
  vi.stubGlobal('fetch', fetch)
  vi.resetModules()
  return import('../src/state/workspace')
}
function expectAuth(init?: RequestInit) { return new Headers(init?.headers).get('Authorization') }

describe('credential validation must cover nested reads', () => {
  it.each(['preferences', 'audit'])('does not save a candidate_token when /%s fails with 401', async (nested) => {
    const store = localStore()
    store.values.set(TOKEN_KEY, 'previous-user')
    store.values.set(SELECTED_KEY, 'ticket-nested')
    const fixtureTicket = { id: 'ticket-nested', project_id: 'owned-project', objective: 'A retained ticket', kind: 'read_summary', relative_path: 'input.txt', status: 'running', attempt: 1 }
    const tokenUserCalls: string[] = []
    const fetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const path = new URL(String(url), 'http://fixture.invalid').pathname
      if (path === `/api/v1/${nested}`) {
        tokenUserCalls.push(path)
        return json({ error: { code: 'unauthorized', message: 'Client authentication failed' } }, 401)
      }
      if (path === '/api/v1/tickets/ticket-nested') return json(fixtureTicket)
      if (path === '/api/v1/tickets') return json({ tickets: [fixtureTicket] })
      return renderPayload(String(url), new Headers(init?.headers))
    })
    const workspace = await setup(store, fetch)
    expect(await workspace.reconnect('previous-user')).toBe(false)
    const { state } = workspace.useWorkspace()
    expect(state.credentialState).toBe('required')
    expect(store.values.get(TOKEN_KEY)).toBe('previous-user')
    expect(state.connected).toBeNull()
    expect(state.errors.workspace).toContain('凭据已失效')
    expect(tokenUserCalls).toEqual([`/api/v1/${nested}`])
  })
})

describe('authenticated workspace recovery', () => {
  it('settles an older read before a new verified refresh, and cannot let it replace a fresh user view', async () => {
    const store = localStore()
    store.values.set(TOKEN_KEY, 'previous-user')
    let resume!: (value: Response) => void
    const waiting = new Promise<Response>(resolve => { resume = resolve })
    let arrived!: () => void
    const waitingForOld = new Promise<void>(resolve => { arrived = resolve })
    const seen: string[] = []
    const fetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      seen.push(String(url))
      if (expectAuth(init) === 'Bearer previous-user' && String(url).endsWith('/bootstrap')) {
        arrived()
        return waiting
      }
      if (!['Bearer previous-user', 'Bearer replacement-user'].includes(expectAuth(init) ?? '')) return json({ error: { code: 'unauthorized' } }, 401)
      return renderPayload(String(url), new Headers(init?.headers))
    })
    const workspace = await setup(store, fetch)
    const older = workspace.refresh()
    await waitingForOld
    const recovered = workspace.reconnect(' replacement-user ')
    const resolving = Promise.resolve().then(() => resume(renderPayload('/api/v1/bootstrap', new Headers())))
    await older
    expect(await recovered).toBe(true)
    await resolving
    expect(store.values.get(TOKEN_KEY)).toBe('replacement-user')
    const { state } = workspace.useWorkspace()
    expect(state.credentialState).toBe('valid')
    expect(state.connected).toBe(true)
    expect(state.bootstrap?.principal?.display_name).toBe('replacement-personal-profile')
    expect(state.errors.workspace).toBe('')
    expect(seen.filter(url => url.endsWith('/bootstrap')).length).toBe(2)
  })

  it('keeps the old ticket snapshot after failed reauthentication without creating new work or replacing the saved token', async () => {
    const store = localStore()
    store.values.set(TOKEN_KEY, 'previous-user')
    store.values.set(SELECTED_KEY, 'ticket-still-instruction')
    const fetch: typeof globalThis.fetch = vi.fn(async (url, init) => expectAuth(init) === 'Bearer previous-user'
      ? renderPayload(String(url), new Headers(init?.headers)) : json({ error: { code: 'unauthorized', message: 'Client authentication failed' } }, 401))
    const workspace = await setup(store, fetch)
    const { state } = workspace.useWorkspace()
    state.credentialState = 'valid'
    state.ticket = { id: 'ticket-still-instruction', status: 'running' } as (typeof state.ticket)
    state.bootstrap = { principal: { display_name: 'previous-snapshot' } } as (typeof state.bootstrap)
    expect(await workspace.reconnect('wrong-user')).toBe(false)
    expect(state.credentialState).toBe('required')
    expect(state.ticket?.id).toBe('ticket-still-instruction')
    expect(state.selectedTicketId).toBe('ticket-still-instruction')
    expect(store.values.get(TOKEN_KEY)).toBe('previous-user')
    expect(state.errors.workspace).toContain('先前快照')
    const before = vi.mocked(fetch).mock.calls.length
    expect(await workspace.createTicket({ project_id: 'owned-project', kind: 'read_summary', objective: 'must not execute when credential has expired' })).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(before)
    expect(state.errors.composer).toContain('请先完成连接认证')
    expect(await workspace.reconnect('previous-user')).toBe(true)
    expect(state.credentialState).toBe('valid')
    expect(state.connected).toBe(true)
  })

  it('distinguishes missing connectivity from invalid credentials and does not erase on an unverified attempt', async () => {
    const store = localStore()
    store.values.set(TOKEN_KEY, 'previous-user')
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline simulator'))
    const workspace = await setup(store, fetch)
    expect(await workspace.reconnect('new-unverified-candidate')).toBe(false)
    const { state } = workspace.useWorkspace()
    expect(state.credentialState).toBe('unknown')
    expect(state.connected).toBe(false)
    expect(store.values.get(TOKEN_KEY)).toBe('previous-user')
  })
})
