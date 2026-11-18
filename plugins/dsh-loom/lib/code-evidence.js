// Explicit test-fixture source-code proof. This is not general Agent/tool authority.
import { createHash } from 'node:crypto'
import { stableArtifactId } from './ids.js'

export const CODE_EDIT_TOOL = 'loom_fixture_code_edit'
export const CODE_VERIFY_TOOL = 'loom_fixture_verify'
const SOURCE = 'src/calc.js'
const TEST = 'test/calc.test.js'
const MAX_SOURCE = 32 * 1024
const MAX_OUTPUT = 4096
const bounded = (value, max = MAX_OUTPUT) => typeof value === 'string' && Buffer.byteLength(value) <= max
const hash = value => createHash('sha256').update(value).digest('hex')
// Actual root, file type and Git patch verification use the shared source helper.

export function fixtureCodeTask(assignment) {
  if (assignment?.kind !== 'edit_file' || !assignment.objective?.includes('LOOM_FIXTURE_CODE_TASK')) return null
  const otherProvider = (assignment.provider && assignment.provider !== 'loom-stub') || (assignment.model && assignment.model !== 'loom-stub-v1')
  if (otherProvider) throw new Error('The scoped code fixture allows only the deterministic loom-stub model, never an external route')
  if (assignment.relative_path !== SOURCE || typeof assignment.content !== 'string' || Buffer.byteLength(assignment.content) > MAX_SOURCE) {
    throw new Error('The source-code fixture requires only the bounded src/calc.js target')
  }
  if (assignment.artifact_input !== undefined) throw new Error('Code fixture cannot substitute another Artifact authority')
  return { assignment, relative_path: SOURCE, test_relative_path: TEST }
}

export function captureCodeCall(record, name, data) {
  if (![CODE_EDIT_TOOL, CODE_VERIFY_TOOL].includes(name)) return
  if (!data?.callId || typeof data.arguments !== 'string' || data.arguments.length > 4096) return
  let args
  try { args = JSON.parse(data.arguments) } catch { args = null }
  record.code_calls ||= new Map()
  record.code_calls.set(data.callId, { name, args, seq: data.__seq })
}

export function captureCodeResult(record, data, session) {
  const message = data?.message
  const callId = message?.toolCallId || message?.source?.callId
  const call = record.code_calls?.get(callId)
  if (!call || !message.id) return
  const text = (message.content || []).filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n')
  const tool = { call, call_id: callId, result_id: message.id, seq: data.seq, session,
    is_error: message.isError === true, text: text.slice(0, 4096) }
  if (call.name === CODE_EDIT_TOOL) tool.possible_effect = true
  // A result can be present but failed to execute the actual tool correctly.
  // Parse only the allowed schemas; never blindly accept a paraphrase as proof.
  try {
    const value = JSON.parse(text)
    if (call.name === CODE_EDIT_TOOL) {
      if (value.schema !== 'loom.fixture-code-edit.v1' || value.path !== SOURCE || value.created !== true || value.next_tool !== CODE_VERIFY_TOOL
        || !hex(value.previous_sha256) || !hex(value.sha256) || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_SOURCE
        || !Number.isSafeInteger(value.baseline_test_exit_code) || value.baseline_test_exit_code === 0 || value.baseline_git_clean !== true) throw new Error('Malformed or partial code-edit ToolResult')
      tool.edit = { path: SOURCE, previous_sha256: value.previous_sha256, sha256: value.sha256, size_bytes: value.size_bytes,
        baseline_test_exit_code: value.baseline_test_exit_code, baseline_git_clean: true }
      tool.possible_effect = true
    } else {
      if (value.schema !== 'loom.fixture-code-verification.v1' || value.path !== SOURCE
        || value.command?.file !== 'node' || JSON.stringify(value.command.args) !== JSON.stringify(['--test', TEST])
        || !hex(value.sha256) || !Number.isSafeInteger(value.previous_test_exit_code) || value.previous_test_exit_code < 1
        || (Number.isInteger(value.exit_code) && (value.exit_code < 0 || value.exit_code > 255))
        || (!Number.isInteger(value.exit_code) && value.exit_code !== null)
        || typeof value.passed !== 'boolean' || value.execution_status !== 'completed'
        || !bounded(value.stdout) || !bounded(value.stderr)
        || (Number.isInteger(value.exit_code) && value.passed !== (value.exit_code === 0))) throw new Error('Malformed or partial code-verification ToolResult')
      tool.verify = { path: SOURCE, sha256: value.sha256, exit_code: value.exit_code,
        passed: value.passed, stdout: value.stdout, stderr: value.stderr,
        previous_test_exit_code: value.previous_test_exit_code,
        execution_status: value.execution_status }
      // A completed verification service must provide its precise baseline.
      if (!Number.isSafeInteger(tool.verify.previous_test_exit_code) || tool.verify.previous_test_exit_code < 1) throw new Error('Missing original failing-test evidence')
    }
  } catch (error) {
    tool.invalid_error = error.message.slice(0, 512)
    tool.is_error = true
  }
  record.code_tool_records ||= []
  record.code_tool_records.push(tool)
}

export function hasCodeRecord(record) { return Array.isArray(record?.code_tool_records) && record.code_tool_records.length > 0 }

import { sourceChangeProof, sourceArtifact, sourceEffectId } from './source-change-evidence.js'

export async function codeEvidence(assignment, projectRoot, task, record, options = {}) {
  const records = record.code_tool_records || []
  const failure = (summary, state = 'failed', evidence = records) => ({ state, summary,
    effects: [], artifacts: [], evidence,
    ...(record.agent?.session ? { session_ref: record.session_ref } : {}) })
  if (!task || records.length === 0) return null
  if (records.some(entry => entry.invalid_error
    && !(options.cancelled === true && record.abort_stage?.phase === 'before-test-subprocess' && entry.call?.name === CODE_VERIFY_TOOL))) {
    return failure('The ordinary DSH ToolResult is incomplete or violates the bounded code-proof schema; actual effects remain uncertain.', 'unknown')
  }
  const edits = records.filter(entry => entry.call?.name === CODE_EDIT_TOOL)
  if (edits.length !== 1) return failure('More than one or no exact source edit ToolResult exists; no trustworthy change pair was constructed.', 'unknown')
  const edit = edits[0]
  if (!edit || edit.is_error || !edit.edit) {
    return failure(`The source edit ToolResult did not resolve a verified effect (it may have been partial after the atomic write): ${edit?.text || edit?.invalid_error || 'source edit result unavailable'}`, 'unknown', [edit])
  }
  if (edit.call.args === null || edit.call.args?.path !== task.relative_path || !edit.call_id || !edit.result_id) {
    return failure('The public ToolCall and ToolResult were not matched to the persisted source target.', 'unknown', [edit])
  }
  if (!record.agent?.session) return failure('A real DSH Session is required for code evidence.', 'unknown', [edit])
  const cancelled = options.cancelled === true
  // The ABORTED verifier is a transport outcome, never a fabricated completed test.

  if (cancelled && (record.cancel_requested !== true || record.abort_reason !== 'user'
    || !Number.isSafeInteger(record.abort_seq) || edit.seq >= record.abort_seq)) {
    return failure('Only an observed later user cancellation can certify an interrupted source change; an unfinished editor stays uncertain.', 'unknown', [edit])
  }
  // A cancelled verifier ToolResult is an abort transport event, not a
  // completed `loom.fixture-code-verification.v1` record. Count only real tests.
  const tests = records.filter(entry => entry.call?.name === CODE_VERIFY_TOOL && entry.verify)
  if (cancelled && !assignment.objective?.includes('LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY')) {
    return failure('Change-only cancellation is restricted to the explicitly held pre-subprocess fixture.', 'unknown', [edit])
  }
  const stop_boundary = cancelled ? cancelledBoundary(record, edit, records) : undefined
  if (cancelled && stop_boundary.error) return failure(stop_boundary.error, 'unknown', [edit, ...tests])
  if (cancelled && (tests.length > 0
    || record.abort_stage?.phase !== 'before-test-subprocess'
    || ![...(record.code_calls?.values() || [])].some(call => call.name === CODE_VERIFY_TOOL))) {
    return failure('A change-only cancellation must stop the real verifier before its test process and completed ToolResult, not after validation is done.', 'unknown', [edit, ...tests])
  }
  let verify
  if (!cancelled) {
    if (tests.length !== 1) return failure('The source edit has no single completed verification result; a changed file cannot be labelled test-successful.', 'unknown')
    verify = tests[0]
    if (!verify.verify) return failure(`The fixed verification tool failed: ${verify.text || verify.invalid_error || 'verification not completed'}`, 'failed', [edit, verify])
    if (verify.is_error && verify.verify.passed) return failure('The SDK declared an execution error despite a purported passing test; verification is unresolved.', 'unknown', [edit, verify])
    if (verify.call.args === null || verify.call.args?.path !== task.relative_path || verify.call.args?.sha256 !== edit.edit.sha256
      || !Number.isSafeInteger(edit.seq) || !Number.isSafeInteger(verify.seq) || verify.seq <= edit.seq
      || verify.verify.sha256 !== edit.edit.sha256 || verify.verify.previous_test_exit_code !== edit.edit.baseline_test_exit_code) {
      return failure('Verification did not follow the observed source edit with the same content and original failing baseline.', 'unknown', [edit, verify])
    }
  }
  const relative = task.relative_path
  const content = Buffer.from(assignment.content, 'utf8')
  const source = await sourceChangeProof(assignment, projectRoot, task, edit, failure)
  if (source.state) return source
  const actual = source.actual
  const { changeRef, changeId, patch } = source
  const effectId = sourceEffectId(assignment, edit, actual, source.previous)
  if (cancelled) {
    const artifact = sourceArtifact(assignment, changeId, patch)
    artifact.metadata.evidence = [changeRef]
    return { state: 'unknown', cancel_acknowledged: true,
      summary: 'The real source edit and diff are confirmed, but the user cancelled before verification. This operation remains unknown, not a successful completion or an invented rollback.',
      effects: [{ effect_id: effectId, ticket_id: assignment.ticket_id, assignment_id: assignment.id,
        node_id: assignment.node_id, attempt: assignment.attempt,
        input_digest: hash(JSON.stringify({ assignment_id: assignment.id, kind: assignment.kind, path: relative, content })),
        status: 'confirmed', evidence: [changeRef], artifacts: [changeId] }],
      artifacts: [artifact], evidence: [changeRef], stop_boundary: { ...stop_boundary, source_change_artifact_id: changeId }, session_ref: record.session_ref }
  }
  const verificationId = stableArtifactId(`${assignment.id}:code-verification:${verify.call_id}:${verify.result_id}:${hash(actual)}`)
  const verificationRef = { type: 'dsh-tool-result', name: verify.call.name, call_id: verify.call_id,
    call_seq: verify.call.seq, result_id: verify.result_id, result_seq: verify.seq, session: verify.session,
    code_change_artifact_id: changeId, path: relative, sha256: hash(actual) }
  const output = value => typeof value === 'string' ? value.split(source.root).join('<authorized_project_root>') : ''
  const reportBytes = Buffer.from(JSON.stringify({ schema: 'loom.code-verification.v1',
    path: relative, sha256: hash(actual), source_change_artifact_id: changeId,
    edit_tool_result: edit.result_id, verification_tool_result: verify.result_id,
    command: { file: 'node', args: ['--test', TEST] }, runner: 'node:test', cwd_scope: 'authorized_project_root',
    execution_status: verify.verify.execution_status, exit_code: verify.verify.exit_code, passed: verify.verify.passed,
    previous_test_exit_code: verify.verify.previous_test_exit_code,
    stdout: output(verify.verify.stdout), stderr: output(verify.verify.stderr),
    dsh_session: verify.session }, null, 2))
  const changeArtifact = sourceArtifact(assignment, changeId, patch)
  changeArtifact.metadata.evidence = [changeRef]
  const verificationArtifact = { artifact_id: verificationId, bytes: reportBytes,
    metadata: { artifact_id: verificationId, name: `code-verification-${assignment.id}.json`, media_type: 'application/json',
      origin_node_id: assignment.node_id, size_bytes: reportBytes.length, sha256: hash(reportBytes), parents: [], evidence: [verificationRef] } }
  // sourceEffectId preserves the original immutable Effect's derivation.
  const effects = [{ effect_id: effectId, ticket_id: assignment.ticket_id, assignment_id: assignment.id,
    node_id: assignment.node_id, attempt: assignment.attempt,
    input_digest: hash(JSON.stringify({ assignment_id: assignment.id, kind: assignment.kind,
      path: relative, content })), status: 'confirmed',
    evidence: [{ schema: 'loom.code-change.v1', ...changeRef, test_tool_result_id: verify.result_id,
      verification_artifact_id: verificationId, test_exit_code: verify.verify.exit_code }], artifacts: [changeId] }]
  return { state: verify.verify.passed ? 'succeeded' : 'failed',
    summary: verify.verify.passed ? 'An isolated DSH Agent changed the exact fixture source and the real fixed node:test succeeded with an independently verified diff.' : 'The source edit is confirmed, but the real fixed node:test failed. The changed code and failure are retained; this is not a rollback.',
    effects, artifacts: [changeArtifact, verificationArtifact],
    evidence: [changeRef, verificationRef], session_ref: record.session_ref }
}

function cancelledBoundary(record, edit, records) {
  if (record.abort_stage?.aborted !== true || record.abort_stage.phase !== 'before-test-subprocess'
    || record.abort_stage.reason !== 'user' || record.abort_reason !== 'user'
    || records.some(entry => entry.verify)
    || !record.session_ref?.session_id || !Number.isSafeInteger(record.abort_seq)) {
    return { error: 'The precise held verifier abort or matching user stop-intent proof is missing; change-only certification stays unknown.' }
  }
  const calls = [...(record.code_calls?.values() || [])].filter(call => call.name === CODE_VERIFY_TOOL)
  if (calls.length !== 1) return { error: 'Change-only proof needs exactly one held verification ToolCall.' }
  const call = calls[0]
  const stopped = records.find(entry => entry.call === call)
  const id = [...(record.code_calls?.entries() || [])].find(([, value]) => value === call)?.[0]
  if (!stopped) return { error: 'The held verification ToolResult was not bound to that specific invocation.' }
  if (!stopped || stopped.call_id !== id || !stopped.result_id || stopped.is_error !== true
    || !['Fixture verification cancelled before its test subprocess', 'Error: Fixture verification cancelled before its test subprocess'].includes(stopped.text)
    || !Number.isSafeInteger(call.seq) || call.seq <= edit.seq
    || !Number.isSafeInteger(stopped.seq) || call.seq >= stopped.seq || record.abort_seq < stopped.seq) {
    return { error: 'The observed verifier abort is not an exact ordered ABORTED ToolResult before any completed test.' }
  }
  return {
    schema: 'loom.code-stop-boundary.v1', type: 'dsh-tool-abort', name: CODE_VERIFY_TOOL,
    phase: 'before-test-subprocess', reason: 'user',
    call_id: id, call_seq: call.seq,
    result_id: stopped.result_id, result_seq: stopped.seq,
    abort_seq: record.abort_seq, session: record.session_ref,
  }
}

function hex(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
