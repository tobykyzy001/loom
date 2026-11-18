import type { Ticket } from '../api/types'

/** Only a completed failed Ticket can ask Concierge for another bounded Attempt.
 * Reconciling/unknown outcomes, stop intent, and never-started work need their
 * own reconciliation or approval, not another duplicate execution.
 */
export function canRetryTicket(ticket: Pick<Ticket, 'status' | 'cancel_requested'> | null | undefined): boolean {
  return ticket?.status === 'failed' && !ticket.cancel_requested
}
