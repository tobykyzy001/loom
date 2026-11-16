import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * DSH 0.2.2-rc.3 public adapter. Sources verified in the installed ASAR:
 * dsh-agent/src/index.ts + runtime-types.ts and dsh-session/src/index.ts.
 * No private event types, Session.appendPluginRecord, synthetic transcript, or hidden protocol.
 */
export class DshAdapter {
  constructor(ctx, { allowCreation = false, agentSessionId = '', snapshotDir } = {}) {
    if (!ctx || typeof ctx.on !== 'function') throw new Error('A real Host Context is required')
    this.ctx = ctx; this.allowCreation = allowCreation; this.agentSessionId = agentSessionId; this.snapshotDir = snapshotDir
    this.owned = new Map(); this.waiters = new Map(); this.latest = new Map(); this.sequence = new Map()
    this.detected = false
    ctx.on('session/event', (session, event) => {
      // A currently tracked Agent must match this exact live Session, not an ID claimed by input.
      const assignmentId = [...this.sequence.keys()].find((id) => this.sequence.get(id).agent.session === session)
      if (!assignmentId) return
      const tracked = this.sequence.get(assignmentId)
      if (!tracked) return
      const sessionRef = this.sessionRef(session)
      this.endpointRecord(assignmentId, sessionRef)
      tracked.last_seq = event.seq
      if (event.type === 'assistant/message') {
        const previous = this.latest.get(assignmentId) || { full_text: '' }
        for (const block of event.data?.content || []) {
          if (block?.type === 'text' && typeof block.text === 'string') previous.full_text += block.text + '\n'
        }
        this.latest.set(assignmentId, previous)
      }
      if (event.type === 'turn/end') {
        const waiter = this.waiters.get(assignmentId)
        if (waiter) {
          const reason = event.data?.reason
          if (reason?.kind === 'completed') waiter.resolve(reason)
          else waiter.reject(Object.assign(new Error(`DSH turn ended without normal completion: ${reason?.kind || 'unknown'}`), { state: 'unknown' }))
        }
      }
    })
  }
  get available() {
    const agents = this.ctx.agents
    this.detected = Boolean(agents && typeof agents.create === 'function' && typeof agents.resume === 'function'
      && typeof agents.get === 'function' && typeof agents.list === 'function')
    return this.detected
  }
  sessionRef(session) {
    // Version is a provenance declaration, not a claim about a second transcript.
    return { harness: 'dsh', session_id: session.id, protocol: 'dsh-session-log', host_api: '0.2.2-rc.3' }
  }
  endpointRecord(id, sessionRef) {
    const entry = this.sequence.get(id)
    if (!entry || entry.refReported) return
    entry.refReported = true
    if (entry.reportLink) entry.reportLink(sessionRef).catch((error) => { entry.linkError = error.message })
  }
  async attach(assignment, { provider, model, reasoningEffort, maxTokens, reportLink } = {}) {
    if (!this.available) throw new Error('Unsupported executor: live ctx.agents surface is unavailable')
    const existing = this.sequence.get(assignment.id)
    if (existing) return existing
    const selectedSession = this.agentSessionId || randomUUID()
    let handle, resumed = false
    if (this.agentSessionId && this.ctx.agents.get(this.agentSessionId)) {
      handle = { agent: this.ctx.agents.get(this.agentSessionId), owned: false }
    } else if (this.agentSessionId) {
      if (typeof this.ctx.sessionProjections === 'undefined') {
        // resume itself validates persistence availability; never fake a restored Session.
        throw new Error('A persisted DSH Session is unavailable for the configured session ID')
      }
      handle = await this.ctx.agents.resume({ resumeSessionId: selectedSession }); resumed = true
    } else {
      if (!this.allowCreation) throw new Error('DSH Agent creation is disabled; explicitly configure an existing session or opt in')
      handle = await this.ctx.agents.create({ sessionId: selectedSession, meta: {},
        agentOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}), ...(maxTokens ? { maxTokens } : {}) } })
    }
    const record = { agent: handle.agent, owned: !this.agentSessionId, dispose: ownedDispose(handle),
      last_seq: handle.agent.session.seq, refReported: false }
    this.sequence.set(assignment.id, record)
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
      agent.followup({ role: 'user', content, source: { kind: 'loom' } })
      await settled
      const snapshot = this.latest.get(assignment.id)
      if (!snapshot || !snapshot.full_text) throw new Error('DSH completed without an assistant message; no success can be inferred')
      const text = snapshot.full_text.slice(0, 64_000)
      const bytes = Buffer.from(JSON.stringify({ source: 'dsh-assistant-messages', assignment_id: assignment.id, text }, null, 2))
      let metadata = { name: `loom-session-${assignment.id}.json`, media_type: 'application/json', origin_node_id: assignment.node_id }
      if (this.snapshotDir) {
        const file = join(this.snapshotDir, `${assignment.id}.json`)
        await writeFile(file, bytes, { mode: 0o600, flag: assignment.recovered ? 'a' : 'wx' })
      }
      return { state: 'succeeded', summary: 'DSH Agent completed an observed turn; report text is collected from ordinary Session messages.',
        content: bytes, metadata: { ...metadata, size_bytes: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') }, session_ref: this.sessionRef(agent.session), effects: [] }
    } catch (error) {
      if (this.sequence.get(assignment.id)?.refReported) error.state = 'unknown'
      throw error
    } finally { this.waiters.delete(assignment.id) }
  }
  async cancel(assignmentId) {
    const entry = this.sequence.get(assignmentId)
    if (entry?.agent?.status === 'running') { entry.agent.cancel({ kind: 'user' }); return true }
    if (this.waiters.has(assignmentId)) this.waiters.get(assignmentId).reject(new Error('Cancelled by Loom coordinator'))
    return false
  }
  async unregister(assignmentId) { this.sequence.delete(assignmentId); this.waiters.delete(assignmentId); this.latest.delete(assignmentId) }
  agents() { return [...new Set([...this.sequence.values()].map((value) => value.agent))] }
  async dispose() {
    for (const agent of this.agents()) { if (agent.status === 'running') agent.cancel({ kind: 'user' }) }
    for (const entry of this.waiters.values()) entry.reject(new Error('Loom plugin disposing'))
    this.waiters.clear()
    // Do not cancel/dispose a session not created by Loom. Existing user session is not ours.
    for (const dispose of this.owned.values()) await dispose()
    this.owned.clear()
  }
}
function ownedDispose(handle) { return typeof handle.dispose === 'function' ? () => handle.dispose() : async () => {} }
