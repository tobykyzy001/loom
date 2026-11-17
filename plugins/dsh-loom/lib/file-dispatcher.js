import { validateAssignment, CAPABILITIES } from '../src/validation.js'
import { canonical, sha256 } from '../src/util.js'
import { admissionFence, sameAuthorizedAssignment } from '../src/admission.js'

/** Generic deterministic local dispatcher; MUST NOT be described as real DSH execution. */
export class LocalFileDispatcher {
  constructor(runner, grantProvider = (assignment) => assignment.grant) {
    this.runner = runner; this.grantProvider = grantProvider
    this.capabilities = CAPABILITIES
    this.active = new Map()
  }
  async canExecute(assignment) {
    try {
      const previous = this.runner.state.data.assignments[assignment.id]
      const grant = await this.grantProvider(assignment)
      if (admissionFence(previous, assignment) || (previous && !sameAuthorizedAssignment(previous, assignment))) return false
      validateAssignment(assignment, grant, this.runner.identity)
      return CAPABILITIES.includes(assignment.kind)
    } catch { return false }
  }
  async executeAssignment(assignment) {
    const stale = admissionFence(this.runner.state.data.assignments[assignment.id], assignment)
    if (stale) return this.runner.rejectAssignment(assignment, stale)
    const active = this.active.get(assignment.id)
    if (active) {
      if (!sameAuthorizedAssignment(active.assignment, assignment)) return this.runner.rejectAssignment(assignment, 'active_assignment_mismatch')
      return active.promise
    }
    const entry = { assignment: structuredClone(assignment), promise: null,
      controller: new AbortController(), started: false }
    entry.promise = (async () => {
      try {
        const grant = await this.grantProvider(assignment)
        const verified = validateAssignment(assignment, grant, this.runner.identity)
        const candidate = { ...assignment, ...verified }
        await this.runner.state.mutate((data) => {
          const previous = data.assignments[assignment.id]
          const stale = admissionFence(previous, candidate)
          if (stale || (previous && !sameAuthorizedAssignment(previous, candidate))) {
            const error = new Error(stale || 'assignment_input_changed'); error.fenced = true; throw error
          }
          data.assignments[assignment.id] = previous?.cancel_requested ? { ...candidate, cancel_requested: true } : candidate
        })
        const digest = sha256(canonical({ assignment_id: assignment.id, lease_epoch: assignment.lease_epoch }))
        await this.runner.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
          leaseEpoch: assignment.lease_epoch, accepted: true })
        const result = await this.runner.state.once(assignment.id, digest, () => {
          entry.started = true
          return this.runner.executor.execute(assignment, grant)
        })
        if (entry.started && entry.controller.signal.aborted && result.state === 'succeeded' && !result.duplicate) {
          return this.runner.state.complete(assignment.id, { ...result, state: 'unknown', cancel_acknowledged: false,
            summary: 'Cancellation raced this file operation; the actual completion and effects require reconciliation.' })
        }
        return result
      } catch (error) {
        if (error.fenced) return this.runner.rejectAssignment(assignment, error.message)
        throw error
      } finally {
        if (this.active.get(assignment.id) === entry) this.active.delete(assignment.id)
      }
    })()
    this.active.set(assignment.id, entry)
    return entry.promise
  }
  async report(assignment, result) { return this.runner.report(assignment, result) }
  /** Capture a stop intent for this dispatcher's operation, not unrelated runner work.
   * Files are not assumed abortable: late completion is durably unknown, never fabricated rollback. */
  async cancel(assignmentId) {
    const entry = this.active.get(assignmentId)
    if (!entry) return false
    const same = await this.runner.state.mutate((data) => {
      const admitted = data.assignments[assignmentId]
      if (!sameAuthorizedAssignment(entry.assignment, admitted)) return false
      data.assignments[assignmentId] = { ...admitted, cancel_requested: true }
      return true
    })
    if (!same) return false
    entry.controller.abort(new Error('Center requested cancellation of this file assignment'))
    return true
  }
}
