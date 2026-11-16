import { resolve } from 'node:path'
import { LocalNodeRunner } from '../src/runner.js'
import { sleep } from '../src/util.js'

/** Bounded outbound-only coordinator plugin runner. Idempotent local completions and backoff survive restart. */
export class CoordinatorLoop {
  constructor(config, executor, client) {
    this.config = config; this.executor = executor; this.client = client
    this.controller = new AbortController(); this.disposed = false; this.workerCount = 0
    this.timer = null; this.rejections = 0; this.lastError = null; this.pending = new Map()
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
    await this.client.heartbeat({ status: this.workerCount ? 'busy' : 'online', capabilities: this.capabilities, signal: this.signal })
    const delivered = await this.client.dispatchOutbox({ signal: this.signal })
    if (delivered.some((item) => item.status === 'deferred' && item.error.includes('409'))) this.rejections++
    return this.client.poll({ waitSeconds: this.config.poll_seconds, signal: this.signal })
  }
  startAssignment(assignment) {
    if (this.pending.has(assignment.id)) return
    const task = this.handle(assignment).catch((error) => { this.lastError = error.message })
      .finally(() => this.pending.delete(assignment.id))
    this.pending.set(assignment.id, task)
    return task
  }
  async handle(assignment) {
    if (assignment.cancel_requested) {
      await this.executor.cancel?.(assignment.id)
      await this.client.acknowledge({ ticketId: assignment.ticket_id, assignmentId: assignment.id,
        leaseEpoch: assignment.lease_epoch, accepted: true, cancellation: true, reason: 'Cancellation requested; outcome awaits observed effect/report' })
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
    await Promise.allSettled([...this.pending.values()].map((_, index) => this.executor.cancel?.([...this.pending.keys()][index])))
    if (this.effectTask) await this.effectTask
    await Promise.allSettled(this.pending.values())
    await this.executor.dispose?.()
  }
}
export async function createClient({ baseUrl, stateDir, artifactDir, fetch, enrollmentCode, registration }) {
  const runner = await LocalNodeRunner.create({ baseUrl: baseUrl, stateDir: resolve(stateDir), artifactDir: resolve(artifactDir),
    enrollmentCode, fetch, registration })
  return { runner, client: runner.client, capabilities: runner.capabilities }
}
export async function runLocalDshPlugin(config, dependency) {
  const context = await (dependency.createClient || createClient)(config)
  const local = dependency.localDispatcher(config, context.runner)
  const executor = dependency.executor || local
  const loop = new CoordinatorLoop(config, executor, context.client)
  loop.capabilities = executor.capabilities || context.capabilities
  loop.start()
  return loop
}
