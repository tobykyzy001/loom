import { randomUUID } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { stableArtifactId } from './ids.js'
import { modelRef } from './model-policy.js'
import { fixtureCodeTask, captureCodeCall, captureCodeResult, hasCodeRecord, codeEvidence } from './code-evidence.js'
import { boundedReadArtifact, fixtureReadAssignment } from './read-evidence.js'

// Only versions whose relevant public Agent/Session APIs were actually inspected.
// rc.3 legacy uses its previously accepted assistant read evidence. Current Hosts
// use the public read projection; old stored artifacts are not rewritten.
// The optional default preserves old already-signed evidence and unit fixtures; the
// production `apply` always supplies the version read from the selected Host.
const VERIFIED_HOST_VERSIONS = new Set(['0.2.2-rc.3', '0.2.2-rc.5'])
export function supportedDshHostVersion(value = '0.2.2-rc.3') {
  if (!VERIFIED_HOST_VERSIONS.has(value)) throw new Error('This fixed source-evidence fixture does not accept an unverified DSH host version')
  return value
}

function captureReadEvent(record, session, event, sessionRef) {
  if (!record.code_task && event.type === 'tool/call' && event.data?.name === 'loom_fixture_inspect') {
    try {
      const args = JSON.parse(event.data.arguments)
      record.read_calls ||= new Map()
      record.read_calls.set(event.data.callId, { name: event.data.name, args, seq: event.seq })
    } catch { record.read_invalid = true }
    return
  }
  if (record.code_task || event.type !== 'tool/result') return
  const message = event.data?.message
  const calls = [...(record.read_calls?.entries() || [])]
  const match = calls.find(([id]) => message?.toolCallId === id || message?.source?.callId === id)
  if (!match) {
    // Do not assign a different tool's arbitrary text to a read proof. A named
    // error for the currently captured name must still not leak its message.
    if (message?.name === 'loom_fixture_inspect' || message?.source?.name === 'loom_fixture_inspect') record.read_invalid = true
    return
  }
  if (typeof message?.id !== 'string' || !message.id) { record.read_invalid = true; return }
  const [call_id, call] = match
  const text = (message.content || []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
  const recordOut = { call, call_id, result_id: message.id, result_seq: event.seq, session: sessionRef(), is_error: message.isError === true }
  if (recordOut.is_error) recordOut.is_error = true
  try {
    const proof = JSON.parse(text)
    if (proof.schema === 'loom.fixture-read.v1' && proof.path === 'input.txt' && /^[a-f0-9]{64}$/.test(proof.sha256)
      && Number.isSafeInteger(proof.size_bytes) && proof.size_bytes > 0 && proof.size_bytes <= 4096 && proof.read === true
      && Object.keys(proof).length === 5 && ['schema', 'path', 'sha256', 'size_bytes', 'read'].every(key => key in proof)) {
      recordOut.result = { schema: proof.schema, path: proof.path, sha256: proof.sha256, size_bytes: proof.size_bytes, read: true }
    } else record.read_invalid = true
  } catch { record.read_invalid = true }
  record.read_records ||= []
  record.read_records.push(recordOut)
}

/**
 * Public DSH Agent/Session adapter; host_version follows the selected installation.
 * Sources are the installed dsh-agent and dsh-session public APIs, never private
 * event types, Session.appendPluginRecord, synthetic transcript, or hidden protocol.
 */
export class DshAdapter {
  constructor(ctx, { allowCreation = false, agentSessionId = '', snapshotDir, sessionMapPath = '', allowBoundedFixtureEffects = false, delegationAgentSetup, fixtureCodeTools, hostVersion } = {}) {
    if (!ctx || typeof ctx.on !== 'function') throw new Error('A real Host Context is required')
    this.ctx = ctx; this.allowCreation = allowCreation; this.agentSessionId = agentSessionId; this.snapshotDir = snapshotDir
    this.hostVersion = supportedDshHostVersion(hostVersion)
    this.allowBoundedFixtureEffects = allowBoundedFixtureEffects
    this.delegationAgentSetup = delegationAgentSetup
    this.fixtureCodeTools = fixtureCodeTools
    this.sessionMapPath = sessionMapPath; this.sessionMap = null
    this.readCaptureEnabled = supportedDshHostVersion(hostVersion) === '0.2.2-rc.5'
    this.owned = new Map(); this.waiters = new Map(); this.latest = new Map(); this.sequence = new Map()
    this.sessionOwners = new Map()
    this.pendingCancellations = new Set()
    this.attachClaims = new Set()
    this.expiredClaims = new Set()
    this.cancellationDeadlines = new Map()
    this.verificationGates = new Map()
    ctx.on('session/event', (session, event) => {
      const assignmentId = this.sessionOwners.get(session.id)
      if (!assignmentId || this.expiredClaims.has(assignmentId)) return
      const tracked = this.sequence.get(assignmentId)
      const previousSeq = tracked?.last_seq
      // Reject an older terminal replay before updating the latest observation.
      const wrongTurn = event.data?.turn !== undefined
        && tracked?.active_turn !== event.data.turn
      const wrongRequestWindow = tracked?.request_seq !== undefined && event.seq < tracked.request_seq
      if (event.type === 'turn/end' && tracked) {
        if (event.seq <= previousSeq || wrongRequestWindow || wrongTurn) {
          return
        }
      }
      // still selects only this assignment's terminal waiter, never new tools.
      if (tracked?.agent.session === session
        && (tracked.request_seq === undefined || event.seq >= tracked.request_seq)) {
        // The actual attached Agent/Session is the owner boundary, not code_task.
        if (tracked.code_task) {
          if (event.type === 'tool/call') captureCodeCall(tracked, event.data?.name, { ...(event.data || {}), __seq: event.seq })
          if (event.type === 'tool/result') captureCodeResult(tracked, { ...(event.data || {}), seq: event.seq }, this.sessionRef(session))
        }
        if (this.readCaptureEnabled && !tracked.code_task && tracked.read_fixture) {
          // Fixed read projection only; no arbitrary tool or assistant plaintext.
          captureReadEvent(tracked, session, event, () => this.sessionRef(session))
        }
      }
      // During SDK resume a session has a different identity but is the exact live Agent named by our mapping.
      const replacement = this.ctx.agents.get(session.id)
      // Only the attached Agent's exact Session object can provide ordinary
      // ToolCall/ToolResult evidence. A lookup cannot create a terminal claim.
      if (tracked && tracked.agent.session !== session) return
      if (!tracked && (event.type === 'turn/end' || !replacement || replacement.session !== session)) return
      if (!tracked) this.sequence.set(assignmentId, { agent: replacement, owned: false, dispose: async () => {}, refReported: true, last_seq: session.seq })
      this.sequence.get(assignmentId).last_seq = event.seq
      this.sequence.get(assignmentId).session_ref = {
        session_id: session.id, harness: 'dsh', host_api: this.hostVersion, protocol: 'dsh-session-log', observed_seq: event.seq,
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
      if (event.type === 'turn/start' && (tracked?.request_seq === undefined || event.seq >= tracked.request_seq)) {
        tracked.active_turn = event.data?.turn
      }
      if (event.type === 'turn/end') {
        const waiter = this.waiters.get(assignmentId)
        if (!waiter) return
        const deadline = this.cancellationDeadlines.get(assignmentId)
        if (deadline) clearTimeout(deadline)
        this.cancellationDeadlines.delete(assignmentId)
        this.pendingCancellations.delete(assignmentId)
        // The first observed terminal event is the only resolver for this operation.
        this.waiters.delete(assignmentId)
        if (waiter) {
          const reason = event.data?.reason
          if (reason?.kind === 'completed') waiter.resolve(reason)
          else if (reason?.kind === 'aborted') {
            tracked.abort_reason = reason.reason?.kind || 'unknown'
            tracked.abort_seq = event.seq
            const startedCodeWork = Boolean(tracked.code_task) && [...(tracked.code_calls?.values() || [])].some(call => call.name === 'loom_fixture_code_edit')
            if (startedCodeWork) {
              waiter.reject(Object.assign(new Error('The scoped code work was aborted after a tool began; file and verification outcomes need reconciliation.'), {
                state: 'unknown', cancel_acknowledged: tracked.cancel_requested === true, aborted_user: reason.reason?.kind === 'user', reason,
              }))
            } else waiter.reject(Object.assign(new Error(`DSH turn was aborted (${reason.reason?.kind || 'unknown'})`), { state: 'cancelled', cancel_acknowledged: true, reason }))
          }
          else {
            const codeTask = this.sequence.get(assignmentId)?.code_task
            // A terminal Agent interrupted/failed outcome does not prove the
            // bounded file effects never started. Complete their proof before choosing failed vs unknown.
            if (codeTask && ['error', 'failed'].includes(reason?.kind)) {
              // Resolve the Agent's turn, then assess bounded evidence instead
              // of skipping boundedFileEffects on the catch path.
              tracked.code_outcome_requires_review = reason
              waiter.resolve(reason)
            } else waiter.reject(Object.assign(new Error(`DSH turn ended without normal completion: ${reason?.kind || 'unknown'}${reason?.error?.message ? `: ${reason.error.message}` : ''}`), { state: reason?.kind === 'error' ? 'failed' : 'unknown', reason }))
          }
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
    if (hasCodeRecord(record)) {
      if (!this.fixtureCodeTools || !record.code_task) {
        return { state: 'unknown', summary: 'A code-fixture ToolResult appeared outside the explicitly configured current scoped assignment. No code effect certification is inferred.',
          effects: [], artifacts: [], evidence: record.code_tool_records }
      }
      const root = await codeEvidence(assignment, config.projectRoot || assignment.grant?.project_root, record.code_task, record)
      if (root) return root
    }
    const toolRecords = record?.tool_records || []
    const evidenceScope = assignment.kind === 'edit_file'
    if (!evidenceScope) {
      const outside = toolRecords.find((entry) => entry.possible_effect)
      if (outside) return { state: 'unknown', summary: 'A tool reported a possible file effect outside the authorized operation kind; neither success nor automatic rollback is inferred.', effects: [], artifacts: [], evidence: [outside] }
      const rejected = toolRecords.find((entry) => entry.is_error && entry.possible_effect !== true && ['loom_fixture_write', 'loom_fixture_delegate_write'].includes(entry.call?.name))
      if (rejected) return { state: 'failed', summary: `DSH ToolResult rejected an out-of-scope operation: ${rejected.text || rejected.invalid_error || 'invalid bounded tool result'}`,
        effects: [], artifacts: [] }
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
    return { harness: 'dsh', session_id: session.id, protocol: 'dsh-session-log', host_api: this.hostVersion, observed_seq: session.seq }
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
    const codeTask = fixtureCodeTask(assignment)
    if (codeTask && typeof this.fixtureCodeTools !== 'function') {
      throw new Error('Explicit source-code fixture tools are disabled and must not be inferred from a model response')
    }
    if (!this.available) throw new Error('Unsupported executor: live ctx.agents surface is unavailable')
    const existing = this.sequence.get(assignment.id)
    if (existing) return existing
    const sessionMap = await this.loadSessionMap()
    const ownedSessionId = sessionMap.get(assignment.id)
    if (this.fixtureCodeTools && (this.agentSessionId || ownedSessionId)) {
      throw new Error('Scoped code fixtures require a new isolated Agent per authorized assignment; reuse/resume of code-bearing Sessions is not supported')
    }
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
      const pauseBeforeVerify = codeTask && assignment.objective?.includes('LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY')
        ? (agent) => async (signal) => {
          if (signal?.aborted) throw Object.assign(new Error('Verification was cancelled before its pause'), { name: 'AbortError' })
          let gate = this.verificationGates.get(assignment.id)
          if (!gate) {
            gate = Promise.withResolvers()
            gate.timer = setTimeout(() => {
              this.verificationGates.delete(assignment.id)
              gate.reject(new Error(`The scoped pre-verification pause timed out for ${assignment.id}`))
            }, 12000)
            this.verificationGates.set(assignment.id, gate)
            process.stderr.write(`[loom-local-node] code-pause-before-verify ${JSON.stringify({ assignment_id: assignment.id, session_id: agent.session.id, phase: 'before-test-subprocess' })}\n`)
          }
          await gate.promise
          if (signal?.aborted) {
            // Record the actual SDK abort at this precise tool-body boundary,
            // separately from the center's durable cancel-intent flag.
            this.sequence.get(assignment.id).abort_stage = { aborted: true, reason: signal.reason?.kind, phase: 'before-test-subprocess' }
          }
          // Abort data belongs to the actual SDK invocation, not a synthetic session event.
        }
        : undefined
      handle = await this.ctx.agents.create({ sessionId: selectedSession, meta: {
        ...(projectRoot ? { cwd: projectRoot } : {}),
        ...(provenance ? { parentSession: provenance.parent_session.session_id, origin: 'subagent' } : {}),
      },
      ...(provenance ? { setup: async (agentCtx) => { await this.delegationAgentSetup({ ctx: agentCtx, scene: provenance }) } } :
        codeTask ? { setup: async (agentCtx, agent) => {
        // The exported fixture signature is (scoped Cordis context, ticket scope), not a nested wrapper.
        if ((provider && provider !== 'loom-stub') || (model && model !== 'loom-stub-v1')) {
          throw new Error('Scoped code fixture cannot switch to a different model/provider')
        }
        await this.fixtureCodeTools(agentCtx, { assignment, project_root: projectRoot, agent_session_id: agent.session.id, before_verify_pause: pauseBeforeVerify?.(agent) })
      } } : {}),
      agentOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}), ...(maxTokens ? { maxTokens } : {}) } })
    }
    const record = { agent: handle.agent, owned: Boolean(handle.owned), dispose: ownedDispose(handle),
      last_seq: handle.agent.session.seq, refReported: false }
    this.sequence.set(assignment.id, record)
    record.code_task = codeTask
    record.read_fixture = fixtureReadAssignment(assignment) !== null
    this.sessionOwners.set(handle.agent.session.id, assignment.id)
    await this.persistSessionMap(assignment.id, handle.agent.session.id)
    await reportLink(this.sessionRef(handle.agent.session))
    record.refReported = true
    if (handle.owned) this.owned.set(handle.agent, handle.dispose)
    return record
  }
  async executeAssignment(assignment, config) {
    if (this.attachClaims.has(assignment.id) || this.waiters.has(assignment.id)) {
      throw new Error('One Assignment cannot have concurrent execution claims')
    }
    this.attachClaims.add(assignment.id)
    try { return await this.executeClaim(assignment, config) }
    finally { this.attachClaims.delete(assignment.id) }
  }
  async executeClaim(assignment, config) {
    const { agent } = await this.attach(assignment, config)
    const tracked = this.sequence.get(assignment.id)
    if (tracked?.pre_start_outcome) return { ...tracked.pre_start_outcome }
    if (tracked) {
      tracked.request_seq = Number.isSafeInteger(tracked.last_seq) ? tracked.last_seq : 0
      tracked.active_turn = undefined
      tracked.request_started = false
    }
    const { promise: settled, resolve, reject } = Promise.withResolvers()
    this.waiters.set(assignment.id, { resolve, reject })
    if (this.pendingCancellations.has(assignment.id)) {
      const record = tracked ?? this.sequence.get(assignment.id)
      this.sequence.set(assignment.id, { ...record, cancel_requested: true })
      if (record?.request_started === true && agent.status === 'running') {
        agent.cancel({ kind: 'user' })
        return this.awaitCancelledTurn(settled, agent)
      } else if (agent.status === 'idle') {
        // Creation/attach completed, but no request was issued for this Assignment.
        // This is an actual pre-start stop, not a fabricated SDK turn event.
        return this.settlePendingCancellation(assignment, agent, { state: 'cancelled', cancel_acknowledged: true,
          summary: 'The center cancellation arrived before a model request was issued for this Assignment. No tools were executed.',
          effects: [], artifacts: [],
        })
      } else if (agent.status === 'running') {
        // A shared/pre-existing running Session is not this claim's execution.
        // Do not cancel it or claim its aborted user terminal as our acknowledgement.
        return this.settlePendingCancellation(assignment, agent, { state: 'unknown', cancel_acknowledged: false,
          summary: 'Pending cancellation predates this Assignment’s followup, while a different running turn exists. It remains unresolved and cannot be acknowledged as this operation’s cancellation.',
          effects: [], artifacts: [] })
      } else {
        return this.settlePendingCancellation(assignment, agent, { state: 'unknown', summary: 'Cancellation arrived before execution, but the current Agent state is not proven. No model request was issued.',
          cancel_acknowledged: false, effects: [], artifacts: [] })
      }
    }
    try {
      const objective = typeof assignment.objective === 'string' && assignment.objective
        ? assignment.objective : `Perform the authorized ${assignment.kind} operation.`
      const content = [{ type: 'text', text: objective + (config.provenance
         ? `\nVerified source delegation: call only the scoped delegated HTML tool. LOOM_FIXTURE_DELEGATE parent_artifact=${config.provenance.ref.artifact_id} sha256=${config.provenance.ref.sha256}`
         : '') }]
      agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze(content), source: Object.freeze({ kind: 'loom' }) }))
      if (tracked) tracked.request_started = true
      await settled
      const snapshot = this.latest.get(assignment.id)
      const terminal = this.sequence.get(assignment.id)?.code_outcome_requires_review
      if ((!snapshot || !snapshot.full_text) && terminal?.kind !== 'error' && !this.readCaptureEnabled) throw new Error('DSH completed without an assistant message; no success can be inferred')
      // A recognized real read can succeed without trusting or publishing the
      // followup assistant narration. All other outcomes keep their old paths.
      const readResult = this.readCaptureEnabled && tracked?.read_fixture
        ? await boundedReadArtifact(assignment, config.projectRoot || assignment.grant?.project_root, this.sequence.get(assignment.id))
        : null
      if (readResult) return readResult
      if ((!snapshot || !snapshot.full_text) && terminal?.kind !== 'error') throw new Error('DSH completed without an assistant message; no success can be inferred')
      const fileEvidence = await this.boundedFileEffects(assignment, config, this.sequence.get(assignment.id))
      if (fileEvidence.state === 'unknown') {
        // Keep all original cancellation/uncertainty evidence. Only the fixed
        // post-edit fixture has an independently observed terminal error whose
        // reason may refine its otherwise generic missing-message fallback.
        const current = this.sequence.get(assignment.id)
        const reason = current?.code_outcome_requires_review
        return { ...fileEvidence, artifacts: [], session_ref: current?.session_ref,
          ...(reason?.kind === 'error' ? { summary: 'A source edit was followed by a real tool/adapter failure. No verified source/test Artifact can certify the outcome; no completed verification or cancellation is inferred.' } : {}) }
      }
      if (assignment.kind === 'edit_file' && !fileEvidence.effects?.length && fileEvidence.state !== 'failed') {
        // Unresolved tool/size facts never authorize a successful file report.
        throw new Error('A file-write assignment completed without a verified actual file Effect')
      }
      if (this.sequence.get(assignment.id)?.code_outcome_requires_review && hasCodeRecord(this.sequence.get(assignment.id))
        && fileEvidence.state === 'succeeded') {
        return { ...fileEvidence, state: 'unknown', summary: 'The Agent terminated abnormally after verified source/test output; task completion stays unknown and does not become a success from test output alone.' }
      }
      if (fileEvidence.state === 'failed' && !fileEvidence.artifacts?.length) return { ...fileEvidence, content: Buffer.from(JSON.stringify({ tool_rejection: true, session_ref: fileEvidence.session_ref, evidence: fileEvidence.evidence })), artifacts: [] }
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
        return { state: fileEvidence.state || 'succeeded', summary: fileEvidence.summary || 'DSH Agent produced a verified file effect through ordinary public tool results.',
          effects: fileEvidence.effects, artifacts: fileEvidence.artifacts, session_ref: this.sessionRef(agent.session),
          evidence: [{ source: 'dsh-tool-result', session_ref: this.sessionRef(agent.session), artifact_ids: fileEvidence.artifacts.map((item) => item.artifact_id) }], metadata }
      }
      const bytes = Buffer.from(JSON.stringify({ source: 'dsh-assistant-messages', assignment_id: assignment.id, text }, null, 2))
      const metadata = { name: `loom-session-${assignment.id}.json`, media_type: 'application/json', origin_node_id: assignment.node_id,
        // Source is the ordinary committed DSH message in this assignment, not a fabricated parent Artifact UUID.
        parents: [], evidence: [{ source: 'dsh-session-log', session_id: agent.session.id, observed_seq: agent.session.seq }] }
      if (this.snapshotDir) await writeFile(join(this.snapshotDir, `${assignment.id}.json`), bytes, { mode: 0o600, flag: 'wx' })
      const outcome = fileEvidence.state === 'failed' ? 'failed' : 'succeeded'
      return { state: outcome, summary: outcome === 'failed' ? fileEvidence.summary : 'DSH Agent completed an observed turn; report text is collected from ordinary Session messages.',
        content: bytes, metadata: { ...metadata, size_bytes: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') }, session_ref: this.sessionRef(agent.session), effects: [] }
    } catch (error) {
      const state = this.sequence.get(assignment.id)
      // A real user abort may leave known write effects without a known final task outcome.
      if (error.aborted_user && state?.code_task && state.cancel_requested === true && state.abort_reason === 'user') {
        let partial
        try {
          partial = await codeEvidence(assignment, config.projectRoot || assignment.grant?.project_root, state.code_task, state, { cancelled: true })
          // Reconcile exact source effects without declaring overall completion.
        } catch (proofError) {
          partial = { state: 'unknown', summary: `Cancellation interrupted source work and its byte proof could not be completed: ${proofError.message}`, effects: [], artifacts: [] }
        }
        return { ...partial, cancel_acknowledged: true, session_ref: partial.session_ref || state.session_ref }
      }
      // Preserve the original cancellation acknowledgement and observed result.
      // A cancelled/aborted Session is not repackaged as a tool rejection.
      error.session_ref ||= state?.session_ref
      const codeOutcomeUncertain = this.sequence.get(assignment.id)?.code_task && error.state !== 'cancelled'
      if (codeOutcomeUncertain || (!['cancelled', 'failed'].includes(error.state) && this.sequence.get(assignment.id)?.refReported)) error.state = 'unknown'
      process.stderr.write(`[loom-local-node] DSH execution error ${assignment.id}: ${error.message}\n`)
      throw error
    } finally {
      // The terminal waiter is single-use, including later SDK history readback.
      this.waiters.delete(assignment.id)
      this.clearCancellationDeadline(assignment.id)
      this.releaseVerificationGate(assignment.id)
    }
  }
  async awaitCancelledTurn(settled, agent) {
    let timer
    const deadline = Promise.withResolvers()
    timer = setTimeout(() => {
      deadline.reject(Object.assign(new Error('The SDK did not settle cancellation within the bounded wait'), {
        state: 'unknown', cancel_acknowledged: false, session_ref: this.sessionRef(agent.session),
      }))
    }, 12_000)
    try { return await Promise.race([settled, deadline.promise]) }
    finally { clearTimeout(timer) }
  }
  clearCancellationDeadline(assignmentId) {
    const timer = this.cancellationDeadlines.get(assignmentId)
    if (timer) clearTimeout(timer)
    this.cancellationDeadlines.delete(assignmentId)
    this.pendingCancellations.delete(assignmentId)
  }
  armCancellationDeadline(assignmentId) {
    if (this.expiredClaims.has(assignmentId) || this.cancellationDeadlines.has(assignmentId)) return
    if (!this.waiters.has(assignmentId)) return
    this.cancellationDeadlines.set(assignmentId, setTimeout(() => {
      const waiter = this.waiters.get(assignmentId)
      if (!waiter) return
      // Expiry is a terminal unknown for this claim, never a late SDK abort.
      this.expiredClaims.add(assignmentId)
      const record = this.sequence.get(assignmentId)
      if (record) record.pre_start_outcome = { state: 'unknown', cancel_acknowledged: false,
        summary: 'Cancellation was not acknowledged within the bounded wait; late events cannot rewrite it.',
        effects: [], artifacts: [], session_ref: this.sessionRef(record.agent.session) }
      this.clearCancellationDeadline(assignmentId)
      this.waiters.delete(assignmentId)
      waiter.reject(Object.assign(new Error('The bound Agent did not confirm cancellation within the bounded wait'), {
        state: 'unknown', cancel_acknowledged: false,
      }))
    }, 12_000))
  }
  settlePendingCancellation(assignment, agent, outcome) {
    const result = { ...outcome, session_ref: this.sessionRef(agent.session) }
    const record = this.sequence.get(assignment.id)
    if (record) record.pre_start_outcome = result
    this.clearCancellationDeadline(assignment.id)
    this.waiters.delete(assignment.id)
    return result
  }
  releaseVerificationGate(assignmentId) {
    const gate = this.verificationGates.get(assignmentId)
    if (gate) {
      clearTimeout(gate.timer)
      gate.resolve()
      this.verificationGates.delete(assignmentId)
    }
  }
  async cancel(assignmentId) {
    if (this.expiredClaims.has(assignmentId)) return false
    // Remember intent across ctx.agents.create(), not only after attach is complete.
    this.pendingCancellations.add(assignmentId)
    // Only the exact Agent registered for this Assignment is cancelled; never another user's idle Session.
    const record = this.sequence.get(assignmentId)
    if (record && typeof record === 'object') {
      // Keep cancellation intent in adapter-owned state, not on the immutable
      // controller/Grant assignment input. Do not assume the request is mutable.
      this.sequence.set(assignmentId, { ...record, cancel_requested: true })
    }
    const entry = this.sequence.get(assignmentId)
    const agent = entry?.agent
    const id = agent?.session?.id
    try {
      if (entry && typeof id === 'string' && this.sessionOwners.get(id) === assignmentId
        && entry.request_started === true && agent?.status === 'running') {
        agent.cancel({ kind: 'user' })
        this.armCancellationDeadline(assignmentId)
        return true
      }
      return false
    } finally {
      // Timer expiry is not an acknowledgement; only a real observed turn proves stop.
      // Releasing a pause is the controller's observation handoff, not test success.
      // Native Agent cancellation still has to confirm the actual aborted turn.
      this.releaseVerificationGate(assignmentId)
    }
  }
  agents() { return [...new Set([...this.sequence.values()].map((value) => value.agent))] }
  async dispose() {
    // Resolve every owner-scoped bounded gate when the plugin is torn down.
    for (const gate of this.verificationGates.values()) { clearTimeout(gate.timer); gate.resolve() }
    this.pendingCancellations.clear()
    for (const timer of this.cancellationDeadlines.values()) clearTimeout(timer)
    this.cancellationDeadlines.clear()
    this.attachClaims.clear()
    this.verificationGates.clear()
    for (const agent of this.agents()) { if (agent.status === 'running') agent.cancel({ kind: 'user' }) }
    for (const entry of this.waiters.values()) entry.reject(Object.assign(new Error('Loom plugin disposing'), { state: 'unknown' }))
    this.waiters.clear()
    // Existing/attached user agents are not Loom's disposal capability.
    for (const dispose of this.owned.values()) await dispose()
    this.owned.clear(); this.sequence.clear(); this.sessionOwners.clear()
    this.expiredClaims.clear()
  }
}
function ownedDispose(handle) { return typeof handle.dispose === 'function' ? () => handle.dispose() : async () => {} }
