import type { Project } from '../api/types'

// A project relation is metadata, not a replacement for Memory.scope.
// Preserve other supported backend scopes instead of silently relabelling them.
export function canEditMemoryScope(scope: unknown): boolean {
  return scope === 'user' || scope === 'project'
}

export function memoryScopeLabel(scope: unknown, projectId: string | null | undefined, projects: Project[]): string {
  if (scope === 'user') return '用户级偏好'
  if (scope === 'project') return projects.find(project => project.id === projectId)?.name ?? '项目范围'
  if (scope === 'worker' || scope === 'host') return `${scope} 范围`
  return typeof scope === 'string' && scope ? `${scope}（只读）` : '未标明作用域'
}

export function memoryMatchesScope(scope: unknown, projectId: string | null | undefined, selectedFilter: string): boolean {
  if (selectedFilter === 'all') return true
  if (selectedFilter === 'user') return scope === 'user'
  return projectId === selectedFilter
}

export function memoryEditProjectId(options: {
  editing: boolean
  originalScope: string
  selectedScope: string
  projectId: string
}): string | null {
  const { editing, originalScope, selectedScope, projectId } = options
  const explicitProject = projectId || null
  if (selectedScope === 'project') return explicitProject
  // Preserve an existing user preference's project association only when its
  // scope is unchanged. Project -> user is an intentional scope conversion.
  if (editing && originalScope === 'user' && selectedScope === 'user') return explicitProject
  return null
}
