import type { LoomNode, Project } from '../api/types'

/** Compare only the same already declared root, never infer another directory. */
export function publishedSourceRoot(node: LoomNode | undefined, project: Project | undefined): string {
  if (!node || !project) return ''
  const canonical = node.inventory?.canonical_project_roots?.[project.id]
  if (typeof canonical === 'string') return canonical
  if (node.inventory?.canonical_project_roots) return ''
  const declared = node.inventory?.project_roots?.[project.id]
  return typeof declared === 'string' && declared === project.root ? declared : ''
}
