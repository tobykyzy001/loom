import type { ArtifactContent, ArtifactRef, Effect, Report, Ticket } from '../api/types'

const SHA = /^[a-f0-9]{64}$/
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const PATH = 'src/calc.js'
const DIFF = [
  'index 2a10c8c..f582157 100644', '--- a/src/calc.js', '+++ b/src/calc.js',
  '@@ -1,3 +1,3 @@', ' export function add(a, b) {',
  '-  return a - b;', '+  return a + b;', ' }', '\\ No newline at end of file',
]
/** Test fixture shaped like the real bounded git diff, not executed content. */
export const CODE_DIFF = `diff --git a/${PATH} b/${PATH}\n${DIFF.join('\n')}\n`

type CodeEffect = Effect & { assignment_id?: string; artifacts?: string[] }
type Meta = ArtifactRef & { assignment_id?: string; name?: string; parents?: unknown[]; code_evidence?: unknown }
type Rec = Record<string, unknown>
type Line = { text: string; kind: 'added' | 'removed' | 'context' | 'heading' }
type Relation = { assignmentId: string; attempt: number; effectId: string; reportStatus: 'failed' | 'succeeded'; sessionId: string }
export type CodeArtifactPresentation =
  | { kind: 'unsupported'; reason: 'ordinary_artifact' | 'incomplete_relation'; name?: string; content: string }
  | { kind: 'change'; name: string; artifactId: string; relation: Relation & { verificationArtifactId: string }; previousSha256: string; sha256: string; path: string; lines: Line[] }
  | { kind: 'verification'; name: string; artifactId: string; relation: Relation & { sourceArtifactId: string; previousSha256: string; sha256: string; path: string; editResultId: string; verificationResultId: string }; command: string; exitCode: number; passed: boolean; previousTestExitCode: number; stdout: string; stderr: string }

function object(value: unknown): Rec | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null }
function exact(value: unknown, fields: readonly string[]): Rec | null {
  const record = object(value)
  return record && Object.keys(record).length === fields.length && fields.every(field => field in record) ? record : null
}
function id(value: unknown): string | null { return typeof value === 'string' && ID.test(value) ? value : null }
function uuid(value: unknown): string | null { return typeof value === 'string' && UUID.test(value) ? value : null }
function sha(value: unknown): string | null { return typeof value === 'string' && SHA.test(value) ? value : null }
function integer(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && (positive ? (value as number) > 0 : (value as number) >= 0)
}
type SessionEvidence = Rec & { session_id: string; observed_seq: number }
function session(value: unknown): SessionEvidence | null {
  const data = exact(value, ['harness', 'session_id', 'host_api', 'protocol', 'observed_seq'])
  return data && data.harness === 'dsh' && data.host_api === '0.2.2-rc.3' && data.protocol === 'dsh-session-log' && uuid(data.session_id) && integer(data.observed_seq) ? data as SessionEvidence : null
}
const CHANGE_FIELDS = ['schema', 'type', 'name', 'call_id', 'call_seq', 'result_id', 'result_seq', 'session', 'path', 'previous_sha256', 'sha256', 'size_bytes'] as const
function orderedEvents(value: unknown): value is Rec & { call_seq: number; result_seq: number; session: { observed_seq: number } } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Rec
  const currentSession = session(record.session)
  if (!currentSession || typeof record.call_seq !== 'number' || typeof record.result_seq !== 'number') return false
  const callSequence = record.call_seq
  const resultSequence = record.result_seq
  if (!Number.isSafeInteger(callSequence) || !Number.isSafeInteger(resultSequence) || resultSequence <= callSequence) return false
  return Number.isSafeInteger(currentSession.observed_seq) && currentSession.observed_seq >= resultSequence
}
function changeValues(data: Record<string, unknown> | null): data is Record<string, unknown> {
  return !!data && !!session(data.session) && data.path === PATH && !!id(data.call_id) && !!id(data.result_id) && orderedEvents(data) && integer(data.size_bytes, true) && data.size_bytes <= 32768 && !!sha(data.previous_sha256) && !!sha(data.sha256) && data.previous_sha256 !== data.sha256
}
function isBoundedUnifiedDiff(value: string): boolean {
  if (value.includes('\r') || value.length > 131072) return false
  const lines = value.split('\n')
  if (lines[0] !== `diff --git a/${PATH} b/${PATH}`) return false
  const added = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length
  const removed = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length
  return added === 1
    && removed === 1
    && lines.some(line => line === ' export function add(a, b) {')
    && lines.some(line => line === ' }')
    && lines.some(line => line === `--- a/${PATH}`)
    && lines.some(line => line === `+++ b/${PATH}`)
    && lines.some(line => /^@@ -\d+,\d+ \+\d+,\d+ @@$/.test(line))
    && lines.some(line => line === '-  return a - b;')
    && lines.some(line => line === '+  return a + b;')
    && lines.filter(line => line === '\\ No newline at end of file').length <= 1
}
function changeEvidence(value: unknown): Rec | null {
  const data = exact(value, ['schema', 'kind', 'call_id', 'call_seq', 'result_id', 'result_seq', 'session', 'path', 'previous_sha256', 'sha256', 'size_bytes'])
  return data && data.schema === 'loom.code-provenance.v1' && data.kind === 'change' && changeValues(data) ? data : null
}
function effectChange(value: unknown): Rec | null {
  const data = exact(value, [...CHANGE_FIELDS, 'test_tool_result_id', 'verification_artifact_id', 'test_exit_code'])
  return data && data.schema === 'loom.code-change.v1' && data.type === 'dsh-tool-result' && data.name === 'loom_fixture_code_edit' && changeValues(data) ? data : null
}
function verifyEvidence(value: unknown): Rec | null {
  const data = exact(value, ['schema', 'kind', 'call_id', 'call_seq', 'result_id', 'result_seq', 'session', 'source_change_artifact_id', 'path', 'sha256'])
  return data && data.schema === 'loom.code-provenance.v1' && data.kind === 'verification' && data.path === PATH && id(data.call_id) && id(data.result_id) && orderedEvents(data) && uuid(data.source_change_artifact_id) && sha(data.sha256) ? data : null
}
function verificationBody(value: unknown): Rec | null {
  const data = exact(value, ['schema', 'sha256', 'source_change_artifact_id', 'edit_tool_result', 'verification_tool_result', 'path', 'command', 'runner', 'cwd_scope', 'execution_status', 'exit_code', 'passed', 'previous_test_exit_code', 'stdout', 'stderr', 'dsh_session'])
  const command = exact(data?.command, ['file', 'args'])
  return data && command && data.schema === 'loom.code-verification.v1' && data.path === PATH && data.runner === 'node:test' && data.cwd_scope === 'authorized_project_root' && data.execution_status === 'completed' && command.file === 'node' && Array.isArray(command.args) && command.args.length === 2 && command.args[0] === '--test' && command.args[1] === 'test/calc.test.js' && sha(data.sha256) && uuid(data.source_change_artifact_id) && id(data.edit_tool_result) && id(data.verification_tool_result) && session(data.dsh_session) && integer(data.exit_code) && data.exit_code <= 255 && integer(data.previous_test_exit_code, true) && typeof data.passed === 'boolean' && data.passed === (data.exit_code === 0) && typeof data.stdout === 'string' && data.stdout.length <= 8192 && typeof data.stderr === 'string' && data.stderr.length <= 8192 ? data : null
}
function text(value: string) { return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) }
function metadata(value: unknown): Meta | null {
  const data = object(value)
  return data && uuid(data.artifact_id) && typeof data.ticket_id === 'string' && data.ticket_id.length <= 160 && typeof data.origin_node_id === 'string' && data.origin_node_id.length <= 160 && id(data.assignment_id) && typeof data.name === 'string' && data.name.length > 0 && data.name.length <= 160 && (data.media_type === 'text/x-diff' || data.media_type === 'application/json') && Array.isArray(data.parents) && data.parents.length === 0 && object(data.code_evidence) ? data as unknown as Meta : null
}
function effectEvidence(value: Partial<CodeEffect>): Rec[] {
  if (!value.evidence) return []
  let data: unknown = value.evidence
  if (typeof data === 'string') {
    if (data.length > 32768) return []
    try { data = JSON.parse(data) } catch { return [] }
  }
  const records = Array.isArray(data) ? data : [data]
  return records.every(record => object(record)) ? records as Rec[] : []
}
function linkedReference(meta: Meta, source: boolean) {
  // Read only the checked public projection, never arbitrary private tool metadata.
  return source ? changeEvidence(meta.code_evidence) : verifyEvidence(meta.code_evidence)
}
function commonArtifact(meta: Meta, artifact: ArtifactContent) {
  return artifact.content.length <= 131072 && (!artifact.encoding || artifact.encoding === 'utf8') && !artifact.truncated && text(artifact.content) && typeof meta.name === 'string' && typeof meta.assignment_id === 'string' && meta.parents?.length === 0
}
function sharedRelation(ticket: Ticket, diff: Meta, verifier: Meta, change: Rec, verify: Rec) {
  if (diff.media_type !== 'text/x-diff' || verifier.media_type !== 'application/json' || diff.artifact_id !== verify.source_change_artifact_id || diff.assignment_id !== verifier.assignment_id || diff.ticket_id !== ticket.id || verifier.ticket_id !== ticket.id || diff.origin_node_id !== verifier.origin_node_id) return null
  const assignment = ticket.assignments?.find(item => item.id === diff.assignment_id && item.ticket_id === ticket.id && Number.isSafeInteger(item.attempt))
  const effect = ticket.effects?.find(item => (item as CodeEffect).assignment_id === diff.assignment_id && item.status === 'confirmed')
  if (!assignment || assignment.node_id !== diff.origin_node_id || ticket.assignments?.filter(item => item.id === diff.assignment_id).length !== 1 || !effect || ticket.effects?.filter(item => (item as CodeEffect).assignment_id === diff.assignment_id).length !== 1 || diff.assignment_id !== (effect as CodeEffect).assignment_id || (effect as CodeEffect).artifacts?.length !== 1 || (effect as CodeEffect).artifacts?.[0] !== diff.artifact_id || !uuid(effect.effect_id)) return null
  const source = changeEvidence(change)
  if (!source) return null
  return { assignment, effect, change }
}
function reportFor(reports: Report[] | undefined, assignmentId: string, passed: boolean) {
  const expected = passed ? 'succeeded' : 'failed'
  const found = reports?.filter(item => item.assignment_id === assignmentId) ?? []
  return found.length === 1 && (found[0].state ?? found[0].status) === expected && found[0].status === expected ? found[0] : null
}
function linked(ticket: Ticket, diff: ArtifactContent, verifier: ArtifactContent): { change: Rec; verify: Rec; report: Report; relation: Relation } | null {
  const dm = metadata(diff.metadata), vm = metadata(verifier.metadata)
  if (!dm || !vm) return null
  if (vm.artifact_id === dm.artifact_id || !commonArtifact(dm, diff) || !commonArtifact(vm, verifier) || !isBoundedUnifiedDiff(diff.content)) return null
  const change = linkedReference(dm, true), reference = linkedReference(vm, false)
  if (!change || !reference) return null
  const body = (() => { try { return verificationBody(JSON.parse(verifier.content)) } catch { return null } })()
  if (!body || body.source_change_artifact_id !== dm.artifact_id || body.edit_tool_result !== change.result_id || body.verification_tool_result !== reference.result_id || body.path !== change.path || body.sha256 !== change.sha256 || reference.sha256 !== change.sha256 || reference.path !== change.path) return null
  const shared = sharedRelation(ticket, dm, vm, change, reference)
  if (!shared) return null
  const editSession = session(change.session)!, verifySession = session(reference.session)!, bodySession = session(body.dsh_session)!
  if (editSession.session_id !== verifySession.session_id || verifySession.session_id !== bodySession.session_id) return null
  const editResultSequence = change.result_seq
  const verifyCallSequence = reference.call_seq
  if (typeof editResultSequence !== 'number' || typeof verifyCallSequence !== 'number'
    || editResultSequence >= verifyCallSequence) return null
  const evidence = effectEvidence(shared.effect)
  const effectRecords = evidence.filter(record => record.schema === 'loom.code-change.v1')
  if (effectRecords.length !== 1) return null
  const effect = effectRecords[0]
  if (!effectChange(effect) || !uuid(effect.verification_artifact_id) || effect.verification_artifact_id !== vm.artifact_id || effect.test_tool_result_id !== reference.result_id || effect.test_exit_code !== body.exit_code
    || ['call_id', 'result_id', 'path', 'previous_sha256', 'sha256'].some(key => effect[key] !== change[key]) || session(effect.session)?.session_id !== editSession.session_id) return null
  const report = reportFor(ticket.reports, shared.assignment.id, body.passed as boolean)
  if (!report) return null
  return { change, verify: body, report, relation: { assignmentId: shared.assignment.id, attempt: shared.assignment.attempt, effectId: shared.effect.effect_id, reportStatus: report.status as 'failed' | 'succeeded', sessionId: editSession.session_id } }
}

/** Reads already downloaded/authorized evidence, checking structural links only. It does not create Grants, execute content, or replace center authority. */
export function codeArtifactPresentation(ticket: Ticket, artifact: ArtifactContent, sourceArtifacts: ArtifactContent[] = []): CodeArtifactPresentation {
  const name = typeof (artifact.metadata as Meta | undefined)?.name === 'string' ? (artifact.metadata as Meta).name : undefined
  const raw = { kind: 'unsupported' as const, reason: 'ordinary_artifact' as const, name, content: artifact.content }
  try {
    const meta = metadata(artifact.metadata)
    if (!meta || typeof artifact.content !== 'string') return raw
    if (!commonArtifact(meta, artifact)) return { ...raw, reason: 'incomplete_relation' }
    if (meta.media_type === 'text/x-diff') {
      const verifier = effectEvidence(ticket.effects?.find(item => (item as CodeEffect).assignment_id === meta.assignment_id && item.status === 'confirmed') ?? {})
        .flatMap(record => [uuid(record.verification_artifact_id)]).filter((id): id is string => !!id)
        .flatMap(id => ticket.artifacts?.filter(item => item.artifact_id === id) ?? [])
        .flatMap(ref => sourceArtifacts.filter(item => metadata(item.metadata)?.artifact_id === ref.artifact_id))
      if (verifier.length !== 1 || !isBoundedUnifiedDiff(artifact.content)) return { ...raw, reason: 'incomplete_relation' }
      const linkedData = linked(ticket, artifact, verifier[0])
      if (!linkedData) return { ...raw, reason: 'incomplete_relation' }
      const lines = artifact.content.split('\n').map(line => ({ text: line, kind: line.startsWith('+') && !line.startsWith('+++') ? 'added' as const : line.startsWith('-') && !line.startsWith('---') ? 'removed' as const : line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('---') || line.startsWith('+++') ? 'heading' as const : 'context' as const }))
      return { kind: 'change', name: meta.name!, artifactId: meta.artifact_id, relation: { ...linkedData.relation, reportStatus: linkedData.report.status as 'failed' | 'succeeded', verificationArtifactId: verifier[0].metadata.artifact_id }, previousSha256: linkedData.change.previous_sha256 as string, sha256: linkedData.change.sha256 as string, path: PATH, lines }
    }
    const body = (() => { try { return verificationBody(JSON.parse(artifact.content)) } catch { return null } })()
    if (!body) return meta ? { ...raw, reason: 'incomplete_relation' } : raw
    const sourceRefs = ticket.artifacts?.filter(item => item.artifact_id === body.source_change_artifact_id) ?? []
    const sources = sourceArtifacts.filter(item => meta && sourceRefs.some(ref => ref.artifact_id === metadata(item.metadata)?.artifact_id) && linked(ticket, item, artifact))
    if (sourceRefs.length !== 1 || sources.length !== 1) return { ...raw, reason: 'incomplete_relation' }
    const linkedData = linked(ticket, sources[0], artifact)!
    return { kind: 'verification', name: meta.name!, artifactId: meta.artifact_id, relation: { ...linkedData.relation, sourceArtifactId: body.source_change_artifact_id as string, previousSha256: linkedData.change.previous_sha256 as string, sha256: body.sha256 as string, path: PATH, editResultId: body.edit_tool_result as string, verificationResultId: body.verification_tool_result as string }, command: 'node --test test/calc.test.js', exitCode: body.exit_code as number, passed: body.passed as boolean, previousTestExitCode: body.previous_test_exit_code as number, stdout: (body.stdout as string).slice(0, 8192), stderr: (body.stderr as string).slice(0, 8192) }
  } catch {
    return { ...raw, reason: 'incomplete_relation' }
  }
}
