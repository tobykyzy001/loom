import { createSSRApp, reactive } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'

// Static subtree rendering is a UI contract check only, not a fake browser or device test.
const sources: Record<string, string> = {}
for (const [name, file] of Object.entries({
  AccessView: '../src/views/AccessView.vue',
  MemoriesView: '../src/views/MemoriesView.vue',
  ProjectBindingDialog: '../src/components/ProjectBindingDialog.vue',
})) {
  sources[name] = (await import(`${file}?raw`)).default
}

type RenderContext = { __teleportBuffers?: Record<string, unknown[]>; teleports?: Record<string, string> }
async function render(component: unknown, props: Record<string, unknown>) {
  const app = createSSRApp(component as Parameters<typeof createSSRApp>[0], reactive(props))
  const context: RenderContext = {}
  const html = await renderToString(app, context)
  const body = context.__teleportBuffers?.body?.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('') ?? ''
  return html + (context.teleports?.body ?? '') + body
}

describe('static usability contracts (SSR, not a browser test)', () => {
  it('uses the current user scope rather than legacy global', async () => {
    const MemoriesView = (await import('../src/views/MemoriesView.vue')).default
    const html = await render(MemoriesView, { memories: [], projects: [] })
    expect(html).toContain('<option value="user">用户级偏好 · 适用于当前用户</option>')
    expect(html).not.toContain('<option value="global">')
    expect(html).not.toContain('<option value="">用户级偏好</option>')
  })

  it('preserves the exact root, does not invent a node, and requires explicit selection', async () => {
    const ProjectBindingDialog = (await import('../src/components/ProjectBindingDialog.vue')).default
    const html = await render(ProjectBindingDialog, { project: { id: 'project-a', name: 'A', root: '/srv/explicit-project', mode: 'read_only' }, nodes: [] })
    expect(html).toContain('/srv/explicit-project')
    expect(html).toContain('尚无已注册节点')
    expect(html).toContain('inventory.project_roots')
    expect(html).not.toContain('<option value="node-a"')
    expect(html).toContain('<button class="button primary" type="submit" disabled>')
  })

  it('keeps node choices explicit rather than silently selecting the first node', async () => {
    const ProjectBindingDialog = (await import('../src/components/ProjectBindingDialog.vue')).default
    const html = await render(ProjectBindingDialog, { project: { id: 'project-a', name: 'A', root: '/srv/explicit-project', mode: 'read_only' }, nodes: [{ id: 'node-a', name: 'Node A' }] })
    expect(html).toContain('value="default"')
    expect(html).toContain('请选择执行所在节点')
    expect(html).toContain('value="node-a"')
    expect(html).not.toContain('value="node-a" selected')
  })
  it('shows the complete Node/Installation choices without silently defaulting the shared-key target', async () => {
    const ProjectBindingDialog = (await import('../src/components/ProjectBindingDialog.vue')).default
    const html = await render(ProjectBindingDialog, {
      project: { id: 'project-b', name: 'B', root: '/owned/actual-b', mode: 'read_write' },
      nodes: [
        { id: 'same-node', name: 'First install', installation_id: 'install-a', revoked_at: null },
        { id: 'same-node', name: 'Second install', installation_id: 'install-b', revoked_at: null },
      ],
    })
    expect(html).toContain('安装 install-a')
    expect(html).toContain('安装 install-b')
    const selected = [...html.matchAll(/<option\b[^>]*>/gu)].find(item => item[0].includes('install-b'))
    expect(selected?.[0]).not.toContain('selected')
    expect(html).toContain('请选择执行所在节点')
  })

  it('exposes missing installation identity and disabled revoked rows without fabricating substitutes', async () => {
    const ProjectBindingDialog = (await import('../src/components/ProjectBindingDialog.vue')).default
    const html = await render(ProjectBindingDialog, {
      project: { id: 'project-b', name: 'B', root: '/owned/actual-b', mode: 'read_write' },
      nodes: [
        { id: 'same-node', name: 'Missing identity', revoked_at: null },
        { id: 'same-node', installation_id: 'revoked-second', revoked_at: '2026-01-01T00:00:00Z' },
      ],
    })
    expect(html).toContain('未提供安装 ID')
    expect(html).toContain('已撤销')
    const target = html.indexOf('revoked-second')
    expect(target).toBeGreaterThan(-1)
    const start = html.lastIndexOf('<option', target)
    const end = html.indexOf('>', target)
    expect(start).toBeGreaterThanOrEqual(0)
    const tag = html.slice(start, end + 1)
    expect(tag).toContain('disabled')
  })
})

describe('typed resource facts view', () => {
  it('shows actual bounded hardware observations and keeps unknown model support honest', async () => {
    const DeviceView = (await import('../src/views/DevicesView.vue')).default
    const html = await render(DeviceView, { nodes: [{ id: 'node-a', installation_id: 'install-a', status: 'online', last_heartbeat: new Date().toISOString(), inventory: {
      schema: 'loom.inventory.v1', freshness: 'fresh', facts: [
        { resource: 'hardware.os', value: 'macos', confidence: 'available', source: 'host_reported' },
        { resource: 'hardware.memory_bytes', value: 17179869184, confidence: 'available', source: 'host_reported' },
        { resource: 'model.adapter', confidence: 'unknown', value: null },
      ],
      project_roots: { 'project-a': '/srv/exact-project' },
    } }] })
    expect(html).toContain('macos')
    expect(html).toContain('16.0 GiB')
    expect(html).toContain('未知（未验证）')
    expect(html).toContain('主机上报')
    expect(html).not.toContain('16 GiB ·')
  })
  it('labels a controller-measured memory fact as such rather than host-reported', async () => {
    const DeviceView = (await import('../src/views/DevicesView.vue')).default
    const html = await render(DeviceView, { nodes: [{ id: 'node-a', installation_id: 'install-a', status: 'online', last_heartbeat: new Date().toISOString(), inventory: {
      schema: 'loom.inventory.v1', freshness: 'fresh', facts: [{ resource: 'hardware.memory_bytes', value: 64000000000, confidence: 'available', source: 'controller_probed' }],
      project_roots: { 'project-a': '/srv/exact-project' },
    } }] })
    expect(html).toContain('59.6 GiB · 控制器实测')
    expect(html).not.toContain('59.6 GiB · 主机上报')
  })
})

describe('credential recovery presentation', () => {
  it('renders verification in progress and preserves masked credential input', async () => {
    const ConnectionDialog = (await import('../src/components/ConnectionDialog.vue')).default
    const html = await render(ConnectionDialog, { checking: true, error: '凭证验证失败' })
    expect(html).toContain('正在验证连接…')
    expect(html).toContain('type="password"')
    expect(html).toContain('凭证验证失败')
    expect(html).toContain('disabled')
    expect(html).toContain('只有受保护读取通过后')
   })
})

describe('static expert inspection anchors', () => {
  it('shows how read_write is communicated on the create form, not only in the confirmation', () => {
    expect(sources.AccessView).toContain("'read_write'")
    expect(sources.AccessView).toContain('这包含读取 + 写入')
    expect(sources.AccessView).toContain('operations={{ JSON.stringify(reviewedGrant.operations) }}')
  })

  it('keeps binding separate from Grant creation and uses the existing near-screen confirmation pattern', () => {
    expect(sources.ProjectBindingDialog).toContain('此步骤只建立精确绑定，之后仍需单独创建 Grant')
    expect(sources.ProjectBindingDialog).toContain('value.worker_id.trim()')
  })
})
