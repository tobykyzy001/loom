import { LoomClient } from '../api/client'
import { skillDataFrom, skillSourceRefs } from './skillProof'
import { ticketFrom } from '../api/parsing'
import type { SkillCandidate, SkillWorkspaceData, Ticket } from '../api/types'
import { ticketsFrom } from '../api/parsing'
// The graph is deliberately a plain list: no launcher, scheduler or background replay.
export interface SkillWorkspaceReference {
  read(): Promise<{ data: SkillWorkspaceData; tickets: Ticket[] }>
  replay(candidate: SkillCandidate, sourceTicketId: string): Promise<{ data: SkillWorkspaceData; tickets: Ticket[] }>
  review(candidate: SkillCandidate, decision: 'accept' | 'reject' | 'undo'): Promise<{ data: SkillWorkspaceData; tickets: Ticket[] }>
}

/** Thin client wrapper. It always uses the same dynamically-read browser token. */
export class SkillActions {
  constructor(private readonly client: LoomClient) {}

  async read(): Promise<{ data: SkillWorkspaceData; tickets: Ticket[] }> {
    const [raw, tickets] = await Promise.all([this.client.get<unknown>('/candidates'), this.client.get<unknown>('/tickets')])
    const data = skillDataFrom(raw)
    if (!data || data.candidates.length > 500) throw new Error('Skill 响应不完整，暂不显示候选。')
    const listing = ticketsFrom(tickets)
    const ids = new Set<string>()
    for (const candidate of data.candidates) for (const sourceTicketId of skillSourceRefs(candidate.source_refs)) ids.add(sourceTicketId)
    for (const replay of data.skill_replays) {
      if (replay.source_ticket_id) ids.add(replay.source_ticket_id)
      if (replay.replay_ticket_id) ids.add(replay.replay_ticket_id)
    }
    if (ids.size > 64) throw new Error('Skill 关联任务过多，按原授权范围分步查阅，不进行批量回放。')
    // The list returns status summaries, not the artifacts this review needs.
    // Only declared sources/replays get bounded ordinary read-only details.
    const details = await Promise.all([...ids].map(async (id) =>
      ticketFrom(await this.client.get<unknown>(`/tickets/${encodeURIComponent(id)}`))))
    const byId = new Map(details.map(ticket => [ticket.id, ticket]))
    return { data, tickets: listing.map(ticket => ({ ...ticket, ...byId.get(ticket.id) })) }
  }

  async replay(candidate: SkillCandidate, sourceTicketId: string): Promise<{ data: SkillWorkspaceData; tickets: Ticket[] }> {
    if (candidate.status !== 'pending' || !sourceMatchesCandidate(candidate, sourceTicketId)) throw new Error('回放来源不在真实候选绑定中，未创建 Ticket。')
    // Deliberately the only body field: never a fake proof, Grant, root or ticket target.
    await this.client.post<unknown>(`/candidates/${encodeURIComponent(candidate.id)}/replay`, { source_ticket_id: sourceTicketId })
    return this.read()
  }

  async review(candidate: SkillCandidate, decision: 'accept' | 'reject' | 'undo'): Promise<{ data: SkillWorkspaceData; tickets: Ticket[] }> {
    if (candidate.kind !== 'skill' || (decision === 'accept' && candidate.status !== 'pending') || (decision === 'undo' && candidate.status !== 'accepted') || (decision === 'reject' && !['pending', 'accepted'].includes(candidate.status))) {
      throw new Error('该候选当前状态不允许这项审阅操作。')
    }
    await this.client.patch<unknown>(`/candidates/${encodeURIComponent(candidate.id)}`, { decision })
    return this.read()
  }
}

export function sourceMatchesCandidate(candidate: SkillCandidate, sourceTicketId: string): boolean {
  const refs = skillSourceRefs(candidate.source_refs)
  return !!skillSourceMatches(sourceTicketId, refs) && sourceTicketId.length <= 160
}
function skillSourceMatches(sourceTicketId: string, refs: string[]): boolean {
  return refs.includes(sourceTicketId)
}
