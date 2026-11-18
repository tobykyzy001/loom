import { resolve } from 'node:path'
import { LocalNodeRunner, wireCapabilities } from '../src/runner.js'
import { sleep, sha256, canonical } from '../src/util.js'
import { admissionFence, cancellationFence, sameAuthorizedAssignment } from '../src/admission.js'

/** Bounded outbound-only coordinator plugin runner. Idempotent local completions and backoff survive restart. */
export class CoordinatorLoop {
  constructor(config, executor, client) {
    this.config = config; this.executor = executor; this.client = client
    this.runner = executor.runner
    this.controller = new AbortController(); this.disposed = false; this.workerCount = 0
    this.timer = null; this.rejections = 0; this.lastError = null; this.pending = new Map()
    this.lastAssignment = null; this.revocationStops = new Set()
  }
  get signal() { return this.controller.signal }
  start() {
    this.effectTask = this.loop().catch((error) => { if (!this.disposed) this.lastError = error.message })
  }
  async loop() {
    let failures = 0
    while (!this.signal.aborted) {
      try {
        const assignment = await this.pollCycle()
        if (assignment) this.startAssignment(assignment)
        failures = 0
        if (assignment || this.pending.size) continue
        await sleep(this.config.heartbeat_ms
          ? Math.min(this.config.heartbeat_ms, (this.config.poll_seconds + 1) * 1000) : 1000, this.signal)
      } catch (error) {
        if (this.signal.aborted) break
        this.lastError = error.message; failures++
        await sleep(Math.min(this.config.heartbeat_ms, 1000 * (2 ** Math.min(failures, 4))), this.signal)
      }
    }
  }
  async pollCycle() {
    const facts = await (this.executor.registrationFacts?.(this.capabilities) || this.runner?.registrationFacts?.(this.capabilities)) || {}
    const { workers, inventory } = facts
    const outgoing = { status: this.workerCount ? 'busy' : 'online',
      capabilities: wireCapabilities(this.capabilities || []), ...(workers ? { workers } : {}), ...(inventory ? { inventory } : {}), signal: this.signal }
    // The authenticated outbound body is verified by the real Coordinator; no test-only transport log.
    await this.client.heartbeat(outgoing)
    const delivered = await this.client.dispatchOutbox({ signal: this.signal })
    if (delivered.some((item) => item.status === 'deferred' && item.error.includes('409'))) this.rejections++
    return this.client.poll({ lastAssignmentId: this.lastAssignment?.id || null, waitSeconds: this.config.poll_seconds, signal: this.signal })
  }
  startAssignment(assignment) {
    const revocation = isRevocation(assignment)
    // Once stopped, only this process's original operation may finish/report. A restart has
    // an empty Set but must still prove durable + executing + pending before another stop.
    if (revocation && this.revocationStops.has(assignment.id)) return
    const taskKey = revocation ? `${assignment.id}:revocation`
      : assignment.cancel_requested ? `${assignment.id}:cancellation` : assignment.id
    if (this.pending.has(taskKey)) return
    if (!revocation && this.lastAssignment?.id === assignment.id && this.lastAssignment.lease_epoch === assignment.lease_epoch && this.lastAssignment.grant_digest === assignment.grant_digest && !assignment.cancel_requested) return
    this.lastAssignment = assignment
    const task = this.handle(assignment).catch((error) => {
      // Report failed delivery truthfully; never fabricate cancellation acknowledgement.
      this.lastError = error.message
      process.stderr.write(`[loom-local-node] ${assignment.id}: ${error.message}\n`)
    })
      .finally(() => this.pending.delete(taskKey))
    this.pending.set(taskKey, task)
    return task
  }
  async handle(assignment) {
    if (this.executor.immutableInput) {
      try { assignment = this.executor.immutableInput(assignment) } catch {
        await this.runner.rejectAssignment(assignment, 'invalid_immutable_model_request')
        return
      }
    }
    const revocation = isRevocation(assignment)
    const existing = this.pending.get(assignment.id) || (assignment.cancel_requested && !revocation ? null : this.pending.get(`${assignment.id}:cancellation`))
    let durable = this.runner?.state?.data?.assignments?.[assignment.id]
    const active = this.executor.active?.get(assignment.id)
    // Ordinary execution flags are useful but are not the only proof of an
    // attached claim. The adapter must actually own a live waiter and followup.
    if (revocation && active?.executing !== true && !hasLiveAdapterClaim(this.executor, assignment.id)) {
      await this.runner.rejectAssignment(assignment, 'revoked_execution_not_attached')
      return
    }
    const activeAssignment = revocation
      ? (active?.executing === true ? active?.assignment : durable)
      : this.runner?.activeAssignments?.get(assignment.id) || this.executor.active?.get(assignment.id)?.assignment
    if (revocation) {
      if (!existing || !durable || !sameAdmittedRevocation(durable, activeAssignment, assignment)) {
        await this.runner.rejectAssignment(assignment, 'revocation_assignment_mismatch')
        return
      }
      const annotated = await annotateRevocation(this.runner, durable, assignment)
      if (!annotated) {
        await this.runner.rejectAssignment(assignment, 'revocation_assignment_changed_before_persist')
        return
      }
      this.revocationStops.add(assignment.id)
      await this.executor.cancel?.(assignment.id)
      // Only the original in-flight operation produces its Report/Artifacts. Stop intent is
      // neither a cancelled Center acknowledgement nor a second completion of the Assignment.
      await existing
      await this.client.dispatchOutbox()
      return
    }
    if (assignment.cancel_requested && !durable && !existing && !activeAssignment) {
      try { durable = await this.runner.admitCancellation(assignment) }
      catch (error) {
        await this.runner.rejectAssignment(assignment, error.message)
        return
      }
    }
    if (assignment.cancel_requested && (existing || activeAssignment) && !durable) {
      await this.runner.rejectAssignment(assignment, 'missing_previous_assignment')
      return
    }
    const stale = assignment.cancel_requested
      ? cancellationFence(durable, assignment, activeAssignment)
      : admissionFence(durable, assignment)
    if (assignment.cancel_requested) {
      if (!durable || stale) {
        await this.runner.rejectAssignment(assignment, stale || 'unknown_local_assignment')
        return
      }
      const prestart = this.runner?.state?.data?.completions?.[assignment.id]
      const beforeExecution = prestart?.state === 'cancelled' && prestart?.execution_started === false
      const expectedDigest = sha256(canonical({ assignment_id: assignment.id, lease_epoch: assignment.lease_epoch, grant_version: assignment.grant_version }))
      if (beforeExecution && prestart.digest !== expectedDigest) {
        await this.runner.rejectAssignment(assignment, 'cancellation_delivery_fingerprint_mismatch')
        return
      }
      const stopped = (beforeExecution && !existing) || await this.executor.cancel?.(assignment.id)
      await this.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: stopped === true, cancelRequested: true,
        reason: 'Cancellation requested; outcome awaits observed effect/report' })
      if (beforeExecution && !existing) {
        // Replay the durable pre-start completion, even after an ack interruption or restart.
        await this.executor.report(assignment, prestart)
        await this.client.dispatchOutbox()
        return
      }
      if (existing) {
        await existing
        // The original in-flight Assignment is the unique Report producer; this stop branch only dispatches its evidence.
        await this.client.dispatchOutbox()
        return
      }
      const observed = this.runner?.state.data.completions[assignment.id]
      // Only an actually observed terminal local completion may produce this Report, never the intent itself.
      process.stderr.write(`[loom-local-node] cancel ${assignment.id} observed terminal ${observed?.state || 'none'}\n`)
      if (observed && ['cancelled', 'failed', 'unknown'].includes(observed.state)) await this.executor.report(assignment, observed)
      return
    }
    const mismatched = durable && !sameAuthorizedAssignment(durable, assignment)
    if (stale || durable?.cancel_requested || mismatched) {
      await this.runner.rejectAssignment(assignment, stale || (durable?.cancel_requested ? 'assignment_already_cancelled' : 'assignment_input_changed'))
      return
    }
    if (this.workerCount >= this.config.max_active_workers || await this.executor.canExecute?.(assignment) === false) {
      await this.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: false, reason: 'Insufficient local capability or configured worker limit' })
      return
    }
    this.workerCount++
    try {
      const completed = await this.executor.executeAssignment(assignment)
      await this.executor.report(assignment, completed)
    } catch (error) {
      if (error.fenced) {
        await this.runner.rejectAssignment(assignment, error.message)
        return
      }
      await this.executor.report(assignment, { state: error.state || 'unknown', summary: error.message, effects: [], artifacts: [] })
    } finally { this.workerCount-- }
  }
  async dispose() {
    this.disposed = true; this.controller.abort(new Error('Plugin unloading'))
    const activeIds = [...new Set([...this.pending.keys()].map((key) => key.replace(/:(?:cancellation|revocation)$/, '')))]
    await Promise.allSettled(activeIds.map((id) => this.executor.cancel?.(id)))
    if (this.effectTask) await this.effectTask
    await Promise.allSettled(this.pending.values())
    await this.executor.dispose?.()
  }
}

function hasLiveAdapterClaim(executor, assignmentId) {
  const adapter = executor?.adapter
  const record = adapter?.sequence?.get(assignmentId)
  const sessionId = record?.agent?.session?.id
  // These flags have an exact single-operation meaning: the bound Agent followup
  // was issued, its original waiter still exists, and it is actually running.
  return record?.request_started === true && record?.agent?.status === 'running'
    && adapter?.waiters?.has(assignmentId) === true
    && typeof sessionId === 'string'
    && adapter?.sessionOwners?.get(sessionId) === assignmentId
}

// A reconciled Grant view is not a fresh execution authorization. This intentionally narrow
// file-Agent increment does not extend revocation handling to model or credential work.
function isRevocation(assignment) {
  return assignment?.kind === 'edit_file' && assignment.purpose === 'reconcile'
    && assignment.status === 'reconciling' && assignment.grant_status === false
    && Number.isSafeInteger(assignment.grant?.version) && assignment.grant.version > 0
    && typeof assignment.grant.revoked_at === 'string' && assignment.grant.revoked_at.trim() !== ''
    && assignment.grant_revoked_at === assignment.grant.revoked_at
    && Number.isFinite(Date.parse(assignment.grant.revoked_at))
}

// Compare immutable work only. The JSON copies deliberately remove the current Grant view;
// durable/executing frames and their O(n) history are never normalized or overwritten for this.
function sameAdmittedRevocation(durable, active, incoming) {
  // The frozen Assignment header proves which Grant version was admitted. Only current
  // grant.version / revoked_at may advance on this view; header 1 must never erase into 2.
  const version = value => value?.grant_version ?? value?.grant?.version
  if (!Number.isSafeInteger(version(incoming)) || version(durable) !== version(incoming)
    || version(active) !== version(incoming)
    || incoming.grant.version <= version(incoming)
    || durable?.grant?.revoked_at != null || active?.grant?.revoked_at != null) return false
  const view = value => {
    // Both header levels are current revocation views, not the prior work payload.
    const { grant_version: _version, grant_revoked_at: _revoked_at, ...frame } = JSON.parse(JSON.stringify(value))
    if (frame.grant && typeof frame.grant === 'object' && !Array.isArray(frame.grant)) {
      const { version: _version, ...grant } = frame.grant
      frame.grant = grant
    }
    return frame
  }
  return sameAuthorizedAssignment(view(durable), view(active))
    && sameAuthorizedAssignment(view(active), view(incoming))
}

async function annotateRevocation(runner, before, incoming) {
  return runner.state.mutate((data) => {
    const current = data.assignments[incoming.id]
    // Preserve the exact admitted payload, including cancel_requested, under an optimistic fence.
    // This is a non-authority observation, not an executing/current Grant replacement.
    if (!sameAuthorizedAssignment(before, current)) return false
    data.assignments[incoming.id] = {
      ...current,
      revocation: {
        schema: 'loom.local-revocation-view.v1', authority: false,
        grant_id: incoming.grant_id || incoming.grant.id,
        version: incoming.grant.version, revoked_at: incoming.grant.revoked_at,
        grant_status: false,
      },
    }
    return true
  })
}

export async function createClient({ base_url: baseUrl, state_dir: stateDir, artifact_dir: artifactDir, baseUrl: legacyBaseUrl, stateDir: legacyStateDir, artifactDir: legacyArtifactDir, enrollment_code: enrollmentCode, enrollmentCode: legacyEnrollmentCode, fetch, registration, request_timeout_ms, project_roots: projectRoots, profile_id: profileId }, { signal } = {}) {
  const runner = await LocalNodeRunner.create({ baseUrl: baseUrl || legacyBaseUrl, stateDir: resolve(stateDir || legacyStateDir), artifactDir: resolve(artifactDir || legacyArtifactDir),
    enrollmentCode: enrollmentCode || legacyEnrollmentCode, fetch, registration: { profile_id: profileId, ...registration, project_roots: projectRoots }, requestTimeoutMs: request_timeout_ms, signal })
  return { runner, client: runner.client, capabilities: runner.capabilities }
}
export async function runLocalDshPlugin(config, dependency, { signal } = {}) {
  const stopped = () => {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Loom factory startup cancelled before Coordinator polling')
  }
  stopped()
  const context = await (dependency.createClient || createClient)({ ...config, request_timeout_ms: config.request_timeout_ms ?? config.requestTimeoutMs }, { signal })
  stopped()
  const local = dependency.localDispatcher(config, context.runner)
  const executor = dependency.executor || local
  // Exactly one bounded lookup per new executor before its first authenticated heartbeat.
  await timeoutWithin(executor.initializeModelCatalog?.(), 5000, executor, signal)
  stopped()
  const loop = new CoordinatorLoop(config, executor, context.client)
  loop.capabilities = executor.capabilities || context.capabilities
  loop.start()
  return loop
}
async function timeoutWithin(promise, milliseconds, executor, signal) {
  if (!promise) return
  let timer, onAbort
  const deadline = new Error('Model adapter observation timed out')
  const observation = new Promise((_, reject) => {
    timer = setTimeout(() => reject(deadline), milliseconds)
    timer.unref()
    onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('Loom factory startup cancelled while observing the catalog'))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([promise, observation])
  } catch (error) {
    if (error === deadline) executor.modelCatalogLookupExpired?.()
    else if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error
    else executor.modelCatalogLookupExpired?.()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
