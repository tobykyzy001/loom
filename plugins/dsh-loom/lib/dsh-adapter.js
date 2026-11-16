import { randomUUID } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { stableArtifactId } from './ids.js'
import { modelRef } from './model-policy.js'

/**
 * DSH 0.2.2-rc.3 public adapter. Sources verified in the installed ASAR:
 * dsh-agent/src/index.ts + runtime-types.ts and dsh-session/src/index.ts.
 * No private event types, Session.appendPluginRecord, synthetic transcript, or hidden protocol.
 */
export class DshAdapter {
  constructor(ctx, { allowCreation = false, agentSessionId = '', snapshotDir, sessionMapPath = '', allowBoundedFixtureEffects = false, delegationAgentSetup } = {}) {
    if (!ctx || typeof ctx.on !== 'function') throw new Error('A real Host Context is required')
    this.ctx = ctx; this.allowCreation = allowCreation; this.agentSessionId = agentSessionId; this.snapshotDir = snapshotDir
    this.allowBoundedFixtureEffects = allowBoundedFixtureEffects
    this.delegationAgentSetup = delegationAgentSetup
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
      if (this.allowBoundedFixtureEffects && event.type === 'tool/call' && ['loom_fixture_write', 'loom_fixture_delegate_write'].includes(event.data?.name)) {
        this.sequence.get(assignmentId).calls ||= new Map()
        let args
        try {
          if (event.data.arguments.length > 4096) throw new Error('Fixture call exceeds 4 KiB')
          const parsed = JSON.parse(event.data.arguments)
          if (event.data.name === 'loom_fixture_delegate_write' && Object.keys(parsed).length > 0) throw new Error('Scoped delegated tool accepts no caller-selected path')
          args = { path: event.data.name === 'loom_fixture_delegate_write' ? 'docs/delegated.html' : parsed.path,
            title: event.data.name === 'loom_fixture_delegate_write' ? 'Verified delegated Agent' : parsed.title, seq: event.seq }
        } catch { args = null }
        this.sequence.get(assignmentId).calls.set(event.data.callId, { name: event.data.name, args, seq: event.seq })
      }
      if (this.allowBoundedFixtureEffects && event.type === 'tool/result') {
        const tracked = this.sequence.get(assignmentId)
        const call = tracked.calls?.get(event.data.message?.toolCallId) || tracked.calls?.get(event.data.message?.source?.callId)
        if (!['loom_fixture_write', 'loom_fixture_delegate_write'].includes(call?.name)) return
        tracked.tool_records ||= []
        const text = (event.data.message?.content || []).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
        const record = { call, call_id: event.data.message?.toolCallId || event.data.message?.source?.callId,
          result_id: event.data.message?.id, result_seq: event.seq, is_error: event.data.message?.isError === true, session: this.sessionRef(session) }
        if (record.is_error) record.text = text.slice(0, 2048)
        else if (text.length <= 4096) {
          try {
            const value = JSON.parse(text)
            if (value.created !== true || typeof value.path !== 'string' || typeof value.title !== 'string'
              || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > 4096) {
              throw new Error('Fixture tool result shape/size is outside the bounded contract')
            }
            record.result = { created: true, path: value.path, sha256: value.sha256, size_bytes: value.size_bytes, title: value.title }
            if (call.name === 'loom_fixture_delegate_write') {
              const source = value.source
              const fields = ['artifact_id', 'ticket_id', 'origin_node_id', 'sha256', 'location']
              if (source?.type !== 'artifact_ref'
                || !/^[a-f0-9]{64}$/.test(source.sha256)
                || !/^[a-f0-9]{64}$/.test(source.origin_node_id)
                || !/^[a-f0-9-]{36}$/.test(value.source_session_id || '')
                || !Array.isArray(source.parents) || source.parents.length !== 0
                || fields.some((key) => typeof source[key] !== 'string' || !source[key] || source[key].length > 160)) {
                throw new Error('Delegate Source evidence is not a bounded immutable Artifact lineage')
              }
              // Preserve only the needed validated fields, never arbitrary
              // provider claims or a lifecycle path as authority.
              record.result.source = {
                type: 'artifact_ref', artifact_id: source.artifact_id,
                ticket_id: source.ticket_id, origin_node_id: source.origin_node_id,
                sha256: source.sha256, location: source.location, parents: [],
              }
              record.result.source_session_id = value.source_session_id
            }
            if (value.created === true) record.possible_effect = true
        } catch (error) { record.invalid_error = error.message.slice(0, 512); record.is_error = true }
        } else { record.invalid_error = 'Fixture tool response exceeds 4 KiB'; record.is_error = true }
        tracked.tool_records.push(record)
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
  async boundedFileEffects(assignment, config, record) {
    const toolRecords = record?.tool_records || []
    const evidenceScope = assignment.kind === 'edit_file'
    if (!evidenceScope) {
      const outside = toolRecords.find((entry) => entry.possible_effect)
      if (outside) return { state: 'unknown', summary: 'A tool reported a possible file effect outside the authorized operation kind; neither success nor automatic rollback is inferred.', effects: [], artifacts: [], evidence: [outside] }
      return { effects: [], artifacts: [] }
    }
    const uncertain = toolRecords.find((entry) => entry.is_error && entry.possible_effect && ['loom_fixture_write', 'loom_fixture_delegate_write'].includes(entry.call?.name))
    if (this.allowBoundedFixtureEffects && uncertain) return { state: 'unknown', summary: 'The ToolResult claims an effect, but its immutable evidence could not be fully validated. No success or automatic rollback is inferred.', session_ref: this.sessionRef(record.agent.session), effects: [], artifacts: [], evidence: [uncertain] }
    const failed = toolRecords.find((entry) => entry.is_error && ['loom_fixture_write', 'loom_fixture_delegate_write'].includes(entry.call?.name))
    if (this.allowBoundedFixtureEffects && failed) return { state: 'failed', summary: `DSH ToolResult rejected the authorized file operation: ${failed.text || failed.invalid_error || 'invalid bounded tool result'}`,
      session_ref: this.sessionRef(record.agent.session), effects: [], artifacts: [], evidence: [failed] }
    if (!this.allowBoundedFixtureEffects || !toolRecords.some((entry) => ['loom_fixture_write', 'loom_fixture_delegate_write'].includes(entry.call?.name))) return { effects: [], artifacts: [] }
    const effects = [], artifacts = []
    // The exact Grant root is checked; no profile/cwd prefix heuristic authorizes a path.
    const rootInput = config.projectRoot || assignment.grant?.project_root
    if (!rootInput) throw new Error('A file effect requires the exact ProjectBinding root')
    const projectRoot = await realpath(resolve(rootInput))
    if (assignment.grant?.project_root && await realpath(resolve(assignment.grant.project_root)) !== projectRoot) throw new Error('Effect root differs from the exact ProjectBinding root')
    for (const entry of toolRecords) {
      const delegated = entry.call?.name === 'loom_fixture_delegate_write'
      if (entry.is_error || !['loom_fixture_write', 'loom_fixture_delegate_write'].includes(entry.call?.name) || !entry.call.args) continue
      if (typeof entry.call.args.path !== 'string' || entry.call.args.path.length > 128
        || !entry.call_id || !entry.result_id) continue
      const parsed = entry.result
      const path = delegated ? 'docs/delegated.html' : 'demo.html'
      if (!parsed || parsed.path !== path || entry.call.args.path !== parsed.path || (delegated && config.provenance === undefined)) {
        throw new Error('Committed ToolCall and ToolResult do not name the same bounded fixture artifact')
      }
      const actualFile = await realpath(resolve(projectRoot, parsed.path)).catch((error) => { throw new Error('Committed file is missing or unreadable', { cause: error }) })
      const expectedParent = delegated ? await realpath(join(projectRoot, 'docs')) : projectRoot
      if (dirname(actualFile) !== expectedParent) throw new Error('The bounded file output escaped the exact Grant root')
      const bytes = await readFile(actualFile)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (bytes.length !== parsed.size_bytes || sha256 !== parsed.sha256) throw new Error('Actual Artifact bytes differ from the committed public ToolResult')
      if (delegated) {
        const mismatched = ['artifact_id', 'ticket_id', 'origin_node_id', 'sha256']
          .filter((key) => parsed.source?.[key] !== config.provenance.ref[key])
        if (parsed.source_session_id !== config.provenance.parent_session.session_id) mismatched.push('parent_session_id')
        if (mismatched.length) throw new Error(`Delegate result mismatch in: ${mismatched.join(',')}`)
      }
      const reference = { type: 'dsh-tool-result', name: entry.call.name, path, title: parsed.title,
        call_id: entry.call_id, call_seq: entry.call.seq, result_id: entry.result_id, result_seq: entry.result_seq,
        session: entry.session, sha256, size_bytes: bytes.length, actual_file: parsed.path }
      const artifactId = stableArtifactId(`${assignment.id}:artifact:${entry.call_id}:${sha256}`)
      const effectId = stableArtifactId(`${assignment.id}:effect:${entry.call_id}:${sha256}`)
      artifacts.push({ artifact_id: artifactId, bytes,
        metadata: { artifact_id: artifactId, name: parsed.path, media_type: 'text/html', origin_node_id: assignment.node_id,
          size_bytes: bytes.length, sha256, parents: delegated ? [config.provenance.ref.artifact_id] : [],
          ...(delegated ? { artifact_ref: config.provenance.ref, delegated_from: { ...config.provenance.ref, session: config.provenance.parent_session } } : {}),
          evidence: [reference] } })
      const inputDigest = createHash('sha256').update(JSON.stringify({ path: parsed.path, title: parsed.title, ...(delegated ? { source: config.provenance.ref } : {}) })).digest('hex')
      effects.push({ effect_id: effectId, ticket_id: assignment.ticket_id, assignment_id: assignment.id, node_id: assignment.node_id,
        attempt: assignment.attempt, input_digest: inputDigest, status: 'confirmed', evidence: [reference], artifacts: [artifactId] })
    }
    return { effects, artifacts }
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
  async attach(assignment, { provider, model, reasoningEffort, maxTokens, projectRoot, reportLink, provenance } = {}) {
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
      if (provenance && typeof this.delegationAgentSetup !== 'function') throw new Error('Source delegation requires a declared scoped tool installer; execution unavailable')
      handle = await this.ctx.agents.create({ sessionId: selectedSession, meta: {
        ...(projectRoot ? { cwd: projectRoot } : {}),
        ...(provenance ? { parentSession: provenance.parent_session.session_id, origin: 'subagent' } : {}),
      },
      ...(provenance ? { setup: async (agentCtx) => { await this.delegationAgentSetup({ ctx: agentCtx, scene: provenance }) } } : {}),
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
      const content = [{ type: 'text', text: objective + (config.provenance
         ? `\nVerified source delegation: call only the scoped delegated HTML tool. LOOM_FIXTURE_DELEGATE parent_artifact=${config.provenance.ref.artifact_id} sha256=${config.provenance.ref.sha256}`
         : '') }]
      agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze(content), source: Object.freeze({ kind: 'loom' }) }))
      await settled
      const snapshot = this.latest.get(assignment.id)
      if (!snapshot || !snapshot.full_text) throw new Error('DSH completed without an assistant message; no success can be inferred')
      const fileEvidence = await this.boundedFileEffects(assignment, config, this.sequence.get(assignment.id))
      if (assignment.kind === 'edit_file' && !fileEvidence.effects?.length && fileEvidence.state !== 'failed') throw new Error('A file-write assignment completed without a verified actual file Effect')
      if (fileEvidence.state === 'unknown') return { ...fileEvidence, artifacts: [] }
      if (fileEvidence.state === 'failed') return { ...fileEvidence, content: Buffer.from(JSON.stringify({ tool_rejection: true, session_ref: fileEvidence.session_ref, evidence: fileEvidence.evidence })), artifacts: [] }
      const text = snapshot.full_text.slice(0, 64_000)
      if (assignment.kind === 'model_text') {
        if (!config.modelObservation || !config.textRoute) throw new Error('model_text requires a confirmed public route observation')
        const bytes = Buffer.from(JSON.stringify({ schema: 'loom.model-text-result.v1', source: 'dsh_llm_stream', text }, null, 2))
        const routeRef = modelRef(assignment, config.textRoute, config.modelObservation, text.trim().length > 0,
          { sha256: createHash('sha256').update(bytes).digest('hex') })
        const artifactId = stableArtifactId(`${assignment.id}:model_text:${config.textRoute.provider}:${config.textRoute.model}`)
        const metadata = { name: `loom-model_text-${assignment.id}.json`, media_type: 'application/json', origin_node_id: assignment.node_id,
          model_ref: routeRef, parents: [], evidence: [{ source: 'dsh_public_llm', model_ref: routeRef, session: this.sessionRef(agent.session) }] }
        return { state: 'succeeded', summary: 'Observed a text response from the explicitly selected public SDK model route.',
          artifact: { artifact_id: artifactId, bytes, metadata }, session_ref: this.sessionRef(agent.session),
          effects: [], artifacts: [], metadata }
      }
      if (fileEvidence.artifacts?.length) {
        const metadata = fileEvidence.artifacts[0].metadata
        if (this.snapshotDir) await writeFile(join(this.snapshotDir, `${assignment.id}.html`), fileEvidence.artifacts[0].bytes, { mode: 0o600, flag: 'wx' })
        return { state: 'succeeded', summary: 'DSH Agent produced a verified file effect through ordinary public tool results.',
          effects: fileEvidence.effects, artifacts: fileEvidence.artifacts, session_ref: this.sessionRef(agent.session),
          evidence: [{ source: 'dsh-tool-result', session_ref: this.sessionRef(agent.session), artifact_ids: fileEvidence.artifacts.map((item) => item.artifact_id) }], metadata }
      }
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
      process.stderr.write(`[loom-local-node] DSH execution error ${assignment.id}: ${error.message}\n`)
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
