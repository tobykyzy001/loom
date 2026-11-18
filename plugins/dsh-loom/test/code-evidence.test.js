import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { codeEvidence, fixtureCodeTask, captureCodeResult, hasCodeRecord } from '../lib/code-evidence.js'
import { DshAdapter } from '../lib/dsh-adapter.js'

const expected = 'export function add(a, b) {\n  return a + b;\n}\n'
let serial = 0
const run = promisify(execFile)
const oldSha = createHash('sha256').update('export function add(a, b) {\n  return a - b;\n}\n').digest('hex')
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'loom-code-evidence-'))
  await mkdir(join(root, 'src')); await mkdir(join(root, 'test'))
  await writeFile(join(root, 'src', 'calc.js'), 'export function add(a, b) {\n  return a - b;\n}\n')
  await writeFile(join(root, 'test', 'calc.test.js'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport {add} from '../src/calc.js'\ntest('add', () => assert.equal(add(2,3),5))\n")
  const env = { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  await run('/usr/bin/git', ['init', '--quiet', '.'], { cwd: root, env })
  await run('/usr/bin/git', ['add', '--', 'src/calc.js', 'test/calc.test.js'], { cwd: root, env })
  await run('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'baseline'], { cwd: root, env })
  return root
}
function records(passed = true, { edit = true, test = true, valid = true } = {}) {
  const session = { harness: 'dsh', session_id: 'actual-fixture-session', protocol: 'dsh-session-log', host_api: '0.2.2-rc.3', observed_seq: 5 }
  const result = []
  if (edit) result.push({ call: { name: 'loom_fixture_code_edit', args: { path: 'src/calc.js' }, seq: 1 }, call_id: 'edit-call', result_id: 'edit-result', seq: 2,
    session, edit: { path: 'src/calc.js', previous_sha256: oldSha, sha256: hash(Buffer.from(expected)), size_bytes: Buffer.byteLength(expected), baseline_test_exit_code: 1 } })
  if (test) result.push({ call: { name: 'loom_fixture_verify', args: { path: 'src/calc.js', sha256: hash(Buffer.from(expected)) }, seq: 3 }, call_id: 'verify-call', result_id: 'verify-result', seq: 4,
    session, verify: { path: 'src/calc.js', sha256: hash(Buffer.from(expected)), exit_code: passed ? 0 : 1, passed,
      stdout: `pass ${passed ? 1 : 0}\n`, stderr: passed ? '' : 'synthetic actual pending test failure\n',
      previous_test_exit_code: 1, execution_status: 'completed' } })
  if (!valid && result[0]) result[0].invalid_error = 'Missing structural tool result'
  return result
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('code proof builds a real unified diff and verification Artifact from actual source changes', async () => {
  const root = await setup()
  await writeFile(join(root, 'src', 'calc.js'), expected)
  const assignment = { id: 'code-assignment', ticket_id: 'code-ticket', kind: 'edit_file', node_id: 'node', attempt: 1,
    objective: 'LOOM_FIXTURE_CODE_TASK preserve the intended source task', relative_path: 'src/calc.js', content: expected }
  const task = fixtureCodeTask(assignment)
  const result = await codeEvidence(assignment, root, task, { code_task: task, code_tool_records: records(), agent: { session: { id: 'actual-fixture-session' } }, session_ref: { session_id: 'actual-fixture-session' } })
  assert.equal(result.state, 'succeeded')
  assert.equal(result.effects.length, 1)
  assert.equal(result.artifacts.length, 2)
  assert.equal(result.effects[0].status, 'confirmed')
  assert.deepEqual(result.effects[0].artifacts, [result.artifacts[0].artifact_id])
  assert.notEqual(result.artifacts[0].artifact_id, result.artifacts[1].artifact_id)
  assert.match(result.artifacts[0].bytes.toString(), /-  return a - b;/)
  assert.match(result.artifacts[0].bytes.toString(), /\+  return a \+ b;/)
  assert.equal(result.artifacts[0].metadata.media_type, 'text/x-diff')
  const diff = await run('/usr/bin/git', ['--no-pager', 'diff', '--no-color', '--', 'src/calc.js'], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' } })
  assert.deepEqual(result.artifacts[0].bytes.toString(), diff.stdout)
  const proof = JSON.parse(result.artifacts[1].bytes.toString())
  assert.equal(proof.schema, 'loom.code-verification.v1')
  assert.equal(proof.exit_code, 0)
  assert.deepEqual(proof.command, { file: 'node', args: ['--test', 'test/calc.test.js'] })
  assert.equal(proof.sha256, result.artifacts[0].metadata.evidence[0].sha256)
  assert.equal(proof.source_change_artifact_id, result.artifacts[0].artifact_id)
  assert.equal(Number.isInteger(proof.previous_test_exit_code), true)
  assert.equal(await readFile(join(root, 'src', 'calc.js'), 'utf8'), expected)
})

test('a real test failure preserves its effect and returns precise verification without rollback', async () => {
  const root = await setup()
  await writeFile(join(root, 'src', 'calc.js'), expected)
  const result = await codeEvidence({ id: 'a', ticket_id: 't', node_id: 'n', relative_path: 'src/calc.js', content: expected },
    root, { relative_path: 'src/calc.js', test_relative_path: 'test/calc.test.js' }, { code_tool_records: records(false), agent: { session: { id: 'actual-fixture-session' } }, session_ref: { session_id: 'actual-fixture-session' } })
  assert.equal(result.state, 'failed')
  assert.equal(result.effects.length, 1)
  assert.equal(result.artifacts.length, 2)
  assert.equal(JSON.parse(result.artifacts[1].bytes.toString()).exit_code, 1)
  assert.match(result.summary, /failed/)
})

test('missing or invalid verification cannot manufacture success', async () => {
  const root = await setup()
  await writeFile(join(root, 'src', 'calc.js'), expected)
  for (const options of [{ test: false }, { valid: false }]) {
    const result = await codeEvidence({ id: 'x', ticket_id: 't', node_id: 'n', relative_path: 'src/calc.js', content: expected },
      root, { relative_path: 'src/calc.js' }, { code_tool_records: records(true, options), session_ref: { session_id: 's' } })
    assert.equal(result.state, 'unknown')
    assert.equal(result.effects.length, 0)
    assert.equal(result.artifacts.length, 0)
  }
  const disabled = { relative_path: 'src/calc.js', kind: 'edit_file', objective: 'fix arbitrary source root', content: expected }
  assert.equal(fixtureCodeTask(disabled), null)
  assert.throws(() => fixtureCodeTask({ ...disabled, objective: 'LOOM_FIXTURE_CODE_TASK', relative_path: '../outside.js' }), /only the bounded src\/calc\.js target/)
  assert.throws(() => fixtureCodeTask({ ...disabled, objective: 'LOOM_FIXTURE_CODE_TASK', provider: 'external-provider' }), /only the deterministic loom-stub/)
  assert.equal(fixtureCodeTask({ ...disabled, objective: 'LOOM_FIXTURE_CODE_TASK', provider: 'loom-stub', model: 'loom-stub-v1' }).relative_path, 'src/calc.js')
  assert.equal(hasCodeRecord({}), false)
})

test('an editor ToolResult error after a possible write stays unknown, not a fabricated rejection', async () => {
  const invalidScope = { relative_path: 'src/calc.js', kind: 'edit_file', content: expected }
  const root = await setup()
  await writeFile(join(root, 'src', 'calc.js'), expected)
  const frame = { id: 'err-call', toolCallId: 'edit-call', isError: true,
    content: [{ type: 'text', text: JSON.stringify({ schema: 'loom.fixture-code-edit.v1', path: 'src/calc.js', created: true,
      next_tool: 'loom_fixture_verify', previous_sha256: oldSha, sha256: hash(Buffer.from(expected)), size_bytes: Buffer.byteLength(expected), baseline_test_exit_code: 1, baseline_git_clean: true }) }] }
  const record = { code_calls: new Map([['edit-call', { name: 'loom_fixture_code_edit', args: { path: 'src/calc.js' }, seq: 1 }]]), code_tool_records: [], session_ref: { session_id: 's' } }
  // Exercise the actual parser: this error flag is not equivalent to a rejected write.
  captureCodeResult(record, { seq: 2, message: frame }, { harness: 'dsh', session_id: 's' })
  assert.equal(record.code_tool_records[0].edit.sha256, hash(Buffer.from(expected)))
  assert.equal(record.code_tool_records[0].invalid_error, undefined)
  const result = await codeEvidence({ id: 'a', ticket_id: 't', node_id: 'n', relative_path: 'src/calc.js', content: expected },
    root, {}, { code_tool_records: record.code_tool_records, agent: { session: { id: 's' } }, session_ref: { session_id: 's' } })
  assert.equal(result.state, 'unknown')
  assert.equal(result.effects.length, 0)
  assert.equal(result.artifacts.length, 0)
  assert.equal((await readFile(join(root, 'src', 'calc.js'))).toString(), expected)
  const disabled = new DshAdapter({ on() {}, agents: {} })
  const nonCurrent = await disabled.boundedFileEffects({ kind: 'edit_file' }, {}, { code_task: { relative_path: 'src/calc.js' }, code_tool_records: record.code_tool_records })
  assert.equal(nonCurrent.state, 'unknown')
  assert.equal(nonCurrent.effects.length, 0)
  assert.equal(nonCurrent.artifacts.length, 0)
})

test('terminal Agent error keeps possibly-edited source evidence unknown before report classification', async () => {
  const root = await setup()
  await writeFile(join(root, 'src', 'calc.js'), expected)
  const listeners = new Set()
  const session = { id: 'errorful-code-session', seq: 0 }
  const agent = { status: 'idle', session, followup: () => {} }
  const ctx = { on: (name, handler) => { assert.equal(name, 'session/event'); listeners.add(handler) },
    agents: { get: () => undefined, list: () => [], create: async ({ setup }) => {
      await setup?.({ tools: { register: () => () => {} } }, agent)
      return { owned: true, agent, dispose: async () => {} }
    }, resume: async () => { throw new Error('new code Assignment needs a fresh Agent; must not resume') } },
    sessionPersistence: {} }
  const fixtureRecord = { meta: {} }
  // No fixture resume support; the test exercises the direct setup path of an injected authorized Agent.
  const adapter = new DshAdapter(ctx, { allowCreation: true, fixtureCodeTools: async (agentContext, { assignment, project_root }) => {
    fixtureRecord.assignment = assignment
    fixtureRecord.root = project_root
  } })
  const request = { id: 'terminal-error-assignment', ticket_id: 'terminal-ticket', node_id: 'n', kind: 'edit_file',
    objective: 'LOOM_FIXTURE_CODE_TASK reproduce an editor failure followed by a terminal Agent error',
    relative_path: 'src/calc.js', content: expected, attempt: 1 }
  const exec = adapter.executeAssignment(request, { projectRoot: root, reportLink: async () => {} }).catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  let inspected = false
  const originalBound = adapter.boundedFileEffects.bind(adapter)
  adapter.boundedFileEffects = async (assignment, config, record) => {
    inspected = true
    return originalBound(assignment, config, record)
  }
  const emit = event => { session.seq++; for (const handler of listeners) handler(session, { ...event, seq: session.seq }) }
  emit({ type: 'tool/call', data: { name: 'loom_fixture_code_edit', callId: 'edit-call', arguments: JSON.stringify({ path: 'src/calc.js' }) } })
  emit({ type: 'tool/result', data: { message: { id: 'tool-edit-failed-after-possible-rename', toolCallId: 'edit-call', isError: true,
    content: [{ type: 'text', text: 'Fixture editor reported an outcome unknown after a possible file rename; no successful edit shape can be inferred' }] } } })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The tool result was observed but its source effect needs reconciliation.' }] } } })
  emit({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'The agent failed after the invoked tool returned uncertainty' } } } })
  const result = await exec
  assert.equal(inspected, true, 'The actual proof branch must execute rather than skipping to a failure report')
  assert.equal(result.state, 'unknown', 'Terminal error cannot be misclassified as a definitely rejected write or no effect')
  assert.equal(result.artifacts?.length || 0, 0, 'Unknown editor/tool evidence is not repackaged as verified artifacts either')
  assert.equal(fixtureRecord.assignment.id, request.id)
  assert.equal(fixtureRecord.root, root)
})

test('a real completed nonzero test under terminal Agent error retains failed status plus confirmed file effect', async () => {
  const root = await setup()
  await writeFile(join(root, 'src', 'calc.js'), expected)
  const listeners = new Set()
  const session = { id: 'terminated-after-real-test', seq: 0 }
  const agent = { status: 'idle', session, followup: () => {} }
  const ctx = { on: (name, fn) => listeners.add(fn), sessionPersistence: {}, agents: {
    get: () => undefined, list: () => [agent],
    create: async ({ setup }) => { await setup?.({ tools: { register: () => () => {} } }, agent); return { owned: true, agent, dispose: async () => {} } },
    resume: async () => { throw new Error('fresh source Task must not resume') },
  } }
  const adapter = new DshAdapter(ctx, { allowCreation: true, fixtureCodeTools: async () => {} })
  const assignment = { id: 'failed-real-test-assignment', ticket_id: 'failed-real-test-ticket', node_id: 'n', kind: 'edit_file',
    objective: 'LOOM_FIXTURE_CODE_TASK actual test fails even though Agent did not complete normally', relative_path: 'src/calc.js', content: expected, attempt: 1 }
  const operation = adapter.executeAssignment(assignment, { projectRoot: root, reportLink: async () => {} })
  await new Promise(resolve => setImmediate(resolve))
  const emit = event => { session.seq++; for (const listener of listeners) listener(session, { ...event, seq: session.seq }) }
  const sha = hash(Buffer.from(expected))
  emit({ type: 'tool/call', data: { name: 'loom_fixture_code_edit', callId: 'edit-final', arguments: JSON.stringify({ path: 'src/calc.js' }) } })
  const editResult = { schema: 'loom.fixture-code-edit.v1', path: 'src/calc.js', created: true, next_tool: 'loom_fixture_verify',
    previous_sha256: oldSha, sha256: sha, size_bytes: Buffer.byteLength(expected), baseline_test_exit_code: 1, baseline_git_clean: true }
  emit({
    type: 'tool/result',
    data: {
      message: {
        id: 'edit-final-result', toolCallId: 'edit-final', isError: false,
        content: [{ type: 'text', text: JSON.stringify(editResult) }],
      },
    },
  })
  emit({ type: 'tool/call', data: { name: 'loom_fixture_verify', callId: 'verify-final', arguments: JSON.stringify({ path: 'src/calc.js', sha256: sha }) } })
  const verificationResult = { schema: 'loom.fixture-code-verification.v1', command: { file: 'node', args: ['--test', 'test/calc.test.js'] },
    path: 'src/calc.js', sha256: sha, exit_code: 1, passed: false, previous_test_exit_code: 1, execution_status: 'completed', stdout: 'actual node test exited 1\n', stderr: '' }
  emit({
    type: 'tool/result',
    data: {
      message: {
        id: 'verify-final-result', toolCallId: 'verify-final', isError: true,
        content: [{ type: 'text', text: JSON.stringify(verificationResult) }],
      },
    },
  })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The real target test failed after editing; do not relabel it as tool refused or ambiguous outcome.' }] } } })
  emit({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Agent stepped after the fixed test but terminated abnormally' } } } })
  const result = await operation
  assert.equal(result.state, 'failed')
  assert.equal(result.artifacts.length, 2)
  assert.equal(result.effects.length, 1)
  assert.equal(result.effects[0].status, 'confirmed')
  const verification = result.artifacts.find(artifact => artifact.metadata.media_type === 'application/json')
  assert.equal(JSON.parse(verification.bytes.toString()).exit_code, 1)
  assert.equal(JSON.parse(verification.bytes.toString()).passed, false)
})

test('code fixture never resumes or shares an older Agent between assignments', async () => {
  const assignment = { id: 'code-reused', kind: 'edit_file', relative_path: 'src/calc.js', content: expected,
    objective: 'LOOM_FIXTURE_CODE_TASK retain an existing source task' }
  const agents = {
    get: () => { throw new Error('must not reuse a current Agent') },
    create: async () => { throw new Error('must not create while reusing existing identity') },
    resume: async () => { throw new Error('must not resume the older scoped Agent') }, list: () => [],
  }
  const adapter = new DshAdapter({ on() {}, agents, sessionPersistence: {} },
    { agentSessionId: 'already-owned-context', fixtureCodeTools: async () => { throw new Error('must not install reused tools') } })
  await assert.rejects(() => adapter.attach(assignment, {}), /new isolated Agent|reuse\/resume/)
  const ephemeral = await mkdtemp(join(tmpdir(), 'loom-code-map-'))
  const saved = new DshAdapter({ on() {}, agents, sessionPersistence: {} }, { fixtureCodeTools: async () => {}, sessionMapPath: join(ephemeral, 'map.json') })
  const mapping = await saved.loadSessionMap()
  mapping.set(assignment.id, 'old-session-for-completed-task')
  await assert.rejects(() => saved.attach(assignment, {}), /new isolated Agent|reuse\/resume/)
})

test('does not alter an already-correct source without committed changes', async () => {
  const root = await setup()
  await writeFile(join(root, 'src', 'calc.js'), expected)
  await run('/usr/bin/git', ['config', 'diff.external', '/bin/false'], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' } })
  const result = await codeEvidence({ id: 'a', ticket_id: 't', node_id: 'n', relative_path: 'src/calc.js', content: expected },
    root, {}, { code_tool_records: records(), session_ref: { session_id: 's' } })
  assert.equal(result.state, 'unknown')
  assert.equal(result.artifacts.length, 0)
  assert.equal((await readFile(join(root, 'src', 'calc.js'))).toString(), expected)
})
