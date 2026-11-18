import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { acceptSourceTicketReceipt, rejectSourceSpecMismatch, sourceReceiptFrom, sourceThreadFrom, sourceWorkBodyFrom } from '../src/api/parsing'
import { eligibleSourceGrant, sourceWorkError, type SourceWorkDraft } from '../src/components/SourceWorkPanel.vue'
import { ApiError, LoomClient } from '../src/api/client'
import type { Grant, SourceEvent, SourceWorkSpec, Ticket } from '../src/api/types'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers() })
const localStore = () => {
  const values = new Map<string, string>()
  return { values, window: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } } }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const objective = '  Read 精确原文\n第二行 preserve whitespace  '
const sourceEvent = (content = objective): SourceEvent => ({ id: 'sre_exact', source_id: 'src_internal', thread_id: 'thread_internal', client_thread_id: 'custom-thread', external_event_id: 'generated-once', kind: 'user_message', content, source_sequence: 1, thread_sequence: 1, ticket_id: null, task_ticket_id: null })
const sourceTicket = (status = 'running'): Ticket => ({ id: 'tkt_new', project_id: 'project-a', objective, kind: 'read_summary', relative_path: 'docs/exact.txt', status, attempt: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })
const goodGrant = { id: 'grant-a', project_id: 'project-a', node_id: 'node-a', installation_id: 'install-a', worker_id: 'worker-a', project_binding_id: 'binding-a', operations: ['read'], revoked_at: null }
const draft: SourceWorkDraft = { source_event_id: 'sre_exact', objective, kind: 'read_summary', relative_path: 'docs/exact.txt', project_id: 'project-a', grant_id: 'grant-a', node_id: 'node-a', worker_id: 'worker-a' }

async function setup(fetch: typeof globalThis.fetch) {
  const storage = localStore()
  vi.stubGlobal('window', storage.window)
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555' })
  vi.resetModules()
  const workspace = await import('../src/state/workspace')
  workspace.useWorkspace().state.credentialState = 'valid'
  return { ...workspace, storage }
}
const eventPage = (event = sourceEvent()) => ({ schema: 'loom.source-page.v1', source_id: event.source_id, thread: { id: 'thread_internal', client_thread_id: 'custom-thread' }, events: [event], has_more: false, next_cursor: null, permission_granted: false })
const resource = (body: unknown) => json(body)
const replies: Record<string, unknown> = {
  '/api/v1/projects': { projects: [{ id: 'project-a', name: 'Exact authorized project', root: '/srv/exact', mode: 'read_only' }] },
  '/api/v1/grants': { grants: [goodGrant] },
  '/api/v1/nodes': { nodes: [{ id: 'node-a', installation_id: 'install-a', inventory: { project_roots: { 'project-a': '/srv/exact' } } }] },
}

describe('Source explicit authorization and exact request contracts', () => {
  it('rejects auto/blank/unbound/revoked/non-read Grants instead of choosing defaults', () => {
    const invalid = [undefined, { ...goodGrant, installation_id: undefined }, { ...goodGrant, operations: 'read' },
      { ...goodGrant, node_id: 'auto' }, { ...goodGrant, node_id: '' },
      { ...goodGrant, worker_id: '' }, { ...goodGrant, project_binding_id: '' }, { ...goodGrant, revoked_at: '2026-01-01' },
      { ...goodGrant, status: 'revoked' }, { ...goodGrant, operations: [] }, { ...goodGrant, operations: ['write'] }, { ...goodGrant, operations: ['read_summary'] }]
    expect((invalid as unknown as Array<Grant | undefined>).map(eligibleSourceGrant)).toEqual(invalid.map(() => false))
    expect(eligibleSourceGrant(goodGrant)).toBe(true)
  })
  it('preserves every objective character and returns only the eight backend ticket fields', () => {
    const body = sourceWorkBodyFrom(draft)
    expect(body.objective).toBe(objective)
    expect(body.objective).not.toBe(objective.trim())
    expect(body).toEqual({ source_event_id: 'sre_exact', objective, kind: 'read_summary', relative_path: 'docs/exact.txt', project_id: 'project-a', grant_id: 'grant-a', node_id: 'node-a', worker_id: 'worker-a' })
    expect('source_scope' in body).toBe(false)
    expect('source_event' in sourceWorkBodyFrom({ ...draft, source_event: sourceEvent() })).toBe(false)
    for (const key of ['objective', 'relative_path', 'grant_id', 'node_id', 'worker_id'] as const) expect(() => sourceWorkBodyFrom({ ...draft, [key]: '' })).toThrow()
  })
  it('records full raw user text using stable UUID and an exact client thread, and never creates a Ticket on open/record', async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown>; method?: string }> = []
    const fetch = vi.fn(async (url, init) => {
      const path = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      requests.push({ path, body, method: init?.method })
      if (path === '/api/v1/sources') return json({ source: { id: 'src_internal', source_key: 'web-main', kind: 'web' }, duplicate: false, task_created: false, permission_granted: false })
      if (path === '/api/v1/source-events' && init?.method === 'POST') return json({ ...sourceEvent(body?.content as string), external_event_id: body?.event_id, duplicate: false, task_created: false, permission_granted: false, delivery_stage: 'recorded' })
      if (path.startsWith('/api/v1/source-events?')) return json(eventPage())
      if (path === '/api/v1/sources?limit=100') return json({ sources: [], has_more: false, next_cursor: null })
      return json({ error: { code: 'unexpected', message: 'unexpected route' } }, 500)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    const transport = workspace.createSourceWorkTransport('web-main', 'custom-thread', 'Explicit messages')
    const event = await transport.registerAndRecord({ thread_id: 'custom-thread', content: objective })
    expect(event?.content).toBe(objective)
    expect(event?.task_created).toBe(false)
    const record = requests.find(request => request.path === '/api/v1/source-events' && request.method === 'POST')
    expect(record?.body).toEqual({ schema: 'loom.source-event.v1', source_id: 'src_internal', thread_id: 'custom-thread', event_id: 'web-11111111-2222-4333-8444-555555555555', kind: 'user_message', content: objective })
    expect(Object.keys(record?.body ?? {})).not.toContain('ticket_id')
    expect(requests.filter(request => request.path === '/api/v1/tickets')).toHaveLength(0)
    await expect(transport.readThread({ thread_id: 'other-thread' })).rejects.toThrow('exact client thread')
    await transport.readThread({ thread_id: 'custom-thread' })
    expect(requests.filter(request => request.path === '/api/v1/tickets')).toHaveLength(0)
    expect(requests.some(request => pathMatchesThread(request.path))).toBe(true)
    expect(workspace.storage.values.get('loom.source-event')).toBeUndefined()
    expect([...workspace.storage.values.values()].some(value => value.includes(objective) || value.includes('token'))).toBe(false)
  })
  it('reuses event_id for a failed raw-message retry and changes it when replacement text is recorded', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetch = vi.fn(async (url, init) => {
      if (String(url) === '/api/v1/source-events') {
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        if (bodies.length === 1) return json({ error: { code: 'network_error', message: 'retry the same intake' } }, 503)
        return json({ ...sourceEvent(body.content), external_event_id: body.event_id, duplicate: false, task_created: false, permission_granted: false, delivery_stage: 'recorded' })
      }
      return json({ error: { code: 'forbidden', message: 'refused' } }, 403)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    expect(await workspace.recordSourceMessage({ source_id: 'src_internal', thread_id: 'custom-thread', content: objective })).toBeNull()
    await workspace.recordSourceMessage({ source_id: 'src_internal', thread_id: 'custom-thread', content: objective })
    await workspace.recordSourceMessage({ source_id: 'src_internal', thread_id: 'custom-thread', content: 'replacement text' })
    expect(bodies.map(body => body.event_id)).toEqual(['web-11111111-2222-4333-8444-555555555555', 'web-11111111-2222-4333-8444-555555555555', 'web-11111111-2222-4333-8444-555555555555'])
  })
  it('validates known custom thread, sends exact parameters, retains a new running ticket and avoids global refresh', async () => {
    const paths: string[] = []
    const fetch = vi.fn(async (url, init) => {
      const path = String(url)
      paths.push(path)
      if (pathMatchesThread(path)) return json(eventPage())
      if (path === '/api/v1/tickets' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual(draft)
        expect(JSON.parse(String(init.body)).objective).toBe(objective)
        return json({ ticket: sourceTicket(), source_event_id: 'sre_exact', task_digest: 'a'.repeat(64), duplicate: false, task_created: true, linked_existing_authorized_ticket: false })
      }
      if (path in replies) return resource(replies[path])
      return json({ error: { code: 'wrong_scope', message: 'No unbounded fallback' } }, 403)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    workspace.rememberSourceThread('src_internal', 'custom-thread', 'sre_exact')
    workspace.useWorkspace().state.tickets = [{ ...sourceTicket(), id: 'existing' }]
    const result = await workspace.createTicketFromSource(draft)
    expect(result?.ticket.status).toBe('running')
    expect(result?.task_created).toBe(true)
    expect(result?.duplicate).toBe(false)
    expect(workspace.useWorkspace().state.tickets.map(ticket => ticket.id)).toEqual(['tkt_new', 'existing'])
    expect(workspace.useWorkspace().state.sourceTicketToOpen).toBe('tkt_new')
    expect(paths.filter(pathMatchesThread).every(path => path.includes('thread_id=custom-thread'))).toBe(true)
    expect(paths.filter(pathMatchesThread)).toHaveLength(2)
    expect(paths.filter(path => path === '/api/v1/tickets')).toHaveLength(1)
    expect(paths.filter(path => !pathMatchesThread && !['/api/v1/tickets', '/api/v1/grants', '/api/v1/projects', '/api/v1/nodes'].includes(path))).toEqual([])
    expect(paths).not.toContain('/api/v1/bootstrap')
    expect(paths).not.toContain('/api/v1/messages')
  })
  it('holds source-write busy through the pending POST and settles the confirmed thread read afterward', async () => {
    let release!: (response: Response) => void
    const response = new Promise<Response>(resolve => { release = resolve })
    const paths: string[] = []
    const fetch = vi.fn(async (url, init) => {
      const path = String(url)
      paths.push(path)
      if (pathMatchesThread(path)) return json(eventPage({ ...sourceEvent(), task_ticket_id: 'tkt_new', creation_kind: 'explicit_task_created_after_intake', task_digest: 'a'.repeat(64), payload_digest: 'e'.repeat(64), task_spec: { schema: 'loom.source-work-spec.v1', source_event_id: 'sre_exact', event_request_digest: 'e'.repeat(64), ticket_id: 'tkt_new', digest: 'a'.repeat(64), project_id: 'project-a', kind: 'read_summary', objective, relative_path: 'docs/exact.txt', content: null, grant_id: 'grant-a', grant_digest: 'g'.repeat(64), grant_version: 1, project_binding_id: 'binding-a', binding_digest: 'b'.repeat(64), root_scope: '/srv/exact', node_id: 'node-a', installation_id: 'install-a', worker_id: 'worker-a', created_at: '2026-01-01T00:00:00Z' } }))
      if (path === '/api/v1/grants') {
        expect(workspace.useWorkspace().state.busy['source-write']).toBe(true)
        return resource(replies[path])
      }
      if (path === '/api/v1/tickets' && init?.method === 'POST') {
        expect(workspace.useWorkspace().state.busy['source-write']).toBe(true)
        return response
      }
      return json({ error: { code: 'unexpected', message: 'unexpected' } }, 500)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    workspace.rememberSourceThread('src_internal', 'custom-thread', 'sre_exact')
    const pending = workspace.createTicketFromSource({ ...draft, source_event: sourceEvent() })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(workspace.useWorkspace().state.busy['source-write']).toBe(true)
    expect(await workspace.createTicketFromSource(draft)).toBeNull()
    expect(workspace.useWorkspace().state.busy['source-write']).toBe(true)
    release(json({ ticket: sourceTicket(), source_event_id: 'sre_exact', task_digest: 'a'.repeat(64), duplicate: false, task_created: true, linked_existing_authorized_ticket: false }))
    const result = await pending
    expect(result?.ticket.id).toBe('tkt_new')
    expect(workspace.useWorkspace().state.busy['source-write']).toBe(false)
    expect(paths.filter(pathMatchesThread)).toHaveLength(1)
    expect(paths.filter(path => path === '/api/v1/tickets')).toHaveLength(1)
  })
  it('re-reads only the known exact thread when no client event is attached, using the same busy write', async () => {
    const paths: string[] = []
    const fetch = vi.fn(async (url, init) => {
      const path = String(url)
      paths.push(path)
      if (pathMatchesThread(path)) {
        expect(workspace.useWorkspace().state.busy['source-write']).toBe(path.includes('sre_exact') === false)
        return json(eventPage())
      }
      if (path === '/api/v1/tickets') return json({ ticket: sourceTicket(), source_event_id: 'sre_exact', task_digest: 'a'.repeat(64), duplicate: false, task_created: true, linked_existing_authorized_ticket: false })
      if (path in replies) return resource(replies[path])
      return json({ error: { code: 'forbidden', message: 'wrong exact thread' } }, 403)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    workspace.rememberSourceThread('src_internal', 'custom-thread', 'sre_exact')
    const result = await workspace.createTicketFromSource(draft)
    expect(result?.ticket.id).toBe('tkt_new')
    expect(paths.filter(pathMatchesThread)).toHaveLength(2)
    expect(paths.filter(pathMatchesThread).every(path => path.includes('source_id=src_internal') && path.includes('thread_id=custom-thread'))).toBe(true)
  })
  it('rejects malformed client-only Source evidence before any network write', async () => {
    const fetch = vi.fn(async url => {
      if (String(url) === '/api/v1/grants') return resource(replies['/api/v1/grants'])
      return json({ error: { code: 'forbidden', message: 'forbidden' } }, 403)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    workspace.rememberSourceThread('src_internal', 'custom-thread', 'sre_exact')
    const incomplete: SourceEvent = { ...sourceEvent(), external_event_id: '' }
    expect(await workspace.createTicketFromSource({ ...draft, source_event: incomplete })).toBeNull()
    expect(workspace.useWorkspace().state.errors['source-write']).toContain('external_event_id')
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([
    ['different objective', { ...draft, objective: objective.trim() }],
    ['unsafe explicit path', { ...draft, relative_path: '' }],
    ['cross-project', { ...draft, project_id: 'project-other' }],
    ['cross-node', { ...draft, node_id: 'node-other' }],
    ['empty worker', { ...draft, worker_id: '' }],
  ])('rejects %s locally before protected task creation', async (_name, changed) => {
    const fetch = vi.fn(async (url) => {
      const path = String(url)
      if (pathMatchesThread(path)) return json(eventPage())
      if (path in replies) return resource(replies[path])
      return json({ error: { code: 'forbidden', message: 'refused' } }, 403)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    workspace.rememberSourceThread('src_internal', 'custom-thread', 'sre_exact')
    expect(await workspace.createTicketFromSource(changed)).toBeNull()
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/tickets', expect.anything())
  })
  it.each([
    ['revoked', { ...goodGrant, revoked_at: '2026-01-01T00:00:00Z' }],
    ['no binding', { ...goodGrant, project_binding_id: '' }],
    ['auto node', { ...goodGrant, node_id: 'auto' }],
    ['missing read', { ...goodGrant, operations: ['write'] }],
    ['blank worker', { ...goodGrant, worker_id: '' }],
    ['missing installation', { ...goodGrant, installation_id: undefined }],
    ['invalid status', { ...goodGrant, status: 'stale_or_unknown' }],
  ])('does not silently select or invent authority for %s', async (_label, grant) => {
    const fetch = vi.fn(async (url) => {
      const path = String(url)
      if (pathMatchesThread(path)) return json(eventPage())
      if (path === '/api/v1/grants') return json({ grants: [grant] })
      if (path in replies) return resource(replies[path])
      return json({ error: { code: 'forbidden', message: 'refused' } }, 403)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    workspace.rememberSourceThread('src_internal', 'custom-thread', 'sre_exact')
    expect(await workspace.createTicketFromSource(draft)).toBeNull()
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/tickets', expect.anything())
    expect(workspace.useWorkspace().state.errors['source-write']).toContain('Grant')
  })
})

describe('Source parsers and authoritative nested responses', () => {
  it('requires nested Ticket, source ID, digest and coherent duplicate flags', () => {
    const receipt = acceptSourceTicketReceipt({ ticket: sourceTicket('waiting_approval'), source_event_id: 'sre_exact', task_digest: 'd'.repeat(64), duplicate: false, task_created: true, linked_existing_authorized_ticket: false })
    expect(receipt.ticket.id).toBe('tkt_new')
    expect(receipt.ticket.status).toBe('waiting_approval')
    expect(receipt.ticket.status).not.toBe('succeeded')
    expect(() => acceptSourceTicketReceipt({ id: 'top-level-ticket' })).toThrow()
    expect(() => acceptSourceTicketReceipt({ ticket: sourceTicket(), source_event_id: 'sre_exact', duplicate: false, task_created: true, linked_existing_authorized_ticket: false })).toThrow('task_digest')
    const legal = { ticket: sourceTicket(), source_event_id: 'sre_exact', task_digest: 'a'.repeat(64), duplicate: true, task_created: false, linked_existing_authorized_ticket: true }
    expect(acceptSourceTicketReceipt(legal).ticket.id).toBe('tkt_new')
    expect(() => acceptSourceTicketReceipt({ ...legal, duplicate: false })).toThrow()
    expect(() => acceptSourceTicketReceipt({ ...legal, task_created: true })).toThrow()
  })
  it('refuses an unverifiable legacy or invented duplicate rather than linking an unrelated Ticket', async () => {
    const body = { ticket: sourceTicket('waiting_approval'), source_event_id: 'sre_exact', task_digest: 'x'.repeat(64), duplicate: true, task_created: false, linked_existing_authorized_ticket: true }
    const fetch = vi.fn(async (url, init) => {
      const path = String(url)
      if (pathMatchesThread(path)) return json(eventPage())
      if (path === '/api/v1/tickets' && init?.method === 'POST') return json(body)
      if (path in replies) return resource(replies[path])
      return json({ error: { code: 'forbidden', message: 'refused' } }, 403)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    workspace.rememberSourceThread('src_internal', 'custom-thread', 'sre_exact')
    const result = await workspace.createTicketFromSource(draft)
    expect(result).toBeNull()
    expect(workspace.useWorkspace().state.errors['source-write']).toContain('未绑定')
    expect(workspace.useWorkspace().state.tickets.filter(ticket => ticket.id === 'tkt_new')).toHaveLength(0)
  })
  it('reviews only the immutable bound task scope, returning the same duplicate Ticket without rebind', async () => {
    const taskSpec: SourceWorkSpec = { schema: 'loom.source-work-spec.v1', source_event_id: 'sre_exact', event_request_digest: 'e'.repeat(64), ticket_id: 'tkt_new', digest: 's'.repeat(64), project_id: 'project-a', kind: 'read_summary', objective, relative_path: 'docs/exact.txt', content: null, grant_id: 'grant-a', grant_digest: 'g'.repeat(64), grant_version: 1, project_binding_id: 'binding-a', binding_digest: 'b'.repeat(64), root_scope: '/srv/exact', node_id: 'node-a', installation_id: 'install-a', worker_id: 'worker-a', created_at: '2026-01-01T00:00:00Z' }
    const boundEvent = { ...sourceEvent(), task_ticket_id: 'tkt_new', task_digest: taskSpec.digest, creation_kind: 'explicit_task_created_after_intake', payload_digest: taskSpec.event_request_digest, task_spec: taskSpec }
    expect(() => rejectSourceSpecMismatch(boundEvent, draft)).not.toThrow()
    expect(() => rejectSourceSpecMismatch(boundEvent, { ...draft, grant_id: 'other-grant' })).toThrow('不能重放或改绑')
    expect(() => rejectSourceSpecMismatch({ ...boundEvent, task_spec: null }, draft)).toThrow('完整 task_spec')
    let replayRead = 0
    const receipts: SourceWorkDraft[] = []
    const fetch = vi.fn(async (url, init) => {
      const path = String(url)
      if (pathMatchesThread(path)) {
        if (path.includes('custom-thread')) replayRead++
        return json(replayRead === 0 ? eventPage() : eventPage(boundEvent))
      }
      if (path === '/api/v1/tickets' && init?.method === 'POST') {
        receipts.push(JSON.parse(String(init.body)))
        return json({ ticket: sourceTicket('waiting_approval'), source_event_id: 'sre_exact', task_digest: taskSpec.digest, duplicate: true, task_created: false, linked_existing_authorized_ticket: true })
      }
      if (path in replies) return resource(replies[path])
      return json({ error: { code: 'grant_scope', message: 'cross project refused' } }, 403)
    }) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    workspace.rememberSourceThread('src_internal', 'custom-thread', 'sre_exact')
    const scoped = { ...draft, source_scope: { source_id: 'src_internal', client_thread_id: 'custom-thread' } }
    const result = await workspace.createTicketFromSource(scoped)
    expect(receipts).toEqual([draft])
    expect(result?.duplicate).toBe(true)
    expect(result?.ticket.id).toBe('tkt_new')
    expect(result?.ticket.status).toBe('waiting_approval')
    expect(result?.ticket.status).not.toBe('succeeded')
    expect(workspace.useWorkspace().state.tickets.filter(ticket => ticket.id === 'tkt_new')).toHaveLength(1)
    const calls = vi.mocked(fetch).mock.calls.length
    expect(await workspace.createTicketFromSource({ ...scoped, grant_id: 'grant-other', node_id: 'node-other', worker_id: 'worker-other' })).toBeNull()
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls + 1) // only exact known-thread read; no Grant lookup or /tickets rebind.
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/tickets', expect.objectContaining({ body: expect.stringContaining('grant-other') }))
  })
  it('uses Source event API without Ticket Activity/message filtering, even when intake ticket_id exists', () => {
    const event = sourceReceiptFrom({ ...sourceEvent(), ticket_id: 'legacy_unverified', duplicate: true, task_created: false, permission_granted: false, delivery_stage: 'recorded' })
    expect(event.legacy_reference).toBe('unverified_intake_reference')
    expect(event.task_ticket_id).toBeNull()
    expect(() => sourceReceiptFrom({ ...event, task_created: true })).toThrow()
    expect(() => sourceThreadFrom(eventPage(), { source_id: 'src_wrong', client_thread_id: 'custom-thread' })).toThrow('范围不匹配')
  })
})

describe('Source credential guards and errors', () => {
  it('blocks source intake and source task writes before a valid protected credential is verified', async () => {
    const workspace = await setup(vi.fn() as typeof globalThis.fetch)
    workspace.useWorkspace().state.credentialState = 'required'
    expect(await workspace.registerSource({ source_key: 'web-main', kind: 'web', label: 'Explicit' })).toBeNull()
    expect(await workspace.recordSourceMessage({ source_id: 'src_internal', thread_id: 'custom-thread', content: objective })).toBeNull()
    expect(await workspace.createTicketFromSource(draft)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(workspace.useWorkspace().state.errors['source-write']).toContain('请先完成连接认证')
  })
  it('does not update from a stale read and tells writes to use identical receipt replay on epoch changes', async () => {
    let token = 'first'
    let epoch = 1
    const client = new LoomClient({ token: () => token, credentialEpoch: () => epoch, fetch: async () => {
      const response = json(eventPage())
      response.json = async () => { token = 'replacement'; epoch++; return eventPage() }
      return response
    } })
    await expect(client.get('/source-events?source_id=src_internal&thread_id=custom-thread&limit=50')).rejects.toMatchObject({ code: 'credential_epoch_changed' })
  })
  it('turns source 401 into an explicit required credential state, and subsequent writes send nothing', async () => {
    const fetch = vi.fn(async () => json({ error: { code: 'unauthorized', message: 'expired' } }, 401)) as typeof globalThis.fetch
    const workspace = await setup(fetch)
    expect(await workspace.recordSourceMessage({ source_id: 'src_internal', thread_id: 'custom-thread', content: objective })).toBeNull()
    expect(workspace.useWorkspace().state.credentialState).toBe('required')
    expect(workspace.useWorkspace().state.errors['source-write']).toContain('凭据已失效')
    expect(await workspace.createTicketFromSource(draft)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    [409, 'source_event_conflict', 'Source'],
    [403, 'grant_scope', 'Grant/Project/Node/Worker'],
    [403, 'source_task_scope', 'Grant/Project/Node/Worker'],
    [404, 'not_found', 'missing exact thread'],
    [401, 'unauthorized', '客户端凭据'],
    [409, 'preview_cursor_bound', 'Source/thread'],
  ])('preserves HTTP %s %s as a visible error rather than a new Grant/Artifact', async (status, code, text) => {
    expect(sourceWorkError(new ApiError(status, code, 'missing exact thread', '/tickets'))).toContain(text)
  })
})

describe('SSR panel auth projections', () => {
  it('shows blank Grant default and exact scope placeholders, never default Project/README/Node/Worker', async () => {
    const Panel = (await import('../src/components/SourceWorkPanel.vue')).default
    const html = await renderToString(createSSRApp(Panel, {
      transport: {}, projects: [{ id: 'project-a', name: 'A', root: '/srv/exact', mode: 'read_only' }], grants: [goodGrant], nodes: [{ id: 'node-a', inventory: { project_roots: { 'project-a': '/srv/exact' } } }], sourceKey: 'web-main', threadId: 'custom-thread',
    }))
    expect(html).toMatch(/<select id="source-grant"[^>]*><option value=""[^>]* selected>请选择，不默认选择<\/option>/)
    expect(html).toContain('exact client thread: custom-thread')
    expect(html).not.toContain('value="grant-a" selected')
    expect(html).toContain('请选择')
    expect(html).toContain('不默认 README')
  })
  it('renders real scope only after explicit event/Grant selection path in server-side test hooks', async () => {
    const Panel = (await import('../src/components/SourceWorkPanel.vue')).default
    const html = await renderToString(createSSRApp(Panel, { transport: {}, projects: [], grants: [], nodes: [], sourceKey: 'web-main', threadId: 'custom-thread' }))
    expect(html).toContain('没有可同时验证')
    expect(html).toContain('基于')
  })
})
function pathMatchesThread(path: string): boolean { return path.startsWith('/api/v1/source-events?') }
