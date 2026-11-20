import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { canEditMemoryScope, memoryEditProjectId, memoryMatchesScope, memoryScopeLabel } from '../src/lib/memoryScope'
import type { Memory, Project } from '../src/api/types'

const projects: Project[] = [
  { id: 'project-a', name: 'Alpha', root: '/tmp/a' },
  { id: 'project-b', name: 'Bravo', root: '/tmp/b' },
] as Project[]
const memory = (scope: string, project_id = 'project-a'): Memory => ({ id: `memo-${scope}`, scope, project_id, content: `${scope} preference` })

describe('Memory scope identity instead of project-id heuristics', () => {
  it('retains user/worker/host identity and never treats other scopes as implicit user', async () => {
    const html = await renderToString(createSSRApp((await import('../src/views/MemoriesView.vue')).default, {
      memories: [memory('user'), memory('worker'), memory('host')], projects,
    }))
    expect(html).toContain('用户级偏好')
    expect(html).toContain('worker 范围')
    expect(html).toContain('host 范围')
    expect(html).not.toContain('仅限 host')
    const buttons = html.match(/<button[^>]*aria-label="编辑记忆"[^>]*>/g) ?? []
    expect(buttons).toHaveLength(3)
    expect(buttons[0]).not.toContain('disabled')
    expect(buttons[1]).toContain('disabled')
    expect(buttons[2]).toContain('disabled')
  })

  it('supports only user/project editing without transforming other scope facts', () => {
    expect(canEditMemoryScope('user')).toBe(true)
    expect(canEditMemoryScope('project')).toBe(true)
    for (const scope of ['worker', 'host', 'global', null, undefined, 7]) {
      expect(canEditMemoryScope(scope)).toBe(false)
      expect(memoryScopeLabel(scope, null, projects)).not.toBe('用户级偏好')
    }
  })

  it('does not treat a User Memory with a project association as a project-scope choice', () => {
    expect(memoryScopeLabel('user', 'project-b', projects)).toBe('用户级偏好')
    expect(memoryMatchesScope('user', 'project-a', 'user')).toBe(true)
    expect(memoryMatchesScope('user', 'project-a', 'project-b')).toBe(false)
    expect(memoryMatchesScope('user', 'project-b', 'user')).toBe(true)
    expect(memoryMatchesScope('user', 'project-b', 'project-b')).toBe(true)
    expect(memoryMatchesScope('user', 'project-b', 'all')).toBe(true)
  })

  it('retains existing user/project association only when the scope itself does not change', () => {
    for (const options of [
      { editing: true, originalScope: 'user', selectedScope: 'user', projectId: 'project-b' },
      { editing: true, originalScope: 'project', selectedScope: 'user', projectId: 'project-a' },
      { editing: true, originalScope: 'user', selectedScope: 'project', projectId: 'project-b' },
      { editing: false, originalScope: 'project', selectedScope: 'user', projectId: '' },
      { editing: true, originalScope: 'worker', selectedScope: 'user', projectId: '' },
    ]) {
      expect(memoryEditProjectId(options)).toBe({
        user_user: 'project-b', project_user: null,
        user_project: 'project-b', project_user_new: null, worker_user: null,
      }[options.originalScope + '_' + options.selectedScope + (options.editing ? '' : '_new')] ?? null)
    }
    expect(memoryEditProjectId({ editing: true, originalScope: 'project', selectedScope: 'project', projectId: '' })).toBeNull()
  })
})
