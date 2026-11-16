import { validateAssignment } from '../src/validation.js'
import { canonical, sha256 } from '../src/util.js'

/** Maps verified DSH Agent events to node Sessions, never treating file as DSH execution. */
export class DshDispatcher {
  constructor(runner, adapter, config) {
    this.runner = runner; this.adapter = adapter; this.config = config; this.active = new Set()
    this.capabilities = ['dsh_agent_turn'] // Not a file-capability Grant, and not advertised by local dispatcher.
  }
  sessionRefs() { return [...this.adapter.sequence.entries()].map(([assignment_id, record]) => ({ assignment_id, ...this.adapter.sessionRef(record.agent.session) })) }
  async canExecute(assignment) { try { validateAssignment(assignment, assignment.grant, this.runner.identity); return true } catch { return false } }
  async executeAssignment(assignment) {
    if (this.active.has(assignment.id)) throw new Error('Assignment is already active')
    this.active.add(assignment.id)
    try {
      await this.runner.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: true })
      const operation = () => this.adapter.executeAssignment(assignment, {
        provider: assignment.provider || this.config.provider,
        model: assignment.model || this.config.model,
        reasoningEffort: this.config.reasoning_effort,
        maxTokens: this.config.max_tokens,
        reportLink: (session_ref) => this.runner.client.event({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
          leaseEpoch: assignment.lease_epoch, sessionRef: { ...session_ref, session_seq: agent.session.seq }, kind: 'session_link', summary: 'Loom linked to the existing DSH Session log.' }).then(() => this.runner.client.dispatchOutbox()),
      })
      const digest = sha256(canonical({ assignment_id: assignment.id, kind: assignment.kind, objective: assignment.objective }))
      const result = await this.runner.state.once(assignment.id, digest, operation)
      if (result.state === 'unknown' && result.content) {
        const previous = this.runner.state.data.deliveries?.find((item) => item.kind === 'artifact' && item.body?.metadata?.name === `loom-session-${assignment.id}.json`)
        if (previous && !this.runner.state.outbox.some((item) => item.kind === 'artifact' && item.digest === previous.digest)) {
          await this.runner.state.enqueue('artifact', previous.body, { digest: previous.digest })
        }
        result.content = null
      }
      if (result.artifact?.artifact_id) await this.adapter.unregister(assignment.id)
      if (!result.artifact && result.content) result.artifact = { artifact_id: id(), metadata: result.metadata, bytes: result.content }
      return result
    } finally { this.active.delete(assignment.id)
      if (this.runner.state.data.completions[assignment.id]?.state !== 'running') await this.adapter.unregister(assignment.id)
    }
  }
  preserveLinkRequests() {
    // Handled by CoordinatorLoop's shared outbox, not a second coordinator/client authority.
  }
  async report(assignment, result) {
    // Outbox survives failure/restart; stable session-link request has already been persisted before return.
    return this.runner.report(assignment, result)
  }
  async cancel(assignmentId) { await this.adapter.cancel(assignmentId); return true }
  dispose() { return this.adapter.dispose() }
}
