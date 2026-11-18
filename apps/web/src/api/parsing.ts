import type { ApiErrorBody, ArtifactContent, ArtifactRef, AuditEntry, Bootstrap, Effect, Grant, LoomNode, Memory, Message, Preferences, Project, Report, SourceEvent, SourceRegistration, SourceThread, SourceTicketReceipt, SourceWorkDraft, SourceWorkSpec, Ticket } from './types'

export function listOf<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    for (const key of [...keys, 'items', 'data']) {
      const candidate = (value as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) return candidate as T[]
    }
  }
  return []
}

export const projectsFrom = (value: unknown) => listOf<Project>(value, ['projects'])
export const grantsFrom = (value: unknown) => listOf<Grant>(value, ['grants'])
export const memoriesFrom = (value: unknown) => listOf<Memory>(value, ['memories'])
export const auditFrom = (value: unknown) => listOf<AuditEntry>(value, ['audit', 'entries'])
export const nodesFrom = (value: unknown) => listOf<LoomNode>(value, ['nodes']).map(nodeFrom)
export const ticketsFrom = (value: unknown) => listOf<Ticket>(value, ['tickets']).map(ticketFrom)

export function ticketFrom(value: unknown): Ticket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Ticket response must be an object.')
  const ticket = { ...value } as Ticket
  // Intermediate cancellation intent is not evidence of acknowledged cancellation.
  ticket.cancel_requested = ticket.cancel_requested === true || (ticket as unknown as { status: string }).status === 'cancel_requested'
  // cancel_requested is left as a visible transitional status, never final success/cancellation.
  ticket.reports = (ticket.reports ?? []).map(report => ({ ...report, status: validReportStatus(report.state ?? report.status) }))
  ticket.effects = (ticket.effects ?? []).map(effect => ({ ...effect, effect_id: effect.effect_id ?? (effect as Effect & { id?: string }).id }))
  ticket.artifacts = (ticket.artifacts ?? []).map(artifact => ({ ...artifact, artifact_id: artifact.artifact_id ?? (artifact as ArtifactRef & { id?: string }).id, type: artifact.type ?? (artifact as ArtifactRef & { name?: string }).name }))
  ticket.messages = (ticket.messages ?? [])
    .filter(message => message.visible !== false && ('visibility' in message ? !['private', 'denied'].includes(String((message as Message & { visibility: string }).visibility)) : true))
    .map(message => ({
      ...message,
      sender_kind: message.sender_kind ?? message.sender,
      segment: message.segment ?? (['collaboration', 'session_link'].includes((message as Message & { kind?: string }).kind || '') ? 'collaboration' : 'activity'),
    }))
  return ticket
}

function validReportStatus(status?: string): Report['status'] {
  return status === 'running' || status === 'succeeded' || status === 'failed' || status === 'cancelled' ? status : 'unknown'
}
export function nodeFrom(node: LoomNode): LoomNode {
  return { ...node, status: node.revoked_at ? 'offline' : node.online === true ? 'online' : node.online === false ? 'offline' : node.status ?? 'offline' }
}
export function projectFrom(value: unknown): Project | null {
  if (!value || typeof value !== 'object') return null
  const root = value as { project?: Project } & Partial<Project>
  return root.project ?? (root.id ? root as Project : null)
}
export function ticketResponseFrom(value: unknown): Ticket | null {
  if (!value || typeof value !== 'object' || !('id' in value)) return null
  return ticketFrom(value)
}
export function artifactFrom(value: unknown): ArtifactContent {
  if (!value || typeof value !== 'object') throw new Error('Invalid artifact response')
  const result = value as Record<string, unknown>
  const source = (result.metadata ?? result.artifact ?? value) as ArtifactRef & { id?: string; name?: string }
  const metadata: ArtifactRef & { id?: string; name?: string } = { ...source, artifact_id: source.artifact_id ?? source.id ?? '' }
  metadata.type = source.type ?? source.name
  return {
    metadata,
    content: typeof result.content === 'string' ? result.content : '',
    encoding: result.encoding === 'base64' ? 'base64' : 'utf8',
    truncated: result.truncated === true,
  }
}
export function preferencesFrom(value: unknown): Preferences {
  const result = (value ?? {}) as Partial<Preferences>
  return { expanded: result.expanded === true, sender_filter: result.sender_filter ?? null }
}
export function isProtocolError(value: unknown): value is ApiErrorBody {
  return !!value && typeof value === 'object' && typeof (value as ApiErrorBody).error?.code === 'string' && typeof (value as ApiErrorBody).error?.message === 'string'
}
export function defaultTicketId(bootstrap: Bootstrap | null): string | null {
  if (!bootstrap) return null
  return bootstrap.default_ticket_id ?? bootstrap.ticket_id ?? bootstrap.default_ticket?.id ?? bootstrap.tickets?.[0]?.id ?? null
}

function sourceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source 响应格式无效，未用于创建工作或授权。')
  return value as Record<string, unknown>
}
function requiredSourceText(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== 'string' || !(record[key] as string).length) throw new Error(`Source 响应缺少有效 ${key}；未用于创建工作或授权。`)
  return record[key] as string
}
function optionalSourceText(record: Record<string, unknown>, key: string): string | null {
  if (record[key] === undefined || record[key] === null) return null
  if (typeof record[key] !== 'string') throw new Error(`Source 响应的 ${key} 类型无效。`)
  return record[key] as string
}
function requiredSourceBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== 'boolean') throw new Error(`Source 响应缺少布尔 ${key}；未用于决定任务或授权状态。`)
  return record[key] as boolean
}
function requiredSourceSequence(record: Record<string, unknown>, key: string): number {
  if (typeof record[key] !== 'number' || !Number.isSafeInteger(record[key]) || (record[key] as number) < 0) throw new Error(`Source 响应的 ${key} 序号无效。`)
  return record[key] as number
}

export function sourceRegistrationFrom(value: unknown): SourceRegistration {
  const root = sourceObject(value)
  const source = sourceObject(root.source)
  if (source.kind !== 'web') throw new Error('只支持已登记的 web Source。')
  const duplicate = requiredSourceBoolean(root, 'duplicate')
  if (root.task_created !== false || root.permission_granted !== false) throw new Error('Source 注册不授权或创建任务；回包与这一边界不符。')
  return {
    source: {
      ...source,
      id: requiredSourceText(source, 'id'), source_key: requiredSourceText(source, 'source_key'), kind: 'web',
      label: optionalSourceText(source, 'label'),
    } as SourceRegistration['source'],
    duplicate, task_created: false, permission_granted: false,
  }
}

export function sourceEventFrom(value: unknown): SourceEvent {
  const record = sourceObject(value)
  if (record.kind !== 'user_message') throw new Error('只有 user_message Source 事件可进入此面板。')
  const ticketId = optionalSourceText(record, 'ticket_id')
  const taskSpec = record.task_spec === undefined || record.task_spec === null ? null : sourceSpecFrom(record.task_spec)
  return {
    ...record, task_spec: taskSpec,
    id: requiredSourceText(record, 'id'), source_id: requiredSourceText(record, 'source_id'),
    thread_id: requiredSourceText(record, 'thread_id'), client_thread_id: requiredSourceText(record, 'client_thread_id'),
    external_event_id: requiredSourceText(record, 'external_event_id'), kind: 'user_message', content: requiredSourceText(record, 'content'),
    source_sequence: requiredSourceSequence(record, 'source_sequence'), thread_sequence: requiredSourceSequence(record, 'thread_sequence'),
    ticket_id: ticketId, task_ticket_id: optionalSourceText(record, 'task_ticket_id'), task_digest: optionalSourceText(record, 'task_digest'),
    legacy_reference: ticketId ? 'unverified_intake_reference' : null,
  } as SourceEvent
}

export function sourceReceiptFrom(value: unknown): SourceEvent {
  const root = sourceObject(value)
  const hasReceiptFields = ['duplicate', 'task_created', 'permission_granted', 'delivery_stage'].some(key => key in root)
  const record = hasReceiptFields ? root : { ...root, duplicate: false, task_created: false, permission_granted: false, delivery_stage: 'recorded' }
  const event = sourceEventFrom(record)
  if (record.task_created !== false || record.permission_granted !== false || record.delivery_stage !== 'recorded') throw new Error('Source 消息接收不能声称 Ticket 或新授权。')
  if ('ticket_id' in record && event.ticket_id) {
    // Kept only as an explicit legacy history annotation. It is never a task Ticket.
    event.legacy_reference = 'unverified_intake_reference'
  }
  return { ...event, duplicate: requiredSourceBoolean(record, 'duplicate'), task_created: false, permission_granted: false, delivery_stage: 'recorded' }
}

export function sourceThreadFrom(value: unknown, scope: { source_id: string; client_thread_id: string }): SourceThread {
  const root = sourceObject(value)
  if (!Array.isArray(root.events)) throw new Error('Source thread 响应缺少有界 events 数组。')
  const events = root.events.map(sourceEventFrom)
  if (requiredSourceText(root, 'source_id') !== scope.source_id || events.some(event => event.source_id !== scope.source_id || event.client_thread_id !== scope.client_thread_id)) throw new Error('Source/thread 范围不匹配，未混合展示。')
  const thread = sourceObject(root.thread)
  if (requiredSourceText(thread, 'client_thread_id') !== scope.client_thread_id) throw new Error('Source 返回了不同的 client thread，已拒绝。')
  return {
    ...root, source_id: scope.source_id, client_thread_id: scope.client_thread_id, thread_id: requiredSourceText(thread, 'id'),
    events, has_more: requiredSourceBoolean(root, 'has_more'), next_cursor: optionalSourceText(root, 'next_cursor'),
    permission_granted: root.permission_granted,
  } as SourceThread
}

export function sourceSpecFrom(value: unknown): SourceWorkSpec {
  const spec = sourceObject(value)
  if (spec.schema !== 'loom.source-work-spec.v1' || spec.kind !== 'read_summary') throw new Error('Source Work Spec 不是受限 read_summary。')
  const textKeys = ['source_event_id', 'event_request_digest', 'ticket_id', 'digest', 'project_id', 'objective', 'relative_path', 'grant_id', 'grant_digest', 'project_binding_id', 'binding_digest', 'root_scope', 'node_id', 'installation_id', 'worker_id', 'created_at'] as const
  for (const key of textKeys) requiredSourceText(spec, key)
  if (typeof spec.grant_version !== 'number' || !Number.isSafeInteger(spec.grant_version) || spec.grant_version < 1 || spec.content !== null) throw new Error('Source Work Spec 的 Grant 版本/content 无效。')
  return spec as unknown as SourceWorkSpec
}

export function rejectSourceSpecMismatch(event: SourceEvent, draft: SourceWorkDraft): void {
  const spec = event.task_spec
  if (!spec) throw new Error('已绑定 Source event 缺少完整 task_spec，禁止重放或改绑。')
  const matches = spec.schema === 'loom.source-work-spec.v1' && spec.source_event_id === event.id && spec.source_event_id === draft.source_event_id
    && spec.event_request_digest === event.payload_digest && spec.ticket_id === event.task_ticket_id && spec.digest === event.task_digest
    && spec.objective === event.content && spec.objective === draft.objective && spec.kind === draft.kind
    && spec.project_id === draft.project_id && spec.grant_id === draft.grant_id && spec.node_id === draft.node_id && spec.worker_id === draft.worker_id
    && spec.relative_path === draft.relative_path && spec.project_binding_id.length > 0 && spec.binding_digest.length > 0 && spec.root_scope.length > 0
  if (!matches) throw new Error('已绑定 Source Work Spec 与 event/objective/path/Grant/Node/Worker/digest 不一致；不能重放或改绑。')
}

export function acceptSourceTicketReceipt(value: unknown): SourceTicketReceipt {
  const root = sourceObject(value)
  const body = root
  const ticket = ticketFrom(body.ticket)
  const sourceEventId = requiredSourceText(body, 'source_event_id')
  const taskDigest = requiredSourceText(body, 'task_digest')
  const duplicate = requiredSourceBoolean(body, 'duplicate')
  const taskCreated = requiredSourceBoolean(body, 'task_created')
  const linked = requiredSourceBoolean(body, 'linked_existing_authorized_ticket')
  if (ticket.id.length === 0 || duplicate !== linked || duplicate === taskCreated || (taskCreated && duplicate)) throw new Error('Ticket 回包的 duplicate / task_created / linked 信息不一致，未假定成功。')
  return { ticket, source_event_id: sourceEventId, task_digest: taskDigest, duplicate, task_created: taskCreated, linked_existing_authorized_ticket: linked }
}

/** Shared client guard, independent from the parsed backend fields. */
export function sourceWorkBodyFrom(draft: SourceWorkDraft): SourceWorkDraft {
  if (!draft || typeof draft !== 'object' || draft.kind !== 'read_summary') throw new Error('Source 工作只能是显式 read_summary。')
  const keys: Array<keyof SourceWorkDraft> = ['source_event_id', 'objective', 'relative_path', 'project_id', 'grant_id', 'node_id', 'worker_id']
  for (const key of keys) if (typeof draft[key] !== 'string' || !draft[key]) throw new Error(`Source 工作缺少必需 ${key}，未发送 Ticket 请求。`)
  // In particular, objective is the exact immutable Source content: never trim, normalize or replace it.
  return { source_event_id: draft.source_event_id, objective: draft.objective, kind: 'read_summary', relative_path: draft.relative_path, project_id: draft.project_id, grant_id: draft.grant_id, node_id: draft.node_id, worker_id: draft.worker_id }
}
