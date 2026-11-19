import type { Grant, LoomNode, PlacementDecision, PlacementWait, Project } from '../api/types'
import { publishedSourceRoot } from './projectRoot.ts'

/** A deliberately user-visible requirement example, not a model specification. */
export interface ImageEvaluationState {
  busy: boolean
  error?: string
  result?: { decision: PlacementDecision; received_at: string } | null
}

export const IMAGE_HARDWARE_EXAMPLE = Object.freeze({ os: 'macos', arch: 'arm64', minimum_memory_bytes: 64 * 1024 ** 3 })

export function imageGrantCandidates(node: LoomNode, projects: Project[], grants: Grant[]): Grant[] {
  if (typeof node.installation_id !== 'string' || !node.installation_id.trim()) return []
  return grants.filter(grant => grant.node_id === node.id && grant.installation_id === node.installation_id
    && (grant.revoked_at === null || grant.revoked_at === undefined)
    && grant.node_id !== 'auto' && grant.status !== 'revoked' && Array.isArray(grant.operations) && grant.operations.includes('read')
    && typeof grant.project_binding_id === 'string' && grant.project_binding_id
    && typeof grant.worker_id === 'string' && grant.worker_id
    && projects.some(project => project.id === grant.project_id && publishedSourceRoot(node, project).length > 0))
}

function text(value: unknown, max = 1600): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function waitReason(value: unknown): value is PlacementWait {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const wait = value as Record<string, unknown>
  return text(wait.code, 120) && text(wait.source, 80) && text(wait.resource, 240) && text(wait.confidence, 80)
}
/** Only the bounded, known placement response is shown. It cannot become a Grant. */
export function placementResult(value: unknown): PlacementDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (data.schema !== 'loom.inventory.v1' || !text(data.explanation, 5000) || !text(data.permission_boundary, 3000)
    || typeof data.existing_grant_matching_passed !== 'boolean' || !Array.isArray(data.waiting) || data.waiting.length > 64
    || !data.waiting.every(waitReason)) return null
  const selected = data.selected
  if (selected !== null && selected !== undefined) {
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return null
    const identity = selected as Record<string, unknown>
    return ['node_id', 'installation_id', 'worker_id', 'project_binding_id', 'root_scope'].every(key => text(identity[key]))
      ? { schema: 'loom.inventory.v1', selected: identity as unknown as PlacementDecision['selected'], waiting: data.waiting, explanation: data.explanation as string, existing_grant_matching_passed: data.existing_grant_matching_passed, permission_boundary: data.permission_boundary as string }
      : null
  }
  return { schema: 'loom.inventory.v1', selected: null, waiting: data.waiting, explanation: data.explanation as string, existing_grant_matching_passed: data.existing_grant_matching_passed, permission_boundary: data.permission_boundary as string }
}

export function imageWaitMeaning(reason: PlacementWait): string {
  const direct: Record<string, string> = {
    hardware_incompatible: '不满足这次明确写出的硬件条件（并非据此否定所有图像生成）',
    hardware_requirement_unknown: '当前没有足够信息核对这组硬件条件。',
    node_offline: '节点离线；旧库存不等于当前可用。',
    node_busy: '节点正忙；这不等于永久不提供其它操作。',
    stale_heartbeat: '心跳陈旧；保留历史，但不宣称为当前实测。',
    grant_revoked: '引用 Grant 已撤销；不会换绑后偷偷执行。',
    binding_revoked: '对应项目绑定已撤销，不能扩权修改原范围。',
    worker_root_not_declared_exactly: 'Worker 尚未公开匹配的项目根目录，不从名字猜测。',
    grant_operation_missing: '该 Grant 仅适合已列操作；不把它推导成图片执行授权。',
    grant_missing: '仍需明确选择一个现有读取 Grant；此处不会创建授权。',
  }
  return direct[reason.code] ?? `${reason.code}：需要人工核对，不能表述为已支持图像生成。`
}
