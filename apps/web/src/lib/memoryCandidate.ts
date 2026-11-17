import type { SkillCandidate } from '../api/types'
import { skillSourceRefs } from './skillProof'

export type ReviewDecision = 'accept' | 'reject' | 'later' | 'never' | 'undo'
export interface MemoryCandidate extends SkillCandidate { derived_memory_id?: string; schema?: string }

export function memoryProvenance(candidate: MemoryCandidate): 'tickets' | 'legacy' | 'invalid' {
  let raw: unknown = candidate.source_refs
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return 'invalid' }
  }
  if (!Array.isArray(raw)) return 'invalid'
  if (!raw.every(ref => typeof ref === 'string')) return 'invalid'
  const ids = skillSourceRefs(raw)
  if (ids.length !== raw.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) return 'invalid'
  if (candidateSchema(candidate) === 'loom.memory-candidate.v1' && ids.length === 0) return 'invalid'
  return ids.length > 0 ? 'tickets' : 'legacy'
}

export function candidateSchema(candidate: MemoryCandidate): string | null | 'invalid' {
  if (typeof candidate.content !== 'string' || candidate.content.length > 4096) return 'invalid'
  let content: unknown
  try { content = JSON.parse(candidate.content) } catch { return 'invalid' }
  if (!content || typeof content !== 'object') return 'invalid'
  const schema = (content as { schema?: unknown }).schema
  if (schema === undefined) return ''
  if (typeof schema !== 'string' || schema.length === 0 || schema.trim() !== schema) return 'invalid'
  return schema
}

export function memoryLegacyReason(candidate: MemoryCandidate): string {
  return memoryProvenance(candidate) === 'legacy'
    ? '旧无来源候选，仅供显式审阅；它没有任何声称的真实 Ticket 复用证明。'
    : ''
}

export function memoryCandidates(value: unknown): MemoryCandidate[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { candidates?: unknown }).candidates)) return []
  return (value as { candidates: unknown[] }).candidates.filter((candidate): candidate is MemoryCandidate => {
    if (!candidate || typeof candidate !== 'object') return false
    const value = candidate as SkillCandidate
    return value.kind === 'memory' && typeof value.id === 'string' && value.id.length <= 160
      && typeof value.scope === 'string' && value.scope.length <= 160
      && ['pending', 'accepted', 'rejected', 'later', 'never'].includes(value.status)
      && memoryText(value) !== null && memoryProvenance(value) !== 'invalid'
      && ['', 'loom.memory-candidate.v1'].includes(candidateSchema(value) || '')
  }).slice(0, 100)
}

export function memoryText(candidate: SkillCandidate): string | null {
  if (typeof candidate.content !== 'string' || candidate.content.length > 4096) return null
  let content: unknown = candidate.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { return null }
  }
  if (!content || typeof content !== 'object' || typeof (content as { content?: unknown }).content !== 'string') return null
  const value = (content as { content: string }).content
  return value.length > 0 && value.length <= 500 ? value : null
}

export function memoryDecision(decision: ReviewDecision, candidate: MemoryCandidate): ReviewDecision | null {
  if (decision === 'undo' && candidate.status === 'accepted' && candidate.derived_memory_id) return 'undo'
  if (decision === 'undo' && candidate.status === 'never') return 'undo'
  if (decision === 'accept' && !['pending', 'later'].includes(candidate.status)) return null
  if (decision === 'undo' && candidate.status === 'accepted' && !candidate.derived_memory_id) return null
  if (decision === 'undo' && !['accepted', 'never'].includes(candidate.status)) return null
  if (decision !== 'accept' && decision !== 'undo' && !['pending', 'later'].includes(candidate.status)) return null
  return decision
}
