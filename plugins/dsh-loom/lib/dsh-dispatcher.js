import { validateAssignment } from '../src/validation.js'
import { canonical, sha256 } from '../src/util.js'
function stableUUID(value) {
  const hex = sha256(value).slice(0, 32).split('')
  hex[12] = '4'; hex[16] = '89ab'[Number.parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

/** Maps verified DSH Agent events to node Sessions, never treating file as DSH execution. */
export class DshDispatcher {
  constructor(runner, adapter, config) {
    this.runner = runner; this.adapter = adapter; this.config = config; this.active = new Map()
    // Capabilities describe Agent work; they are not a silent filesystem allowance.
    this.capabilities = ['dsh_agent_turn', 'read_summary', 'edit_file'] // Agent-presented operations; Grant remains separately enforced.
  }
  sessionRefs() { return [...this.adapter.sequence.entries()].map(([assignment_id, record]) => ({ assignment_id, ...this.adapter.sessionRef(record.agent.session) })) }
  async canExecute(assignment) {
    if (!['read_summary', 'edit_file', 'dsh_agent_turn'].includes(assignment.kind)) return false
    try { validateAssignment(assignment, assignment.grant, this.runner.identity); return true } catch { return false }
  }
  async executeAssignment(assignment) {
    if (this.active.has(assignment.id)) throw new Error('Assignment is already active')
    this.active.set(assignment.id, assignment)
    this.runner.state.data.assignments[assignment.id] = assignment
    await this.runner.state.flush()
    try {
      await this.runner.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: true })
      const operation = () => this.adapter.executeAssignment(assignment, {
        provider: assignment.provider || this.config.provider,
        model: assignment.model || this.config.model,
        reasoningEffort: this.config.reasoning_effort,
        maxTokens: this.config.max_tokens,
        projectRoot: assignment.grant?.project_root,
        reportLink: (session_ref) => this.runner.client.event({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
          leaseEpoch: assignment.lease_epoch, sessionRef: { ...session_ref, session_seq: session_ref.observed_seq }, kind: 'session_link', summary: 'Loom linked to the existing DSH Session log.' }),
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
      if (!result.artifact && result.content) result.artifact = { artifact_id: stableUUID(`${digest}:loom-dsh-assistant-artifact:v1`), metadata: result.metadata, bytes: result.content }
      if (result.artifact) {
        if (typeof result.artifact.artifact_id !== 'string' || !result.artifact.artifact_id) throw new Error('A completed DSH report requires its actual stable UUID Artifact ID')
        const metadata = { ...(result.artifact.metadata || {}), artifact_id: result.artifact.artifact_id }
        result.artifact.metadata = metadata
        result.artifact_ids = [...new Set([...(result.artifact_ids || []), result.artifact.artifact_id])]
        result.artifacts = [...(result.artifacts || []), metadata]
      }
      return result
    } finally { this.active.delete(assignment.id) }
  }
  preserveLinkRequests() { /* Shared Node outbox is the one coordinator transport. */ }
  async report(assignment, result) { return this.runner.report(assignment, result) }
  async cancel(assignmentId) {
    const cancelled = await this.adapter.cancel(assignmentId)
    process.stderr.write(`[loom-local-node] actual cancel request ${assignmentId}: ${cancelled ? 'sent-to-running-agent' : 'no-running-agent'}\n`)
    // A stop request is not a terminal cancellation or acknowledgement. Only the
    // ordinary observed DSH turn/end event may settle the original operation.
    // A host that never reaches that event must retain running/unknown evidence.
    const record = this.runner.state.data.assignments[assignmentId]
    if (record) {
      record.cancel_requested = true
      await this.runner.state.flush()
    }
    return cancelled
  }
  async dispose() { return this.adapter.dispose() }
}
