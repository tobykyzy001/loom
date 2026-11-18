import { afterEach, describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function localStore() {
  const values = new Map<string, string>()
  return { values, window: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } } }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Client authentication failed' } }, 401)
const serverError = () => json({ error: { code: 'fixture_failure', message: 'Fixture read failed' } }, 500)
const preferences = (url: URL, expanded: boolean, override = false) => {
  const ticketId = url.searchParams.get('ticket_id')
  return { scope: ticketId ? 'ticket' : 'global', ticket_id: ticketId,
    has_override: ticketId ? override : false, expanded, sender_filter: null }
}
const ticket = (id: string) => ({ id, project_id: 'owned-project', objective: id, kind: 'read_summary', relative_path: 'input.txt', status: 'running', attempt: 1 })

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>
async function setup(handler: Handler) {
  const store = localStore()
  const calls: { url: URL; init?: RequestInit; body?: unknown }[] = []
  const arrived = new Map<string, ReturnType<typeof deferred<void>>>()
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input), 'http://fixture.invalid')
    calls.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    arrived.get(`${init?.method ?? 'GET'}:${url.searchParams.get('ticket_id') ?? 'global'}`)?.resolve()
    if (url.pathname === '/api/v1/tickets/ticket-a' || url.pathname === '/api/v1/tickets/ticket-b') return json(ticket(url.pathname.endsWith('ticket-a') ? 'ticket-a' : 'ticket-b'))
    if (url.pathname.endsWith('/audit')) {
      const response = await handler(url, init)
      return response.status === 200 ? response : json({ audit: [] })
    }
    return handler(url, init)
  })
  vi.stubGlobal('window', store.window)
  vi.stubGlobal('fetch', fetch)
  vi.resetModules()
  const workspace = await import('../src/state/workspace')
  workspace.useWorkspace().state.credentialState = 'valid'
  type WorkspaceModule = typeof workspace
  return Object.assign(workspace, {
    state: workspace.useWorkspace().state, store, fetch,
    preferenceRequest(method: string, ticketId?: string) {
      const key = `${method}:${ticketId ?? 'global'}`
      if (calls.some(call => call.url.pathname === '/api/v1/preferences' && (call.init?.method ?? 'GET') === method && call.url.searchParams.get('ticket_id') === (ticketId ?? null))) return Promise.resolve()
      const pending = deferred<void>()
      arrived.set(key, pending)
      return pending.promise
    },
  }) as WorkspaceModule & { state: ReturnType<WorkspaceModule['useWorkspace']>['state']; store: ReturnType<typeof localStore>; fetch: typeof fetch; preferenceRequest: (method: string, ticketId?: string) => Promise<void> }
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

const preferenceRequest = (workspace: Awaited<ReturnType<typeof setup>>, method: string, ticketId?: string) => workspace.preferenceRequest(method, ticketId)

describe('scoped process display preferences', () => {
  it('keeps true effective Ticket preferences and explicit PUTs independent from global defaults', async () => {
    const puts: { ticketId: string | null; body: unknown }[] = []
    const workspace = await setup(async (url, init) => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (init?.method === 'PUT') { puts.push({ ticketId: url.searchParams.get('ticket_id'), body: JSON.parse(String(init.body)) }) }
      const includeRow = url.searchParams.get('ticket_id') === 'ticket-a'
      return json(preferences(url, includeRow, includeRow))
    })
    await workspace.readPreferences()
    await workspace.selectTicket('ticket-a')
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.state.preferences.expanded).toBe(true)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('false')
    expect(workspace.store.values.get('loom.preferences:ticket-a')).toBe('true')
    expect(puts).toEqual([]) // A GET cannot create an override row.

    expect(await workspace.updatePreferences(false, '', 'ticket-a')).toBe(true)
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('false')
    expect(puts).toEqual([{ ticketId: 'ticket-a', body: { expanded: false, sender_filter: null } }])

    await workspace.selectTicket('ticket-b')
    expect(workspace.state.preferences.expanded).toBe(false) // B inherits global, never A.
    expect(workspace.state.expanded).toBe(false)
    workspace.startNewTicket()
    await preferenceRequest(workspace, 'GET')
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(puts).toHaveLength(1)
  })

  it('keeps Task overrides separate from global fallbacks and exact request URLs', async () => {
    const puts: { ticketId: string | null; body: unknown }[] = []
    const workspace = await setup(async (url, init) => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (init?.method === 'PUT') {
        puts.push({ ticketId: url.searchParams.get('ticket_id'), body: JSON.parse(String(init.body)) })
      }
      const includeRow = url.searchParams.get('ticket_id') === 'ticket-a'
      return json(preferences(url, includeRow, includeRow))
    })
    await workspace.readPreferences()
    await workspace.selectTicket('ticket-a')
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.state.preferences.expanded).toBe(true)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('false')
    expect(workspace.store.values.get('loom.preferences:ticket-a')).toBe('true')
    expect(puts).toEqual([])
    expect(await workspace.updatePreferences(false, '', 'ticket-a')).toBe(true)
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(puts).toEqual([{ ticketId: 'ticket-a', body: { expanded: false, sender_filter: null } }])
    await workspace.selectTicket('ticket-b')
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.store.values.has('loom.preferences:ticket-b')).toBe(false)
    workspace.startNewTicket()
    await preferenceRequest(workspace, 'GET')
    expect(workspace.state.expanded).toBe(false)
    expect(puts).toHaveLength(1)
  })

  it('allows independent same-time global and Ticket PUTs with exact routes and rollback-safe busy keys', async () => {
    const globalWrite = deferred<Response>()
    const ticketWrite = deferred<Response>()
    const workspace = await setup((url, init) => {
      if (url.pathname === '/api/v1/preferences' && init?.method === 'PUT') return url.searchParams.get('ticket_id') === 'ticket-a' ? ticketWrite.promise : globalWrite.promise
      return json(preferences(url, false))
    })
    workspace.state.selectedTicketId = 'ticket-a'
    workspace.state.ticket = ticket('ticket-a') as typeof workspace.state.ticket
    const ticketSave = workspace.updatePreferences(true, 'worker-one', 'ticket-a')
    const globalSave = workspace.updatePreferences(true, '')
    await Promise.all([preferenceRequest(workspace, 'PUT', 'ticket-a'), preferenceRequest(workspace, 'PUT')])
    expect(workspace.state.busy['preferences:ticket:ticket-a']).toBe(true)
    expect(workspace.state.busy['preferences:global']).toBe(true)
    expect(workspace.store.values.get('loom.preferences:ticket-a')).toBe('true')
    expect(workspace.store.values.get('loom.preferences:global')).toBe('true')
    const writes = vi.mocked(workspace.fetch).mock.calls.filter(([input, init]) => new URL(String(input), 'http://fixture.invalid').pathname === '/api/v1/preferences' && init?.method === 'PUT').map(([input, init]) => ({
      path: `${new URL(String(input), 'http://fixture.invalid').pathname}${new URL(String(input), 'http://fixture.invalid').search}`,
      body: JSON.parse(String(init!.body)),
    }))
    expect(writes).toEqual(expect.arrayContaining([
      { path: '/api/v1/preferences', body: { expanded: true, sender_filter: null } },
      { path: '/api/v1/preferences?ticket_id=ticket-a', body: { expanded: true, sender_filter: 'worker-one' } },
    ]))
    globalWrite.resolve(json(preferences(new URL('/api/v1/preferences', 'http://fixture.invalid'), true, false)))
    expect(await globalSave).toBe(true)
    expect(workspace.state.busy['preferences:global']).toBe(false)
    expect(workspace.state.busy['preferences:ticket:ticket-a']).toBe(true)
    expect(workspace.state.preferences.expanded).toBe(true)
    ticketWrite.resolve(json(preferences(new URL('/api/v1/preferences?ticket_id=ticket-a', 'http://fixture.invalid'), true, true)))
    expect(await ticketSave).toBe(true)
    expect(workspace.state.busy['preferences:ticket:ticket-a']).toBe(false)
  })

  it('rejects a late A detail/preference read after selecting B and does not invent A or B rows', async () => {
    const aPreference = deferred<Response>()
    const workspace = await setup(url => {
      if (url.pathname === '/api/v1/preferences' && url.searchParams.get('ticket_id') === 'ticket-a') return aPreference.promise
      return json(preferences(url, false))
    })
    await workspace.readPreferences()
    const first = workspace.selectTicket('ticket-a')
    await preferenceRequest(workspace, 'GET', 'ticket-a')
    const second = workspace.selectTicket('ticket-b')
    await second
    expect(workspace.state.ticket?.id).toBe('ticket-b')
    expect(workspace.state.preferences.expanded).toBe(false)
    aPreference.resolve(json(preferences(new URL('/api/v1/preferences?ticket_id=ticket-a', 'http://fixture.invalid'), true, true)))
    await first
    expect(workspace.state.selectedTicketId).toBe('ticket-b')
    expect(workspace.state.ticket?.id).toBe('ticket-b')
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.store.values.get('loom.preferences:ticket-a')).toBe('true')
    expect(workspace.store.values.has('loom.preferences:ticket-b')).toBe(false)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('false')
    expect(vi.mocked(workspace.fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  it('rejects an obsolete queued Ticket GET and does not let a newer global read change that Ticket', async () => {
    const firstRead = deferred<Response>()
    let delayNextA = false
    const workspace = await setup(url => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (delayNextA && url.searchParams.get('ticket_id') === 'ticket-a') return firstRead.promise.then(() => json(preferences(url, true, true)))
      const ticketId = url.searchParams.get('ticket_id')
      return json(preferences(url, ticketId === 'ticket-a', ticketId === 'ticket-a'))
    })
    await workspace.readPreferences()
    await workspace.selectTicket('ticket-a')
    delayNextA = true
    const retry = workspace.readPreferences('ticket-a')
    const selectedB = workspace.selectTicket('ticket-b')
    await selectedB
    const newGlobal = workspace.readPreferences()
    await newGlobal
    firstRead.resolve(json(preferences(new URL('/api/v1/preferences?ticket_id=ticket-a', 'http://fixture.invalid'), true, true)))
    await retry
    expect(workspace.state.ticket?.id).toBe('ticket-b')
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.store.values.get('loom.preferences:ticket-a')).toBe('true') // A valid verification persists only A's own cache, never B's view.
    expect(workspace.store.values.has('loom.preferences:ticket-b')).toBe(false)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('false')
  })

  it('rolls back a deferred global 401 without changing the selected Ticket or accepting optimistic state', async () => {
    const pending = deferred<Response>()
    const workspace = await setup((url, init) => {
      if (url.pathname === '/api/v1/preferences' && init?.method === 'PUT') return pending.promise
      return json(preferences(url, url.searchParams.has('ticket_id'), url.searchParams.get('ticket_id') === 'ticket-a'))
    })
    await workspace.readPreferences()
    await workspace.selectTicket('ticket-a')
    const saving = workspace.updatePreferences(true, '')
    await preferenceRequest(workspace, 'PUT')
    expect(workspace.state.expanded).toBe(true)
    expect(workspace.state.preferences.expanded).toBe(true)
    pending.resolve(unauthorized())
    expect(await saving).toBe(false)
    expect(workspace.state.credentialState).toBe('required')
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.state.preferences.expanded).toBe(true)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('false')
    expect(workspace.store.values.get('loom.preferences:ticket-a')).toBe('true')
    expect(workspace.state.errors['preferences:global']).toContain('凭据已失效')
    expect(workspace.state.errors['preferences:ticket:ticket-a']).toBeUndefined()
  })

  it('retains a Ticket 401 after another scoped 500 and rolls failed old-Ticket writes back only locally', async () => {
    const aWrite = deferred<Response>()
    let preferenceReads = 0
    const workspace = await setup((url, init) => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (init?.method === 'PUT' && url.searchParams.get('ticket_id') === 'ticket-a') return aWrite.promise
      if (init?.method === 'PUT') return unauthorized()
      preferenceReads++
      if (preferenceReads >= 4) return serverError()
      return json(preferences(url, false))
    })
    await workspace.readPreferences()
    await workspace.selectTicket('ticket-a')
    const saving = workspace.updatePreferences(true, '', 'ticket-a')
    await preferenceRequest(workspace, 'PUT', 'ticket-a')
    await workspace.selectTicket('ticket-b')
    aWrite.resolve(unauthorized())
    expect(await saving).toBe(false)
    expect(workspace.state.credentialState).toBe('required')
    expect(workspace.state.ticket?.id).toBe('ticket-b')
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.store.values.has('loom.preferences:ticket-a')).toBe(false)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('false')
    expect(workspace.state.errors['preferences:ticket:ticket-a']).toContain('凭据已失效')
    expect(workspace.state.errors['preferences:global']).toBeUndefined()

    await workspace.readPreferences('ticket-a')
    expect(workspace.state.errors['preferences:ticket:ticket-a']).toContain('凭据已失效')
    expect(workspace.state.errors['preferences:global']).toBeUndefined()
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(workspace.store.values.has('loom.preferences:ticket-a')).toBe(false)

    expect(await workspace.updatePreferences(true, '', 'ticket-b')).toBe(false)
    expect(vi.mocked(workspace.fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    expect(workspace.state.errors['preferences:ticket:ticket-b']).toContain('请先完成连接认证')
  })

  it('preserves a Ticket write 401 and local rollback through a later separate global 500', async () => {
    const write = deferred<Response>()
    let failGlobal = false
    const workspace = await setup((url, init) => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (init?.method === 'PUT') return write.promise
      if (failGlobal) return serverError()
      return json(preferences(url, false))
    })
    await workspace.readPreferences()
    workspace.state.selectedTicketId = 'ticket-a'
    workspace.state.ticket = ticket('ticket-a') as typeof workspace.state.ticket
    const saving = workspace.updatePreferences(true, '', 'ticket-a')
    await preferenceRequest(workspace, 'PUT', 'ticket-a')
    failGlobal = true
    const reading = workspace.readPreferences()
    write.resolve(unauthorized())
    expect(await saving).toBe(false)
    await reading
    expect(workspace.state.errors['preferences:ticket:ticket-a']).toContain('凭据已失效')
    expect(workspace.state.errors['preferences:global:read']).toContain('显示偏好暂不可用')
    expect(workspace.state.credentialState).toBe('required')
    expect(workspace.state.expanded).toBe(false)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('false')
  })

  it('routes a direct preference GET 401 to authentication handling and rolls back its snapshot', async () => {
    const workspace = await setup(async url => {
      if (url.pathname === '/api/v1/preferences') return unauthorized()
      return serverError()
    })
    await workspace.readPreferences()
    expect(workspace.state.credentialState).toBe('required')
    expect(workspace.state.errors['preferences:global:read']).toContain('凭据已失效')
    expect(workspace.store.values.has('loom.preferences:global')).toBe(false)
  })

  it('does not turn a failed scoped network read into another successful connection', async () => {
    let disconnected = false
    let currentSender: string | null = 'worker'
    const workspace = await setup(async url => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (disconnected) return Promise.reject(new TypeError('fixture network unavailable'))
      return json({ scope: 'ticket', ticket_id: 'ticket-a', has_override: true, expanded: false, sender_filter: currentSender })
    })
    await workspace.selectTicket('ticket-a')
    expect(workspace.state.preferences.sender_filter).toBe('worker')
    expect(workspace.state.connected).toBe(true)
    disconnected = true
    await workspace.readPreferences('ticket-a')
    // Direct preference-only failure remains a scoped degradation without an unhandled public Promise rejection.
    expect(workspace.state.connected).toBe(true)
    // Retain only the last accepted display, not fabricated new credentials.
    expect(workspace.state.preferences.sender_filter).toBe('worker')
    expect(workspace.state.errors['preferences:ticket:ticket-a:read']).toContain('显示偏好暂不可用')
    // Composite ticket/workspace acquisition must not leisurely infer that the
    // whole read succeeded when this scope knows its own transport failed.
    await workspace.readPreferences('ticket-a', undefined, { propagateTransportErrors: true })
    expect(workspace.state.connected).toBe(false)
    expect(workspace.state.credentialState).toBe('unknown')
    expect(workspace.state.errors['preferences:ticket:ticket-a:read']).toContain('显示偏好暂不可用')
    disconnected = false
    currentSender = 'client'
    await workspace.readPreferences('ticket-a')
    expect(workspace.state.connected).toBe(true)
    expect(workspace.state.credentialState).toBe('valid')
    expect(workspace.state.preferences.sender_filter).toBe('client')
    expect(workspace.state.errors['preferences:ticket:ticket-a:read']).toBe('')
    workspace.state.credentialState = 'valid'
    disconnected = false
    currentSender = null
    await workspace.readPreferences('ticket-a')
    expect(workspace.state.connected).toBe(true)
    expect(workspace.state.preferences.sender_filter).toBe(null)
  })

  it('keeps a scoped 403 as a display degradation and rejects a mismatched ticket response without caching it', async () => {
    const workspace = await setup(async url => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (url.searchParams.get('ticket_id') === 'ticket-a') {
        return json({ error: { code: 'permission_degraded', message: 'preference read unavailable' } }, 403)
      }
      if (url.searchParams.get('ticket_id') === 'ticket-b') {
        return json({ scope: 'ticket', ticket_id: 'ticket-b', has_override: true, expanded: true, sender_filter: null })
      }
      return json(preferences(url, false))
    })
    await workspace.selectTicket('ticket-a')
    expect(workspace.state.credentialState).toBe('valid')
    expect(workspace.state.errors['preferences:ticket:ticket-a:read']).toContain('显示偏好暂不可用')
    expect(workspace.store.values.has('loom.preferences:ticket-a')).toBe(false)
    workspace.state.selectedTicketId = 'ticket-a'
    workspace.state.ticket = ticket('ticket-a') as typeof workspace.state.ticket
    await workspace.readPreferences('ticket-a')
    expect(workspace.state.errors['preferences:ticket:ticket-a:read']).toContain('显示偏好暂不可用')
    expect(workspace.state.credentialState).toBe('valid')
  })

  it('rejects a preference response belonging to a different ticket instead of manufacturing cached cover', async () => {
    const workspace = await setup(async url => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (url.searchParams.get('ticket_id') === 'ticket-a') {
        return json({ scope: 'ticket', ticket_id: 'ticket-b', has_override: true, expanded: true, sender_filter: null })
      }
      return json(preferences(url, false))
    })
    await workspace.selectTicket('ticket-a')
    expect(workspace.state.preferences.expanded).toBe(false)
    expect(workspace.state.errors['preferences:ticket:ticket-a:read']).toContain('does not belong')
    expect(workspace.store.values.has('loom.preferences:ticket-a')).toBe(false)
  })

  it('keeps no-row fallback linked to the current global default rather than a cached effective value', async () => {
    const pending = deferred<Response>()
    const workspace = await setup(async url => {
      if (url.pathname !== '/api/v1/preferences') return serverError()
      if (url.searchParams.get('ticket_id') === 'ticket-a') return pending.promise
      return json(preferences(url, false))
    })
    await workspace.readPreferences()
    const selected = workspace.selectTicket('ticket-a')
    await preferenceRequest(workspace, 'GET', 'ticket-a')
    expect(await workspace.updatePreferences(true, '')).toBe(true)
    expect(workspace.state.expanded).toBe(true)
    expect(workspace.state.preferences.expanded).toBe(true)
    pending.resolve(json(preferences(new URL('/api/v1/preferences?ticket_id=ticket-a', 'http://fixture.invalid'), true, false)))
    await selected
    expect(workspace.state.preferences.expanded).toBe(true)
    expect(workspace.store.values.has('loom.preferences:ticket-a')).toBe(false)
    expect(workspace.store.values.get('loom.preferences:global')).toBe('true')
    expect(vi.mocked(workspace.fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
  })

  it('discards audit returning from an old Ticket after another Ticket was selected', async () => {
    const oldAudit = deferred<Response>()
    const workspace = await setup(async url => {
      if (url.pathname === '/api/v1/audit') {
        if (url.searchParams.get('ticket_id') === 'ticket-a') return oldAudit.promise
        return json({ audit: [{ id: `audit-${url.searchParams.get('ticket_id')}`, action: 'fresh_for_selected_ticket' }] })
      }
      return json(preferences(url, false))
    })
    const first = workspace.selectTicket('ticket-a')
    await preferenceRequest(workspace, 'GET', 'ticket-a')
    await workspace.selectTicket('ticket-b')
    oldAudit.resolve(json({ audit: [{ id: 'audit-a', action: 'stale_from_other_ticket' }] }))
    await first
    expect(workspace.state.selectedTicketId).toBe('ticket-b')
    expect(workspace.state.ticket?.id).toBe('ticket-b')
    expect(workspace.state.audit.map(row => row.id)).toEqual(['audit-ticket-b'])
  })

  it('does not poll or commit audit for a stale loaded Ticket from a different selection', async () => {
    const workspace = await setup(async url => {
      if (url.pathname === '/api/v1/audit') {
        return json({ audit: [{ id: `audit-${url.searchParams.get('ticket_id')}`, action: 'verified_against_loaded_id' }] })
      }
      return json(preferences(url, false))
    })
    vi.useFakeTimers()
    vi.stubGlobal('document', { visibilityState: 'visible' })
    try {
      workspace.startNewTicket()
      workspace.state.selectedTicketId = 'ticket-b'
      workspace.state.ticket = ticket('ticket-a') as typeof workspace.state.ticket
      workspace.startPolling()
      await vi.advanceTimersByTimeAsync(12000)
      expect(vi.mocked(workspace.fetch).mock.calls.filter(([url]) => new URL(String(url), 'http://fixture.invalid').pathname.startsWith('/api/v1/tickets/'))).toHaveLength(0)

      workspace.state.selectedTicketId = 'ticket-a'
      workspace.startPolling()
      await vi.advanceTimersByTimeAsync(12000)
      expect(workspace.state.ticket?.id).toBe('ticket-a')
      workspace.state.selectedTicketId = 'ticket-b'
      workspace.state.ticket = ticket('ticket-a') as typeof workspace.state.ticket
      workspace.state.audit = [{ id: 'audit-b', action: 'already_for_b' }] as typeof workspace.state.audit
      expect(await workspace.loadAudit('ticket-a')).toBe(false)
      expect(workspace.state.audit.map(row => row.id)).toEqual(['audit-b'])
    } finally {
      workspace.stopPolling()
      vi.useRealTimers()
    }
  })
})
