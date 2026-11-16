import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * DSH 0.2.2-rc.3 public adapter. Sources verified in the installed ASAR:
 * dsh-agent/src/index.ts + runtime-types.ts and dsh-session/src/index.ts.
 * No private event types, Session.appendPluginRecord, synthetic transcript, or hidden protocol.
 */
export class DshAdapter {
  constructor(ctx, { allowCreation = false, agentSessionId = '', snapshotDir, sessionMapPath = '' } = {}) {
    if (!ctx || typeof ctx.on !== 'function') throw new Error('A real Host Context is required')
    this.ctx = ctx; this.allowCreation = allowCreation; this.agentSessionId = agentSessionId; this.snapshotDir = snapshotDir
    this.sessionMapPath = sessionMapPath; this.sessionMap = null
    this.owned = new Map(); this.waiters = new Map(); this.latest = new Map(); this.sequence = new Map()
    this.sessionOwners = new Map()
    ctx.on('session/event', (session, event) => {
      const assignmentId = this.sessionOwners.get(session.id)
      if (!assignmentId) return
      const tracked = this.sequence.get(assignmentId)
      // During SDK resume a session has a different identity but is the exact live Agent named by our mapping.
      const replacement = this.ctx.agents.get(session.id)
      if (tracked && tracked.agent.session !== session) return
      if (!tracked && !replacement) return
      if (!tracked) this.sequence.set(assignmentId, { agent: replacement, owned: false, dispose: async () => {}, refReported: true, last_seq: session.seq })
      this.sequence.get(assignmentId).last_seq = event.seq
      this.sequence.get(assignmentId).session_ref = {
        session_id: session.id, harness: 'dsh', host_api: '0.2.2-rc.3', protocol: 'dsh-session-log', observed_seq: event.seq,
      }
      if (event.type === 'assistant/message') {
        const previous = this.latest.get(assignmentId) || { full_text: '' }
        for (const block of event.data?.message?.content || event.data?.content || []) {
          if (block?.type === 'text' && typeof block.text === 'string') previous.full_text += block.text + '\n'
        }
        this.latest.set(assignmentId, previous)
      }
      if (event.type === 'turn/end') {
        const waiter = this.waiters.get(assignmentId)
        if (waiter) {
          const reason = event.data?.reason
          if (reason?.kind === 'completed') waiter.resolve(reason)
          else if (reason?.kind === 'aborted') waiter.reject(Object.assign(new Error(`DSH turn was aborted (${reason.reason?.kind || 'unknown'})`), { state: 'cancelled', cancel_acknowledged: true, reason }))
          else waiter.reject(Object.assign(new Error(`DSH turn ended without normal completion: ${reason?.kind || 'unknown'}${reason?.error?.message ? `: ${reason.error.message}` : ''}`), { state: reason?.kind === 'error' ? 'failed' : 'unknown', reason }))
        }
      }
    })
  }
  get available() {
    const agents = this.ctx.agents
    return Boolean(agents && typeof agents.create === 'function' && typeof agents.resume === 'function'
      && typeof agents.get === 'function' && typeof agents.list === 'function')
  }
  sessionRef(session) {
    // A reference to Session's real ordinary log, not a second transcript or private event source.
    return { harness: 'dsh', session_id: session.id, protocol: 'dsh-session-log', host_api: '0.2.2-rc.3', observed_seq: session.seq }
  }
  async loadSessionMap() {
    if (this.sessionMap) return this.sessionMap
    this.sessionMap = new Map()
    if (this.sessionMapPath) {
      try {
        const value = JSON.parse(await readFile(this.sessionMapPath, 'utf8'))
        if (value.version !== 1 || !Array.isArray(value.assignments)) throw new Error('Invalid Loom DSH Session mapping')
        for (const row of value.assignments) {
          if (typeof row.assignment_id === 'string' && typeof row.session_id === 'string') this.sessionMap.set(row.assignment_id, row.session_id)
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return this.sessionMap
  }
  async persistSessionMap(assignmentId, sessionId) {
    const map = await this.loadSessionMap()
    map.set(assignmentId, sessionId)
    if (!this.sessionMapPath) return
    const file = this.sessionMapPath + '.tmp'
    try {
      await writeFile(file, JSON.stringify({ version: 1, assignments: [...map].map(([assignment_id, session_id]) => ({ assignment_id, session_id })) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await import('node:fs/promises').then(({ rename }) => rename(file, this.sessionMapPath))
    } finally { await import('node:fs/promises').then(({ rm }) => rm(file, { force: true })).catch(() => {}) }
  }
  async attach(assignment, { provider, model, reasoningEffort, maxTokens, projectRoot, reportLink } = {}) {
    if (!this.available) throw new Error('Unsupported executor: live ctx.agents surface is unavailable')
    const existing = this.sequence.get(assignment.id)
    if (existing) return existing
    const sessionMap = await this.loadSessionMap()
    const ownedSessionId = sessionMap.get(assignment.id)
    const selectedSession = this.agentSessionId || ownedSessionId || randomUUID()
    let handle
    if (this.ctx.agents.get(selectedSession)) {
      handle = { agent: this.ctx.agents.get(selectedSession), owned: false }
    } else if (this.agentSessionId || ownedSessionId) {
      if (typeof this.ctx.sessionPersistence === 'undefined') throw new Error('A persisted DSH Session is unavailable for the configured session ID')
      handle = await this.ctx.agents.resume({ resumeSessionId: selectedSession, ...(provider || model ? { agentOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}) } } : {}) })
    } else {
      if (!this.allowCreation) throw new Error('DSH Agent creation is disabled; explicitly configure an existing session or opt in')
      handle = await this.ctx.agents.create({ sessionId: selectedSession, meta: { ...(projectRoot ? { cwd: projectRoot } : {}) },
        agentOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}), ...(maxTokens ? { maxTokens } : {}) } })
    }
    const record = { agent: handle.agent, owned: Boolean(handle.owned), dispose: ownedDispose(handle),
      last_seq: handle.agent.session.seq, refReported: false }
    this.sequence.set(assignment.id, record)
    this.sessionOwners.set(handle.agent.session.id, assignment.id)
    await this.persistSessionMap(assignment.id, handle.agent.session.id)
    await reportLink(this.sessionRef(handle.agent.session))
    record.refReported = true
    if (handle.owned) this.owned.set(handle.agent, handle.dispose)
    return record
  }
  async executeAssignment(assignment, config) {
    const { agent } = await this.attach(assignment, config)
    const { promise: settled, resolve, reject } = Promise.withResolvers()
    this.waiters.set(assignment.id, { resolve, reject })
    try {
      const objective = typeof assignment.objective === 'string' && assignment.objective
        ? assignment.objective : `Perform the authorized ${assignment.kind} operation.`
      const content = [{ type: 'text', text: objective }]
      agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze(content), source: Object.freeze({ kind: 'loom' }) }))
      await settled
      const snapshot = this.latest.get(assignment.id)
      if (!snapshot || !snapshot.full_text) throw new Error('DSH completed without an assistant message; no success can be inferred')
      const text = snapshot.full_text.slice(0, 64_000)
      const bytes = Buffer.from(JSON.stringify({ source: 'dsh-assistant-messages', assignment_id: assignment.id, text }, null, 2))
      const metadata = { name: `loom-session-${assignment.id}.json`, media_type: 'application/json', origin_node_id: assignment.node_id,
        // Source is the ordinary committed DSH message in this assignment, not a fabricated parent Artifact UUID.
        parents: [], evidence: [{ source: 'dsh-session-log', session_id: agent.session.id, observed_seq: agent.session.seq }] }
      if (this.snapshotDir) await writeFile(join(this.snapshotDir, `${assignment.id}.json`), bytes, { mode: 0o600, flag: 'wx' })
      return { state: 'succeeded', summary: 'DSH Agent completed an observed turn; report text is collected from ordinary Session messages.',
        content: bytes, metadata: { ...metadata, size_bytes: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') }, session_ref: this.sessionRef(agent.session), effects: [] }
    } catch (error) {
      // A known observer cancellation is not "unknown" merely because SessionRef was reported.
      error.session_ref ||= this.sequence.get(assignment.id)?.session_ref
      if (!['cancelled', 'failed'].includes(error.state) && this.sequence.get(assignment.id)?.refReported) error.state = 'unknown'
      throw error
    } finally { this.waiters.delete(assignment.id) }
  }
  async cancel(assignmentId) {
    // Only the exact Agent registered for this Assignment is cancelled; never another user's idle Session.
    const record = this.sequence.get(assignmentId)
    if (record) record.cancel_requested = true
    const entry = this.sequence.get(assignmentId)
    const id = entry?.agent?.session?.id
    const agent = this.ctx.agents.get(id) || entry?.agent
    if (agent?.status === 'running') { agent.cancel({ kind: 'user' }); return true }
    return false
  }
  agents() { return [...new Set([...this.sequence.values()].map((value) => value.agent))] }
  async dispose() {
    for (const agent of this.agents()) { if (agent.status === 'running') agent.cancel({ kind: 'user' }) }
    for (const entry of this.waiters.values()) entry.reject(Object.assign(new Error('Loom plugin disposing'), { state: 'unknown' }))
    this.waiters.clear()
    // Existing/attached user agents are not Loom's disposal capability.
    for (const dispose of this.owned.values()) await dispose()
    this.owned.clear(); this.sequence.clear(); this.sessionOwners.clear()
  }
}
function ownedDispose(handle) { return typeof handle.dispose === 'function' ? () => handle.dispose() : async () => {} }
