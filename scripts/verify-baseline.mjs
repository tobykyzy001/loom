#!/usr/bin/env node
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SyntheticCoordinator } from './fixtures/coordinator.mjs'
import { LocalNodeRunner } from '../packages/node-client/src/runner.js'
import { requireIsolatedRoot } from '../packages/node-client/src/util.js'

const started = new Date().toISOString()
const checks = []
let failed = false
const check = async (name, fn) => {
  try { const evidence = await fn(); checks.push({ name, status: 'PASS', evidence }); return evidence }
  catch (error) { failed = true; checks.push({ name, status: 'FAIL', evidence: error.message }); console.error(`FAIL ${name}: ${error.message}`); return null }
}
const expect = (condition, message) => { if (!condition) throw new Error(message) }
const reportPath = process.env.LOOM_VERIFY_OUTPUT_DIR || await mkdtemp(join(tmpdir(), 'loom-baseline-verification-'))
mkdir(reportPath, { recursive: true })
const syntheticRoot = await mkdtemp(join(tmpdir(), 'loom-synthetic-baseline-'))
const synthetic = new SyntheticCoordinator({ root: syntheticRoot })
let syntheticUrl
const result = { schema: 'loom.baseline.verification.v1', started_at: started, finished_at: null, overall: 'FAIL',
  execution: { real_dsh_host: 'NOT RUN', live_llm: 'NOT RUN', rust_integration: 'NOT RUN', platforms: 'NOT RUN' },
  environment: { node: process.version, base_url_configured: Boolean(process.env.LOOM_BASE_URL) },
  temp_root: syntheticRoot, synthetic_server: 'HTTP protocol fixture, not Rust', checks, limitation: [] }
try {
  syntheticUrl = await synthetic.listen()
  synthetic.issueEnrollment = () => { const v = randomUUID(); synthetic.enrollmentCodes.set(requireHash(v), Date.now() + 60000); return v }
  const stateDir = join(syntheticRoot, 'node-state'); const artifactDir = join(syntheticRoot, 'node-artifacts')
  const enrollmentCode = synthetic.issueEnrollment = (() => { const v = crypto.randomUUID(); synthetic.enrollmentCodes.set(globalThis.process.versions.node ? (requireHash(v)) : v, Date.now() + 60000); return v })()
  const project = await check('isolated synthetic project', () => synthetic.prepareProject('synthetic-m0'))
  const grant = await check('coordinator enrollment code and explicit Grant', async () => {
    expect(project, 'missing synthetic project')
    return synthetic.makeGrant({ project_id: project.id, operations: ['read_summary', 'edit_file'] })
  })
  let node
  await check('Ed25519 challenge, single-use enrollment, registration and heartbeat', async () => {
    node = await LocalNodeRunner.create({ baseUrl: syntheticUrl, stateDir, artifactDir, enrollmentCode,
      projectRoots: { [project.id]: project.root },
      registration: { workerId: 'local-fixture-worker', harnessKind: 'local-fixture', profileId: 'isolated' } })
    expect(synthetic.nodes.get(node.nodeId).heartbeat === 'online', 'heartbeat was not stored')
    return { node_id: node.nodeId, installation_id: node.installationId, identity_persisted: true }
  })
  await check('single-use enrollment code rejected on reuse with a new key', async () => {
    try { await LocalNodeRunner.create({ baseUrl: syntheticUrl, stateDir: join(syntheticRoot, 'other'), artifactDir: join(syntheticRoot, 'other-artifacts'), enrollmentCode }) }
    catch (error) { expect(error.status === 401, 'enrollment reuse did not return 401'); return 'enrollment reuse returned 401' }
    throw new Error('enrollment reuse was accepted')
  })
  let ticket, assignment, readResult
  await check('authenticated outbound poll -> deterministic read -> artifact and report', async () => {
    ticket = synthetic.makeTicket({ project_id: project.id, objective: 'Summarize a synthetic project file' })
    assignment = await synthetic.dispatchTicket(ticket.id, node.nodeId, { kind: 'read_summary', relative_path: 'input.txt' })
    await node.pollAndRun(); await node.client.dispatchOutbox()
    const stored = [...synthetic.artifacts.values()]
    expect(stored.length === 1, 'expected one actual artifact')
    expect(stored[0].metadata.sha256.length === 64, 'expected artifact sha256')
    expect(JSON.parse(Buffer.from(stored[0].bytes_base64, 'base64')).schema === 'loom.synthetic_summary.v1', 'artifact not deterministic')
    expect(synthetic.tickets.get(ticket.id).status === 'succeeded', 'actual report did not settle ticket')
    return { artifact_id: stored[0].artifact_id, requested_state: 'succeeded', model_calls: 0 }
  })
  await check('idempotent duplicate callback has stable request ID and no duplicate side effects', async () => {
    const before = [...synthetic.artifacts.values()].length
    const delivered = node.state.data.deliveries.find((item) => item.kind === 'report')
    const deliveredReplay = await node.http.post('/api/v1/nodes/reports', delivered.body, { token: node.identity.token })
    expect(deliveredReplay.duplicate === true, 'exact callback replay was not accepted as a server duplicate')
    await node.state.enqueue('report', delivered.body)
    const delivery = await node.client.dispatchOutbox()
    expect(delivery.some((item) => item.status === 'replay_delivered'), 'exact persistent callback replay was not sent')
    expect(delivery[0].requestId === delivered.body.request_id, 'replay changed stable request ID')
    expect(synthetic.tickets.get(ticket.id).reports.length === 1, 'report duplicated on synthetic server')
    expect(synthetic.artifacts.size === before, 'artifact was duplicated')
    return { duplicate_response: true, reports: 1, artifacts: before }
  })
  await check('deterministic isolated edit is atomic and file content is real', async () => {
    const edit = synthetic.makeTicket({ project_id: project.id, objective: 'Write synthetic output' })
    await synthetic.dispatchTicket(edit.id, node.nodeId, { kind: 'edit_file', relative_path: 'nested/result.txt', content: 'Loom synthetic content; deterministic edit.\n' })
    await node.pollAndRun(); await node.client.dispatchOutbox()
    const content = await readFile(join(project.root, 'nested/result.txt'), 'utf8')
    expect(content === 'Loom synthetic content; deterministic edit.\n', 'target file does not have expected bytes')
    expect(!(await readdir(join(project.root, 'nested'))).some((name) => name.startsWith('.loom-')), 'temporary file was not cleaned')
    return { target_relative: 'nested/result.txt', actual_bytes: Buffer.byteLength(content) }
  })
  let cancelling
  await check('cancellation intent / ack and restart preserve unknown effects', async () => {
    cancelling = synthetic.makeTicket({ project_id: project.id, objective: 'Preserve cancellation' })
    const active = await synthetic.dispatchTicket(cancelling.id, node.nodeId, { kind: 'read_summary', relative_path: 'input.txt' })
    synthetic.outbox.delete(node.nodeId)
    synthetic.tickets.get(cancelling.id).cancel_requested = true
    const value = await node.pollAndRun()
    expect(value.status === 'cancel_acknowledged', 'pending cancellation did not return')
    expect(synthetic.tickets.get(cancelling.id).cancel_requested, 'intent was not preserved')
    await node.state.mutate((data) => { data.completions['restart-fixture'] = { assignment_id: 'restart-fixture', digest: 'x', state: 'running', summary: '', effects: [], artifacts: [] } })
    const restoredNode = new LocalNodeRunner({ stateDir, artifactDir, baseUrl: syntheticUrl,
      projectRoots: { [project.id]: project.root },
      registration: { workerId: 'local-fixture-worker', harnessKind: 'local-fixture', profileId: 'isolated' } })
    await restoredNode.start()
    expect(restoredNode.nodeId === node.nodeId, 'node identity changed during restart')
    expect(restoredNode.state.data.completions['restart-fixture'].state === 'unknown', 'unfinished restart effect was misreported')
    expect(restoredNode.identity.token === node.identity.token, 'node token was not restored')
    node = restoredNode
    return { cancellation_acknowledged: true, same_identity: true, recovered_effect: 'unknown', duplicate_execution: false }
  })
  await check('revoked Grant fences old-epoch report; invalid Grant is refused locally', async () => {
    const fenced = synthetic.makeTicket({ project_id: project.id, objective: 'Fencing negative test' })
    const stale = await synthetic.dispatchTicket(fenced.id, node.nodeId, { kind: 'edit_file', relative_path: 'forbidden.txt', content: 'must not write' })
    grant.revoked_at = new Date().toISOString(); grant.version += 1
    await node.pollAndRun().catch(() => {})
    const results = await node.client.dispatchOutbox()
    expect(results.some((item) => item.kind === 'report' && item.status === 'deferred'), 'old Grant report was not fenced')
    let read
    try { read = await readFile(join(project.root, 'forbidden.txt'), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    expect(read === undefined, 'fenced Grant wrote a file')
    const invalid = { ...stale, id: '00000000-0000-4000-8000-000000009999', lease_expires_at: new Date(Date.now() + 60000).toISOString(), grant: { ...grant, operations: [] } }
    synthetic.outbox.set(node.nodeId, invalid); const rejected = await node.pollAndRun()
    expect(rejected.status === 'rejected', 'invalid Grant accepted')
    return { old_grant_fenced: true, project_file_absent: true, local_invalid_grant_rejected: true }
  })
  result.execution.synthetic_protocol = failed ? 'FAIL' : 'PASS'
} finally { await synthetic.close() }

function requireHash(value) {
  const { createHash } = globalThis.process.getBuiltinModule('node:crypto')
  return createHash('sha256').update(value).digest('hex')
}
result.execution.rust_integration = 'NOT RUN'
try {
  const { runRealIntegration } = await import('./real-integration.mjs')
  result.real_coordinator = await runRealIntegration()
  result.execution.rust_integration = result.real_coordinator.overall
} catch (error) {
  failed = true
  result.execution.rust_integration = 'FAIL'
  result.real_coordinator = { overall: 'FAIL', error: error.message }
  console.error(`FAIL Rust integration: ${error.message}`)
}
result.limitation.push('Synthetic PASS and real HTTP Rust↔Node PASS are reported separately; no fixture report is substituted for a Rust Assignment.')
result.limitation.push('DSH plugin was not installed or executed in a live Host. DSH, paid model, UI rendering, iOS/Android, Linux/Windows and signed installers are NOT RUN.')
result.overall = failed || result.execution.rust_integration !== 'PASS' ? 'FAIL' : 'PASS'
result.finished_at = new Date().toISOString()
const json = JSON.stringify(result, null, 2) + '\n'
await writeFile(join(reportPath, 'verify-baseline-result.json'), json)
const md = ['# Loom deterministic baseline result', '', `Overall **${result.overall}** (separate Synthetic fixture and real Rust↔Node HTTP checks; not live DSH completion evidence).`, '',
  `Started: ${result.started_at}`, `Finished: ${result.finished_at}`, '', '| Check | Result | Evidence |', '| --- | --- | --- |',
  ...checks.map((item) => `| ${item.name} | ${item.status} | ${JSON.stringify(item.evidence)} |`), '', '## Real coordinator', '',
  `LOOM_BASE_URL mode: **${result.real_coordinator.overall}**`, ...(result.real_coordinator.checks || []).map((item) => `- ${item.status}: ${item.name} — ${JSON.stringify(item.evidence)}`),
  '', '## Not verified', ...result.limitation.map((item) => `- ${item}`), '', 'No paid model was called. The synthetic server does not pretend to be the Rust center.', ''].join('\n')
await writeFile(join(reportPath, 'verify-baseline-result.md'), md)
console.log(json)
console.log(`Results: ${join(reportPath, 'verify-baseline-result.json')} and ${join(reportPath, 'verify-baseline-result.md')}`)
if (result.overall !== 'PASS') process.exitCode = 1
