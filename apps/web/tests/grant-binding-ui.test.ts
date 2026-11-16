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
