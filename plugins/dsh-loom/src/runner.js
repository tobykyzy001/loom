import { resolve } from 'node:path'
import { LoomHttpClient } from './http.js'
import { LoomNodeClient } from './client.js'
import { NodeIdentity } from './identity.js'
import { NodeState } from './state.js'
import { CAPABILITIES, envelope, validateAssignment } from './validation.js'
import { ControlledFileExecutor } from './executor.js'
import { canonical, id, sha256, requireIsolatedRoot } from './util.js'

export class LocalNodeRunner {
  constructor(options) {
    this.options = options
    this.stopped = false
    this.lastAssignmentId = null
    this.versions = new Map()
    this.active = new Map()
    this.capabilities = CAPABILITIES
  }
  async start({ enrollmentCode } = {}) {
    this.identity = await NodeIdentity.open(this.options.stateDir)
    this.state = await NodeState.open(this.options.stateDir)
    this.http = new LoomHttpClient({ baseUrl: this.options.baseUrl, fetch: this.options.fetch })
    this.client = new LoomNodeClient({ http: this.http, identity: this.identity, state: this.state })
    this.executor = new ControlledFileExecutor({ artifactDir: this.options.artifactDir })
    if (enrollmentCode || !this.identity.token) {
      if (!enrollmentCode) throw new Error('Persistent node token is missing; an explicit enrollment code is required')
      await this.client.enroll({ enrollmentCode, capabilities: this.capabilities, ...this.options.registration })
    }
    await this.client.heartbeat({ capabilities: this.capabilities })
    return this.identity.public
  }
  /** New coordinator caller; no server-to-node transport or local HTTP listener is needed. */
  static async create({ stateDir, artifactDir, baseUrl, enrollmentCode, registration } = {}) {
    const runner = new LocalNodeRunner({ stateDir: requireIsolatedRoot(stateDir), artifactDir: resolve(artifactDir),
      baseUrl, registration })
    await runner.start({ enrollmentCode })
    return runner
  }
  get nodeId() { return this.identity.nodeId }
  get installationId() { return this.identity.installationId }
  async pollAndRun() {
    const assignment = await this.client.poll({ lastAssignmentId: this.lastAssignmentId })
    if (!assignment) return { status: 'idle' }
    if (assignment.cancel_requested && assignment.id) {
      const previous = this.state.data.assignments[assignment.id]
      await this.state.mutate((data) => { data.assignments[assignment.id] = { ...previous, ...assignment, cancel_requested: true } })
      this.active.get(assignment.id)?.abort(new Error('Center cancellation requested'))
      return { status: 'cancel_acknowledged', assignmentId: assignment.id }
    }
    this.lastAssignmentId = assignment.id
    const previous = this.state.data.assignments[assignment.id]
    if (previous) {
      const previousEpoch = previous.lease_epoch
      if (Number.isSafeInteger(previousEpoch) && assignment.lease_epoch < previousEpoch) {
        await this.rejectAssignment(assignment, 'Lease epoch moved backwards')
        return { status: 'fenced', assignmentId: assignment.id }
      }
    }
    await this.state.mutate((data) => { data.assignments[assignment.id] = assignment })
    if (this.active.has(assignment.id)) return { status: 'duplicate_active', assignmentId: assignment.id }
    const version = this.versions.get(assignment.id) || {}
    if (assignment.lease_epoch < (version.lease_epoch || 0)
      || (assignment.grant_digest && version.grant_digest && assignment.grant_digest !== version.grant_digest)) {
      await this.rejectAssignment(assignment, 'Stale Lease or Grant fencing')
      return { status: 'fenced', assignmentId: assignment.id }
    }
    this.versions.set(assignment.id, { lease_epoch: assignment.lease_epoch, grant_version: assignment.grant_version, grant_digest: assignment.grant_digest })
    const grant = assignment.grant || this.options.grants?.[assignment.grant_digest]
    let verified
    try { verified = validateAssignment(assignment, grant, this.identity) } catch (error) {
      await this.report(assignment, { state: 'failed', summary: `Assignment rejected: ${error.message}`, artifact: null, effect: null })
      await this.rejectAssignment(assignment, error.message)
      return { status: 'rejected', assignmentId: assignment.id, reason: error.message }
    }
    const controller = new AbortController()
    this.active.set(assignment.id, controller)
    try {
      const digest = sha256(canonical({ assignment_id: assignment.id, lease_epoch: assignment.lease_epoch, grant_version: assignment.grant_version }))
      const result = await this.state.once(assignment.id, digest, () => this.executor.execute(assignment, grant))
      if (controller.signal.aborted && result.state === 'succeeded') {
        // The operation may already have had its effect: Unknown Outcome != Failed.
        result.state = 'unknown'; result.summary = 'Cancellation raced with a completed effect; reconciliation is required.'
      }
      await this.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: result.state !== 'failed' })
      return { status: result.state, assignmentId: assignment.id, ...(await this.report(assignment, result)) }
    } finally { this.active.delete(assignment.id) }
  }
  async report(assignment, result) {
    let artifacts = Array.isArray(result.artifacts) ? result.artifacts : []
    let effects = Array.isArray(result.effects) ? result.effects : []
    if (result.artifact) {
      await this.client.artifact({ ticketId: assignment.ticket_id, artifactId: result.artifact.artifact_id,
        assignmentId: assignment.id, leaseEpoch: assignment.lease_epoch, metadata: result.artifact.metadata, bytes: result.artifact.bytes })
      artifacts = [...artifacts, result.artifact.metadata]
    }
    if (result.effect) effects = [...effects, result.effect]
    return this.client.report({ ticketId: assignment.ticket_id, assignmentId: assignment.id, leaseEpoch: assignment.lease_epoch,
      state: result.state, summary: result.summary,
      evidence: result.effect ? [result.effect.evidence] : (result.session_ref ? [result.session_ref] : []), artifacts, effects })
  }
  async rejectAssignment(assignment, reason) {
    try {
      await this.client.acknowledge({ ticketId: assignment.ticket_id || id(), assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: false, reason })
    } catch { /* durable next center poll can fence/retry; local report still never indicates success */ }
  }
  async tick() { await this.pollAndRun(); return this.client.dispatchOutbox() }
}
export { envelope }
