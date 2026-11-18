import { afterEach, describe, expect, it, vi } from 'vitest'

function ticket(id: string, status: string, cancelRequested = false) {
  return { id, project_id: 'owned-project', objective: 'Source approval fixture', kind: 'read_summary', relative_path: 'input.txt', status, attempt: 0, cancel_requested: cancelRequested }
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('one exact approval selection and human rationale', () => {
  it('trims the actual reason, submits it with one source-ticket decision, and reopens the same ticket', async () => {
    const id = 'waiting-source'
    const fixture = await setup(async (url, init) => {
      if (url.pathname === `/api/v1/tickets/${id}/approval`) {
        const body = JSON.parse(String(init?.body))
        expect(body.decision).toBe('approve')
        expect(body.reason).toBe('Reviewed the exact file and original limited read Grant')
        expect(typeof body.approval_id).toBe('string')
        return json({ acknowledged: true })
      }
      if (url.pathname === `/api/v1/tickets/${id}`) return json(ticket(id, 'running'))
      throw new Error(`Unexpected post-approval read ${url.pathname}`)
    })
    fixture.state.selectedTicketId = id
    fixture.state.ticket = ticket(id, 'waiting_approval') as typeof fixture.state.ticket
    expect(await fixture.workspace.decideApproval(id, 'approve', '  Reviewed the exact file and original limited read Grant  ')).toBe(true)
    const approvals = fixture.calls.filter(call => call.url.pathname === `/api/v1/tickets/${id}/approval`)
    expect(approvals).toHaveLength(1)
    const body = JSON.parse(String(approvals[0].init?.body))
    expect(Object.keys(body).sort()).toEqual(['approval_id', 'decision', 'reason'])
    expect(body).not.toHaveProperty('grant_id')
    expect(body).not.toHaveProperty('project_binding_id')
    expect(body).not.toHaveProperty('source_event_id')
    expect(fixture.state.ticket?.status).toBe('running')
  })

  it('keeps the later selected Ticket and page after a pending approval is accepted', async () => {
    const id = 'waiting-source'
    const completion = deferred<Response>()
    const fixture = await setup(async url => {
      if (url.pathname === `/api/v1/tickets/${id}/approval`) return completion.promise
      if (url.pathname === `/api/v1/tickets/${id}`) return json(ticket(id, 'running'))
      throw new Error(`Unexpected fetch while operator browsed another context: ${url}`)
    })
    fixture.state.selectedTicketId = id
    fixture.state.ticket = ticket(id, 'waiting_approval') as typeof fixture.state.ticket
    const decision = fixture.workspace.decideApproval(id, 'approve', '  Explicitly reviewed the original Ticket  ')
    await vi.waitFor(() => {
      expect(fixture.calls.filter(call => call.url.pathname.endsWith('/approval'))).toHaveLength(1)
    })
    fixture.state.selectedTicketId = 'different-ticket'
    fixture.state.ticket = ticket('different-ticket', 'running') as typeof fixture.state.ticket
    fixture.state.page = 'projects'
    completion.resolve(json(ticket(id, 'running')))
    expect(await decision).toBe(true)
    expect(fixture.state.selectedTicketId).toBe('different-ticket')
    expect(fixture.state.ticket?.id).toBe('different-ticket')
    expect(fixture.state.page).toBe('projects')
    const approvals = fixture.calls.filter(call => call.url.pathname === `/api/v1/tickets/${id}/approval`)
    expect(approvals).toHaveLength(1)
    expect(JSON.parse(String(approvals[0].init?.body))).toEqual(expect.objectContaining({ decision: 'approve', reason: 'Explicitly reviewed the original Ticket' }))
    expect(fixture.calls.filter(call => (call.init?.method ?? 'GET') === 'GET' && call.url.pathname === `/api/v1/tickets/${id}`)).toHaveLength(0)
  })

  it('re-reads the same still-selected Ticket without forcing conversation when the operator changed pages', async () => {
    const id = 'waiting-source'
    const completion = deferred<Response>()
    const fixture = await setup(async url => {
      if (url.pathname === `/api/v1/tickets/${id}/approval`) return completion.promise
      if (url.pathname === `/api/v1/tickets/${id}`) return json(ticket(id, 'waiting_approval'))
      throw new Error(`Unexpected revalidation target ${url.pathname}`)
    })
    fixture.state.selectedTicketId = id
    fixture.state.ticket = ticket(id, 'waiting_approval') as typeof fixture.state.ticket
    const decision = fixture.workspace.decideApproval(id, 'reject', '  Reviewed only this waiting Ticket  ')
    await vi.waitFor(() => expect(fixture.calls.some(call => call.url.pathname.endsWith('/approval'))).toBe(true))
    fixture.state.page = 'devices'
    completion.resolve(json(ticket(id, 'waiting_approval')))
    expect(await decision).toBe(true)
    expect(fixture.state.selectedTicketId).toBe(id)
    expect(fixture.state.page).toBe('devices')
    expect(fixture.calls.filter(call => (call.init?.method ?? 'GET') === 'GET' && call.url.pathname === `/api/v1/tickets/${id}`)).toHaveLength(1)
    expect(fixture.calls.filter(call => call.url.pathname === `/api/v1/tickets/${id}/approval`)).toHaveLength(1)
    expect(fixture.state.ticket?.status).toBe('waiting_approval')
    expect(fixture.state.ticket?.id).toBe(id)
  })

  it('rejects the stale selected id, changed state, stop intent and malformed reasons without any new decision', async () => {
    const fixture = await setup(async () => { throw new Error('No fetch is allowed for an invalid approval') })
    for (const status of ['pending', 'running', 'reconciling', 'cancel_requested', 'succeeded', 'failed']) {
      fixture.state.selectedTicketId = `waiting-${status}`
      fixture.state.ticket = ticket(`waiting-${status}`, status, status === 'cancel_requested') as typeof fixture.state.ticket
      expect(await fixture.workspace.decideApproval(`waiting-${status}`, 'approve', 'Reviewed the unauthorized stale action')).toBe(false)
    }
    fixture.state.selectedTicketId = 'other-ticket'
    fixture.state.ticket = ticket('waiting-source', 'waiting_approval') as typeof fixture.state.ticket
    expect(await fixture.workspace.decideApproval('waiting-source', 'approve', 'Reviewed a different selected context')).toBe(false)
    fixture.state.selectedTicketId = 'waiting-source'
    fixture.state.ticket = ticket('waiting-source', 'waiting_approval') as typeof fixture.state.ticket
    for (const reason of ['', '   ', 'x'.repeat(1001), '重'.repeat(334)]) {
      expect(await fixture.workspace.decideApproval('waiting-source', 'reject', reason)).toBe(false)
    }
    expect(fixture.calls).toHaveLength(0)
    expect(fixture.state.errors['ticket-write']).toContain('不会提交审批')
  })
})
