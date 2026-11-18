#!/usr/bin/env node
// Independent pure fixture-tool unit driver (fake registry; NOT a DSH Agent/Host).
// Real files, a real local Git repository and actual `node --test` child processes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CODE_FIXTURE_SOURCE, CODE_FIXTURE_TEST, registerScopedCodeTools } from '../harness/fixtures/stub-provider/code-tools.js'

const checks = []
const roots = []
const processes = new Set()
const expected = CODE_FIXTURE_SOURCE.replace('return a - b;', 'return a + b;')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function makeRepository({ testSource = CODE_FIXTURE_TEST } = {}) {
  await realpath('/tmp')
  const requested = `/tmp/loom-dsh-${randomUUID()}`
  await mkdir(join(requested, 'src'), { recursive: true, mode: 0o700 })
  // macOS canonicalizes /tmp to /private/tmp; the adapter must grant this exact canonical path.
  const root = await realpath(requested)
  await mkdir(join(root, 'test'), { mode: 0o700 })
  await writeFile(join(root, 'src', 'calc.js'), CODE_FIXTURE_SOURCE, { mode: 0o600, flag: 'wx' })
  await writeFile(join(root, 'test', 'calc.test.js'), testSource, { mode: 0o600, flag: 'wx' })
  const childEnv = { PATH: '/usr/bin:/bin', TMPDIR: root }
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root, env: childEnv, shell: false, stdio: 'pipe', encoding: 'utf8', timeout: 10_000 })
  git('init', '--quiet', '.')
  git('add', '--', 'src/calc.js', 'test/calc.test.js')
  git('-c', 'user.name=Loom Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Owned clean test fixture')
  assert.equal(await git('status', '--porcelain', '--untracked-files=no'), '')
  roots.push(root)
  return { root, git }
}

async function install(root, changes = {}) {
  const definitions = new Map()
  const dispose = await registerScopedCodeTools({ tools: { register(definition) {
    assert.equal(definitions.has(definition.name), false)
    definitions.set(definition.name, definition)
    return () => definitions.delete(definition.name)
  } } }, { assignment: { relative_path: 'src/calc.js', test_relative_path: 'test/calc.test.js', content: expected, ...changes }, project_root: root })
  const call = (name, args, signal = new AbortController().signal) => {
    assert.ok(definitions.has(name), `Registered public tool ${name}`)
    const promise = Promise.resolve(definitions.get(name).execute(args, { signal }))
    processes.add(promise)
    return promise.finally(() => processes.delete(promise))
  }
  return { definitions, dispose, call }
}

async function pass(name, action) {
  await action()
  checks.push({ name, status: 'PASS' })
  console.log(`PASS ${name}`)
}

try {
  // Confirm that the fixture is genuinely able to fail before invoking the edit tool.
  const { root, git } = await makeRepository()
  const expectedBytes = Buffer.from(expected)
  const original = Buffer.from(CODE_FIXTURE_SOURCE)
  const tools = await install(root)
  await pass('verification without an edit result is refused without a file change', async () => {
    await assert.rejects(() => tools.call('loom_fixture_verify', { path: 'src/calc.js' }), /preceding edit/)
    assert.equal((await readFile(join(root, 'src', 'calc.js'))).equals(original), true)
  })
  for (const args of [
    null,
    { path: 'test/calc.test.js' },
    { path: 'src/calc.js', content: 'arbitrary' },
    { path: '../src/calc.js' },
  ]) {
    await pass(`invalid edit input ${JSON.stringify(args)} cannot alter source`, async () => {
      await assert.rejects(() => tools.call('loom_fixture_code_edit', args))
      assert.equal((await readFile(join(root, 'src', 'calc.js'))).equals(original), true)
    })
  }
  let edit
  let verification
  let failedVerification
  await pass('clean baseline fails, atomic edit writes exact bytes, fixed real tests pass', async () => {
    edit = await tools.call('loom_fixture_code_edit', {})
    assert.equal(edit.schema, 'loom.fixture-code-edit.v1')
    assert.equal(edit.created, true)
    assert.equal(edit.next_tool, 'loom_fixture_verify')
    assert.equal(edit.baseline_git_clean, true)
    assert.ok(edit.baseline_test_exit_code > 0)
    assert.equal(edit.previous_sha256, sha256(original))
    assert.equal(edit.sha256, sha256(expectedBytes))
    assert.equal((await readFile(join(root, 'src', 'calc.js'))).equals(expectedBytes), true)
    assert.equal(git('status', '--porcelain', '--untracked-files=no').trimEnd(), ' M src/calc.js')
    assert.equal((await readFile(join(root, 'test', 'calc.test.js'))).equals(Buffer.from(CODE_FIXTURE_TEST)), true)
    await assert.rejects(() => tools.call('loom_fixture_verify', { path: 'src/calc.js', sha256: '0'.repeat(64) }), /digest/)
    verification = await tools.call('loom_fixture_verify', { path: 'src/calc.js', sha256: edit.sha256 })
    assert.equal(verification.schema, 'loom.fixture-code-verification.v1')
    assert.deepEqual(verification.command, { file: 'node', args: ['--test', 'test/calc.test.js'] })
    assert.equal(verification.execution_status, 'completed')
    assert.equal(verification.passed, true)
    assert.equal(verification.exit_code, 0)
    assert.equal(verification.previous_test_exit_code, edit.baseline_test_exit_code)
    assert.equal(verification.sha256, edit.sha256)
    assert.equal(Buffer.byteLength(verification.stdout) <= 4096, true)
    assert.equal(Buffer.byteLength(verification.stderr) <= 4096, true)
    assert.match(verification.stdout, /pass 1/)
  })
  await pass('repeat edit and verification are single-use and leave evidence intact', async () => {
    await assert.rejects(() => tools.call('loom_fixture_code_edit', {}), /single-use/)
    await assert.rejects(() => tools.call('loom_fixture_verify', {}), /single-use/)
    assert.equal((await readFile(join(root, 'src', 'calc.js'))).equals(expectedBytes), true)
  })
  await pass('extra tracked change blocks verification', async () => {
    const extra = await makeRepository()
    const scoped = await install(extra.root)
    await scoped.call('loom_fixture_code_edit', {})
    await writeFile(join(extra.root, 'src', 'other.js'), 'tracked dirty\n', { mode: 0o600 })
    extra.git('add', '--', 'src/other.js')
    await assert.rejects(() => scoped.call('loom_fixture_verify', {}), /single expected source modification/)
    assert.equal((await readFile(join(extra.root, 'test', 'calc.test.js'))).equals(Buffer.from(CODE_FIXTURE_TEST)), true)
    await scoped.dispose()
  })
  await tools.dispose()
  assert.equal(tools.definitions.size, 0)

  await pass('dirty initial Git worktree refuses edit', async () => {
    const repo = await makeRepository()
    await writeFile(join(repo.root, 'src', 'calc.js'), CODE_FIXTURE_SOURCE + '// local change\n')
    const scoped = await install(repo.root)
    await assert.rejects(() => scoped.call('loom_fixture_code_edit', {}), /clean/)
    assert.equal((await readFile(join(repo.root, 'src', 'calc.js'))).toString(), CODE_FIXTURE_SOURCE + '// local change\n')
    await scoped.dispose()
  })
  await pass('nonzero baseline is mandatory; passing test cannot gain edit permission', async () => {
    const repo = await makeRepository()
    const passing = "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { add } from '../src/calc.js'\n\ntest('baseline', () => { assert.equal(add(2, 3), -1) })\n"
    await writeFile(join(repo.root, 'test', 'calc.test.js'), passing)
    repo.git('add', '--', 'test/calc.test.js')
    repo.git('-c', 'user.name=Loom Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Passing baseline')
    const scoped = await install(repo.root)
    await assert.rejects(() => scoped.call('loom_fixture_code_edit', {}), /nonzero baseline/)
    assert.equal((await readFile(join(repo.root, 'src', 'calc.js'))).equals(original), true)
    await scoped.dispose()
  })
  await pass('symlink target cannot redirect the write', async () => {
    const repo = await makeRepository()
    const outside = join(repo.root, 'outside.txt')
    await writeFile(outside, CODE_FIXTURE_SOURCE, { mode: 0o600 })
    const source = join(repo.root, 'src', 'calc.js')
    const renamed = join(repo.root, 'src', 'calc.original')
    await import('node:fs/promises').then(({ rename, rm }) => rename(source, renamed).then(() => rm(renamed)))
    await symlink(outside, source)
    const scoped = await install(repo.root)
    await assert.rejects(() => scoped.call('loom_fixture_code_edit', {}), /regular file/)
    assert.equal((await readFile(outside)).equals(original), true)
    await scoped.dispose()
  })
  await pass('hardlinked source is refused without modifying its peer', async () => {
    const repo = await makeRepository()
    const peer = join(repo.root, 'peer.txt')
    await link(join(repo.root, 'src', 'calc.js'), peer)
    const scoped = await install(repo.root)
    await assert.rejects(() => scoped.call('loom_fixture_code_edit', {}), /regular file/)
    assert.equal((await readFile(join(repo.root, 'src', 'calc.js'))).equals(original), true)
    assert.equal((await readFile(peer)).equals(original), true)
    await scoped.dispose()
  })
  await pass('oversized test file is refused without source mutation', async () => {
    const repo = await makeRepository()
    await writeFile(join(repo.root, 'test', 'calc.test.js'), CODE_FIXTURE_TEST + ' '.repeat(33 * 1024))
    const scoped = await install(repo.root)
    await assert.rejects(() => scoped.call('loom_fixture_code_edit', {}), /regular file/)
    assert.equal((await readFile(join(repo.root, 'src', 'calc.js'))).equals(original), true)
    await scoped.dispose()
  })
  await pass('failing verification returns exit 1 and preserves the actual altered source', async () => {
    const repo = await makeRepository({ testSource: CODE_FIXTURE_TEST.replace('assert.equal(add(2, 3), 5)', 'assert.equal(add(2, 3), 3)') })
    const scoped = await install(repo.root)
    const changed = await scoped.call('loom_fixture_code_edit', {})
    const result = await scoped.call('loom_fixture_verify', {})
    assert.equal(result.schema, 'loom.fixture-code-verification.v1')
    assert.equal(result.passed, false)
    assert.equal(result.exit_code, 1)
    assert.equal(result.execution_status, 'completed')
    assert.equal(result.sha256, changed.sha256)
    failedVerification = result
    assert.equal((await readFile(join(repo.root, 'src', 'calc.js'))).equals(expectedBytes), true)
    assert.equal(repo.git('status', '--porcelain', '--untracked-files=no').trimEnd(), ' M src/calc.js')
    await scoped.dispose()
  })
  for (const [name, root, assignment] of [
    ['missing project root', '/tmp/loom-dsh-does-not-exist', { relative_path: 'src/calc.js', content: expected }],
    ['unrelated project root', '/tmp', { relative_path: 'src/calc.js', content: expected }],
    ['wrong ticket path', '/tmp/does-not-matter', { relative_path: 'test/calc.test.js', content: expected }],
    ['arbitrary replacement content', '/tmp/does-not-matter', { relative_path: 'src/calc.js', content: 'return anything' }],
  ]) {
    await pass(`scope rejected: ${name}`, async () => {
      await assert.rejects(() => registerScopedCodeTools({ tools: { register() { throw new Error('must not register') } } }, { project_root: root, assignment }))
    })
  }
  assert.equal(processes.size, 0)
  const report = {
    schema: 'loom.fixture-code-tools.unit.v1', overall: 'PASS', checks_count: checks.length, checks,
    actual_git: '/usr/bin/git execFile shell:false', actual_tests: 'node --test test/calc.test.js',
    baseline_test_observed_nonzero: true, edit_result: edit, verification_result: verification,
    failing_verification_preserves_source: true,
    failing_verification_result: failedVerification && { schema: failedVerification.schema, command: failedVerification.command,
      path: failedVerification.path, sha256: failedVerification.sha256, exit_code: failedVerification.exit_code,
      passed: failedVerification.passed, previous_test_exit_code: failedVerification.previous_test_exit_code,
      execution_status: failedVerification.execution_status, stdout_bytes: Buffer.byteLength(failedVerification.stdout),
      stderr_bytes: Buffer.byteLength(failedVerification.stderr) },
    fake_tool_registry_unit_worker_only: true,
    real_dsh_agent_host: 'NOT RUN — main adapter lifecycle integration is separate',
    live_llm_external_http_credentials: 'NOT RUN', profile_touched: false,
    test_roots: roots, cleanup: 'Retained owned /tmp fixture roots for review; no reset/stash/checkout/commit by tools',
  }
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(JSON.stringify({ schema: 'loom.fixture-code-tools.unit.v1', overall: 'FAIL', error: error.message.slice(0, 1024), checks, real_dsh_agent_host: 'NOT RUN', test_roots: roots }, null, 2))
  process.exitCode = 1
}
