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
    if (data.deliveries !== undefined && !Array.isArray(data.deliveries)) throw new Error('Invalid local delivery ledger')
    state.data = data
    if (data.rejections === undefined) data.rejections = {}
    else if (!data.rejections || typeof data.rejections !== 'object' || Array.isArray(data.rejections)) throw new Error('Invalid local rejection ledger')
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
    if (!['ack', 'event', 'report', 'artifact'].includes(kind)) throw new TypeError('Unsupported outbox message kind')
    return this.mutate((data) => {
      const existing = data.outbox.find((item) => item.kind === kind && item.digest === digest)
      if (existing) return existing
      const delivered = data.deliveries?.find((item) => item.kind === kind && item.digest === digest)
      if (delivered && kind === 'ack') {
        if (typeof delivered.body?.request_id === 'string' && delivered.body.request_id.length > 0) {
          const original = { ...body, request_id: delivered.body.request_id }
          if (canonical(delivered.body) !== canonical(original)) {
            throw new Error('Cannot replay a different ACK body with the same logical digest')
          }
          const item = { kind, body: original, digest: delivered.digest, attempts: 0, next_attempt_at: new Date(now).toISOString(), last_error: null }
          data.outbox.push(item)
          return item
        }
        // Missing ACK request identity cannot be advertised as previously accepted.
        // Schedule the current well-formed intent and let an actual server reconcile it.
      }
      const item = { kind, body, digest, attempts: 0, next_attempt_at: new Date(now).toISOString(), last_error: null }
      data.outbox.push(item); return item
    })
  }
  /** Dedupe is scoped to assignment+digest; accepting a retry with a different digest is forbidden. */
  async once(key, digest, operation) {
    const existing = this.data.completions[key]
    if (existing) {
      const bad = typeof existing.digest !== 'string' || !existing.digest
      if (bad || existing.digest !== digest) {
        const error = new Error(bad ? 'Persistent completion has no verifiable task input digest' : 'Assignment reused with different input')
        error.fenced = true
        throw error
      }
      return { ...existing, duplicate: true }
    }
    const pending = { assignment_id: key, digest, state: 'running', summary: 'The deterministic operation is in progress.', artifacts: [], effects: [] }
    await this.mutate((data) => { data.completions[key] = pending })
    if (this.data.assignments[key]?.cancel_requested) {
      return this.complete(key, { ...pending, state: 'cancelled', cancel_acknowledged: true, summary: 'Cancelled before the operation started.', artifacts: [], effects: [] })
    }
    let result
    try { result = await operation() } catch (error) {
      result = { state: error.state || 'failed', summary: error.message, cancel_acknowledged: error.cancel_acknowledged === true, session_ref: error.session_ref, artifact: null, effect: null }
    }
    return this.complete(key, { ...pending, ...result, digest, assignment_id: key })
  }
  async complete(key, result) {
    await this.mutate((data) => { data.completions[key] = result })
    return result
  }
}
