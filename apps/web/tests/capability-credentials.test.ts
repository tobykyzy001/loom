import { describe, expect, it, vi } from 'vitest'
import { startRustConcierge, testingRoot } from '../../../scripts/fixtures/rust-server.mjs'
import { placementResult } from '../src/lib/imageAvailability'

const memoryStorage = () => {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  } as Storage
}

describe('real workspace credential lifecycle for condition-only evaluation', () => {
  it('normalizes a real invalid token into required, then prevents the read-only POST from becoming a privileged bypass', async () => {
    const root = await testingRoot()
    let server: Awaited<ReturnType<typeof startRustConcierge>> | undefined
    try {
      server = await startRustConcierge({ root })
      vi.stubGlobal('window', { localStorage: memoryStorage() })
      vi.stubGlobal('localStorage', window.localStorage)
      const nativeFetch = globalThis.fetch
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const route = String(input)
        if (!route.startsWith('/api/v1/')) throw new Error('This test may only call its owned Concierge API')
        return nativeFetch(new URL(route, server!.baseUrl), init)
      })
      vi.stubGlobal('fetch', fetch)
      const { evaluatePlacement, reconnect, useWorkspace } = await import('../src/state/workspace')
      const { state } = useWorkspace()
      expect(await reconnect(server.clientToken)).toBe(true)
      const request = { project_id: 'no-project', capability: 'read_summary', grant_id: 'no-grant', project_binding_id: 'no-binding', worker_id: 'default', node_id: 'f'.repeat(64) }
      const valid = placementResult(await evaluatePlacement(request))
      expect(valid?.schema).toBe('loom.inventory.v1')
      expect(valid?.selected).toBeNull()
      expect(valid?.waiting.some(row => row.code === 'grant_missing')).toBe(true)
      expect(state.credentialState).toBe('valid')

      expect(await reconnect('not-the-owned-client-token')).toBe(false)
      expect(state.credentialState).toBe('required')
      const callsAfter401 = fetch.mock.calls.length
      await expect(evaluatePlacement(request)).rejects.toThrow(/凭据已失效|认证尚未完成/)
      expect(state.credentialState).toBe('required')
      expect(fetch).toHaveBeenCalledTimes(callsAfter401)
      expect(await reconnect(server.clientToken)).toBe(true)
      const restored = placementResult(await evaluatePlacement(request))
      expect(restored?.waiting[0]?.code).toBe('grant_missing')
      expect(restored?.selected).toBeNull()
      expect(await nativeFetch(`${server.baseUrl}/api/v1/tickets`, { headers: { authorization: `Bearer ${server.clientToken}` } }).then(value => value.json())).toMatchObject({ tickets: [] })
    } finally {
      await server?.stop().catch(() => {})
      vi.unstubAllGlobals()
    }
  })
})
