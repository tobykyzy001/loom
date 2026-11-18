import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROFILE = 'loom-local-fixture'
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

export function installation() {
  const executable = process.env.DSH_NODE_EXECUTABLE
  const install = process.env.DSH_INSTALL_DIR
  if (!executable || !install || !isAbsolute(executable) || !isAbsolute(install)) {
    throw new Error('NOT RUN: verified DSH_NODE_EXECUTABLE and DSH_INSTALL_DIR are required; Desktop Profile is never inferred')
  }
  if (process.env.DSH_PROFILE !== 'desktop') throw new Error('The harness runner requires explicit Desktop runtime facts, not an unrelated source installation')
  return { executable, cli: join(install, 'lib/bin.js') }
}

export function redact(value, secrets = []) {
  let text = String(value)
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) text = text.replaceAll(secret, '[redacted-fixture-secret]')
  return text
}

export async function fixtureRoot(requested) {
  const root = requested ? resolve(requested) : await mkdtemp(join(tmpdir(), 'loom-dsh-'))
  if (requested) await mkdir(root, { recursive: true, mode: 0o700 })
  if (!isAbsolute(root) || root === sep || root === resolve(process.env.HOME || '__none__')) throw new Error('Unsafe fixture root')
  await chmod(root, 0o700)
  for (const name of ['home', 'agents', 'dsh-test-state', 'project', 'node-state', 'artifacts', 'private', 'patch']) {
    await mkdir(join(root, name), { recursive: true, mode: 0o700 }); await chmod(join(root, name), 0o700)
  }
  return root
}

export function isolatedEnv(root, extra = {}) {
  // No user Profile, credentials, API keys, proxy instructions or inherited private PROJECT path.
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: join(root, 'home'),
    DSH_HOME: join(root, 'dsh-test-state'),
    DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    ELECTRON_RUN_AS_NODE: '1',
    LOOM_DSH_INSTALL_DIR: process.env.DSH_INSTALL_DIR,
    LOOM_FIXTURE_ROOT: root,
    LOOM_FIXTURE_PROJECT_ROOT: join(root, 'project'),
    LOOM_FIXTURE_NODE_STATE_DIR: join(root, 'node-state'),
    LOOM_FIXTURE_ARTIFACT_DIR: join(root, 'artifacts'),
    LOOM_FIXTURE_CONTROL_PATH: join(root, 'private', 'fixture-control.jsonl'),
    // Persistent evidence stays under separately created test roots, never the Desktop profile.
    LOOM_FIXTURE_PROJECT_MAPPING: '{}',
    ...extra,
  }
}

export async function command(command, args, { cwd, env, secrets = [], timeoutMs = 60_000 } = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', fail)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const result = { code, signal, stdout: redact(stdout, secrets), stderr: redact(stderr, secrets) }
      if (code !== 0) fail(Object.assign(new Error(`Command failed (${code ?? signal}): ${command} ${args.join(' ')}\n${result.stderr.slice(-5000)}`), { result }))
      else ok(result)
    })
  })
}

export async function installBundles({ env, root, cli, executable, bundles, sourceOverrides = {} }) {
  const prepared = join(root, 'dsh-test-state', 'profiles', PROFILE)
  const initialArgs = ['--profile', PROFILE, '--from-default-profile', 'sdk-minimal', '--dump-config']
  const initial = await command(executable, [cli, ...initialArgs], { cwd: root, env })
  const commands = [{ args: initialArgs, code: initial.code, stderr: initial.stderr }]
  const shim = join(root, 'fixture-schemastery')
  await mkdir(shim, { mode: 0o700 })
  for (const name of ['package.json', 'index.cjs']) await cp(join(repository, 'tests/harness/fixtures/schemastery-shim', name), join(shim, name))
  const shimArgs = ['plugin', '--profile', PROFILE, 'add', `file:${shim}`, '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store')]
  const shimResult = await command(executable, [cli, ...shimArgs], { cwd: root, env })
  commands.push({ args: shimArgs, code: shimResult.code, stderr: shimResult.stderr })
  await mkdir(join(root, 'fixture-packages'), { mode: 0o700 })
  // Only the exact Schemastery version shipped by this Host needs an offline forwarding fixture.
  for (const name of ['stub-provider', 'dsh-loom', 'credential-record']) {
    const override = sourceOverrides[name]
    if (override !== undefined && (!isAbsolute(override) || override === sep)) throw new Error('Fixture package override must name a specific absolute directory')
    const source = override || join(repository, name === 'dsh-loom' ? 'plugins/dsh-loom' : join('tests/harness/fixtures', name))
    const destination = join(root, 'fixture-packages', name)
    await cp(source, destination, { recursive: true, filter: (path) => !path.includes('/test/') && !path.endsWith('/test') })
  }
  for (const bundle of bundles) {
    const args = ['plugin', '--profile', PROFILE, 'add', `file:${bundle}`, '--ignore-scripts', '--store-dir', join(root, 'pnpm-store') ]
    const result = await command(executable, [cli, ...args], { cwd: root, env })
      commands.push({ args, code: result.code, stderr: redact(result.stderr) })
  }
  // Initialization occurs under the explicit fixture HOME, never the invoking Desktop Profile.
  const configArgs = ['--profile', PROFILE, '--dump-config']
  const dumped = await command(executable, [cli, ...configArgs], { cwd: root, env })
  await writeFile(join(root, 'private', 'composed-config.txt'), dumped.stdout, { mode: 0o600 })
  await chmod(join(prepared, 'package.json'), 0o600)
  await chmod(join(prepared, 'cordis.patch.yml'), 0o600)
  const packageStat = await stat(join(prepared, 'package.json'))
  assert.equal(packageStat.mode & 0o777, 0o600)
  await chmod(join(root, 'dsh-test-state'), 0o700)
  await chmod(prepared, 0o700)
  const manifest = JSON.parse(await readFile(join(prepared, 'package.json'), 'utf8'))
  const dependencies = Object.keys(manifest.dependencies || {})
  const credentialBundles = bundles.filter(bundle => bundle.endsWith('/credential-record')).length
  assert.deepEqual(new Set(dependencies), new Set(['@deepseek-ai/schemastery', '@loom/dsh-fixture-stub-provider', '@loom/dsh-loom',
    ...(credentialBundles > 0 ? ['@loom-test/credential-record'] : [])]))
  return { commands, profile: PROFILE, dependencies, root_mode: (await stat(join(root, 'dsh-test-state'))).mode & 0o777 }
}

/** Newly allocated isolated runner JSONL log, excluding enrollment and node transport tokens. */
export async function appendEvidence(root, value) {
  await appendFile(join(root, 'private', 'driver.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 })
}

export function syntheticToken() { return randomBytes(24).toString('base64url') }

export function profilePatch(runtime = process.env) {
  return `- id: llm-deepseek
  disabled: true
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: !!js process.env.LOOM_FIXTURE_PROJECT_ROOT
    additionalWritableRoots: []
- id: persistent-bash
  disabled: true
- id: persistent-pwsh
  disabled: true
- id: sessions
  config:
    root: !!js process.env.LOOM_FIXTURE_ROOT + '/dsh-test-state/sessions'
    compression: none
- id: loom-fixture-stub-provider
  config:
    control_path: !!js process.env.LOOM_FIXTURE_CONTROL_PATH
    project_root: !!js process.env.LOOM_FIXTURE_PROJECT_ROOT
${runtime.LOOM_FIXTURE_CREDENTIAL_RECORD_KEY ? `- id: loom-credential-seed
  config:
    enabled: !!js process.env.LOOM_FIXTURE_CREDENTIAL_SEED === 'true'
    record_key: !!js process.env.LOOM_FIXTURE_CREDENTIAL_RECORD_KEY
` : ''}- id: loom-local-node
  config:
    enabled: true
    allow_workers: true
    executor: dsh
    base_url: !!js process.env.LOOM_FIXTURE_COORDINATOR_URL
    state_dir: !!js process.env.LOOM_FIXTURE_NODE_STATE_DIR
    artifact_dir: !!js process.env.LOOM_FIXTURE_ARTIFACT_DIR
    enrollment_code: !!js process.env.LOOM_FIXTURE_ENROLLMENT_CODE || ''
    allow_dsh_agent_creation: true
    bounded_fixture_effects: true
    fixture_code_tools: !!js process.env.LOOM_FIXTURE_CODE_TOOLS === 'true'
    model_text_tasks: !!js process.env.LOOM_FIXTURE_MODEL_TEXT_TASKS === 'true'
    model_descriptor_tasks: !!js process.env.LOOM_FIXTURE_MODEL_DESCRIPTOR_TASKS === 'true'
    credential_broker_tasks: !!js process.env.LOOM_FIXTURE_CREDENTIAL_BROKER || 'unsupported'
    delegation_tools: !!js process.env.LOOM_FIXTURE_DELEGATION_TOOLS || 'unsupported'
    delegation_project_root: !!js process.env.LOOM_FIXTURE_PROJECT_ROOT
    agent_session_id: !!js process.env.LOOM_FIXTURE_AGENT_SESSION_ID || ''
    profile_id: loom-local-fixture
    project_roots: !!js JSON.parse(process.env.LOOM_FIXTURE_PROJECT_MAPPING || '{}')
    provider: loom-stub
    model: loom-stub-v1
    max_active_workers: 1
    heartbeat_ms: 2000
    poll_seconds: 0
    request_timeout_ms: 15000
`
}

export async function runCliForProfile({ root, env, extraArgs = [], timeoutMs = 60_000 }) {
  const { executable, cli } = installation()
  const patch = join(root, 'patch', 'fixture.yml')
  await writeFile(patch, profilePatch(), { mode: 0o600 })
  return command(executable, [cli, '--profile', PROFILE, '--patch', patch, ...extraArgs], { cwd: join(root, 'project'), env, timeoutMs })
}
