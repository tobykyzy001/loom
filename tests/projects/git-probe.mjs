#!/usr/bin/env node
// Real isolated repository + HTTP + SQLite evidence. Never fetch, clone or push.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

let available = false
try {
  execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] })
  available = true
} catch { /* Report NOT RUN rather than inventing platform coverage. */ }
if (!available) {
  console.log(JSON.stringify({ overall: 'NOT RUN', reason: 'git binary unavailable' }, null, 2))
  process.exit(0)
}

const root = await testingRoot()
const repository = await realpath(join(root, 'project')).catch(async () => {
  await mkdir(join(root, 'project'), { mode: 0o700 })
  return realpath(join(root, 'project'))
})
const home = join(root, 'private-home')
const remoteFile = join(repository, '.git', 'config')
const remoteArtifacts = [remoteFile]
const privateStrings = ['user:must-not-appear', 'must-not-appear', 'user:super-secret', 'super-secret']
let server
try {
  await mkdir(home, { mode: 0o700 })
  git(repository, ['init', '--quiet', '.'])
  await writeFile(join(repository, 'input.txt'), 'isolated fixture\n', { mode: 0o600 })
  git(repository, ['add', '--', 'input.txt'])
  git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
  addRemote('https://user:must-not-appear@example.invalid/team/repo.git')

  server = await startRustConcierge({ root: join(root, 'rust') })
  const call = async (method, path, body) => {
    const response = await fetch(`${server.baseUrl}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${server.clientToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value = await response.json()
    assert.equal(response.ok, true, `${method} ${path}: HTTP ${response.status}; ${value.error?.code || 'unknown'}`)
    return value
  }
  const createdResponse = await call('POST', '/projects', { name: 'Isolated project probe', root: repository, mode: 'read_only' })
  let inventory = createdResponse.project.inventory
  const projectId = createdResponse.project.id
  assertPublicInventory(inventory, 'https://example.invalid/team/repo.git')
  assert.equal(inventory.dirty, false)
  assert.equal(inventory.form, 'working_tree')
  assert.equal(inventory.git_available, true)
  assert.match(inventory.revision, /^[0-9a-f]{40,64}$/)
  assertNoPrivate(createdResponse)
  assert.equal(createdResponse.read_only_probe, undefined)

  await writeFile(join(repository, 'input.txt'), 'isolated fixture modified\n', { mode: 0o600 })
  const reprobed = await call('POST', `/projects/${encodeURIComponent(projectId)}/probe`, {})
  assert.equal(reprobed.read_only_probe, true)
  inventory = reprobed.project.inventory
  assert.equal(inventory.dirty, true)
  assertPublicInventory(inventory, 'https://example.invalid/team/repo.git')
  assertNoPrivate(reprobed)

  privateStrings.push('user@example.invalid')
  setRemote('https://user@example.invalid/team/repo.git')
  inventory = (await call('POST', `/projects/${encodeURIComponent(projectId)}/probe`, {})).project.inventory
  assertPublicInventory(inventory, 'https://example.invalid/team/repo.git')
  assertNoPrivate(inventory)

  // Public SCP-style remotes preserve only the literal public Git login.
  setRemote('git@github.com:team/repo.git')
  inventory = (await call('POST', `/projects/${encodeURIComponent(projectId)}/probe`, {})).project.inventory
  assertPublicInventory(inventory, 'ssh://git@github.com/team/repo.git')
  assertPublicInventory((await call('GET', '/projects')).projects.find(row => row.id === projectId).inventory, 'ssh://git@github.com/team/repo.git')

  // Strip query/fragment regardless of whether the material looks like a token.
  setRemote('https://other-user:super-secret@example.invalid/team/repo.git?private_access=arbitrary#another-private-fragment')
  privateStrings.push('other-user', 'private_access=arbitrary', 'another-private-fragment')
  inventory = (await call('POST', `/projects/${encodeURIComponent(projectId)}/probe`, {})).project.inventory
  assertPublicInventory(inventory, 'https://example.invalid/team/repo.git')
  assertNoPrivate(inventory)

  // Unknown SSH usernames remain redacted. Do not infer a missing CredentialRef.
  setRemote('ssh://private-login@example.invalid/team/repo.git')
  privateStrings.push('private-login')
  const redacted = await call('POST', `/projects/${encodeURIComponent(projectId)}/probe`, {})
  assert.equal(redacted.project.inventory.canonical_remote, null)
  assert.equal(redacted.project.inventory.canonical_remote_status, 'unsupported_or_redacted')
  assert.equal(redacted.project.inventory.redacted_remote, true)
  assert.equal(redacted.project.inventory.needs_review, true)
  assert.equal(redacted.project.inventory.credential_available, 'unknown')
  assert.equal(redacted.project.inventory.credential_lookup_performed, false)
  assertNoPrivate(redacted)

  const listed = await call('GET', '/projects')
  const audits = await call('GET', '/audit')
  const verification = await call('GET', '/audit/verify')
  assert.equal(verification.valid, true)
  for (const value of [createdResponse, reprobed, redacted, listed, audits, verification]) assertNoPrivate(value)
  const persisted = await sqliteInventory(server.dataDir, projectId, auditsExists())
  assert.deepEqual(persisted.inventory, listed.projects.find(row => row.id === projectId).inventory)
  assertNoPrivate(persisted)
  assert.equal(persisted.projectCount, 1)
  assert.equal(persisted.remoteRows, 0)
  assert.equal(persisted.projectAuditCount > 0, true)

  const documents = join(root, 'documents')
  await mkdir(documents, { mode: 0o700 })
  await writeFile(join(documents, 'input.txt'), 'not a Git repository\n', { mode: 0o600 })
  const nonGit = await call('POST', '/projects', { name: 'Documents', root: documents, mode: 'read_only' })
  assert.equal(nonGit.project.inventory.form, 'documents')
  assert.equal(nonGit.project.inventory.git_available, false)
  for (const field of ['revision', 'dirty', 'canonical_remote', 'credential_location']) assert.equal(nonGit.project.inventory[field], null)
  assert.equal(nonGit.project.inventory.canonical_remote_status, null)
  assert.equal(nonGit.project.inventory.redacted_remote, false)
  assert.equal(nonGit.project.inventory.needs_review, false)
  assertNoPrivate(nonGit)

  // Only the original repository config is expected to hold the synthetic URL.
  // The probe never creates HOME, credentials, plugins, hooks or a clone/fetch.
  assert.equal(await exists(join(repository, '.git', '.loom-probe-empty-home')), false)
  assert.equal(await exists(join(repository, '.git', 'hooks', 'post-status')), false)
  const gitConfig = await readFile(remoteFile, 'utf8')
  assert.equal(gitConfig.includes('[remote "origin"]'), true)
  assert.ok(remoteArtifacts.every(source => !JSON.stringify({ inventory: persisted.inventory, audits }).includes(source)))
  console.log(JSON.stringify({
    overall: 'PASS',
    actual_git_repository: true,
    actual_http_create_and_reprobe: true,
    persisted_inventory_and_audit_checked: true,
    original_remote_secret_absent_from_public_records: true,
    dirty_change_detected: true,
    documents_have_no_revision_or_remote: true,
    canonical_remote_contract: 'HTTPS userinfo removed; scp literal git preserved; unsafe remote becomes null',
    credential_lookup_performed: false,
    clone_fetch_or_network: false,
    remote_config_present_in_isolated_fixture: true,
    test_root: root,
  }, null, 2))
} catch (error) {
  const diagnostic = error instanceof Error ? error.message : 'non-Error fixture failure'
  const privateMatch = privateStrings.some(secret => diagnostic.includes(secret))
    || remoteArtifacts.some(remote => diagnostic.includes(remote))
  console.error(JSON.stringify({ overall: 'FAIL', error: privateMatch ? '[redacted fixture diagnostic]' : diagnostic, test_root: root }, null, 2))
  process.exitCode = 1
} finally {
  if (server) await server.stop().catch(() => {})
}

function git(cwd, args) {
  // env -i removes active-repository/config overrides and credentials, rather
  // than spreading a developer environment into the fixture process.
  const executable = process.platform === 'win32' ? 'git' : 'env'
  const environmentArgs = process.platform === 'win32' ? [] : [
    '-i', `PATH=${process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'}`,
    `HOME=${home}`, `USERPROFILE=${home}`, `XDG_CONFIG_HOME=${home}`,
    'GIT_CONFIG_NOSYSTEM=1', 'GIT_TERMINAL_PROMPT=0', 'git',
  ]
  const platformEnvironment = process.platform === 'win32' ? {
    PATH: process.env.PATH || 'C:\\Windows\\System32',
    SystemRoot: process.env.SystemRoot || '',
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  } : process.env
  try {
    return execFileSync(executable, [
      ...environmentArgs,
      '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
      '-c', 'init.defaultBranch=fixture', ...args,
    ], {
      cwd, shell: false, timeout: 10000, env: platformEnvironment,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (error) {
    // Node's execFileSync message includes argv; never print a configured URL.
    throw new Error(`fixture Git operation failed with status ${error.status ?? 'unknown'}`)
  }
}
function addRemote(remote) {
  git(repository, ['remote', 'add', 'origin', remote])
  remoteArtifacts.push(remote)
}
function setRemote(remote) {
  git(repository, ['remote', 'set-url', 'origin', remote])
  remoteArtifacts.push(remote)
}
function assertPublicInventory(value, remote) {
  assert.equal(value.canonical_remote, remote)
  assert.equal(value.canonical_remote_status, 'public')
  assert.equal(value.redacted_remote, false)
  assert.equal(value.needs_review, false)
  assert.equal(value.source, 'controller_probe')
  assert.equal(value.location_kind, 'local_working_tree')
  assert.equal(value.credential_location, null)
  assert.equal(value.credential_available, 'unknown')
  assert.equal(value.credential_lookup_performed, false)
}
function assertNoPrivate(value) {
  const serialized = JSON.stringify(value)
  for (const secret of privateStrings) assert.equal(serialized.includes(secret), false, 'synthetic remote userinfo or query was reflected')
  for (const url of remoteArtifacts) assert.equal(serialized.includes(url), false, 'a raw configured remote was reflected')
}
async function exists(path) {
  try { await lstat(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
async function sqliteInventory(dataDir, projectId, auditQuery) {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(join(dataDir, 'loom.sqlite3'), { readOnly: true })
  const project = database.prepare('SELECT inventory FROM projects WHERE id = ?').get(projectId)
  const persisted = {
    inventory: JSON.parse(project.inventory),
    projectCount: database.prepare('SELECT COUNT(*) AS count FROM projects').get().count,
    remoteRows: database.prepare("SELECT COUNT(*) AS count FROM projects WHERE instr(inventory, 'must-not-appear') > 0").get().count,
    projectAuditCount: database.prepare(auditQuery).get().count,
  }
  database.close()
  return persisted
}
function auditsExists() { return "SELECT COUNT(*) AS count FROM audits WHERE action = 'project.probed'" }
