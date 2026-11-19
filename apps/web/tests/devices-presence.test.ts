import { describe, it, expect } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import DevicesView from '../src/views/DevicesView.vue'
import { heartbeatStale, nodeOnline } from '../src/lib/format'
import type { LoomNode } from '../src/api/types'

const node = (values: Partial<LoomNode> = {}): LoomNode => ({
  id: '11111111-1111-4111-8111-111111111111',
  installation_id: 'installation-online-before-timeout',
  status: 'online', online: true, freshness: 'fresh',
  last_heartbeat: new Date().toISOString(), ...values,
})

describe('controller-backed device presence', () => {
  it('honors explicit stale/offline, retains fresh busy work, and isolates revocation', () => {
    expect(nodeOnline(node({ status: 'busy', online: true }))).toBe(true)
    expect(nodeOnline(node({ status: 'degraded', online: true }))).toBe(true)
    expect(nodeOnline(node({ online: false, status: 'online', freshness: 'stale_offline' }))).toBe(false)
    expect(nodeOnline(node({ online: false, status: 'busy', freshness: 'stale_offline' }))).toBe(false)
    expect(nodeOnline(node({ online: true, revoked_at: new Date().toISOString() }))).toBe(false)
    expect(nodeOnline({ status: 'online', last_heartbeat: new Date().toISOString() })).toBe(true)
    expect(nodeOnline({ status: 'online', last_heartbeat: '2000-01-01T00:00:00Z' })).toBe(false)
    expect(nodeOnline({ status: 'revoked', revoked_at: null })).toBe(false)
    expect(heartbeatStale(new Date(0).toISOString())).toBe(true)
    expect(heartbeatStale('2050-01-01T00:00:00+00:00')).toBe(false)
    expect(heartbeatStale()).toBe(true)
    expect(heartbeatStale('corrupt-time')).toBe(false)
  })

  it('renders the authoritative stale card with zero online count and its original heartbeat, not current-online claims', async () => {
    const original = '2000-01-01T00:00:00Z'
    const html = await renderToString(createSSRApp(DevicesView, {
      nodes: [node({ online: false, freshness: 'stale_offline', last_heartbeat: original })],
    }))
    expect(html).toMatch(/class="summary-number"[^>]*><strong[^>]*>0<\/strong>/)
    expect(html).toContain('data-device-presence="offline"')
    expect(html).toContain('离线')
    expect(html).toContain('心跳陈旧')
    expect(html).toContain('这是末次心跳快照')
    expect(html).toContain('2000')
  })

  it('renders a revoked identity separately and keeps recent online/degraded status for normal nodes', async () => {
    const revoked = await renderToString(createSSRApp(DevicesView, { nodes: [node({ online: false, status: 'revoked', revoked_at: '2000-01-01T00:00:00Z' })] }))
    expect(revoked).toContain('已撤销')
    expect(revoked).toContain('data-device-presence="revoked"')
    expect(revoked).toMatch(/class="summary-number"[^>]*><strong[^>]*>0<\/strong>/)
    const active = await renderToString(createSSRApp(DevicesView, { nodes: [node({ status: 'busy', online: true })] }))
    expect(active).toContain('data-device-presence="active"')
    expect(active).toContain('忙碌')
    expect(active).toMatch(/class="summary-number"[^>]*><strong[^>]*>1<\/strong>/)
  })
})
