import { resolve } from 'node:path'
import { LocalNodeRunner, wireCapabilities } from '../src/runner.js'
import { sleep } from '../src/util.js'

/** Bounded outbound-only coordinator plugin runner. Idempotent local completions and backoff survive restart. */
export class CoordinatorLoop {
  constructor(config, executor, client) {
    this.config = config; this.executor = executor; this.client = client
    this.runner = executor.runner
    this.controller = new AbortController(); this.disposed = false; this.workerCount = 0
    this.timer = null; this.rejections = 0; this.lastError = null; this.pending = new Map()
    this.lastAssignment = null
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
    const taskKey = assignment.cancel_requested ? `${assignment.id}:cancellation` : assignment.id
    if (this.pending.has(taskKey)) return
    if (this.lastAssignment?.id === assignment.id && this.lastAssignment.lease_epoch === assignment.lease_epoch && !assignment.cancel_requested) return
    this.lastAssignment = assignment
    const task = this.handle(assignment).catch((error) => {
      this.lastError = error.message
      process.stderr.write(`[loom-local-node] ${assignment.id}: ${error.message}\n`)
    })
      .finally(() => this.pending.delete(taskKey))
    this.pending.set(taskKey, task)
    return task
  }
  async handle(assignment) {
    const existing = this.pending.get(assignment.id) || (assignment.cancel_requested ? null : this.pending.get(`${assignment.id}:cancellation`))
    if (assignment.cancel_requested) {
      await this.executor.cancel?.(assignment.id)
      await this.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: true, cancellation: true, reason: 'Cancellation requested; outcome awaits observed effect/report' })
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
      await this.executor.report(assignment, { state: error.state || 'unknown', summary: error.message, effects: [], artifacts: [] })
    } finally { this.workerCount-- }
  }
  async dispose() {
    this.disposed = true; this.controller.abort(new Error('Plugin unloading'))
    await Promise.allSettled([...this.pending.keys()].map((key) => this.executor.cancel?.(key.replace(/:cancellation$/, ''))))
    if (this.effectTask) await this.effectTask
    await Promise.allSettled(this.pending.values())
    await this.executor.dispose?.()
  }
}
export async function createClient({ base_url: baseUrl, state_dir: stateDir, artifact_dir: artifactDir, baseUrl: legacyBaseUrl, stateDir: legacyStateDir, artifactDir: legacyArtifactDir, enrollment_code: enrollmentCode, enrollmentCode: legacyEnrollmentCode, fetch, registration, request_timeout_ms, project_roots: projectRoots, profile_id: profileId }) {
  const runner = await LocalNodeRunner.create({ baseUrl: baseUrl || legacyBaseUrl, stateDir: resolve(stateDir || legacyStateDir), artifactDir: resolve(artifactDir || legacyArtifactDir),
    enrollmentCode: enrollmentCode || legacyEnrollmentCode, fetch, registration: { profile_id: profileId, ...registration, project_roots: projectRoots }, requestTimeoutMs: request_timeout_ms })
  return { runner, client: runner.client, capabilities: runner.capabilities }
}
export async function runLocalDshPlugin(config, dependency) {
  const context = await (dependency.createClient || createClient)({ ...config, request_timeout_ms: config.request_timeout_ms ?? config.requestTimeoutMs })
  const local = dependency.localDispatcher(config, context.runner)
  const executor = dependency.executor || local
  // Exactly one bounded lookup per new executor before its first authenticated heartbeat.
  await timeoutWithin(executor.initializeModelCatalog?.(), 5000, executor)
  const loop = new CoordinatorLoop(config, executor, context.client)
  loop.capabilities = executor.capabilities || context.capabilities
  loop.start()
  return loop
}
async function timeoutWithin(promise, milliseconds, executor) {
  if (!promise) return
  let timer
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Model adapter observation timed out')), milliseconds)
      timer.unref()
    })])
  } catch { executor.modelCatalogLookupExpired?.() }
  finally { clearTimeout(timer) }
}
