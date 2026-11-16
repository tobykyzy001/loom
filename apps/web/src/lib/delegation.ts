import type { DelegationEvidence, Message } from '../api/types'

export type DelegationReference = DelegationEvidence & { parent_session_id: string; child_session_id?: string }

/** Only the center's structural validation is rendered as a provenance link.
 * Session ids and generic session_link messages never imply a new Grant.
 */
export function delegationFor(message: Message): DelegationReference | null {
  try {
    const reference = typeof message.session_ref === 'string'
      ? (message.session_ref.length <= 8192 ? JSON.parse(message.session_ref) : null)
      : message.session_ref
    const source = reference?.delegated_from
    if (source?.type !== 'artifact_ref' || source.source_verified !== true
      || source.validated_by !== 'current_assignment_and_pipeline_relation') return null
    if (typeof source.artifact_id !== 'string' || !source.artifact_id
      || typeof source.ticket_id !== 'string' || !source.ticket_id
      || typeof source.session?.session_id !== 'string' || !source.session.session_id) return null
    return { ...source, parent_session_id: source.session.session_id,
      child_session_id: typeof reference?.session_id === 'string' ? reference.session_id : undefined }
  } catch { return null }
}
