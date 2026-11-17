import { describe, expect, it } from 'vitest'
import type { MemoryCandidate } from '../src/lib/memoryCandidate'
import { memoryCandidates, memoryDecision, memoryProvenance, memoryText } from '../src/lib/memoryCandidate'
import { skillSourceRefs } from '../src/lib/skillProof'

const valid = { id: 'candidate_abc', kind: 'memory', scope: 'project_real', status: 'pending', content: JSON.stringify({ content: 'Use explicit source references' }), source_refs: JSON.stringify(['tkt_1']), version: 1 }

describe('explicit project MemoryCandidate preview', () => {
  it('separates MemoryCandidates from Skill and invalid evidence without granting anything', () => {
    expect(memoryCandidates({ candidates: [valid, { ...valid, id: 'skill', kind: 'skill' }] }).map(row => row.id)).toEqual([valid.id])
    expect(memoryText(valid)).toBe('Use explicit source references')
    expect(memoryCandidates({ candidates: [{ ...valid, content: '{invalid' }] })).toEqual([])
    expect(memoryDecision('accept', valid)).toBe('accept')
    expect(memoryDecision('undo', { ...valid, status: 'accepted', derived_memory_id: 'memory_123' })).toBe('undo')
    expect(memoryDecision('accept', { ...valid, status: 'accepted' })).toBeNull()
  })
  it('has a distinct reversible never state instead of treating it as ordinary rejection', () => {
    const never = { ...valid, status: 'never' }
    expect(memoryCandidates({ candidates: [never] })).toHaveLength(1)
    expect(memoryDecision('undo', never)).toBe('undo')
    expect(memoryDecision('accept', never)).toBeNull()
    expect(memoryDecision('accept', { ...valid, status: 'later' })).toBe('accept')
  })
  it('never disguises corrupt or new empty provenance as valid legacy evidence', () => {
    const asRuntime = (source_refs: unknown): MemoryCandidate => ({ ...valid, content: JSON.stringify({ schema: 'loom.memory-candidate.v1', content: 'Source-bound' }), source_refs: source_refs as MemoryCandidate['source_refs'] })
    const current = { ...valid, content: JSON.stringify({ schema: 'loom.memory-candidate.v1', content: 'Source-bound' }) }
    expect(memoryProvenance(current)).toBe('tickets')
    expect(memoryProvenance(asRuntime([]))).toBe('invalid')
    expect(memoryProvenance({ ...valid, source_refs: JSON.stringify([]) })).toBe('legacy')
    expect(memoryProvenance({ ...valid, source_refs: '{corrupt' })).toBe('invalid')
    expect(memoryProvenance({ ...valid, source_refs: [{ kind: 'source_ticket', ticket_id: 'id' }] as unknown as MemoryCandidate['source_refs'] })).toBe('invalid')
    expect(memoryProvenance({ ...valid, source_refs: JSON.stringify(['dup', 'dup']) })).toBe('invalid')
    expect(memoryCandidates({ candidates: [asRuntime([])] })).toEqual([])
    expect(memoryCandidates({ candidates: [{ ...valid, source_refs: [], status: 'accepted' }] })).toHaveLength(1)
  })

  it('allows the actual 32-source maximum without losing valid evidence at the old eight-source boundary', () => {
    const refs = Array.from({ length: 32 }, (_, n) => `tkt_${'0'.repeat(32)}-${n}`)
    expect(skillSourceRefs(refs)).toEqual(refs)
    expect(skillSourceRefs([...refs, 'extra'])).toEqual([])
  })
})
