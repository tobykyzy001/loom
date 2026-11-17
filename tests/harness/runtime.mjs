import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PROFILE, installation, profilePatch, redact, sleep } from './environment.mjs'

/** Exactly the installed SDK JSON-RPC wire protocol, with private stderr and no secret fields. */
export class FixtureHost extends EventEmitter {
  constructor(root, env, secrets = [], initializeModel = { provider: 'loom-stub', model: 'loom-stub-v1' }) {
    super()
    this.root = root; this.env = env; this.secrets = secrets; this.initializeModel = initializeModel
    this.pending = new Map(); this.frames = []; this.events = []; this.text = ''
    this.earlyExit = null
    this.stderr = []; this.protocolFramingErrors = []; this.child = null; this.next = 1; this.draining = false
  }
  async start() {
    if (this.child) throw new Error('Host already started')
    await this.writePatch()
    const { executable, cli } = installation()
    const patch = join(this.root, 'patch', 'fixture.yml')
    this.startArgs = [cli, '--profile', PROFILE, '--patch', patch]
    this.child = spawn(executable, this.startArgs, { cwd: join(this.root, 'project'), env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    this.child.stdout.setEncoding('utf8'); this.child.stdout.on('data', (chunk) => this.accept(chunk))
    this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', (chunk) => {
      const text = redact(String(chunk), this.secrets)
      this.stderr.push(text.slice(-12000)); if (this.stderr.length > 30) this.stderr.shift()
      // stderr is retained in diagnostics; one expected negative assertion must not drown independent checks.
    })
    const onExit = (value) => {
      this.earlyExit ||= value
      for (const waiter of this.pending.values()) waiter.reject(new Error(`DSH exited before response: ${JSON.stringify(value)}; ${this.stderr.join('').slice(-1000)}`))
      this.pending.clear()
      this.emit('exit', value)
    }
    this.child.once('error', (error) => onExit({ error: error.message }))
    this.child.once('exit', (code, signal) => onExit({ code, signal }))
    await this.raw('initialize', { cwd: join(this.root, 'project'), ...this.initializeModel, approvalRequests: true }, 60_000)
    await appendFile(join(this.root, 'private', 'host-lifecycle.jsonl'), JSON.stringify({ event: 'initialized', dsh_profile: PROFILE, argv: ['--profile', PROFILE, '--patch', '<fixture>/patch/fixture.yml'] }) + '\n', { mode: 0o600 })
    return this
  }
  async writePatch() {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(this.root, 'patch', 'fixture.yml'), profilePatch(this.env), { mode: 0o600 })
  }
  accept(chunk) {
    this.text += chunk
    for (;;) {
      const index = this.text.indexOf('\n'); if (index < 0) break
      const line = this.text.slice(0, index); this.text = this.text.slice(index + 1)
      if (!line.trim()) continue
      let frame
      try { frame = JSON.parse(line) } catch (error) { this.protocolFramingErrors.push(redact(error.message, this.secrets)); this.emit('protocol-error', error); continue }
      this.frames.push(frame)
      if (frame.method) this.emit(frame.method, frame.params)
      if (frame.method === 'session.event') this.events.push(frame.params)
      if (frame.method === 'approval/request' && frame.id !== undefined) {
        void this.answer(frame.id, { outcome: 'rejected' })
      }
      if (!('id' in frame)) continue
      for (const waiter of this.pending.values()) {
        if (waiter.matches(frame)) {
          this.pending.delete(waiter.id); clearTimeout(waiter.timer)
          if ('error' in frame) waiter.reject(new Error(`DSH JSON-RPC ${frame.error.code}: ${frame.error.message}`))
          else waiter.resolve(frame.result)
          break
        }
      }
    }
  }
  raw(method, params, timeoutMs = 45_000) {
    if (this.earlyExit) return Promise.reject(new Error(`Cannot call ${method}; DSH has exited: ${JSON.stringify(this.earlyExit)}`))
    const id = this.next++
    const waiter = { id, matches: (frame) => frame.id === id }
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve; waiter.reject = reject
      waiter.timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out ${method}`)) }, timeoutMs)
    })
    this.pending.set(id, waiter)
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return waiter.promise
  }
  answer(id, result) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); return Promise.resolve() }
  async stop() {
    if (!this.child || this.earlyExit) return this.earlyExit || { code: 0 }
    const exited = new Promise((ok) => { if (this.earlyExit) ok(this.earlyExit); else this.once('exit', ok) })
    try {
      const shutdown = this.raw('shutdown', {}, 12_000).catch(() => {})
      this.child.stdin.end()
      await shutdown
    } catch { this.child.stdin.end() }
    const result = await Promise.race([exited, sleep(12_000).then(() => {
      this.child.kill('SIGTERM')
      return sleep(3000).then(() => { if (!this.earlyExit) this.child.kill('SIGKILL'); return exited })
    })])
    await appendFile(join(this.root, 'private', 'host-lifecycle.jsonl'), JSON.stringify({ event: 'exit', code: result?.code ?? null, signal: result?.signal ?? null }) + '\n', { mode: 0o600 })
    return result
  }
  sessionEvents(sessionId, types) {
    return this.events.filter((entry) => entry.sessionId === sessionId && (!types || types.includes(entry.event.type)))
  }
  async waitFor(predicate, timeoutMs = 30_000, label = 'observed DSH event') {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) { if (await predicate()) return; if (this.earlyExit) throw new Error(`Host exited before ${label}: ${JSON.stringify(this.earlyExit)} ${this.stderr.join('').slice(-1200)}`); await sleep(100) }
    throw new Error(`Timed out waiting for ${label}: ${this.stderr.join('').slice(-1200)}`)
  }
  diagnostics() { return this.stderr.join('').slice(-10000) }
}
