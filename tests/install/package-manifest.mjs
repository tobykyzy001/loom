#!/usr/bin/env node
// Consume the real current native package, without installing or executing it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, link, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { startRustConcierge, testingClientToken, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const root = await testingRoot()
const component = {
  kind: 'bare_host', version: '0.1.0',
  sha256: '1c9dc260a2d689602a6e133b9017561d9b69c30136834e08f51aaa05de3542c5',
  source: 'local_package_candidate',
}
const targets = name => ({ host_key: name, os: 'darwin', arch: 'arm64', baseline_version: '0.0.0', requested_version: '0.1.0', selected: true })
const request = target => ({ schema: 'loom.install-plan.v1', source: 'explicit_admin_inventory_manifest', component, targets: [target] })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
let server

async function main() {
  // The existing smoke creates the actual native copy and package metadata. Its
  // own scanner is not evidence of subsequent host installation or authorization.
  const built = await promisify(execFile)('node', ['scripts/bare-package-smoke.mjs'], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
  const lastBrace = built.stdout.lastIndexOf('\n{')
  assert.ok(lastBrace >= 0, built.stdout)
  const packageProof = JSON.parse(built.stdout.slice(lastBrace + 1))
  assert.equal(packageProof.overall, 'PASS')
  const manifestPath = resolve(dirname(packageProof.report_path), packageProof.package_relative)
  const manifestBytes = await readFile(manifestPath)
  const packageDefinition = JSON.parse(manifestBytes.toString('utf8'))
  assert.equal(packageProof.sha256, packageDefinition.binary.sha256)
  assert.equal(packageDefinition.binary.relative_path, './loom-node')

  server = await startRustConcierge({
    root, env: { ...process.env, LOOM_CLIENT_TOKEN: testingClientToken(), LOOM_INSTALL_SIMULATION: 'synthetic_inventory' },
  })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const target = targets('fixture-local-compiled')
  const validPlan = await admin.post('/api/v1/install-plans', {
    ...request(target), package_manifest: manifestPath,
  })
  const expectedManifestSHA = sha256(manifestBytes)
  const actualComponent = validPlan.plan.component
  assert.equal(actualComponent.sha256, component.sha256, 'The previous source component reference remains unchanged')
  assert.equal(actualComponent.source_manifest_sha256, expectedManifestSHA, 'The server computes the manifest content digest itself')
  assert.equal(actualComponent.source_manifest_sha256.includes(manifestPath), false)
  assert.equal(JSON.stringify(validPlan).includes(manifestPath), false, 'The private local manifest path is not put in the public plan')
  assert.equal(validPlan.plan.host_execution, false)
  assert.equal(validPlan.policy.remote_execution, false)
  assert.equal(validPlan.policy.proof_kind, 'synthetic_plan_only')
  assert.equal(validPlan.plan.targets[0].status, 'pending_approval')
  assert.equal(validPlan.plan.targets[0].current_operation_id, null)

  const healthySnapshot = async () => ({
    plans: (await admin.get('/api/v1/install-plans')).plans,
    audits: (await admin.get('/api/v1/audit')).audit,
    grants: (await admin.get('/api/v1/grants')).grants,
    tickets: (await admin.get('/api/v1/tickets')).tickets,
  })
  const previous = await healthySnapshot()
  assert.equal(previous.grants.length, 0)
  assert.equal(previous.tickets.length, 0)

  const tamperDir = resolve(root, 'tampered-package')
  await mkdir(tamperDir, { mode: 0o700 })
  const binaryPath = resolve(dirname(manifestPath), 'loom-node')
  const binary = new Uint8Array(await readFile(binaryPath))
  binary[20] ^= 1
  await Promise.all([
    copyFile(manifestPath, resolve(tamperDir, 'manifest.json')),
    writeFile(resolve(tamperDir, 'loom-node'), binary, { mode: packageDefinition.binary.mode }),
  ])
  const rejection = await admin.post('/api/v1/install-plans', {
    ...request(target), package_manifest: resolve(tamperDir, 'manifest.json'),
  }).catch(error => error)
  assert.equal(rejection.status, 400, 'The mutating byte must not become another approved package source')
  assert.deepEqual(await healthySnapshot(), previous, 'A rejected binary produced no plan, audit, Grant or Ticket')

  const wrongArchitectureDir = resolve(root, 'wrong-architecture-package')
  await mkdir(wrongArchitectureDir, { mode: 0o700 })
  const invalidManifest = { ...packageDefinition, arch: 'x86_64' }
  await Promise.all([
    writeFile(resolve(wrongArchitectureDir, 'manifest.json'), JSON.stringify(invalidManifest)),
    copyFile(binaryPath, resolve(wrongArchitectureDir, 'loom-node')),
  ])
  const wrongArchitecture = await admin.post('/api/v1/install-plans', {
    ...request(target), package_manifest: resolve(wrongArchitectureDir, 'manifest.json'),
  }).catch(error => error)
  assert.equal(wrongArchitecture.status, 400)
  assert.deepEqual(await healthySnapshot(), previous)

  const aliasManifest = resolve(root, 'alias-manifest.json')
  await link(manifestPath, aliasManifest)
  const hardlink = await admin.post('/api/v1/install-plans', {
    ...request(target), package_manifest: aliasManifest,
  }).catch(error => error)
  assert.equal(hardlink.status, 400, 'Multi-linked metadata cannot silently become a different immutable source proof')
  assert.deepEqual(await healthySnapshot(), previous)

  const forgedDigest = await admin.post('/api/v1/install-plans', {
    ...request(target), component: { ...component, source_manifest_sha256: '0'.repeat(64) },
    package_manifest: manifestPath,
  }).catch(error => error)
  assert.equal(forgedDigest.status, 400, 'Only the controller can issue this source digest')
  assert.deepEqual(await healthySnapshot(), previous)

  const migrated = await clientDoctor()
  assert.equal(migrated.schema_version, 16)
  assert.equal(migrated.audit_valid, true)
  console.log(JSON.stringify({
    overall: 'PASS', scope: 'real_local_package_manifest_and_binary_read_only_verification',
    actual_source_binary_sha256: packageDefinition.binary.sha256,
    source_manifest_sha256: expectedManifestSHA,
    binary_executed_by_this_driver: false, installation_or_registration: false,
    native_package_status: validPlan.plan.targets[0].status,
    rejects_byte_tampering_architecture_multi_link_and_client_digest: true,
    source_path_not_exposed: true, grants_and_tickets: [0, 0],
    synthetic_installation_still_not_actual_execution: true,
  }, null, 2))
}

async function clientDoctor() {
  // The current server owns its database and diagnostics, not this script's package bytes.
  const raw = await promisify(execFile)('cargo', ['run', '-q', '-p', 'loom-concierge', '--bin', 'loom', '--',
    '--data-dir', server.dataDir, 'doctor'], {
    timeout: 120000, env: { ...process.env, LOOM_CLIENT_TOKEN: server.clientToken },
  })
  const doctor = JSON.parse(raw.stdout)
  assert.equal(doctor.integrity[0].integrity_check, 'ok')
  return doctor
}

try { await main() } catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: error.message, checks: 'actual native package controls did not complete' }, null, 2))
  process.exitCode = 1
} finally {
  if (server) await server.stop().catch(() => {})
}
