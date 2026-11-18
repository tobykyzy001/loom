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
