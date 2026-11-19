import type { LoomNode, Project, ProjectBindingInput } from './api/types'

export type BindingIssue =
  | 'no_node'
  | 'not_usable'
  | 'ambiguous_identity'
  | 'root_required'
  | 'selection_required'
  | 'invalid_selection'
  | 'worker_required'
  | null

/** One record may use its legacy node-only key; more require the exact pair. */
export function nodeOptionKey(node: LoomNode, group?: LoomNode[]): string {
  if (!group) return JSON.stringify([node.id, node.installation_id ?? null])
  const count = group.filter(row => row.id === node.id && !row.revoked_at).length
  return count > 1 ? JSON.stringify([node.id, node.installation_id ?? null]) : node.id
}

function usable(node: LoomNode): boolean {
  return !node.revoked_at
}

function completeIdentity(node: LoomNode): boolean {
  return typeof node.installation_id === 'string'
    && node.installation_id.trim().length > 0 && node.installation_id.length <= 160
}

/**
 * Parse only for matching a reviewed record. An explicit tuple never becomes
 * root, Worker, a new Grant, or another record's credential.
 */
function parseIdentity(input: string): readonly [string, string | null] | null {
  if (!input) return null
  if (!input.startsWith('[')) return [input, null]
  try {
    const value = JSON.parse(input)
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string'
      || !value[0] || (value[1] !== null && typeof value[1] !== 'string')) return null
    return [value[0], value[1]]
  } catch {
    return null
  }
}

/** The one shared predicate for button enabling and the emitted exact request. */
export function selection(
  project: Project,
  nodes: LoomNode[],
  key: string,
  worker: string,
): { issue: BindingIssue; payload: ProjectBindingInput | null; requiresInstallation: boolean } {
  if (!nodes.length) return { issue: 'no_node', payload: null, requiresInstallation: false }
  if (!project.root?.trim()) return { issue: 'root_required', payload: null, requiresInstallation: false }
  const identity = parseIdentity(key)
  if (!identity) return { issue: key ? 'invalid_selection' : 'selection_required', payload: null, requiresInstallation: false }
  const count = nodes.filter(node => node.id === identity[0] && usable(node)).length
  const required = count > 1
  if (required && !key.startsWith('[')) {
    return { issue: 'selection_required', payload: null, requiresInstallation: true }
  }
  const row = nodes.find(node => node.id === identity[0]
    && (!key.startsWith('[') || (node.installation_id ?? null) === identity[1]))
  if (!row) return { issue: 'not_usable', payload: null, requiresInstallation: required }
  if (!usable(row)) return { issue: 'not_usable', payload: null, requiresInstallation: required }
  if (!worker.trim()) return { issue: 'worker_required', payload: null, requiresInstallation: required }
  if (required) {
    const sameNode = nodes.filter(node => node.id === identity[0] && usable(node))
    const ids = sameNode.map(node => node.installation_id)
    if (!sameNode.every(completeIdentity) || new Set(ids).size < sameNode.length) {
      return { issue: 'ambiguous_identity', payload: null, requiresInstallation: true }
    }
    if (!completeIdentity(row)) return { issue: 'ambiguous_identity', payload: null, requiresInstallation: true }
  }
  return {
    issue: null,
    payload: {
      project_id: project.id,
      node_id: row.id,
      worker_id: worker.trim(),
      root_scope: project.root,
      // Preserve the exact legacy object: no empty selector on a sole active
      // Installation, even if there are other historical/revoked rows.
      ...(required ? { installation_id: row.installation_id } : {}),
    },
    requiresInstallation: required,
  }
}
