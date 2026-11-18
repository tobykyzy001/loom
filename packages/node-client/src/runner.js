import { isAbsolute, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { LoomHttpClient } from './http.js'
import { LoomNodeClient } from './client.js'
import { NodeIdentity } from './identity.js'
import { NodeState } from './state.js'
import { CAPABILITIES, envelope, validateAssignment } from './validation.js'
import { ControlledFileExecutor } from './executor.js'
import { canonical, sha256, requireIsolatedRoot } from './util.js'
import { admissionFence, cancellationFence, optionalNodeAckError, rejectionFingerprint, rejectionInputDigest, sameAuthorizedAssignment } from './admission.js'

export class LocalNodeRunner {
  constructor(options) {
    this.options = options
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
    this.http = new LoomHttpClient({ baseUrl: this.options.baseUrl, fetch: this.options.fetch })
    this.client = new LoomNodeClient({ http: this.http, identity: this.identity, state: this.state })
    this.executor = this.options.executor || new ControlledFileExecutor({ artifactDir: this.options.artifactDir, projectRoots: this.options.projectRoots })
    if (enrollmentCode || !this.identity.token) {
      if (!enrollmentCode) throw new Error('Persistent node token is missing; an explicit enrollment code is required')
      stopped()
      await this.client.enroll({ enrollmentCode, capabilities: this.capabilities, ...this.options.registration, signal })
      stopped()
    }
    await this.client.heartbeat({ capabilities: this.capabilities,
      workers: [{ worker_id: this.options.registration?.workerId || 'default' }],
      inventory: { project_roots: this.options.projectRoots || {}, source: 'explicit_local_node_configuration' }, signal })
    stopped()
    return this.identity.public
  }
  /** New coordinator caller; no server-to-node transport or local HTTP listener is needed. */
  static async create({ stateDir, artifactDir, baseUrl, enrollmentCode, registration, projectRoots, signal, fetch } = {}) {
    const runner = new LocalNodeRunner({ stateDir: requireIsolatedRoot(stateDir), artifactDir: resolve(artifactDir),
      baseUrl, registration, projectRoots, fetch })
    await runner.start({ enrollmentCode, signal })
    return runner
  }
  get nodeId() { return this.identity.nodeId }
  get installationId() { return this.identity.installationId }
  async pollAndRun() {
    const assignment = await this.client.poll({ lastAssignmentId: this.lastAssignmentId })
    if (!assignment) return { status: 'idle' }
    if ((assignment.cancel_requested === true || assignment.cancel_requested === 1) && assignment.id) {
      let previous = this.state.data.assignments[assignment.id]
      const activeAssignment = this.activeAssignments.get(assignment.id)
      if (previous === undefined && !activeAssignment) {
        try { previous = await this.admitCancellation(assignment) }
        catch (error) { return this.rejectAssignment(assignment, error.message) }
      }
      const stale = cancellationFence(previous, assignment, activeAssignment)
      if (stale) return this.rejectAssignment(assignment, stale)
      const knownTermination = this.state.data.completions[assignment.id]
      if (!activeAssignment && knownTermination?.execution_started === false && knownTermination.state === 'cancelled') {
        const digest = sha256(canonical({ assignment_id: assignment.id, lease_epoch: assignment.lease_epoch, grant_version: assignment.grant_version }))
        if (knownTermination.digest !== digest) return this.rejectAssignment(assignment, 'cancellation_delivery_fingerprint_mismatch')
        return { status: 'cancel_acknowledged', assignmentId: assignment.id,
          ...await this.report(previous, knownTermination) }
      }
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
      const acknowledged = await this.report(previous, { state: 'cancelled', cancel_acknowledged: true,
        summary: 'Cancellation intent acknowledged; any pre-existing effect requires its own evidence.' })
      return { status: 'cancel_acknowledged', assignmentId: assignment.id, ...acknowledged }
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
      await this.assertApprovedRoot(assignment, grant)
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
      const known = this.state.data.completions[assignment.id]
      if (known) {
        const missing = typeof known.digest !== 'string' || known.digest.length === 0
        if (missing || known.digest !== digest) return this.rejectAssignment(assignment,
          missing ? 'Persistent completion has no verifiable task input digest' : 'Assignment reused with different input')
      }
      if (known) {
        // A late/repeated poll is evidence dedupe, not a new execution or delivery acknowledgement.
        return { status: known.state, assignmentId: assignment.id, duplicate: true,
          ...(await this.report(assignment, known)) }
      }
      const result = await this.state.once(assignment.id, digest, () => this.executor.execute(assignment, grant))
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
  /** A first stop notification requires its actual Assignment and authorization, never a fabricated prior admission. */
  async admitCancellation(assignment) {
    if (![true, 1].includes(assignment.cancel_requested)) throw new Error('Missing node cancellation intent')
    const grant = assignment.grant || this.options.grants?.[assignment.grant_digest]
    const verified = validateAssignment(assignment, grant, this.identity, { forCancellation: true })
    const candidate = { ...assignment, ...verified, grant_version: assignment.grant_version ?? grant.version }
    await this.assertApprovedRoot(assignment, grant)
    await this.state.mutate((data) => {
      const previous = data.assignments[assignment.id]
      const completed = data.completions[assignment.id]
      if (completed) {
        const error = new Error('A pre-start cancellation cannot replace an existing execution outcome')
        error.fenced = true
        throw error
      }
      const stale = admissionFence(previous, candidate)
      if (stale || (previous && !sameAuthorizedAssignment(previous, candidate))) {
        const error = new Error(stale || 'cancellation_admission_mismatch')
        error.fenced = true
        throw error
      }
      data.assignments[assignment.id] = previous || candidate
      data.completions[assignment.id] = {
        assignment_id: candidate.id,
        digest: sha256(canonical({ assignment_id: candidate.id, lease_epoch: candidate.lease_epoch, grant_version: candidate.grant_version })),
        state: 'cancelled', execution_started: false, cancel_acknowledged: true,
        summary: 'An authorized Assignment was stopped before starting an executor or Agent; no Artifact or external effect was created by this cancellation.',
        artifacts: [], effects: [],
      }
    })
    return this.state.data.assignments[assignment.id]
  }
  async assertApprovedRoot(assignment, grant) {
    const mapping = this.options.projectRoots?.[assignment.project_id]
    if (!mapping) throw new Error('No locally configured ProjectId-to-root mapping; refusing to execute')
    if (resolve(grant.project_root || grant.root || '') !== resolve(mapping)) throw new Error('Center Grant root does not match this node\'s exact approved local project mapping')
    const [approved, configured] = await Promise.all([realpath(grant.project_root || grant.root), realpath(mapping)])
    const allowed = (root) => isAbsolute(root) && root !== sep && root !== resolve(process.env.HOME || '__none__')
    if (!allowed(approved) || !allowed(configured) || approved !== configured) {
      throw new Error('Center Grant root does not match this node\'s exact approved local project mapping')
    }
  }
  async report(assignment, result) {
    let artifacts = Array.isArray(result.artifacts) ? result.artifacts : []
    let effects = Array.isArray(result.effects) ? result.effects : []
    if (result.artifact) {
      await this.client.artifact({ ticketId: assignment.ticket_id, artifactId: result.artifact.artifact_id,
        assignmentId: assignment.id, leaseEpoch: assignment.lease_epoch,
        metadata: { ...result.artifact.metadata, artifact_id: result.artifact.artifact_id }, bytes: result.artifact.bytes })
      artifacts = [...artifacts, { ...result.artifact.metadata, artifact_id: result.artifact.artifact_id }]
    }
    if (result.effect) effects = [...effects, result.effect]
    if (result.state === 'unknown' && effects.length === 0) {
      effects.push({ effect_id: `dsh-turn-${assignment.id}`, status: 'unknown', input_digest: result.digest || '', evidence: { description: 'The observed outcome still requires reconciliation; no unobserved file effect is claimed.', ...(result.session_ref ? { session_ref: result.session_ref } : {}) }, artifacts: [] })
    }
    return this.client.report({ ticketId: assignment.ticket_id, assignmentId: assignment.id, leaseEpoch: assignment.lease_epoch,
      state: result.state, summary: result.summary,
      cancelAcknowledged: result.cancel_acknowledged === true,
      evidence: [...(result.effect ? [result.effect.evidence] : (result.session_ref ? [result.session_ref] : [])),
        ...(result.stop_boundary ? [result.stop_boundary] : [])], artifacts, effects })
  }
  async rejectAssignment(assignment, reason, localStatus = 'fenced') {
    const fingerprint = rejectionFingerprint(assignment)
    const input_digest = rejectionInputDigest(assignment)
    const existing = this.state.data.rejections?.[fingerprint]
    const normalizedReason = String(reason).slice(0, 500)
    if (['accepted', 'quarantined'].includes(existing?.acknowledgement?.outcome)
      && existing.reason === normalizedReason
      && existing.input_digest === input_digest) {
      return { status: localStatus, assignmentId: assignment.id, rejection: existing }
    }
    if (['accepted', 'quarantined'].includes(existing?.acknowledgement?.outcome)
      && existing.reason === normalizedReason && existing.input_digest === undefined) {
      return { status: localStatus, assignmentId: assignment.id,
        rejection: { ...existing, current_context_unverified: true } }
    }
    const now = new Date().toISOString()
    const rejection = {
      schema: 'loom.local-rejection.v1', fingerprint, input_digest,
      assignment_id: assignment.id, ticket_id: typeof assignment.ticket_id === 'string' ? assignment.ticket_id : null,
      lease_epoch: assignment.lease_epoch,
      grant_digest: assignment.grant_digest || assignment.grant?.grant_digest || assignment.grant?.digest || null,
      local_status: localStatus, reason: normalizedReason,
      created_at: existing?.created_at || now, updated_at: now,
      // Only an acknowledgement attempt outcome, never task execution permission.
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
