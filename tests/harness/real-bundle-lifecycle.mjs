import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installation, fixtureRoot, isolatedEnv, installBundles, command, redact, PROFILE } from './environment.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { LoomHttpClient, LoomHttpError } from '../../packages/node-client/src/http.js'

const DISABLED_WORKER_PATCH = `- id: llm-deepseek
  disabled: true
- id: persistent-bash
  disabled: true
- id: persistent-pwsh
  disabled: true
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: !!js process.env.LOOM_FIXTURE_PROJECT_ROOT
    additionalWritableRoots: []
- id: sessions
  config:
    root: !!js process.env.LOOM_FIXTURE_ROOT + '/dsh-test-state/sessions'
    compression: none
- id: loom-fixture-stub-provider
  config:
    control_path: !!js process.env.LOOM_FIXTURE_CONTROL_PATH
    project_root: !!js process.env.LOOM_FIXTURE_PROJECT_ROOT
- id: loom-local-node
  config:
    enabled: true
    allow_workers: false
    executor: unsupported
    model_text_tasks: false
    allow_dsh_agent_creation: false
    bounded_fixture_effects: false
    delegation_tools: unsupported
    profile_id: loom-local-fixture
    base_url: http://127.0.0.1:9
    state_dir: !!js process.env.LOOM_FIXTURE_NODE_STATE_DIR
    artifact_dir: !!js process.env.LOOM_FIXTURE_ARTIFACT_DIR
    enrollment_code: ''
    agent_session_id: ''
    project_roots: {}
    max_active_workers: 1
    heartbeat_ms: 2000
    poll_seconds: 0
    request_timeout_ms: 15000
`

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/** One actual SDK process, with only its initialization and bounded shutdown; no Agent/prompt turns. */
async function launchNoWorkerSdk({ root, executable, cli }) {
  const disabledLog = 'Disabled for execution'
  const child = spawn(executable, [cli, '--profile', PROFILE, '--patch', join(root, 'patch', 'disabled-worker.yml')], {
    cwd: join(root, 'project'), env: isolatedEnv(root), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = [], errors = []
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => errors.push(String(chunk)))
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { cwd: join(root, 'project'), provider: 'loom-stub', model: 'loom-stub-v1', approvalRequests: true } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }) + '\n')
    child.stdin.end()
    const exit = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 20000))])
    assert.equal(exit.timeout, undefined, `SDK must exit after initialize/shutdown: ${errors.join('').slice(0, 5000)}`)
    assert.equal(exit.code, 0, `SDK startup failed: ${output.join('\n')}\n${errors.join('').slice(0, 5000)}`)
    const stdout = output.join('')
    const info = stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    assert.ok(info.some((frame) => frame.id === 1 && frame.result?.serverInfo?.name === 'deepseek-harness-sdk-runtime'), `Actual SDK initialize response required: ${stdout.slice(0, 7000)}\nSTDERR: ${errors.join('').slice(0, 7000)}`)
    assert.ok(info.some((frame) => frame.id === 2 && frame.result), 'Actual SDK shutdown must be acknowledged')
    assert.ok(stdout.includes(disabledLog) || errors.join('').includes(disabledLog), 'The disabled apply message must actually occur in SDK logs')
    return { initialized: true, shutdown: exit, plugin_apply_disabled_observed: true }
  } finally {
    if (!child.killed && child.exitCode === null) { child.kill('SIGTERM'); await exited.catch(() => {}) }
  }
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')) }
function profilePath(root) { return join(root, 'dsh-test-state', 'profiles', PROFILE) }
async function installed(root) { return readJson(join(profilePath(root), 'node_modules', '@loom/dsh-loom', 'package.json')) }
async function fileSha(root, name) { return sha256(await readFile(join(root, name))) }
async function nodes(root) { return readdir(join(root, 'node-state')) }
async function dshSessions(root) {
  const exist = await readdir(join(root, 'dsh-test-state', 'sessions')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))
  return exist.length
}
async function prepareRevokedGrant({ root, admin, projectRoot, projectId }) {
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const supportNode = await LocalNodeRunner.create({ baseUrl: admin.baseUrl.origin, stateDir: join(root, 'controller-support-state'), artifactDir: join(root, 'controller-artifacts'),
    enrollmentCode: enrollment.code, projectRoots: { [projectId]: projectRoot },
    registration: { workerId: 'controller-support-only', profileId: 'never-loomed-dsh-worker' } })
  await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: supportNode.nodeId, worker_id: 'controller-support-only', root_scope: projectRoot })
  const grant = (await admin.post('/api/v1/grants', { project_id: projectId, node_id: supportNode.nodeId, worker_id: 'controller-support-only', operations: ['read'] })).grant
  await admin.post(`/api/v1/grants/${grant.id}/revoke`, {})
  return { supportNode, grant, enrollmentCode: enrollment.code }
}
async function rejectTicket(admin, projectId, nodeId, grantId, programming = 'Read synthetic revoked-Grant evidence; never execute.') {
  return admin.post('/api/v1/tickets', { project_id: projectId, node_id: nodeId, grant_id: grantId, worker_id: 'controller-support-only', kind: 'read_summary', objective: programming, relative_path: 'docs/input.txt' })
}

export async function runRealBundleLifecycle({ output = '/tmp/loom-bundle-lifecycle-result.json', root: requestedRoot } = {}) {
  const root = await fixtureRoot(requestedRoot)
  const secretSet = []
  let server
  const report = { schema: 'loom.real_bundle_lifecycle.v1', overall: 'NOT RUN', installation_app: '@deepseek-ai/dsh@0.2.2-rc.3', profile: PROFILE,
    profile_root: { kind: 'owned_mkdtemp', no_desktop_profile: true, directory: root }, steps: [], no_live_llm: true }
  const step = (name, evidence = {}) => {
    report.steps.push({ name, status: 'PASS', evidence })
    console.log(`OBSERVED ${name}`)
  }
  console.log('OWNED_ROOT', root)
  const path = join(root, 'patch', 'disabled-worker.yml')
  let manifestBeforeInvalid
  try {
    const { cli, executable } = installation()
    const envBase = isolatedEnv(root)
    await writeFile(path, DISABLED_WORKER_PATCH, { mode: 0o600 })
    await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
    server = await startRustConcierge({ root: join(root, 'rust'), env: envBase })
    secretSet.push(server.clientToken)
    const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 30_000 })
    const projectRoot = join(root, 'project')
    const project = await admin.post('/api/v1/projects', { name: 'Revocation-retention fixture', root: projectRoot, mode: 'read_write' })
    const { supportNode, grant, enrollmentCode } = await prepareRevokedGrant({ root, admin, projectRoot, projectId: project.project.id })
    secretSet.push(enrollmentCode)
    const revokedBefore = (await admin.get('/api/v1/grants')).grants.find((entry) => entry.id === grant.id)
    assert.ok(revokedBefore?.revoked_at)
    const firstReject = await rejectTicket(admin, project.project.id, supportNode.nodeId, grant.id).then(() => { throw new Error('Revoked grant may not issue a Ticket') }, (error) => error)
    assert.ok(firstReject instanceof LoomHttpError && /grant_scope/.test(firstReject.message))
    step('revoked_grant_baseline_before_bundle_update', { grant_id: grant.id, original_digest: grant.digest, revoked_at: revokedBefore.revoked_at,
      source: 'actual Rust controller support Node, not DSH worker', rejection: 'grant_scope' })
    const sourceDir = join(root, 'fixture-packages', 'dsh-loom')
    // Official SDK Profile initialization and actual CLI package installation, never Desktop.
    const installedSummary = await installBundles({ root, env: envBase, cli, executable,
      bundles: [join(root, 'fixture-packages', 'stub-provider'), join(root, 'fixture-packages', 'dsh-loom')] })
    const baseManifest = await installed(root)
    assert.equal(baseManifest.version, '0.0.0')
    const baseCodeSha = await fileSha(sourceDir, 'index.js')
    step('package_installed', { package: '@loom/dsh-loom@0.0.0', source: 'official dsh plugin CLI with a local path source', selected: true, root_mode: installedSummary.root_mode })

    // No coordinator / Agent fetch exists for this disabled state; absence from help above mirrors the first SDK.
    const firstSdk = await launchNoWorkerSdk({ root, executable, cli })
    assert.equal(firstSdk.plugin_apply_disabled_observed, true)
    assert.deepEqual(await nodes(root), [])
    assert.equal(await dshSessions(root), 0)
    const compose = await command(executable, [cli, '--profile', PROFILE, '--dump-config'], { cwd: join(root, 'project'), env: envBase })
    assert.match(compose.stdout, /allow_workers: false/)
    assert.match(compose.stdout, /executor: unsupported/)
    assert.match(compose.stdout, /# == @loom\/dsh-loom/)
    assert.doesNotMatch(compose.stdout, /transport_token|private_key_pkcs8|LOOM_CLIENT_TOKEN=/)
    assert.equal(firstSdk.shutdown.code, 0)
    step('installed_disabled_workers', { sdk_profile_started: true, no_scheduler: true, no_agent_created: true, no_registration: true,
      public_config: { enabled: true, executor: 'unsupported', allow_workers: false }, controlled_connections: 0 })
    // SDK was initialized and shut down as a separate owned process; no model/prompt operation was requested.

    // State before a bad replacement remains untouched by the alternative roots and missing manifests.
    manifestBeforeInvalid = await readFile(join(profilePath(root), 'package.json'), 'utf8')
    const wrongRoot = await command(executable, [cli, '--profile', 'desktop', '--dump-config'], { cwd: root, env: envBase }).then(() => { throw new Error('Must never select current desktop profile') }, (error) => error)
    assert.match(wrongRoot.message, /managed exclusively by the Electron application/)
    step('wrong_profile_rejected', { runtime_cli_refusal: true, desktop_profile_unchanged: true })
    const missing = resolve(root, 'private', 'intentionally-not-a-bundle')
    await mkdir(missing, { recursive: true })
    await writeFile(join(missing, 'package.json'), JSON.stringify({ name: '@loom/bundle-missing-manifest', version: '0.0.1', private: true,
      type: 'module', exports: { '.': './index.js' }, dsh: { bundle: { patch: './cordis.missing.yml' } } }), { mode: 0o600 })
    const malformed = await command(executable, [cli, 'plugin', '--profile', PROFILE, 'add', `file:${missing}`, '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store')], { cwd: root, env: envBase }).then(() => { throw new Error('Missing bundle manifest must fail') }, (error) => error)
    assert.match(malformed.message, /(?:ENOENT|package|manifest|bundle)/i)
    assert.equal(await readFile(join(profilePath(root), 'package.json'), 'utf8'), manifestBeforeInvalid)
    assert.equal((await installed(root)).version, '0.0.0')
    step('invalid_bundle_rejected_without_profile_mutation', { status: 'rejected', prior_dependency_preserved: true })

    const upgraded = resolve(root, 'private', 'metadata-only-v001')
    await mkdir(upgraded, { recursive: true, mode: 0o700 })
    await cp(sourceDir, upgraded, { recursive: true })
    const updatedManifest = await readJson(join(upgraded, 'package.json'))
    updatedManifest.version = '0.0.1'
    await writeFile(join(upgraded, 'package.json'), JSON.stringify(updatedManifest, null, 2) + '\n', { mode: 0o600 })
    const locale = await readJson(join(upgraded, 'locale', 'en.json'))
    locale.meta.description += ' Bundle lifecycle fixture metadata 0.0.1; non-worker, no credentials and no runtime permission additions.'
    await writeFile(join(upgraded, 'locale', 'en.json'), JSON.stringify(locale, null, 2) + '\n', { mode: 0o600 })
    assert.equal(await fileSha(upgraded, 'index.js'), baseCodeSha)
    const remove = await command(executable, [cli, 'plugin', '--profile', PROFILE, 'remove', '@loom/dsh-loom', '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store')], { cwd: root, env: envBase })
    assert.equal(remove.code, 0)
    const update = await command(executable, [cli, 'plugin', '--profile', PROFILE, 'add', `file:${upgraded}`, '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store')], { cwd: root, env: envBase })
    assert.equal(update.code, 0)
    assert.equal((await installed(root)).version, '0.0.1')
    const selection = await command(executable, [cli, 'plugin', '--profile', PROFILE, 'why', '@loom/dsh-loom', '--offline'], { cwd: root, env: envBase })
    assert.equal(selection.code, 0)
    const updatedSdk = await launchNoWorkerSdk({ root, executable, cli })
    assert.equal(updatedSdk.shutdown.code, 0)
    assert.deepEqual(await nodes(root), [])
    assert.equal(await dshSessions(root), 0)
    const currentConfig = await command(executable, [cli, '--profile', PROFILE, '--dump-config'], { cwd: join(root, 'project'), env: envBase })
    assert.match(currentConfig.stdout, /allow_workers: false/)
    assert.match(currentConfig.stdout, /executor: unsupported/)
    assert.match(currentConfig.stdout, /# == @loom\/dsh-loom/)
    const installedSelection = await readJson(join(profilePath(root), 'package.json'))
    assert.ok(installedSelection.dependencies['@loom/dsh-loom'].includes(upgraded))
    assert.match(selection.stdout + selection.stderr, /(?:0\.0\.1|metadata-only-v001)/)
    assert.equal(await fileSha(upgraded, 'index.js'), baseCodeSha)
    step('updated_and_restarted_same_profile_with_workers_still_disabled', { package: '@loom/dsh-loom@0.0.1', public_cli_operation: 'remove/add file: then SDK restart',
      new_package_manifest_observed_present: true, no_worker_effects: true, change: 'metadata-only; source index.js hash unchanged', persisted: true })
    // SDK was initialized and shut down as a separate owned process; no model/prompt operation was requested.

    // The exact same Support Node/Grant is now queried after removing/reinstalling and restarting the DSH Profile.
    const repeatReject = await rejectTicket(admin, project.project.id, supportNode.nodeId, grant.id).then(() => { throw new Error('Update may not resurrect revoked Grant') }, (error) => error)
    assert.ok(repeatReject instanceof LoomHttpError && /grant_scope/.test(repeatReject.message))
    const revokedAfter = (await admin.get('/api/v1/grants')).grants.find((entry) => entry.id === grant.id)
    assert.equal(revokedAfter.digest, grant.digest)
    assert.equal(revokedAfter.id, revokedBefore.id)
    assert.equal(revokedAfter.revoked_at, revokedBefore.revoked_at)
    assert.deepEqual(await nodes(root), [])
    const tickets = await admin.get('/api/v1/tickets')
    assert.ok(!tickets.tickets.some((ticket) => ticket.objective?.includes('revoked-Grant evidence')))
    step('revoked_grant_retained_after_bundle_update_restart', { grant_id: grant.id, original_digest: grant.digest, revoked_before_and_after: true,
      rejection_before_update: 'grant_scope', rejection_after_update: 'grant_scope', newly_executing_lifecycle_instances: 0,
      controller_support_is_not_dsh_worker: true })
    report.overall = 'PASS'
    report.conclusions = { package_installed: true, updated: true, worker_registered: false, worker_execution_allowed: false, revocation_retained: true,
      no_model_provider_or_billed_invocations: true, dsh_manager_tool_hub_not_called: true }
    console.log(JSON.stringify(report, null, 2))
    return report
  } catch (error) {
    report.overall = 'FAIL'
    report.steps.push({ name: 'failure', status: 'FAIL', evidence: { message: String(error.message || error).slice(0, 1200),
      scope_note: 'No worker grant or execution is inferred from startup logs or package metadata.' } })
    console.error(JSON.stringify(report, null, 2))
    throw error
  } finally {
    if (server) await server.stop().catch(() => {})
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runRealBundleLifecycle()
  } catch { process.exitCode = 1 }
}
