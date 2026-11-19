import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import ProjectsView from '../src/views/ProjectsView.vue'
import { probeProjectResultFrom, projectInventoryFrom, projectsFrom } from '../src/api/parsing'
import type { Project } from '../src/api/types'

const at = '2026-11-19T10:00:00Z'
const revision = 'a'.repeat(40)
const publicInventory = {
  form: 'working_tree', git_available: true, revision, dirty: false,
  canonical_remote: 'https://example.invalid/team/repo.git', canonical_remote_status: 'public',
  redacted_remote: false, needs_review: false,
  source: 'controller_probe', probed_at: at,
  credential_available: 'unknown', credential_location: null, credential_lookup_performed: false,
}
const sample = (changes: Record<string, unknown> = {}): Project => ({
  id: 'project-a', name: 'Isolated worktree', mode: 'read_only', root: '/private/fixture/project', inventory: { ...publicInventory, ...changes },
})

describe('bounded project inventory projection', () => {
  it('renders actual sanitized Git facts without inferring an active remote or extra authority', () => {
    const [project] = projectsFrom({ projects: [sample()] })
    expect(project?.inventory?.canonical_remote).toBe('https://example.invalid/team/repo.git')
    expect(project?.inventory?.revision).toHaveLength(40)
    expect(project?.inventory?.dirty).toBe(false)
    expect(project?.inventory?.credential_lookup_performed).toBe(false)
    expect(project?.inventory?.credential_available).toBe('unknown')
  })

  it('never displays an unsafe remote, private Git configuration or unlisted metadata', () => {
    const secret = 'user:must-not-appear@invalid'
    const redacted = projectInventoryFrom({ ...publicInventory, canonical_remote: `https://${secret}/repo`, canonical_remote_status: 'unsupported_or_redacted', redacted_remote: true, needs_review: true })
    expect(redacted?.canonical_remote).toBeNull()
    expect(redacted?.canonical_remote_status).toBe('unsupported_or_redacted')
    expect(redacted?.needs_review).toBe(true)
    const conflicting = projectInventoryFrom({ ...publicInventory, canonical_remote: `https://${secret}/repo`, redacted_remote: true, canonical_remote_status: 'public' })
    expect(conflicting?.canonical_remote).toBeNull()
  })

  it('does not confuse documents with a Git repository', () => {
    const inventory = projectInventoryFrom({ form: 'documents', git_available: false, revision: null, dirty: null, canonical_remote: null, canonical_remote_status: null, source: 'controller_probe', probed_at: at })
    expect(inventory?.form).toBe('documents')
    expect(inventory?.revision).toBeNull()
    expect(inventory?.git_available).toBe(false)
    expect(inventory?.canonical_remote).toBeNull()
    const unknownGitChanges = projectInventoryFrom({ ...publicInventory, dirty: null })
    expect(unknownGitChanges?.form).toBe('working_tree')
    expect(unknownGitChanges?.dirty).toBeUndefined()
  })

  it('rejects dirty/timestamps/revisions whose type or validity cannot be trusted, and opaque inventory', () => {
    expect(projectInventoryFrom({ ...publicInventory, revision: 'deadbeef' })).toBeNull()
    expect(projectInventoryFrom({ ...publicInventory, dirty: 'true' })).toBeNull()
    expect(projectInventoryFrom({ ...publicInventory, probed_at: 'not-a-time' })).toBeNull()
    expect(projectInventoryFrom({ ...publicInventory, form: 'private-credential-bearing-field' })).toBeNull()
    expect(projectInventoryFrom('serialized-git-config')).toBeNull()
    expect(projectInventoryFrom(null)).toBeNull()
    expect(projectInventoryFrom({ ...publicInventory, needs_review: 'unknown' })).toBeNull()
  })

  it('requires a true read-only receipt for the same project and complete public inventory', () => {
    const value = { project: sample(), read_only_probe: true }
    const parsed = probeProjectResultFrom(value, 'project-a')
    expect(parsed?.id).toBe('project-a')
    expect(probeProjectResultFrom(value, 'other-project')).toBeNull()
    expect(probeProjectResultFrom({ ...value, read_only_probe: false }, 'project-a')).toBeNull()
    expect(probeProjectResultFrom({ ...value, read_only_probe: undefined }, 'project-a')).toBeNull()
    expect(probeProjectResultFrom({ ...value, project: { ...sample(), inventory: 'opaque-private-config' } }, 'project-a')).toBeNull()
    const { inventory: omitted, ...withoutInventory } = sample()
    expect(probeProjectResultFrom({ project: withoutInventory, read_only_probe: true }, 'project-a')).toBeNull()
    expect(probeProjectResultFrom({ project: sample({ dirty: null }), read_only_probe: true }, 'project-a')?.inventory?.dirty).toBeUndefined()
  })
})

describe('real Projects view of public evidence', () => {
  const render = async (project: Project) => renderToString(createSSRApp(ProjectsView, { projects: [project], nodes: [], expanded: false, preferencesBusy: false }))
  it('renders working-tree status, public remote, observation timestamp and credential boundaries', async () => {
    const html = await render(sample())
    expect(html).toContain('Git 工作树')
    expect(html).toContain(revision)
    expect(html).toContain('https://example.invalid/team/repo.git')
    expect(html).toContain('控制器本地只读检查')
    expect(html).toContain('未执行凭据读取')
    expect(html).toContain('不 clone/fetch、不运行项目')
    expect(html).toContain('data-project-probe="project-a"')
    expect(html).not.toContain('<a href=')
  })

  it('presents withheld remote metadata without secret fallback, labels documents separately and preserves probe errors', async () => {
    const withheld = await render(sample({ canonical_remote: null, canonical_remote_status: 'unsupported_or_redacted', needs_review: true, redacted_remote: true, extra_secret: 'must-not-render' }))
    expect(withheld).toContain('已排除不安全或含凭据的远端地址')
    expect(withheld).not.toContain('must-not-render')
    const documents = await render(sample({ form: 'documents', git_available: false, revision: null, dirty: null, canonical_remote: null, canonical_remote_status: null }))
    expect(documents).toContain('普通资料目录（非 Git）')
    expect(documents).not.toContain('HEAD（基线')
    const errors = await renderToString(createSSRApp(ProjectsView, { projects: [sample()], nodes: [], expanded: false, probeBusy: { 'project-probe:project-a': false }, probeErrors: { 'project-probe:project-a': 'probe failed safely' } }))
    expect(errors).toContain('刷新未完成，保留原已知观测')
    expect(errors).toContain('probe failed safely')
  })
})
