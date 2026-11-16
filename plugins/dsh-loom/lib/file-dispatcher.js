import { validateAssignment, CAPABILITIES } from '../src/validation.js'
import { canonical, sha256 } from '../src/util.js'

/** Generic deterministic local dispatcher; MUST NOT be described as real DSH execution. */
export class LocalFileDispatcher {
  constructor(runner, grantProvider = (assignment) => assignment.grant) {
    this.runner = runner; this.grantProvider = grantProvider
    this.capabilities = CAPABILITIES
    this.active = new Set()
  }
  async canExecute(assignment) {
    try {
      const grant = await this.grantProvider(assignment)
      validateAssignment(assignment, grant, this.runner.identity)
      return CAPABILITIES.includes(assignment.kind)
    } catch { return false }
  }
  async executeAssignment(assignment) {
    if (this.active.has(assignment.id)) return this.runner.state.data.completions[assignment.id]
    this.active.add(assignment.id)
    try {
      const grant = await this.grantProvider(assignment)
      validateAssignment(assignment, grant, this.runner.identity)
      const digest = sha256(canonical({ assignment_id: assignment.id, lease_epoch: assignment.lease_epoch }))
      await this.runner.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: true })
      return this.runner.state.once(assignment.id, digest, () => this.runner.executor.execute(assignment, grant))
    } finally { this.active.delete(assignment.id) }
  }
  async report(assignment, result) { return this.runner.report(assignment, result) }
  async cancel(assignmentId) { return this.runner.active.has(assignmentId) }
}
