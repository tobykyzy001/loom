import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactRef } from '../src/api/types'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const values = new Map<string, string>()

interface Seed { id: string; artifactId: string; nodeId: string; assignmentId: string; sha: string; body: string }
const seed = (id: string, artifactId: string): Seed => ({
  id, artifactId, nodeId: `node-${id}`, assignmentId: `assignment-${id}`,
  sha: id === 'ticket-a' ? 'a'.repeat(64) : 'b'.repeat(64), body: `True downloaded contents for ${id}`,
})
function ticket(model: Seed): Record<string, unknown> {
  return {
    id: model.id, project_id: 'owned-project', objective: `work-${model.id}`,
    kind: 'read_summary', relative_path: 'input.txt', status: 'succeeded', attempt: 1,
    artifacts: [{ artifact_id: model.artifactId, ticket_id: model.id, assignment_id: model.assignmentId,
      origin_node_id: model.nodeId, sha256: model.sha, size_bytes: model.body.length, media_type: 'text/plain' }],
    assignments: [{ id: model.assignmentId, ticket_id: model.id, node_id: model.nodeId, attempt: 1 }],
    reports: [], effects: [],
  }
}
function artifactResponse(model: Seed, overrides: Record<string, unknown> = {}) {
  return {
    artifact: {
      id: model.artifactId, ticket_id: model.id, assignment_id: model.assignmentId,
      origin_node_id: model.nodeId, sha256: model.sha, size_bytes: model.body.length,
      media_type: 'text/plain', name: `${model.id}.txt`, ...overrides,
    },
    content: model.body, encoding: 'utf8', truncated: false,
  }
}

async function setup() {
  vi.resetModules()
  const a = seed('ticket-a', 'artifact-a')
  const b = seed('ticket-b', 'artifact-b')
  let resolveA!: (response: Response) => void
  const aResponse = { promise: new Promise<Response>(resolve => { resolveA = resolve }), resolve: (response: Response) => resolveA(response) }
  let delayedA = false
  let changeA: Record<string, unknown> | undefined
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = vi.fn(async input => {
    const url = new URL(String(input), 'http://fixture.invalid')
    calls.push(url.pathname)
    if (url.pathname === '/api/v1/preferences') {
      const ticketId = url.searchParams.get('ticket_id')
      return json({ scope: ticketId ? 'ticket' : 'global', ticket_id: ticketId, has_override: false, expanded: false, sender_filter: null })
    }
    if (url.pathname.endsWith('/audit')) return json({ audit: [] })
    if (url.pathname === '/api/v1/tickets/ticket-a') return json(ticket(a))
    if (url.pathname === '/api/v1/tickets/ticket-b') return json(ticket(b))
    if (url.pathname === `/api/v1/tickets/ticket-a/artifacts/${a.artifactId}`) {
      if (delayedA) return aResponse.promise
      return json(artifactResponse(a, changeA))
    }
    if (url.pathname === `/api/v1/tickets/ticket-b/artifacts/${b.artifactId}`) return json(artifactResponse(b))
    return json({ error: { code: 'unknown_fixture', message: 'No such Fixture' } }, 404)
  })
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } })
  vi.stubGlobal('fetch', fetch)
  const workspace = await import('../src/state/workspace')
  workspace.useWorkspace().state.credentialState = 'valid'
  type WorkspaceModule = typeof workspace
  Object.assign(workspace, { state: workspace.useWorkspace().state })
  return { workspace: workspace as WorkspaceModule & { state: ReturnType<WorkspaceModule['useWorkspace']>['state'] }, a, b, aResponse, calls, fetch, changeA: (change: Record<string, unknown>) => { changeA = change }, delayNextA: () => { delayedA = true } }
}
const refFor = (workspace: Awaited<ReturnType<typeof setup>>['workspace'], index = 0) => workspace.useWorkspace().state.ticket!.artifacts![index] as ArtifactRef

afterEach(() => { values.clear(); vi.unstubAllGlobals(); vi.resetModules() })

describe('verified Artifact reads and cache ownership', () => {
  it('accepts only the exact current artifact identity, worker, assignment, hash and size', async () => {
    const { workspace, a } = await setup()
    await workspace.selectTicket(a.id)
    expect(workspace.state.preferences.expanded).toBe(false)
    await workspace.loadArtifact(a.id, refFor(workspace))
    expect(workspace.state.artifacts[a.artifactId].content).toBe(a.body)
    expect(workspace.state.artifacts[a.artifactId].metadata.assignment_id).toBe(a.assignmentId)
    expect(workspace.state.artifacts[a.artifactId].encoding).toBe('utf8')
  })

  it.each([
    ['foreign Ticket owner', { ticket_id: 'ticket-other' }],
    ['wrong worker', { origin_node_id: 'another-node' }],
    ['changed hash', { sha256: 'f'.repeat(64) }],
    ['changed size', { size_bytes: 999 }],
    ['wrong assignment', { assignment_id: 'assignment-other' }],
    ['wrong Artifact ID', { id: 'artifact-other', artifact_id: 'artifact-other' }],
  ])('rejects a mismatched native response: %s', async (_name, change) => {
    const { workspace, a, fetch, changeA, calls } = await setup()
    await workspace.selectTicket(a.id)
    const callsBefore = calls.length
    changeA(change)
    await workspace.loadArtifact(a.id, refFor(workspace))
    expect(fetch).toHaveBeenCalledTimes(callsBefore + 1)
    expect(workspace.state.artifacts[a.artifactId]).toBeUndefined()
    expect(workspace.state.errors[`artifact:${a.artifactId}`]).toContain('does not belong')
  })

  it('does not fetch an unlisted artifact or another selected Ticket, without manufacturing access', async () => {
    const { workspace, a, calls } = await setup()
    await workspace.selectTicket(a.id)
    await workspace.loadArtifact(a.id, { artifact_id: 'unlisted', ticket_id: a.id, origin_node_id: a.nodeId })
    expect(workspace.state.errors['artifact:unlisted']).toContain('不属于当前Ticket')
    await workspace.loadArtifact('another-ticket', { artifact_id: a.artifactId, ticket_id: 'another-ticket', origin_node_id: a.nodeId })
    expect(calls.filter(url => url.includes('/artifacts/'))).toHaveLength(0)
    expect(workspace.state.artifacts[a.artifactId]).toBeUndefined()
  })

  it('drops a late read after another Ticket is selected and then reads B independently', async () => {
    const { workspace, a, b, aResponse, delayNextA } = await setup()
    await workspace.selectTicket(a.id)
    delayNextA()
    const pending = workspace.loadArtifact(a.id, refFor(workspace))
    await vi.waitFor(() => { expect(workspace.state.busy[`artifact:${a.artifactId}`]).toBe(true) })
    await workspace.selectTicket(b.id)
    aResponse.resolve(json(artifactResponse(a)))
    await pending
    expect(workspace.state.selectedTicketId).toBe(b.id)
    expect(workspace.state.artifacts[a.artifactId]).toBeUndefined()
    await workspace.loadArtifact(b.id, refFor(workspace))
    expect(workspace.state.artifacts[b.artifactId].content).toBe(b.body)
    expect(workspace.state.artifacts[a.artifactId]).toBeUndefined()
  })
})
