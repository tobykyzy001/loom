#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, constants as fsConstants, mkdir, mkdtemp, readdir, readFile, lstat, stat, writeFile, symlink, link, access } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACK_SCHEMA = 'loom.bare-host-package.v1'
const LIMIT = 16 * 1024
const ISOLATED_MARKER = 'loom-bare-package-'
const checks = []
const owned = new Set()
let root, packageDir
const mode = (info) => info.mode & 0o777
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const approxPlatform = { platform: process.platform, arch: process.arch, native_version: 'NOT CLAIMED' }
function noTokens(value) {
  const text = String(value)
  return text.replaceAll(/Bearer\s+\S+/g, 'Bearer [redacted]')
}
async function logCheck(name, evidence) { const value = typeof evidence === 'function' ? await evidence() : evidence; checks.push({ name, status: 'PASS', evidence: value }); console.log(`PASS bare-package: ${name}`); return value }
async function privateDir(path, permissions = 0o700) {
  assert.equal(path.startsWith(root + '/'), true)
  await mkdir(path, { recursive: true, mode: permissions })
  await chmod(path, permissions)
  assert.equal((await lstat(path)).isSymbolicLink(), false)
  assert.equal(mode(await lstat(path)), permissions)
  return path
}
async function processRun(command, argv, { timeoutMs = 8000, cwd = root, env = {} } = {}) {
  assert.equal(typeof command, 'string')
  assert.equal(command.length > 0 && !command.includes('/../'), true)
  const child = spawn(command, argv, { shell: false, cwd, env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...env,
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  owned.add(child)
  const output = []
  let bytes = 0
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes <= LIMIT) output.push(noTokens(chunk.toString()))
  })
  const exit = new Promise((ok, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => ok({ code, signal, output: output.join('') }))
  })
  let timer
  try {
    return await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => {
      child.kill('SIGKILL'); reject(new Error(`bounded child timeout: ${command}`))
    }, timeoutMs) })])
  } finally { clearTimeout(timer); owned.delete(child) }
}
async function fileType(file) {
  try {
    const result = await processRun('file', ['-b', '--', file], { timeoutMs: 5000 })
    assert.equal(result.code, 0, result.output)
    return { tool: 'file', output: result.output.slice(0, 1024).trim() }
  } catch (error) {
    if (error.code === 'ENOENT') return { tool: 'unavailable', output: 'file command unavailable on this machine' }
    throw error
  }
}
async function nativeTypeInspection(file) {
  if (process.platform !== 'darwin') return { otool: 'NOT RUN: this fixture currently demonstrates Darwin only; other linker inspections are unavailable' }
  try {
    const result = await processRun('otool', ['-L', file], { timeoutMs: 5000 })
    assert.equal(result.code, 0, result.output)
    const toolText = result.output.replaceAll(file, '<checked-binary>')
    assert.ok(!/(?:\/\.dsh\/|\/(?:profiles|credentials)\/|application support|\bAPPDATA\b|\.ssh\/)/i.test(toolText), 'Linker inspection must not read profile/credential paths')
    return { otool: 'actual current-binary dynamic linker dependencies', output: toolText.slice(0, 4096) }
  } catch (error) {
    if (error.code === 'ENOENT') return { otool: 'NOT RUN: otool unavailable; cannot claim static or portable binary' }
    throw error
  }
}
async function denyPackageFile(file, expectedSha, description) {
  await assert.rejects(
    () => validateNativeFile(file, { expectedSha, requireExecute: true, noHardlink: true }),
    (error) => error.name === 'AssertionError',
    `A package integrity failure must refuse ${description} before spawning`)
  logCheck(`package rejects ${description} before execution`, { expected_sha256_unchanged: expectedSha !== undefined })
}
async function validateNativeFile(file, { expectedSha, requireExecute = true, noHardlink = true } = {}) {
  const info = await lstat(file)
  assert.equal(info.isSymbolicLink(), false, 'Binary symlink aliases are not trusted')
  assert.equal(info.isFile(), true, 'The package must contain an ordinary executable file')
  assert.equal(info.size > 0, true, 'Truncated/empty executables are not allowable artifacts')
  if (noHardlink) assert.equal(info.nlink, 1, 'Another owner may mutate a hard-linked binary')
  if (expectedSha !== undefined) assert.equal(sha256(await readFile(file)), expectedSha, 'Binary SHA-256 is stale, truncated or incorrect')
  if (requireExecute && process.platform !== 'win32') assert.ok(mode(info) & 0o111, 'Executable permission bit required on this filesystem')
  const [inspected, native] = await Promise.all([fileType(file), nativeTypeInspection(file)])
  return { byte_count: info.size, mode: mode(info), ...inspected, ...native, sha256: sha256(await readFile(file)) }
}
async function copyImmutable(destination, original, knownSha) {
  const source = await lstat(original)
  assert.equal(source.isSymbolicLink(), false)
  assert.equal(source.isFile(), true)
  assert.equal(source.nlink, 1)
  assert.equal(sha256(await readFile(original)), knownSha)
  await copyFile(original, destination, fsConstants.COPYFILE_EXCL)
  const destinationBeforeAppend = await lstat(destination)
  assert.equal(destinationBeforeAppend.isSymbolicLink(), false)
  assert.equal(destinationBeforeAppend.nlink, 1)
  return validateNativeFile(destination, { expectedSha: knownSha })
}
async function listenPolicyFixture() {
  const records = []
  const server = createHttpServer(async (request, response) => {
    let size = 0
    try {
      for await (const chunk of request) {
        size += chunk.length
        if (size > LIMIT) { response.writeHead(413); response.end(); request.destroy(); return }
      }
      const path = request.url
      records.push({ method: request.method, path })
      const payload = path.endsWith('/challenge') ? {
        challenge_id: 'fixture-challenge', nonce: 'f'.repeat(64), expires_at: new Date(Date.now() + 30000).toISOString(),
      } : { error: { code: 'enrollment_denied', message: 'Synthetic invalid test enrollment' } }
      response.writeHead(path.endsWith('/challenge') ? 200 : 401, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end(JSON.stringify({ error: { code: 'bounded_fixture_error', message: error.message } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  owned.add({ kill: () => server.close() })
  return { endpoint: `http://127.0.0.1:${port}`, records,
    async stop() { await new Promise((ok) => server.close(ok)); owned.delete(server) } }
}

// If the compiler really cannot launch, the outcome is NOT RUN not a synthetic binary PASS.
try {
  const build = await processRun('cargo', ['build', '--locked', '--offline', '-p', 'loom-node'], { cwd: repository, timeoutMs: 120000 })
  assert.equal(build.code, 0, build.output.slice(0, 6000))
  logCheck('cargo build --locked -p loom-node completed', { exit_code: 0 })
  root = await mkdtemp(join(tmpdir(), ISOLATED_MARKER))
  packageDir = await privateDir(join(root, 'package'), 0o700)
  const original = join(repository, 'target/debug/loom-node')
  const baseInfo = await validateNativeFile(original, { requireExecute: true, noHardlink: false })
  const binary = join(packageDir, 'loom-node')
  await copyImmutable(binary, original, baseInfo.sha256)
  if (process.platform !== 'win32') await chmod(binary, 0o755)
  const copiedInfo = await validateNativeFile(binary, { expectedSha: baseInfo.sha256, noHardlink: true })
  assert.equal(copiedInfo.sha256, baseInfo.sha256)
  assert.equal(copiedInfo.byte_count, baseInfo.byte_count)
  const help = await processRun(binary, ['--help'], { timeoutMs: 5000 })
  const version = await processRun(binary, ['--version'], { timeoutMs: 5000 })
  assert.equal(help.code, 0, help.output); assert.equal(version.code, 0, version.output)
  assert.strictEqual(version.output.trim(), 'loom-node 0.1.0')
  assert.ok(!/[^\x00-\x7f]/.test(help.output), 'help must be bounded ASCII')
  assert.match(help.output, /Loom bare deterministic Local Node/)
  assert.match(help.output, /Usage: loom-node <COMMAND>/)
  assert.ok(help.output.length < LIMIT && version.output.length <= 64)
  logCheck('not a symlink: valid immutable bare native executable executes current architecture help/version', {
    ...approxPlatform, ...copiedInfo, exit_codes: { help: help.code, version: version.code }, stdout_bytes: { help: Buffer.byteLength(help.output), version: Buffer.byteLength(version.output) },
  })
  await logCheck('help/version create no Identity, enrollment, Grant, Coordinator Agent, project or Session', async () => {
    let registrations = 0
    const capture = createHttpServer((req, res) => { registrations += 1; res.writeHead(500); res.end() })
    await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve))
    try {
      const before = (await readdir(root)).sort()
      await assert.rejects(() => stat(join(root, 'identity.json')), (error) => error.code === 'ENOENT')
      assert.equal((await processRun(binary, ['--help'])).code, 0)
      assert.equal((await processRun(binary, ['--version'])).code, 0)
      assert.equal(registrations, 0)
      assert.deepEqual(await readdir(root), before)
      return { register_http_calls: registrations, new_identity_files: 0, unauthorized_project_root_used: false }
    } finally { await new Promise((ok) => capture.close(ok)) }
  })
  const stateDir = await privateDir(join(root, 'state'), 0o700)
  const artifactsDir = await privateDir(join(root, 'artifacts'), 0o700)
  const inputDir = await privateDir(join(root, 'project-input'), 0o700)
  await writeFile(join(inputDir, 'input.txt'), 'Package fixture: not bundled into the binary.\n', { mode: 0o600, flag: 'wx' })
  assert.notEqual(stateDir, inputDir); assert.notEqual(artifactsDir, inputDir)
  assert.ok([stateDir, artifactsDir, packageDir].every((p) => !p.startsWith(inputDir + '/') && !inputDir.startsWith(p + '/')))
  logCheck('state/artifact/source project roots are separate private siblings', { directories: ['package', 'state', 'artifacts', 'project-input'], mode: 0o700, source_not_in_package: true })
  const startBase = ['start', '--coordinator', 'http://127.0.0.1:65535', '--artifact-dir', artifactsDir, '--once', '--enrollment-code', 'invalid-not-an-enrollment']
  const negativeRuns = [
    ['relative state', [...startBase, '--state-dir', 'relative', '--project-root', `fixture=${inputDir}`]],
    ['filesystem root state', [...startBase, '--state-dir', '/', '--project-root', `fixture=${inputDir}`]],
    ['user HOME state', [...startBase, '--state-dir', homedir(), '--project-root', `fixture=${inputDir}`]],
    ['missing separator', [...startBase, '--state-dir', join(root, 'failed-separator'), '--project-root', 'invalid']],
    ['relative project root', [...startBase, '--state-dir', join(root, 'failed-relative'), '--project-root', 'fixture=relative']],
    ['absolute filesystem root project', [...startBase, '--state-dir', join(root, 'failed-root'), '--project-root', 'fixture=/']],
    ['absolute HOME project', [...startBase, '--state-dir', join(root, 'failed-home'), '--project-root', `fixture=${homedir()}`]],
    ['malformed coordinator', ['start', '--coordinator', ' ', '--state-dir', join(root, 'failed-base'), '--artifact-dir', artifactsDir, '--project-root', 'invalid', '--once']],
    ['missing required project root', ['start', '--coordinator', 'http://127.0.0.1:65535', '--state-dir', join(root, 'failed-missing'), '--artifact-dir', artifactsDir, '--once']],
  ]
  for (const [name, args] of negativeRuns) {
    const result = await processRun(binary, args, { timeoutMs: 10000 })
    assert.notEqual(result.code, 0, `Unsafe ${name} exited zero: ${result.output}`)
  }
  logCheck('actual nonzero rejection for root/HOME/relative/missing state and malformed ProjectRoot/coordinator', {
    attempted_assignments: negativeRuns.length, accepted_invalid_invocations: 0, coordinated_bind_strings_sent_as_single_argv: true,
  })
  const missingProjectDir = join(root, 'missing-project')
  const missingBind = await processRun(binary, ['bind', '--state-dir', join(root, 'missing-bind-root-state'), '--project-root', `missing-project=${missingProjectDir}`], { timeoutMs: 10000 })
  assert.notEqual(missingBind.code, 0, missingBind.output)
  logCheck('actual bind fails for missing approved root rather than silently choosing cwd', { exit_code: missingBind.code })
  const policy = await listenPolicyFixture()
  let deniedEnrollment
  try {
    deniedEnrollment = await processRun(binary, ['start', '--coordinator', policy.endpoint,
      '--state-dir', stateDir, '--artifact-dir', artifactsDir,
      '--project-root', `fixture=${inputDir}`, '--once', '--enrollment-code', 'definitely-invalid-test-enrollment'], { timeoutMs: 20000 })
    assert.notEqual(deniedEnrollment.code, 0, deniedEnrollment.output)
    assert.equal(policy.records.filter((entry) => entry.path.endsWith('/register')).length, 1)
    assert.equal(policy.records.filter((entry) => entry.path.endsWith('/heartbeat') || entry.path.endsWith('/assignments/poll')).length, 0)
    assert.equal(policy.records.every((entry) => entry.method === 'POST' && (entry.path.endsWith('/challenge') || entry.path.endsWith('/register'))), true)
  } finally { await policy.stop() }
  logCheck('invalid enrollment 401 returns error without accepting registration, heartbeat or Grant', {
    nonzero_exit: deniedEnrollment.code, policy: 'enrollment_denied is not accepted as valid registration', registered: false,
  })
  const stale = join(root, 'stale-manifest.json')
  await writeFile(stale, JSON.stringify({ schema: PACK_SCHEMA, binary: { sha256: '0'.repeat(64), path: 'loom-node' } }), { mode: 0o600 })
  await assert.rejects(async () => {
    const manifest = await readFile(stale, 'utf8').then(JSON.parse)
    assert.equal(manifest.binary.sha256, baseInfo.sha256, 'Wrong package-hash entry must prevent use')
    await validateNativeFile(binary, { expectedSha: manifest.binary.sha256 })
  })
  const wrongAlias = join(root, 'wrong-alias.json')
  await writeFile(wrongAlias, JSON.stringify({ schema: PACK_SCHEMA, binary: { sha256: baseInfo.sha256, path: 'unknown-other-host' } }), { mode: 0o600 })
  await assert.rejects(async () => access(join(packageDir, JSON.parse(await readFile(wrongAlias, 'utf8')).binary.path)))
  const truncated = join(root, 'truncated')
  await writeFile(truncated, (await readFile(binary)).subarray(0, BASE_TRUNCATED(baseInfo.byte_count)), { mode: 0o700 })
  await denyPackageFile(truncated, baseInfo.sha256, 'truncated binary')
  const symlinkPath = join(root, 'binary-symlink')
  await symlink(original, symlinkPath)
  await denyPackageFile(symlinkPath, baseInfo.sha256, 'symlinked binary')
  // Exercise nlink=2 without also invalidating the genuine package binary.
  const linkSource = join(root, 'hardlink-source-copy')
  await copyFile(binary, linkSource, fsConstants.COPYFILE_EXCL)
  const hardlink = join(root, 'binary-hardlink')
  await link(linkSource, hardlink)
  await denyPackageFile(hardlink, baseInfo.sha256, 'hard-linked binary')
  const empty = join(root, 'empty-binary')
  await writeFile(empty, '', { mode: 0o700 })
  await denyPackageFile(empty, undefined, '0-byte binary')
  logCheck('stale manifest, wrong alias, truncated file, symlink, hardlink and empty binary are denied', { published_or_executed_bad_binaries: 0 })
  await assert.rejects(() => access(join(packageDir, 'other-os-binary')), (error) => error.code === 'ENOENT', 'No implicit alias to another platform or a runtime fallback')
  const manifest = {
    schema: PACK_SCHEMA, variant: 'native-single-file-current-host', package_version: '0.1.0',
    platform: process.platform, arch: process.arch, rust: (await processRun('rustc', ['--version'], { cwd: repository })).output.trim(),
    target_architecture_support: 'current_host_only', status: 'built_not_installed_not_activated',
    binary: { filename: 'loom-node', relative_path: './loom-node', byte_count: baseInfo.byte_count, sha256: baseInfo.sha256, mode: 0o755,
      file: copiedInfo.output, dynamic_linking: copiedInfo.otool || copiedInfo },
    cli: { help_exit: 0, version_exit: 0, version_output: version.output.trim(), informational_creates_identity: false },
    layout: { state_dir: '../state', artifact_dir: '../artifacts', project_input_dir: '../project-input' },
    policy: {
      no_root_or_home_state: true, explicit_absolute_authorized_project_root_each_cli: true,
      invalid_enrollment_attempt_is_rejected: true, registration_or_grant_only_after_verified_enrollment: true,
      no_dynamic_project_or_coordinator_discovery: true, no_source_project_files: true,
      bundled_credentials_or_profile: false, system_service_installation: false,
      no_SSH_deployment_account_activation_or_global_credential_state: true,
    },
    parent_bundle_hash: sha256(Buffer.from(`loom-node\n${baseInfo.sha256}\n${baseInfo.byte_count}\n`)),
    checks,
    not_run: ['Other OS/architectures', 'Second physical machine', 'Signed/notarized distribution', 'SSH/bootstrap/Ansible', 'system/Tauri daemon/service', 'DSH profile or Credential Store', 'actual package upgrade/uninstall', 'network/model provider or remote deployment'],
  }
  const manifestPath = join(packageDir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  const reportPath = join(root, 'package-smoke-result.json')
  await writeFile(reportPath, JSON.stringify({ overall: 'PASS', package_relative: './package/manifest.json', binary_sha256: baseInfo.sha256, checks, evidence_policy: 'Only synthetic fixture; relative paths are embedded inside the package except this report_path.' }, null, 2) + '\n', { mode: 0o600 })
  const manifestDirectoryEntries = await readdir(packageDir)
  assert.deepEqual(manifestDirectoryEntries.sort(), ['loom-node', 'manifest.json'])
  const publishedBinary = await validateNativeFile(binary, { expectedSha: manifest.binary.sha256, noHardlink: true })
  assert.equal(publishedBinary.sha256, baseInfo.sha256)
  console.log(JSON.stringify({ overall: 'PASS', schema: PACK_SCHEMA, package_relative: './package/manifest.json', report_path: reportPath,
    sha256: baseInfo.sha256, byte_count: baseInfo.byte_count, lifecycle: 'native_read_write_cancel_restart_validated_separately_with_scripts_bare_integration', checks: checks.length }, null, 2))
} catch (error) {
  const report = { schema: PACK_SCHEMA, overall: error.message.includes('rustc') || error.code === 'ENOENT' ? 'NOT RUN' : 'FAIL', error: error.stack,
    reason: error.code === 'ENOENT' ? 'Compiler/tool command unavailable' : 'Unsatisfied actual native package or boundary assertion' }
  console.error(JSON.stringify(report, null, 2))
  process.exitCode = 1
} finally {
  for (const item of owned) { try { item.kill('SIGTERM') } catch {} }
  owned.clear()
}
function BASE_TRUNCATED(size) { return Math.max(1, Math.floor(Math.max(1, size) / 2)) }
