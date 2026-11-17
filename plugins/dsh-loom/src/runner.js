import { resolve } from 'node:path'
import { LoomHttpClient } from './http.js'
import { LoomNodeClient } from './client.js'
import { NodeIdentity } from './identity.js'
import { NodeState } from './state.js'
import { CAPABILITIES, envelope, validateAssignment } from './validation.js'
import { ControlledFileExecutor } from './executor.js'
import { canonical, sha256, requireIsolatedRoot } from './util.js'
import { admissionFence, cancellationFence, optionalNodeAckError, rejectionFingerprint, sameAuthorizedAssignment } from './admission.js'

export function wireCapabilities(values) {
  return values.map((value) => {
    if (value.kind === 'model_text') return { ticket_kind: 'model_text', permission: 'invoke_text' }
    if (value.kind === 'dsh_agent_turn') return { ticket_kind: 'dsh_agent_turn', permission: 'read' }
    if (value === 'model_descriptor') return { ticket_kind: 'model_descriptor', permission: 'read' }
    if (value === 'read_summary' || value === 'dsh_agent_turn') return { ticket_kind: value, permission: 'read' }
    if (value === 'edit_file') return { ticket_kind: 'edit_file', permission: 'write' }
    return value
  })
}

export class LocalNodeRunner {
  constructor(options) {
    this.options = { ...options }
    this.registration = options.registration || {}
    this.stopped = false
    this.lastAssignmentId = null
    this.active = new Map()
    this.activeAssignments = new Map()
    this.capabilities = CAPABILITIES
  }
  async start({ enrollmentCode, signal } = {}) {
    const stopped = () => {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Loom node startup aborted')
    }
    stopped()
    const enrolled = enrollmentCode || await NodeIdentity.readEnrollment(this.options.stateDir)
    stopped()
    if (!enrolled && !enrollmentCode) throw new Error('Persistent node token is missing; an explicit enrollment code is required')
    this.identity = await NodeIdentity.open(this.options.stateDir)
    stopped()
    this.state = await NodeState.open(this.options.stateDir)
    stopped()
    this.http = new LoomHttpClient({ baseUrl: this.options.baseUrl, fetch: this.options.fetch, timeoutMs: this.options.requestTimeoutMs })
    this.client = new LoomNodeClient({ http: this.http, identity: this.identity, state: this.state })
    this.executor = new ControlledFileExecutor({ artifactDir: this.options.artifactDir })
    if (enrollmentCode || !this.identity.token) {
      if (!enrollmentCode) throw new Error('Persistent node token is missing; an explicit enrollment code is required')
      stopped()
      await this.client.enroll({ enrollmentCode, capabilities: wireCapabilities(this.capabilities), workerId: 'default', harnessKind: 'dsh-host', profileId: this.options.registration?.profile_id || 'isolated', ...this.options.registration, signal })
      stopped()
    }
    await this.client.heartbeat({ capabilities: wireCapabilities(this.capabilities), ...this.registrationFacts(), signal })
    stopped()
    return this.identity.public
  }
  /** New coordinator caller; no server-to-node transport or local HTTP listener is needed. */
  static async create({ stateDir, artifactDir, baseUrl, enrollmentCode, registration, requestTimeoutMs, signal, fetch } = {}) {
    const runner = new LocalNodeRunner({ stateDir: requireIsolatedRoot(stateDir), artifactDir: resolve(artifactDir),
      baseUrl, registration, requestTimeoutMs, fetch })
    await runner.start({ enrollmentCode, signal })
    return runner
  }
  registrationFacts(capabilities = this.capabilities) {
    const registration = this.registration || {}
    return { workers: [{ worker_id: 'default', harness_kind: 'dsh-host', profile_id: registration.profile_id || 'isolated', capabilities: wireCapabilities(capabilities) }],
      inventory: { project_roots: registration.project_roots || {}, harness_kind: 'dsh-host' } }
  }
  get nodeId() { return this.identity.nodeId }
  get installationId() { return this.identity.installationId }
  async pollAndRun() {
    const assignment = await this.client.poll({ lastAssignmentId: this.lastAssignmentId })
    if (!assignment) return { status: 'idle' }
    if (assignment.cancel_requested && assignment.id) {
      const previous = this.state.data.assignments[assignment.id]
      const activeAssignment = this.activeAssignments.get(assignment.id)
      const stale = cancellationFence(previous, assignment, activeAssignment)
      if (stale) return this.rejectAssignment(assignment, stale)
      // Preserve the complete previously admitted frame and its validated identity.
      // Cancellation annotations must not overwrite the original facts.
      const authorizedCancel = await this.state.mutate((data) => {
        const current = data.assignments[assignment.id]
        if (!sameAuthorizedAssignment(previous, current)) return false
        data.assignments[assignment.id] = { ...current, cancel_requested: true }
        return true
      })
      if (!authorizedCancel) return this.rejectAssignment(assignment, 'cancellation_assignment_changed_before_persist')
      const controller = this.active.get(assignment.id)
      if (controller && this.activeAssignments.get(assignment.id) === activeAssignment) {
        controller.abort(new Error('Center cancellation requested'))
      }
      return { status: 'cancel_acknowledged', assignmentId: assignment.id }
    }
    this.lastAssignmentId = assignment.id
    const previous = this.state.data.assignments[assignment.id]
    const grant = assignment.grant || this.options.grants?.[assignment.grant_digest]
    let verified
    try {
      // Validation precedes active identification: an active ID is not an authorization cache.
      verified = validateAssignment(assignment, grant, this.identity)
      const incoming = { ...assignment, ...verified }
      const stale = admissionFence(previous, incoming)
      if (stale) return this.rejectAssignment(assignment, stale)
      if (this.active.has(assignment.id)) {
        const activeAssignment = this.activeAssignments.get(assignment.id)
        if (!sameAuthorizedAssignment(activeAssignment, incoming) || !sameAuthorizedAssignment(this.state.data.assignments[assignment.id], incoming)) {
          return this.rejectAssignment(assignment, 'active_assignment_mismatch')
        }
        return { status: 'duplicate_active', assignmentId: assignment.id }
      }
      await this.state.mutate((data) => {
        // Recheck the exact frame being committed after any earlier async rejection/write.
        // Reading state.data before this queued mutation is not durable authorization evidence.
        const current = data.assignments[assignment.id]
        const currentStale = admissionFence(current, incoming)
        if (currentStale || (current && !sameAuthorizedAssignment(current, incoming))) {
          const error = new Error(currentStale || 'active_assignment_mismatch')
          error.fenced = true
          throw error
        }
        data.assignments[assignment.id] = current?.cancel_requested ? { ...incoming, cancel_requested: true } : incoming
      })
    } catch (error) {
      await this.rejectAssignment(assignment, error.message)
      return { status: error.fenced ? 'fenced' : 'rejected', assignmentId: assignment.id, reason: error.message }
    }
    if (this.active.has(assignment.id)) {
      const activeAssignment = this.activeAssignments.get(assignment.id)
      if (!sameAuthorizedAssignment(activeAssignment, this.state.data.assignments[assignment.id])) {
        return this.rejectAssignment(assignment, 'active_assignment_changed_during_admission')
      }
      return { status: 'duplicate_active', assignmentId: assignment.id }
    }
    const controller = new AbortController()
    this.active.set(assignment.id, controller)
    const activeAssignment = structuredClone(this.state.data.assignments[assignment.id])
    this.activeAssignments.set(assignment.id, activeAssignment)
    try {
      if (!sameAuthorizedAssignment(this.state.data.assignments[assignment.id], activeAssignment)) {
        return this.rejectAssignment(assignment, 'active_assignment_changed_before_execution')
      }
      const digest = sha256(canonical({ assignment_id: assignment.id, lease_epoch: assignment.lease_epoch, grant_version: assignment.grant_version }))
      let result
      try { result = await this.state.once(assignment.id, digest, () => this.executor.execute(assignment, grant)) } catch (error) {
        if (error.fenced) return this.rejectAssignment(assignment, error.message)
        throw error
      }
      if (controller.signal.aborted && result.state === 'succeeded') {
        // The operation may already have had its effect: Unknown Outcome != Failed.
        result.state = 'unknown'; result.summary = 'Cancellation raced with a completed effect; reconciliation is required.'
      }
      await this.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: result.state !== 'failed' })
      return { status: result.state, assignmentId: assignment.id, ...(await this.report(assignment, result)) }
    } finally {
      this.active.delete(assignment.id)
      this.activeAssignments.delete(assignment.id)
    }
  }
  async report(assignment, result) {
    const effects = Array.isArray(result.effects) ? [...result.effects] : []
    const uploads = new Map()
    for (const item of [...(Array.isArray(result.artifacts) ? result.artifacts : []), ...(result.artifact ? [result.artifact] : [])]) {
      const id = item.artifact_id || item.id
      if (id) uploads.set(id, item)
    }
    const ids = []
    for (const [artifactId, upload] of uploads) {
      const bytes = upload.bytes ?? upload.content
      if (bytes === undefined || bytes === null) throw new Error(`Artifact ${artifactId} has a reference but no observed byte payload`)
      // Exactly one authenticated artifact upload per immutable UUID; the Report carries UUID lineage.
      await this.client.artifact({ ticketId: assignment.ticket_id, artifactId,
        assignmentId: assignment.id, leaseEpoch: assignment.lease_epoch, metadata: upload.metadata, bytes })
      ids.push(artifactId)
    }
    if (result.effect) effects.push(result.effect)
    if (result.state === 'unknown' && effects.length === 0 && result.session_ref) {
      effects = [{ effect_id: `dsh-turn-${assignment.id}`, status: 'unknown', input_digest: result.digest || '', evidence: { description: 'Actual DSH turn outcome or its delivery needs reconciliation; no external file effect is claimed.', session_ref: result.session_ref }, artifacts: [] }]
    }
    return this.client.report({ ticketId: assignment.ticket_id, assignmentId: assignment.id, leaseEpoch: assignment.lease_epoch,
      state: result.state, summary: result.summary, cancelAcknowledged: Boolean(result.cancel_acknowledged),
      evidence: result.effect ? [result.effect.evidence] : (result.session_ref ? [result.session_ref] : []), artifactIds: ids, effects })
  }
  async rejectAssignment(assignment, reason, localStatus = 'fenced') {
    const fingerprint = rejectionFingerprint(assignment)
    const existing = this.state.data.rejections?.[fingerprint]
    if (['accepted', 'quarantined'].includes(existing?.acknowledgement?.outcome)) {
      return { status: localStatus, assignmentId: assignment.id, rejection: existing }
    }
    const now = new Date().toISOString()
    const rejection = {
      schema: 'loom.local-rejection.v1', fingerprint,
      assignment_id: assignment.id, ticket_id: typeof assignment.ticket_id === 'string' ? assignment.ticket_id : null,
      lease_epoch: assignment.lease_epoch,
      grant_digest: assignment.grant_digest || assignment.grant?.grant_digest || assignment.grant?.digest || null,
      local_status: localStatus, reason: String(reason).slice(0, 500),
      created_at: existing?.created_at || now, updated_at: now,
      acknowledgement: { outcome: 'pending' },
    }
    await this.state.mutate((data) => {
      data.rejections ||= {}
      data.rejections[fingerprint] = rejection
    })
    const idsValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(assignment.id || '') && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(assignment.ticket_id || '')
    let acknowledgement
    if (!idsValid) {
      acknowledgement = { outcome: 'not_attempted', reason: 'missing_current_ticket_or_assignment_id' }
    } else {
      try {
        const receipt = await this.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
          leaseEpoch: assignment.lease_epoch, accepted: false, reason })
        acknowledgement = receipt.response?.accepted === true ? { outcome: 'accepted' } : { outcome: 'pending' }
      } catch (error) {
        acknowledgement = optionalNodeAckError(error)
      }
    }
    await this.state.mutate((data) => {
      data.rejections[fingerprint] = { ...data.rejections[fingerprint], updated_at: new Date().toISOString(), acknowledgement }
    })
    return { status: localStatus, assignmentId: assignment.id,
      rejection: this.state.data.rejections[fingerprint] }
  }
  async tick() { await this.pollAndRun(); return this.client.dispatchOutbox() }
}
export { envelope }
