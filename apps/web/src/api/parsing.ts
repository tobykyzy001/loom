import type { ApiErrorBody, ArtifactContent, ArtifactRef, AuditEntry, Bootstrap, Effect, Grant, LoomNode, Memory, Message, Preferences, Project, Report, Ticket } from './types'

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
    .map(message => ({ ...message, segment: message.segment ?? ((message as Message & { kind?: string }).kind === 'collaboration' ? 'collaboration' : 'activity') }))
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
