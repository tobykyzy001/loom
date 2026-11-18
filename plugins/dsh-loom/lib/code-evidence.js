// Explicit test-fixture source-code proof. This is not general Agent/tool authority.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { stableArtifactId } from './ids.js'

export const CODE_EDIT_TOOL = 'loom_fixture_code_edit'
export const CODE_VERIFY_TOOL = 'loom_fixture_verify'
const SOURCE = 'src/calc.js'
const TEST = 'test/calc.test.js'
const MAX_SOURCE = 32 * 1024
const MAX_OUTPUT = 4096
const hash = value => createHash('sha256').update(value).digest('hex')
const execute = promisify(execFile)
const bounded = (value, max = MAX_OUTPUT) => typeof value === 'string' && Buffer.byteLength(value) <= max

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

export async function codeEvidence(assignment, projectRoot, task, record) {
  const records = record.code_tool_records || []
  const failure = (summary, state = 'failed', evidence = records) => ({ state, summary,
    effects: [], artifacts: [], evidence,
    ...(record.agent?.session ? { session_ref: record.session_ref } : {}) })
  if (!task || records.length === 0) return null
  if (records.some(entry => entry.invalid_error)) {
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
  const tests = records.filter(entry => entry.call?.name === CODE_VERIFY_TOOL)
  if (tests.length !== 1) return failure('The source edit has no single completed verification result; a changed file cannot be labelled test-successful.', 'unknown')
  const verify = tests[0]
  if (!verify.verify) return failure(`The fixed verification tool failed: ${verify.text || verify.invalid_error || 'verification not completed'}`, 'failed', [edit, verify])
  if (verify.is_error && verify.verify.passed) return failure('The SDK declared an execution error despite a purported passing test; verification is unresolved.', 'unknown', [edit, verify])
  if (verify.call.args === null || verify.call.args?.path !== task.relative_path || verify.call.args?.sha256 !== edit.edit.sha256
    || !Number.isSafeInteger(edit.seq) || !Number.isSafeInteger(verify.seq) || verify.seq <= edit.seq
    || verify.verify.sha256 !== edit.edit.sha256 || verify.verify.previous_test_exit_code !== edit.edit.baseline_test_exit_code) {
    return failure('Verification did not follow the observed source edit with the same content and original failing baseline.', 'unknown', [edit, verify])
  }
  const rootInput = projectRoot || assignment.grant?.project_root
  if (!rootInput) return failure('Code change requires the exact ProjectBinding root', 'unknown')
  const root = await realpath(resolve(rootInput))
  if (assignment.grant?.project_root && await realpath(resolve(assignment.grant.project_root)) !== root) {
    return failure('Current Code Evidence root differs from the exact ProjectBinding root', 'unknown')
  }
  // Every path and every actual byte is checked again outside the tool's text.
  const relative = task.relative_path
  const directory = await realpath(resolve(root, dirname(relative)))
  const expectedDirectory = await realpath(resolve(root, 'src'))
  if (directory !== expectedDirectory || !directory.startsWith((await realpath(root)) + sep)) {
    return failure('Actual edit is outside the selected source directory', 'unknown')
  }
  const stat = await lstat(resolve(directory, 'calc.js'))
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SOURCE) {
    return failure('The changed target is not a bounded ordinary non-symlink file', 'unknown')
  }
  const actual = await readFile(resolve(directory, 'calc.js'))
  const content = Buffer.from(assignment.content, 'utf8')
  if (content.length > MAX_SOURCE || !actual.equals(content) || !hex(hash(actual)) || hash(actual) !== edit.edit.sha256
    || stat.size !== edit.edit.size_bytes || verify.verify.sha256 !== hash(actual)) {
    return failure('Actual post-edit bytes or digest differ from the Ticket and one observed test target.', 'unknown')
  }
  // Run only real, read-only Git commands in this explicitly authorized root.
  // No arbitrary user command, shell, git reset/stash/checkout, hooks or Provider.
  const environment = { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  const git = async (...args) => (await execute('/usr/bin/git', ['--no-pager', ...(args)], {
    cwd: root, env: environment, shell: false, windowsHide: true, timeout: 5000, maxBuffer: 96 * 1024,
  })).stdout
  const head = Buffer.from(await git('show', `HEAD:${relative}`), 'binary')
  // Git's `encoding` is deliberately UTF-8 only on text output; this payload is a JS source Buffer.
  // maxBuffer protects all read-only command output; compute the actual baseline hash below.
  const status = (await git('status', '--porcelain=v1', '--untracked-files=all', '--', '.')).trimEnd()
  if (status !== ` M ${relative}`) return failure('Only the exact one-file change is permitted in this fixture; observed unrelated or staged changes.', 'unknown')
  const staged = (await git('diff', '--cached', '--no-ext-diff', '--no-color', '--exit-code', '--', relative)).trim()
  if (staged) return failure('Source is already staged; no read-only change evidence may hide another approved change.', 'unknown')
  const patch = await git('-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', relative)
  if (!patch.includes(`--- a/${relative}`) || !patch.includes(`+++ b/${relative}`)
    || !patch.includes('-  return a - b;') || !patch.includes('+  return a + b;')
    || Buffer.byteLength(patch) > 96 * 1024) return failure('Only a genuine one-source baseline-to-result unified diff is accepted.', 'unknown')
  const previous = hash(head)
  const expectedOld = hash("export function add(a, b) {\n  return a - b;\n}\n")
  if (previous !== edit.edit.previous_sha256 || previous !== expectedOld) {
    return failure('Observed baseline is not the committed source whose actual edit result was reported.', 'unknown')
  }
  const changeRef = { type: 'dsh-tool-result', name: edit.call.name, call_id: edit.call_id,
    call_seq: edit.call.seq, result_id: edit.result_id, result_seq: edit.seq, session: edit.session,
    schema: 'loom.code-change.v1', path: relative, previous_sha256: previous,
    sha256: hash(actual), size_bytes: actual.length }
  const changeId = stableArtifactId(`${assignment.id}:code-change:${edit.call_id}:${previous}:${hash(actual)}`)
  const verificationId = stableArtifactId(`${assignment.id}:code-verification:${verify.call_id}:${verify.result_id}:${hash(actual)}`)
  const verificationRef = { type: 'dsh-tool-result', name: verify.call.name, call_id: verify.call_id,
    call_seq: verify.call.seq, result_id: verify.result_id, result_seq: verify.seq, session: verify.session,
    code_change_artifact_id: changeId, path: relative, sha256: hash(actual) }
  const output = value => typeof value === 'string' ? value.split(root).join('<authorized_project_root>').split(root.replaceAll('\\', '/')).join('<authorized_project_root>') : ''
  const reportBytes = Buffer.from(JSON.stringify({ schema: 'loom.code-verification.v1',
    path: relative, sha256: hash(actual), source_change_artifact_id: changeId,
    edit_tool_result: edit.result_id, verification_tool_result: verify.result_id,
    command: { file: 'node', args: ['--test', TEST] }, runner: 'node:test', cwd_scope: 'authorized_project_root',
    execution_status: verify.verify.execution_status, exit_code: verify.verify.exit_code, passed: verify.verify.passed,
    previous_test_exit_code: verify.verify.previous_test_exit_code,
    stdout: output(verify.verify.stdout), stderr: output(verify.verify.stderr),
    dsh_session: verify.session }, null, 2))
  if (!hex(hash(head)) || previous === hash(actual)) return failure('The source task did not have a measurable original-to-new change', 'unknown')
  const changeArtifact = { artifact_id: changeId, bytes: Buffer.from(patch),
    metadata: { artifact_id: changeId, name: `code-change-${assignment.id}.diff`, media_type: 'text/x-diff',
      origin_node_id: assignment.node_id, size_bytes: Buffer.byteLength(patch), sha256: hash(patch), parents: [], evidence: [changeRef] } }
  const verificationArtifact = { artifact_id: verificationId, bytes: reportBytes,
    metadata: { artifact_id: verificationId, name: `code-verification-${assignment.id}.json`, media_type: 'application/json',
      origin_node_id: assignment.node_id, size_bytes: reportBytes.length, sha256: hash(reportBytes), parents: [], evidence: [verificationRef] } }
  const effectId = stableArtifactId(`${assignment.id}:code-effect:${edit.call_id}:${previous}:${hash(actual)}`)
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

function hex(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
