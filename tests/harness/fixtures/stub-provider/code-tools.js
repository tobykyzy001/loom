// Test-only fixture tools for one canonical, clean Git repository supplied by the adapter.
// Scope is exactly { assignment: { relative_path?, test_relative_path?, content }, project_root }.
// On macOS project_root is the realpath /private/tmp/loom-dsh-* selected path (not the /tmp alias).
// Fixture input source is CODE_FIXTURE_SOURCE; CODE_FIXTURE_TEST must initially fail.
// Ticket bytes live in this closure, not tool input. Verification uses only actual bytes/status.
// No new repository files, test content, shell, remote access, grant, reset, stash or rollback.
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const CODE_SOURCE_PATH = 'src/calc.js'
export const CODE_TEST_PATH = 'test/calc.test.js'
export const CODE_FIXTURE_SOURCE = "export function add(a, b) {\n  return a - b;\n}\n"
export const CODE_FIXTURE_TEST = "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { add } from '../src/calc.js'\n\ntest('add combines two numbers', () => { assert.equal(add(2, 3), 5) })\n"

const MAX_FILE_BYTES = 32 * 1024
const OUTPUT_BYTES = 4096
const TEST_TIMEOUT_MS = 10_000
const OLD_FRAGMENT = 'return a - b;'
const NEW_FRAGMENT = 'return a + b;'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const exactKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.includes(key))

function childEnvironment(root) {
  // No HOME, inherited profile, credentials, proxy, source, package or model configuration.
  // No inherited App/profile is entered for the fixed test command.
  return { PATH: '/usr/bin:/bin', TMPDIR: root, ELECTRON_RUN_AS_NODE: '1' }
}

function runOwnedProcess(file, args, cwd, timeoutMs) {
  return new Promise((ok) => {
    const stdout = []
    const stderr = []
    let stdoutLength = 0
    let stderrLength = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let spawnError = null
    const capture = (chunks, current, chunk, stream) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = Math.max(0, OUTPUT_BYTES - current)
      if (remaining) chunks.push(bytes.subarray(0, remaining))
      if (bytes.length > remaining) {
        if (stream === 'stdout') stdoutTruncated = true
        else stderrTruncated = true
      }
      return current + Math.min(remaining, bytes.length)
    }
    let child
    const timer = setTimeout(() => {
      timedOut = true
      child?.kill('SIGKILL')
    }, timeoutMs)
    try {
      child = execFile(file, args, { cwd, env: childEnvironment(cwd), shell: false, timeout: timeoutMs + 100,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, () => {})
      child.stdout.on('data', (chunk) => { stdoutLength = capture(stdout, stdoutLength, chunk, 'stdout') })
      child.stderr.on('data', (chunk) => { stderrLength = capture(stderr, stderrLength, chunk, 'stderr') })
      child.once('error', (error) => { spawnError = error.message.slice(0, 256) })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        ok({ status: code, signal, timed_out: timedOut || child.killed || signal === 'SIGTERM', spawn_error: spawnError,
          stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
          stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated })
      })
    } catch (error) {
      clearTimeout(timer)
      ok({ status: null, signal: null, timed_out: false, spawn_error: error.message.slice(0, 256), stdout: '', stderr: '',
        stdout_truncated: false, stderr_truncated: false })
    }
  })
}

async function checkedFile(root, relativePath) {
  const file = resolve(root, relativePath)
  const parent = dirname(file)
  if (parent !== resolve(root, dirname(relativePath)) || !file.startsWith(root + sep)) throw new Error('Fixture path escapes the selected root')
  const [rootReal, parentReal, rootStat, parentStat] = await Promise.all([realpath(root), realpath(parent), lstat(root), lstat(parent)])
  if (rootReal !== root || parentReal !== parent || !rootStat.isDirectory() || !parentStat.isDirectory()
    || rootStat.isSymbolicLink() || parentStat.isSymbolicLink()) throw new Error('Fixture parent must be a normal directory in the exact canonical root')
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > MAX_FILE_BYTES) throw new Error('Fixture file must be a regular file with one link and at most 32 KiB')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.nlink > 1 || current.size > MAX_FILE_BYTES || current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error('Fixture file changed identity while being opened')
    }
    const bytes = await handle.readFile()
    if (bytes.length > MAX_FILE_BYTES || bytes.length !== current.size) throw new Error('Fixture file exceeded or changed its size limit')
    return bytes
  } finally { await handle.close() }
}

async function gitStatus(root) {
  const result = await runOwnedProcess('/usr/bin/git', ['status', '--porcelain', '--untracked-files=no'], root, TEST_TIMEOUT_MS)
  if (result.status !== 0 || result.timed_out || result.spawn_error || result.signal) throw new Error('Owned Git status could not be established')
  return result.stdout.trimEnd()
}

async function runTest(root) {
  const result = await runOwnedProcess(process.execPath, ['--test', CODE_TEST_PATH], root, TEST_TIMEOUT_MS)
  return {
    status: result.status,
    execution_status: result.timed_out ? 'timeout' : result.spawn_error || result.status === null ? 'unknown' : 'completed',
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
  }
}

function checkEditArguments(args, expectedPath) {
  if (!exactKeys(args, ['path'])) throw new Error('Code edit accepts only the exact expected fixture path; try {}')
  if (args.path !== undefined && args.path !== expectedPath) throw new Error('Code edit path differs from the persisted ticket')
}

function checkVerifyArguments(args, expectedPath) {
  if (!exactKeys(args, ['path', 'sha256'])) throw new Error('Code verification accepts only the prior edit result')
  if (args.path !== undefined && args.path !== expectedPath) throw new Error('Code verification path differs from the persisted ticket')
}

async function canonicalOwnedRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot) throw new Error('Fixture root must be an absolute normalized selected path')
  const rootInfo = await lstat(projectRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.nlink < 1) throw new Error('Fixture root must be an ordinary existing directory')
  const root = await realpath(projectRoot)
  // lstat has already rejected an alias/symlink root before realpath validation.
  const components = root.split(sep)
  const marker = components.findLastIndex(part => part.startsWith('loom-dsh-'))
  const canonicalFixtureOrDirectChild = marker >= 0 && marker >= components.length - 2
  // `os.tmpdir()` differs by host/installer: never require a `/tmp` alias.
  // Current Grant/ProjectBinding still selects the actual root. The marker and
  // direct-child rule only identify this isolated fixture, not a new grant path.
  if (root !== projectRoot || root === '/' || !canonicalFixtureOrDirectChild) {
    throw new Error(`Fixture requires its marked owned root or only one explicit child project under that root: ${root}`)
  }
  const top = await runOwnedProcess('/usr/bin/git', ['rev-parse', '--show-toplevel'], root, TEST_TIMEOUT_MS)
  if (top.status !== 0 || top.spawn_error || top.timed_out || top.stdout.trimEnd() !== root) throw new Error('Fixture root is not the canonical top of a real Git repository')
  return root
}

/** The caller supplies the frozen persisted Ticket and its independently authorized root. */
export async function registerScopedCodeTools(ctx, scope) {
  // Public boundary: (real scoped Cordis context, {assignment, project_root}).
  if (!ctx || typeof ctx.tools?.register !== 'function') throw new Error('The scoped Agent tools registry is required')
  const { assignment, project_root: projectRoot } = scope
  if (!assignment || (assignment.relative_path ?? CODE_SOURCE_PATH) !== CODE_SOURCE_PATH || typeof assignment.content !== 'string') {
    throw new Error('Code fixture requires the exact src/calc.js Ticket with persisted replacement content')
  }
  if (assignment.test_relative_path !== undefined && assignment.test_relative_path !== CODE_TEST_PATH) throw new Error('Code fixture only supports test/calc.test.js')
  const source = Buffer.from(assignment.content, 'utf8')
  if (source.length > MAX_FILE_BYTES || source.toString('utf8') !== assignment.content) throw new Error('Ticket content must be bounded canonical UTF-8')
  const expected = CODE_FIXTURE_SOURCE.replace(OLD_FRAGMENT, NEW_FRAGMENT)
  if (source.toString('utf8') !== expected || CODE_FIXTURE_SOURCE.split(OLD_FRAGMENT).length !== 2 || expected.split(NEW_FRAGMENT).length !== 2) {
    throw new Error('Ticket content is not the one authorized replacement')
  }
  const root = await canonicalOwnedRoot(projectRoot)
  const state = { edit: null, verification: null }
  // A cancellation pause belongs at the start of the actual SDK tool body,
  // not in an asynchronous waterfall whose lifecycle differs from tool drains.
  const edit = ctx.tools.register({
    name: 'loom_fixture_code_edit',
    description: 'Perform only this ticket’s fixed src/calc.js correction after a clean Git baseline and failing real node test. No arbitrary path, content or command.',
    parameters: { type: 'object', properties: { path: { type: 'string', enum: [CODE_SOURCE_PATH] } }, additionalProperties: false },
    output: { schema: { type: 'object', required: ['schema', 'path', 'previous_sha256', 'sha256', 'size_bytes'],
      properties: { schema: { type: 'string' }, path: { type: 'string' }, previous_sha256: { type: 'string' }, sha256: { type: 'string' }, size_bytes: { type: 'integer' },
        created: { type: 'boolean' }, next_tool: { type: 'string' }, baseline_test_exit_code: { type: 'integer' }, baseline_git_clean: { type: 'boolean' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    // Child deadlines are enforced inside the tool; no cooperative-MS declaration.
    async execute(args, invocation) {
      if (invocation.signal?.aborted) throw Object.assign(new Error('Fixture code edit cancelled'), { name: 'AbortError' })
      checkEditArguments(args, CODE_SOURCE_PATH)
      if (state.edit) throw new Error('Code edit is single-use; no repeated write or replacement is permitted')
      const baselineSource = await checkedFile(root, CODE_SOURCE_PATH)
      await checkedFile(root, CODE_TEST_PATH)
      const baselineSha = sha256(baselineSource)
      // Actual working-tree and test facts are captured before any mutation;
      // neither is supplied by the model or inferred from its response.
      const baselineStatus = await gitStatus(root)
      const baseline = await runTest(root)
      if (baselineStatus !== '') throw new Error('Code edit requires an initially clean tracked Git worktree')
      if (baseline.execution_status !== 'completed' || !Number.isInteger(baseline.status) || baseline.status === 0) throw new Error('Code edit requires a completed nonzero baseline test, not pass/unknown evidence')
      if (!baselineSource.equals(Buffer.from(CODE_FIXTURE_SOURCE))) throw new Error('Source does not match the unique expected baseline')
      const occurrenceCount = baselineSource.toString('utf8').split(OLD_FRAGMENT).length - 1
      if (occurrenceCount !== 1) throw new Error('Source baseline must have exactly one expected old fragment')
      const replacement = baselineSource.toString('utf8').replace(OLD_FRAGMENT, NEW_FRAGMENT)
      if (replacement !== assignment.content || sha256(Buffer.from(replacement)) !== sha256(source)) throw new Error('Persisted ticket no longer corresponds to the unique baseline replacement')
      const beforeWrite = await checkedFile(root, CODE_SOURCE_PATH)
      if (!beforeWrite.equals(baselineSource)) throw new Error('Source changed between baseline checks and atomic write')
      const temporary = join(root, 'src', `.loom-code-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, source, { mode: 0o600, flag: 'wx' })
        if ((await gitStatus(root)) !== '') throw new Error('Concurrent Git change prevented the fixture edit')
        await rename(temporary, resolve(root, CODE_SOURCE_PATH))
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
      const current = await checkedFile(root, CODE_SOURCE_PATH)
      if (!current.equals(source)) throw new Error('Actual post-rename bytes differ from the persisted Ticket')
      const result = { schema: 'loom.fixture-code-edit.v1', path: CODE_SOURCE_PATH, previous_sha256: baselineSha, sha256: sha256(current), size_bytes: current.length,
        created: true, next_tool: 'loom_fixture_verify', baseline_test_exit_code: baseline.status, baseline_git_clean: true }
      state.edit = { result, bytes: current }
      return result
    },
  })
  const verify = ctx.tools.register({
    name: 'loom_fixture_verify',
    description: 'Verify only the preceding code edit using its actual SHA, the one modified Git path, and the real fixed node --test process. A failing test remains a failing result.',
    parameters: { type: 'object', properties: { path: { type: 'string', enum: [CODE_SOURCE_PATH] }, sha256: { type: 'string', description: 'Optional repeat of the preceding successful edit SHA; checked by the tool.' } }, additionalProperties: false },
    output: { schema: { type: 'object', required: ['schema', 'command', 'path', 'sha256', 'exit_code', 'passed', 'stdout', 'stderr', 'previous_test_exit_code'],
      properties: { schema: { type: 'string' },
        command: { type: 'object', required: ['file', 'args'], properties: { file: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
        path: { type: 'string' }, sha256: { type: 'string' }, exit_code: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, passed: { type: 'boolean' }, stdout: { type: 'string' }, stderr: { type: 'string' },
        previous_test_exit_code: { type: 'integer' }, execution_status: { type: 'string' }, stdout_truncated: { type: 'boolean' }, stderr_truncated: { type: 'boolean' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    // The real test subprocess has its own <=10s hard deadline.
    async execute(args, invocation) {
      if (invocation.signal?.aborted) throw Object.assign(new Error('Fixture verification cancelled'), { name: 'AbortError' })
      checkVerifyArguments(args, CODE_SOURCE_PATH)
      if (!state.edit) throw new Error('Verification requires the successful preceding edit and its captured failing baseline')
      if (state.verification) throw new Error('Verification is single-use for the authoritative tool result')
      if (assignment.objective.includes('LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY')) {
        if (typeof scope.before_verify_pause !== 'function') throw new Error('The scoped cancel fixture requires an owner-specific bounded pause resolver')
        await scope.before_verify_pause(invocation.signal)
        if (invocation.signal?.aborted) {
          // Before fixed child process spawn: cancel means no test verification bytes.
          throw Object.assign(new Error('Fixture verification cancelled before its test subprocess'), { name: 'AbortError' })
        }
      }
      const current = await checkedFile(root, CODE_SOURCE_PATH)
      const digest = sha256(current)
      if (args.sha256 !== undefined && args.sha256 !== state.edit.result.sha256) throw new Error('Verification digest does not match the Ticket edit result')
      if (digest !== state.edit.result.sha256 || !current.equals(state.edit.bytes)) throw new Error('Current source is not the completed Ticket edit')
      await checkedFile(root, CODE_TEST_PATH)
      const changes = await gitStatus(root)
      if (changes !== ' M src/calc.js') throw new Error('Tracked worktree must contain exactly the single expected source modification')
      const test = await runTest(root)
      const result = { schema: 'loom.fixture-code-verification.v1', command: { file: 'node', args: ['--test', CODE_TEST_PATH] }, path: CODE_SOURCE_PATH, sha256: digest,
        exit_code: test.status, passed: test.execution_status === 'completed' && test.status === 0, stdout: test.stdout, stderr: test.stderr, previous_test_exit_code: state.edit.result.baseline_test_exit_code,
        execution_status: test.execution_status, stdout_truncated: test.stdout_truncated, stderr_truncated: test.stderr_truncated }
      state.verification = result
      return result
    },
  })
  return () => { edit(); verify() }
}
