import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import type { Grant } from '../src/api/types'
import { activeGrantCount, grantStatus, grantStatusLabel } from '../src/lib/grantStatus'

const CLIENT_TOKEN = 'fixture-client-token'
const GRANT_ID = 'grant/revoke ?#%'
const originalGrant: Grant = {
  id: GRANT_ID, version: 1, project_id: 'project-fixture', node_id: 'node-fixture',
  operations: ['read'], status: 'active', revoked_at: null,
}
const revokedGrant: Grant = { ...originalGrant, version: 2, revoked_at: '2026-11-18T12:00:00Z' }

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
})
const failure = (status: number) => json({ error: { code: 'fixture_failure', message: 'Fixture request failed' } }, status)

function localStore() {
  const values = new Map<string, string>()
  return { values, window: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

interface Fixture {
  revoke?: Response
  grants?: Response
  resources?: Partial<Record<'projects' | 'nodes' | 'memories' | 'candidates', Response | Promise<Response>>>
}

async function setup(fixture: Fixture, initialGrants: Grant[] = [originalGrant]) {
  const store = localStore()
  store.values.set('loom.client-token', CLIENT_TOKEN)
  const requests: Array<{ path: string; method: string; body?: unknown; authorization: string | null }> = []
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const path = new URL(String(input), 'http://fixture.invalid').pathname
    const method = init?.method ?? 'GET'
    requests.push({
      path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('Authorization'),
    })
    if (path === `/api/v1/grants/${encodeURIComponent(GRANT_ID)}/revoke` && method === 'POST') {
      return fixture.revoke ?? json({ revoked: true, grant_id: GRANT_ID })
    }
    const resource = path.slice('/api/v1/'.length) as 'projects' | 'nodes' | 'memories' | 'grants' | 'candidates'
    if (method !== 'GET') return failure(500)
    if (resource === 'grants') return fixture.grants ?? json({ grants: [revokedGrant] })
    return await (fixture.resources?.[resource] ?? json(resource === 'nodes' ? { nodes: [] } : resource === 'memories' ? { memories: [] } : resource === 'candidates' ? { candidates: [] } : { projects: [] }))
  })
  vi.stubGlobal('window', store.window)
  vi.stubGlobal('fetch', fetch)
  vi.resetModules()
  const workspace = await import('../src/state/workspace')
  const state = workspace.useWorkspace().state
  // Test-only prior authenticated snapshot; production revocation never locally writes this badge at HTTP 200.
  state.credentialState = 'valid'
  state.grants = structuredClone(initialGrants)
  return { ...workspace, state, requests }
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe('Grant revocation view semantics', () => {
  it('prioritizes actual revoked_at, retains legacy revocation, and never defaults unknown status to active', () => {
    const fixtures: Grant[] = [
      { ...originalGrant, revoked_at: revokedGrant.revoked_at },
      { ...originalGrant, status: 'revoked' },
      { ...originalGrant, status: undefined },
      { ...originalGrant, status: 'future_status' },
    ]
    expect(fixtures.map(grantStatus)).toEqual(['revoked', 'revoked', 'active', 'unknown'])
    expect(fixtures.map(grantStatusLabel)).toEqual(['已撤销', '已撤销', '有效', '未知状态：future_status'])
    expect(activeGrantCount(fixtures)).toBe(1)
  })

  it('renders the actual badge/count, suppresses repeat revocation, and preserves Grant IDs', async () => {
    const AccessView = (await import('../src/views/AccessView.vue')).default
    const app = createSSRApp(AccessView, {
      grants: [
        { ...originalGrant, id: 'stale-active', revoked_at: revokedGrant.revoked_at },
        { ...originalGrant, id: 'legacy-revoked', status: 'revoked' },
        { ...originalGrant, id: 'legacy-active', status: undefined },
        { ...originalGrant, id: 'future-status', status: 'future_status' },
      ], projects: [], nodes: [],
    })
    const html = await renderToString(app)
    expect(html).toContain('项目授权 <span class="count-pill">1</span>')
    expect(html).toContain('<span class="neutral status-badge">已撤销</span>')
    expect(html).toContain('<span class="success status-badge">有效</span>')
    expect(html).toContain('未知状态：future_status')
    expect(html.match(/撤销授权/g)).toHaveLength(1)
    for (const id of ['stale-active', 'legacy-revoked', 'legacy-active', 'future-status']) expect(html).toContain(`<code>${id}</code>`)
  })
})

describe('authenticated workspace Grant revocation', () => {
  it('uses an exact client-authenticated POST and returns true only after loading the authoritative revoked_at', async () => {
    const before = [structuredClone(originalGrant)]
    const workspace = await setup({ revoke: json({ revoked: true, grant_id: GRANT_ID }) })
    const pending = workspace.revokeGrant(GRANT_ID)
    expect(workspace.state.grants).toEqual(before) // No optimistic local revocation.
    expect(await pending).toBe(true)
    const revoke = workspace.requests.find(request => request.method === 'POST')
    expect(revoke).toMatchObject({
      path: `/api/v1/grants/${encodeURIComponent(GRANT_ID)}/revoke`,
      body: {}, authorization: `Bearer ${CLIENT_TOKEN}`,
    })
    expect(workspace.requests.map(request => `${request.method} ${request.path}`)).toEqual([
      `POST /api/v1/grants/${encodeURIComponent(GRANT_ID)}/revoke`,
      'GET /api/v1/nodes', 'GET /api/v1/memories', 'GET /api/v1/grants', 'GET /api/v1/candidates',
    ])
    expect(workspace.requests.every(request => request.authorization === `Bearer ${CLIENT_TOKEN}`)).toBe(true)
    expect(workspace.state.grants).toEqual([revokedGrant])
    expect(grantStatus(workspace.state.grants[0])).toBe('revoked')
    expect(grantStatusLabel(workspace.state.grants[0])).toBe('已撤销')
    expect(activeGrantCount(workspace.state.grants)).toBe(0)
    expect(workspace.state.errors['grant-write']).toBe('')
  })

  it('keeps confirmation busy after acknowledgment until the ordinary resource read finishes', async () => {
    const read = deferred<Response>()
    const workspace = await setup({ resources: { nodes: read.promise } })
    const pending = workspace.revokeGrant(GRANT_ID)
    await vi.waitFor(() => { expect(workspace.state.busy.resources).toBe(true) })
    expect(workspace.state.busy['grant-write']).toBe(false)
    expect(workspace.state.grants).toEqual([originalGrant])
    const appSource = (await import('../src/App.vue?raw')).default as string
    expect(appSource).toMatch(/confirmationBusy = computed\(\(\) => .*state\.busy\.resources.*\)/)
    read.resolve(json({ nodes: [] }))
    expect(await pending).toBe(true)
    expect(workspace.state.busy.resources).toBe(false)
  })

  it('keeps the stale snapshot and confirms failure separately when the accepted revocation cannot refresh', async () => {
    const before = [structuredClone(originalGrant)]
    const workspace = await setup({ grants: failure(500) })
    expect(await workspace.revokeGrant(GRANT_ID)).toBe(false)
    expect(workspace.state.errors['grant-write']).toBe('中心已确认撤销，但最新授权列表未刷新；当前卡片只有先前快照，不意味着授权仍然有效。')
    expect(workspace.state.grants).toEqual(before)
    expect(workspace.state.grants[0].revoked_at).toBeNull()
    expect(workspace.requests.map(request => request.path)).toContain('/api/v1/grants')
  })

  it('does not refresh or change local revocation after a POST 401', async () => {
    const before = [structuredClone(originalGrant)]
    const workspace = await setup({ revoke: failure(401) })
    expect(await workspace.revokeGrant(GRANT_ID)).toBe(false)
    expect(workspace.state.credentialState).toBe('required')
    expect(workspace.state.errors['grant-write']).toContain('凭据已失效')
    expect(workspace.state.grants).toEqual(before)
    expect(workspace.requests).toHaveLength(1)
    expect(workspace.requests[0]).toMatchObject({ method: 'POST', authorization: `Bearer ${CLIENT_TOKEN}` })
  })

  it('does not turn a truthy revocation receipt for another Grant into local success', async () => {
    const workspace = await setup({ revoke: json({ revoked: true, grant_id: 'another-grant' }) })
    expect(await workspace.revokeGrant(GRANT_ID)).toBe(false)
    expect(workspace.state.errors['grant-write']).toContain('未确认这个精确 Grant')
    expect(workspace.state.grants).toEqual([originalGrant])
    expect(workspace.requests).toHaveLength(1)
  })
})
