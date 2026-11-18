import { afterEach, describe, expect, it, vi } from 'vitest'
import { canRetryTicket } from '../src/lib/retryControl'

function ticket(id: string, status: string, cancelRequested = false) {
  return { id, project_id: 'owned-project', objective: 'Failed ordinary fixture', kind: 'read_summary', relative_path: 'input.txt', status, attempt: 1, cancel_requested: cancelRequested }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function setup(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  const calls: { url: URL; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const url = new URL(String(input), 'http://fixture.invalid')
    calls.push({ url, init })
    if (url.pathname === '/api/v1/preferences') {
      const ticketId = url.searchParams.get('ticket_id')
      return json({ scope: ticketId ? 'ticket' : 'global', ticket_id: ticketId, has_override: false, expanded: false, sender_filter: null })
    }
    if (url.pathname.endsWith('/audit')) return json({ audit: [] })
    return handler(url, init)
  }))
  vi.resetModules()
  const workspace = await import('../src/state/workspace')
  workspace.useWorkspace().state.credentialState = 'valid'
  return { workspace, state: workspace.useWorkspace().state, calls }
}
afterEach(() => vi.unstubAllGlobals())

describe('failed-only task retry controls', () => {
  it('accepts only completed failed work without stop intent', () => {
    expect(canRetryTicket({ status: 'failed', cancel_requested: false })).toBe(true)
    for (const status of ['pending', 'running', 'waiting_approval', 'reconciling', 'cancel_requested', 'cancelled', 'succeeded']) {
      expect(canRetryTicket({ status, cancel_requested: false })).toBe(false)
    }
    expect(canRetryTicket({ status: 'failed', cancel_requested: true })).toBe(false)
  })

  it('posts the exact failed-ticket retry only after checking its current identity, then reopens that Ticket', async () => {
    const id = 'failed-ticket'
    const fixture = await setup(async (url, init) => {
      if (url.pathname === `/api/v1/tickets/${id}/retry`) return json({ acknowledged: true })
      if (url.pathname === `/api/v1/tickets/${id}`) return json(ticket(id, 'running', false))
      throw new Error(`Unexpected requirements for retry ${url.pathname}`)
    })
    fixture.state.selectedTicketId = id
    fixture.state.ticket = ticket(id, 'failed', false) as typeof fixture.state.ticket
    expect(await fixture.workspace.retryTicket(id)).toBe(true)
    const retries = fixture.calls.filter(call => call.url.pathname === `/api/v1/tickets/${id}/retry`)
    expect(retries).toHaveLength(1)
    expect(retries[0].init?.method).toBe('POST')
    expect(retries[0].init?.body).toBe('{}')
    expect(fixture.state.ticket?.id).toBe(id)
  })

  it('does not send a retry for reconciling/stopped work or a different selected ticket after confirmation', async () => {
    const fixture = await setup(async () => { throw new Error('No admission or reads allowed for non-retryable work') })
    for (const status of ['reconciling', 'cancel_requested', 'succeeded', 'running']) {
      const id = `ticket-${status}`
      fixture.state.selectedTicketId = id
      fixture.state.ticket = ticket(id, status, status === 'cancel_requested') as typeof fixture.state.ticket
      expect(await fixture.workspace.retryTicket(id)).toBe(false)
    }
    fixture.state.selectedTicketId = 'ticket-b'
    fixture.state.ticket = ticket('ticket-a', 'failed', false) as typeof fixture.state.ticket
    expect(await fixture.workspace.retryTicket('ticket-a')).toBe(false)
    expect(fixture.calls.filter(call => call.url.pathname.endsWith('/retry'))).toHaveLength(0)
    expect(fixture.state.errors['ticket-write']).toContain('未知结果')
  })

  it('keeps genuine 401 authentication failure without treating the failed Ticket as a new Attempt', async () => {
    const id = 'failed-ticket'
    const fixture = await setup(async (url) => {
      if (url.pathname === `/api/v1/tickets/${id}/retry`) return json({ error: { code: 'unauthorized', message: 'expired client token' } }, 401)
      throw new Error('A refused retry must not trigger a follow-up task read')
    })
    fixture.state.selectedTicketId = id
    fixture.state.ticket = ticket(id, 'failed', false) as typeof fixture.state.ticket
    expect(await fixture.workspace.retryTicket(id)).toBe(false)
    expect(fixture.state.credentialState).toBe('required')
    expect(fixture.calls.map(call => call.url.pathname)).toEqual([`/api/v1/tickets/${id}/retry`])
  })
})
