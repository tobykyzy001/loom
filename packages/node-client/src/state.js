import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { canonical, readJson, sha256, writeJsonAtomic } from './util.js'

const EMPTY = { version: 1, outbox: [], assignments: {}, completions: {} }
/** Explicitly plugin-owned node state, not an alternative session or cross-node authority. */
export class NodeState extends EventEmitter {
  static async open(stateDir) {
    const state = new NodeState(join(stateDir, 'node-state.json'))
    const data = await readJson(state.file, structuredClone(EMPTY))
    if (data.version !== 1 || !Array.isArray(data.outbox) || typeof data.assignments !== 'object' || typeof data.completions !== 'object') {
      throw new Error('Invalid persistent Loom node state')
    }
    state.data = data
    // A synchronous initializer can legitimately return before its effect is known.
    for (const record of Object.values(data.completions)) {
      if (record.state === 'running' || record.state === 'restarting') {
        record.state = 'unknown'
        record.summary = 'Local process restarted while the effect outcome was not confirmed.'
        record.recovered_from_restart = true
      }
    }
    await state.flush()
    return state
  }
  constructor(file) { super(); this.file = file; this.setMaxListeners(20); this.queue = Promise.resolve() }
  flush() {
    const promise = this.queue.then(() => writeJsonAtomic(this.file, this.data))
    this.queue = promise.catch(() => {})
    return promise
  }
  async mutate(callback) {
    const task = this.queue.then(async () => {
      const value = await callback(this.data)
      await writeJsonAtomic(this.file, this.data)
      this.emit('changed')
      return value
    })
    this.queue = task.then(() => {}, () => {})
    return task
  }
  get outbox() { return [...this.data.outbox.values()].sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at)) }
  async enqueue(kind, body, { digest = sha256(canonical(body)), now = Date.now() } = {}) {
    if (!['event', 'report', 'artifact'].includes(kind)) throw new TypeError('Unsupported outbox message kind')
    return this.mutate((data) => {
      const existing = data.outbox.find((item) => item.kind === kind && item.digest === digest)
      if (existing) return existing
      const delivered = data.deliveries?.find((item) => item.kind === kind && item.digest === digest)
      if (delivered) {
        if (canonical(delivered.body) !== canonical(body)) throw new Error('Cannot replay a different body with the same logical digest')
        const item = { kind, body: delivered.body, digest, attempts: 0, next_attempt_at: new Date(now).toISOString(), last_error: null }
        data.outbox.push(item)
        return item
      }
      const item = { kind, body, digest, attempts: 0, next_attempt_at: new Date(now).toISOString(), last_error: null }
      data.outbox.push(item); return item
    })
  }
  /** Dedupe is scoped to assignment+digest; accepting a retry with a different digest is forbidden. */
  async once(key, digest, operation) {
    const existing = this.data.completions[key]
    if (existing) {
      if (existing.digest && existing.digest !== digest) throw new Error('Assignment reused with different input')
      return { ...existing, duplicate: true }
    }
    const pending = { assignment_id: key, digest, state: 'running', summary: 'The deterministic operation is in progress.', artifacts: [], effects: [] }
    await this.mutate((data) => { data.completions[key] = pending })
    if (this.data.assignments[key]?.cancel_requested) {
      return this.complete(key, { state: 'cancelled', summary: 'Cancelled before the operation started.', artifacts: [], effects: [] })
    }
    let result
    try { result = await operation() } catch (error) {
      result = { state: 'failed', summary: error.message, artifact: null, effect: null }
    }
    return this.complete(key, result)
  }
  async complete(key, result) {
    await this.mutate((data) => { data.completions[key] = result })
    return result
  }
}
