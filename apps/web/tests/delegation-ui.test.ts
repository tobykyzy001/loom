import { describe, expect, it } from 'vitest'
import { delegationFor } from '../src/lib/delegation'
import { ticketFrom } from '../src/api/parsing'
import type { DelegationEvidence, Message } from '../src/api/types'

const childSession = '3c44fdaa-2803-449f-b607-2a07d73f9822'
const parentSession = 'f8c661b3-99f7-410a-9563-cd44276c73f6'
const source: DelegationEvidence = { type: 'artifact_ref', artifact_id: '11111111-1111-4111-8111-111111111111',
  ticket_id: 'tkt_valid_parent', origin_node_id: 'a'.repeat(64), sha256: 'b'.repeat(64),
  location: 'loom://artifact/11111111-1111-4111-8111-111111111111', parents: [],
  session: { harness: 'dsh', session_id: parentSession },
  source_verified: true, validated_by: 'current_assignment_and_pipeline_relation' }

describe('controller-verified delegation references', () => {
  const valid: Message = { id: 'link', kind: 'session_link', sender: 'worker', content: 'Real immutable provenance.',
    session_ref: JSON.stringify({ harness: 'dsh', session_id: childSession, delegated_from: source }) }

  it('preserves the exact parent Ticket, Artifact and distinct real SessionRefs', () => {
    const relation = delegationFor(valid)
    expect(relation?.ticket_id).toBe('tkt_valid_parent')
    expect(relation?.artifact_id).toBe(source.artifact_id)
    expect(relation?.parent_session_id).toBe(parentSession)
    expect(relation?.child_session_id).toBe(childSession)
    expect(relation?.parent_session_id).not.toBe(relation?.child_session_id)
    const ticket = ticketFrom({ id: 'tkt_child', status: 'succeeded', messages: [valid] })
    expect(ticket.messages?.[0].segment).toBe('collaboration')
    expect(ticket.messages?.[0].sender_kind).toBe('worker')
  })

  it('does not interpret untrusted fields, an Assignment or a generic link as a provenance badge', () => {
    const cases: Message[] = [
      { id: 'not-a-producer', content: 'None proved', session_ref: { session_id: childSession } },
      { id: 'wrong-kind', content: 'Unknown external role', session_ref: { session_id: childSession, delegated_from: { ...source, type: 'assignment_ref' } } },
      // Deliberately untrusted JSON from a caller, not trusted center evidence.
      { id: 'unverified', content: 'Caller claims lineage', session_ref: JSON.stringify({ session_id: childSession, delegated_from: { ...source, source_verified: false } }) },
      { id: 'bad-source', content: 'Malformed reference', session_ref: '{malformed path}' },
      { id: 'long-reference', content: 'Overlong reference', session_ref: `${' '.repeat(8200)}` },
    ]
    for (const message of cases) expect(delegationFor(message)).toBeNull()
  })
})
