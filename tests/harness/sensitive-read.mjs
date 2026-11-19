#!/usr/bin/env node
/** Real isolated DSH read: private Session narration never becomes public evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { installation, isolatedEnv, fixtureRoot, installBundles, command, redact, sleep, PROFILE } from './environment.mjs'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { chromium } from '../browser/node_modules/playwright-core/index.mjs'

const output = process.env.LOOM_TEST_OUTPUT ? resolve(process.env.LOOM_TEST_OUTPUT) : undefined
const keep = process.env.LOOM_TEST_KEEP_EVIDENCE === 'true'
let root, host, server, admin, context, preview, sessionId
let settled = false
const secrets = [], checks = [], browserScreenshots = {}
const privateMarker = 'SYNTHETIC-PRIVATE-INPUT-d59b302e93ab'
const siblingMarker = 'UNAUTHORIZED-SIBLING-NO-PROOF-1dbf980f09e2'
const pass = (name, evidence = {}) => { const record = { name, status: 'PASS', evidence }; checks.push(record); console.log(redact(`PASS ${name}`, secrets)) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const clean = value => JSON.parse(redact(JSON.stringify(value), [...secrets, privateMarker, siblingMarker]))
const publicClean = value => { const text = JSON.stringify(value); for (const secret of [privateMarker, siblingMarker, ...secrets]) assert.equal(text.includes(secret), false, 'Private synthetic bytes must never become public'); return value }
const report = (overall, diagnostics = '') => clean({ schema: 'loom.dsh.sensitive-read.v1', overall, checks, profile: PROFILE,
  ticket_id: checks[0]?.evidence?.ticket_id, session_id: sessionId, browser: browserScreenshots,
  target: 'one isolated DSH read_summary turn: controlled source read plus a deliberately echoing assistant',
  real_dsh: overall === 'PASS' ? 'PASS' : 'NOT ESTABLISHED', external_llm: 'NOT RUN (zero-network Stub)',
  production_profile_used: false, mobile_device: 'NOT RUN (390px desktop viewport only)',
  not_claimed: ['generic Transcript sanitization', 'arbitrary file or Shell access', 'mobile device lifecycle', 'multi-Host authorization'],
  output: output || null, fixture_root_removed: !keep && !process.env.LOOM_TEST_ROOT, diagnostics: redact(diagnostics, [...secrets, privateMarker, siblingMarker]).slice(-5000) })
const expectHttp = async (promise, status) => assert.rejects(promise, error => {
  console.error('EXPECTED_DENIAL', redact(JSON.stringify({ status: error.status, code: error.code, message: error.message }), [...secrets, privateMarker, siblingMarker]))
  assert.equal(error.status, status); return true
})
async function terminal(id, timeout = 75_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const detail = await admin.get(`/api/v1/tickets/${id}`); if (['succeeded', 'failed', 'cancelled', 'reconciling'].includes(detail.status)) return detail; await sleep(150) }
  const last = await admin.get(`/api/v1/tickets/${id}`)
  throw new Error(`Ticket did not settle: ${JSON.stringify({ id, status: last.status, reports: last.reports.length, artifacts: last.artifacts.length })}`)
}
async function readStoredAssignment() {
  const map = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
  return map.assignments.find(row => row.session_id === sessionId)
}
async function sessionBytes() {
  // Never scan the Host or its ordinary desktop profile: only this driver's synthetic Sessions.
  const entries = []
  for (const name of await readdir(join(root, 'dsh-test-state', 'sessions'), { recursive: true })) {
    if (name.endsWith('/session.v4.jsonl')) entries.push(await readFile(join(root, 'dsh-test-state', 'sessions', name), 'utf8'))
  }
  return entries.filter(value => value.includes(sessionId)).join('\n')
}

try {
  root = process.env.LOOM_TEST_ROOT ? await fixtureRoot(process.env.LOOM_TEST_ROOT) : await mkdtemp(join(tmpdir(), 'loom-dsh-'))
  root = await realpath(root)
  assert.ok(root.split('/').at(-1).startsWith('loom-dsh-'))
  if (!process.env.LOOM_TEST_ROOT) await fixtureRoot(root)
  const projectRoot = join(root, 'project')
  const source = Buffer.from(`${privateMarker}\nOnly virtual synthetic fixture bytes; no real user data.\n`)
  await writeFile(join(projectRoot, 'input.txt'), source, { mode: 0o600 })
  await writeFile(join(projectRoot, 'forbidden.txt'), `${siblingMarker}\n`, { mode: 0o600 })
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  const { executable, cli, install } = installation()
  const version = await command(executable, ['-e', "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).version)", join(install, 'package.json')], { env: isolatedEnv(root) })
  const hostApi = version.stdout.trim()
  assert.ok(/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(hostApi), 'Read the exact selected CLI manifest')
  server = await startRustConcierge({ root: join(root, 'rust'), env: { PATH: process.env.PATH } })
  secrets.push(server.clientToken)
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
  const projectId = (await admin.post('/api/v1/projects', { name: 'Isolated sensitive read fixture', root: projectRoot, mode: 'read_write' })).project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  secrets.push(enrollment.code)
  const env = isolatedEnv(root, { LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl, LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code,
    LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [projectId]: projectRoot }) })
  const installed = await installBundles({ env, root, cli, executable, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
  assert.ok(installed.dependencies.includes('@loom/dsh-loom'))
  host = await new FixtureHost(root, env, secrets).start()
  const deadline = Date.now() + 45_000
  let node
  while (!node && Date.now() < deadline) { node = (await admin.get('/api/v1/nodes')).nodes.find(row => row.status === 'online' && row.inventory?.project_roots?.[projectId] === projectRoot); if (!node) await sleep(200) }
  assert.ok(node, 'Exact real DSH worker and synthetic root must register')
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: projectRoot })
  const grant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: node.id, worker_id: 'default', operations: ['read'] })
  const objective = `LOOM_FIXTURE_READ LOOM_FIXTURE_ECHO_SOURCE Exercise the bounded reader and deliberately echo this synthetic source; do not read the forbidden sibling.`
  const ticket = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: node.id, worker_id: 'default', grant_id: grant.grant.id,
    objective, kind: 'read_summary', relative_path: 'input.txt' })
  const assignment = ticket.assignments[0]
  await host.waitFor(async () => { const map = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8').catch(() => '{"assignments":[]}')); sessionId = map.assignments.find(row => row.assignment_id === assignment.id)?.session_id; return !!sessionId }, 45_000, 'actual source SessionRef')
  const detail = await terminal(ticket.id)
  assert.equal(detail.status, 'succeeded'); assert.equal(detail.artifacts.length, 1); assert.equal(detail.effects.length, 0)
  const calls = host.sessionEvents(sessionId, ['tool/call']), results = host.sessionEvents(sessionId, ['tool/result'])
  assert.equal(calls.length, 1); assert.equal(calls[0].event.data.callId, 'loom-fixture-controlled-read')
  assert.equal(results.length, 1); assert.equal(results[0].event.data.message.isError, false)
  const control = readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(row => row.type === 'tool-execute')
  assert.deepEqual(control.map(row => ({ name: row.name, path: row.path })), [{ name: 'loom_fixture_inspect', path: 'input.txt' }])
  const echoEvents = host.sessionEvents(sessionId, ['assistant/message'])
  assert.ok(echoEvents.some(event => JSON.stringify(event.event).includes(privateMarker)), 'Negative invariant needs the ordinary SDK assistant echo')
  await host.waitFor(async () => (await sessionBytes()).includes(privateMarker), 15_000, 'persisted raw SDK assistant echo')
  const stored = await sessionBytes()
  assert.equal(stored.includes(siblingMarker), false, 'No fixture may read or echo the forbidden sibling')
  assert.ok(results.every(row => !JSON.stringify(row).includes(privateMarker)), 'Public ToolResult has only a digest')
  publicClean(detail); publicClean(await admin.get(`/api/v1/messages?ticket_id=${ticket.id}`)); publicClean(await admin.get(`/api/v1/audit?ticket_id=${ticket.id}`))
  const artifactId = detail.artifacts[0].id
  const download = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifactId}`)
  const body = JSON.parse(download.content), projection = download.artifact.read_evidence
  publicClean(download); assert.equal(digest(download.content), download.artifact.sha256)
  assert.deepEqual(Object.keys(body).sort(), ['proof', 'raw_artifact_published', 'read_observed', 'schema', 'source'])
  assert.equal(body.schema, 'loom.read-evidence.v1'); assert.equal(body.source.schema, 'loom.read-source.v1')
  assert.equal(body.source.path, 'input.txt'); assert.equal(body.source.bytes, digest(source)); assert.equal(body.source.size_bytes, source.length)
  assert.equal(body.read_observed, true); assert.equal(body.raw_artifact_published, false)
  assert.deepEqual(Object.keys(body.proof).sort(), ['call_id', 'call_seq', 'name', 'result_id', 'result_seq', 'schema', 'session'])
  assert.deepEqual(body.proof.session, { session_id: sessionId, protocol: 'dsh-session-log' })
  for (const field of ['call_id', 'call_seq', 'result_id', 'result_seq']) assert.equal(projection[field], body.proof[field])
  const evidence = JSON.parse(detail.reports[0].evidence)
  assert.ok(Array.isArray(evidence) && evidence.length === 1)
  assert.deepEqual(evidence[0], { harness: 'dsh', session_id: sessionId, protocol: 'dsh-session-log', host_api: hostApi, observed_seq: projection.session.observed_seq })
  assert.equal(projection.call_seq, calls[0].event.seq); assert.equal(projection.result_seq, results[0].event.seq)
  assert.ok(projection.result_seq > projection.call_seq && evidence[0].observed_seq >= projection.result_seq)
  for (const key of ['objective', 'tool_args', 'arguments', 'transcript', 'text', 'content']) assert.equal(Object.hasOwn(body, key), false)
  const db = new DatabaseSync(join(server.dataDir, 'loom.sqlite3'), { readOnly: true })
  try {
    const row = db.prepare('SELECT read_evidence_json FROM artifacts WHERE id=?').get(artifactId)
    assert.equal(typeof row.read_evidence_json, 'string'); publicClean(JSON.parse(row.read_evidence_json))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 1)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { db.close() }
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  pass('real controlled read and echoing Session expose only source hash, proof and one exact Report SessionRef', { ticket_id: ticket.id, assignment_id: assignment.id, artifact_id: artifactId, source_sha256: digest(source), tool_calls: 1, raw_session_echo_observed: true })
  const other = await admin.post('/api/v1/tickets', { project_id: projectId, node_id: node.id, worker_id: 'default', grant_id: grant.grant.id,
    objective: 'Separate ticket for the cross-owner read denial, not a fixture execution.', kind: 'read_summary', relative_path: 'forbidden.txt' })
  await expectHttp(admin.get(`/api/v1/tickets/${other.id}/artifacts/${artifactId}`), 403)
  const noAuth = async (url, init) => { assert.equal(init.headers.authorization, undefined); return fetch(url, init) }
  await expectHttp(new LoomHttpClient({ baseUrl: server.baseUrl, fetch: noAuth }).get(`/api/v1/tickets/${ticket.id}/artifacts/${artifactId}`, { noAuth: true }), 401)
  const identity = JSON.parse(await readFile(join(root, 'node-state', 'identity.json'), 'utf8'))
  const nodeToken = identity.token; secrets.push(nodeToken)
  const state = JSON.parse(await readFile(join(root, 'node-state', 'node-state.json'), 'utf8'))
  const completion = state.completions[assignment.id]
  assert.equal(completion.artifact.metadata.evidence.length, 1)
  const forbidden = Buffer.from(JSON.stringify({ schema: 'loom.read-evidence.v1', source: { schema: 'loom.read-source.v1', path: 'forbidden.txt', bytes: digest(Buffer.from('clone')), size_bytes: 5 }, proof: body.proof, read_observed: true, raw_artifact_published: false }))
  await expectHttp(admin.post('/api/v1/nodes/artifacts', { protocol: 'loom.node.v1', node_id: node.id, installation_id: node.installation_id, ticket_id: ticket.id, assignment_id: assignment.id, lease_epoch: assignment.lease_epoch,
    request_id: `sensitive-read-denied-${ticket.id}`, artifact_id: completion.artifact.metadata.artifact_id, bytes_base64: forbidden.toString('base64'), metadata: { ...completion.artifact.metadata, sha256: digest(forbidden), size_bytes: forbidden.length, evidence: [{ ...completion.artifact.metadata.evidence[0], path: 'forbidden.txt' }] } }, { token: nodeToken }), 400)
  assert.equal((await admin.get(`/api/v1/tickets/${ticket.id}`)).artifacts.length, 1)
  assert.equal((await admin.get(`/api/v1/tickets/${other.id}`)).artifacts.length, 0)
  // A valid metadata projection must not be able to launder arbitrary sensitive
  // bytes into a readable Artifact. Reject before either disk or SQLite write.
  const attackArtifactId = 'a0000000-0000-4000-8000-000000000001'
  await expectHttp(admin.post('/api/v1/nodes/artifacts', { protocol: 'loom.node.v1',
    node_id: node.id, installation_id: node.installation_id,
    ticket_id: ticket.id, assignment_id: assignment.id, lease_epoch: assignment.lease_epoch,
    request_id: `sensitive-read-split-body-${attackArtifactId}`, artifact_id: attackArtifactId,
    bytes_base64: Buffer.from(privateMarker).toString('base64'),
    metadata: { ...completion.artifact.metadata, artifact_id: attackArtifactId } }, { token: nodeToken }), 400)
  assert.equal((await admin.get(`/api/v1/tickets/${ticket.id}`)).artifacts.length, 1)
  await access(join(server.dataDir, 'artifacts', `${attackArtifactId}.artifact`))
    .then(() => assert.fail('malicious first-write bytes reached disk'), error => assert.equal(error.code, 'ENOENT'))
  const unchangedBody = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifactId}`)
  publicClean(unchangedBody)
  assert.deepEqual(unchangedBody, download, 'The original immutable proof must stay intact; new bytes must not replace it')
  const rawStored = readFileSync(join(server.dataDir, 'artifacts', `${artifactId}.artifact`), 'utf8')
  assert.equal(rawStored.includes(privateMarker), false, 'The secret replacement bytes never reach storage or the download')
  pass('valid read metadata cannot publish a different secret-bearing body; first bytes never land on disk', { status: 400, artifacts: 1, overwrite_rejected: true })
  const replayUpload = (metadata, evidence = metadata.evidence) => admin.post('/api/v1/nodes/artifacts', { protocol: 'loom.node.v1', node_id: node.id, installation_id: node.installation_id,
    ticket_id: ticket.id, assignment_id: assignment.id, lease_epoch: assignment.lease_epoch,
    request_id: `sensitive-read-replay-${ticket.id}`, artifact_id: completion.artifact.metadata.artifact_id,
    bytes_base64: Buffer.from(download.content, 'utf8').toString('base64'), metadata: { ...metadata, evidence } }, { token: nodeToken })
  const duplicate = await replayUpload(completion.artifact.metadata).catch(error => {
    console.error('DUPLICATE_DIAGNOSTIC', redact(error.message, [...secrets, privateMarker, siblingMarker]))
    throw error
  })
  assert.equal(duplicate.duplicate, true, 'Only an exact provenance+basis ring may reuse the receipt')
  await expectHttp(replayUpload(completion.artifact.metadata, []), 409)
  await expectHttp(replayUpload({ ...completion.artifact.metadata, evidence: completion.artifact.metadata.evidence.map(row => ({ ...row, session: { ...row.session, session_id: '11111111-1111-4111-8111-111111111111' } })) }), 400)
  assert.equal((await admin.get(`/api/v1/tickets/${ticket.id}`)).artifacts.length, 1)
  const immutable = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifactId}`)
  assert.deepEqual(immutable, download, 'Altered duplicate evidence must not replace or strip the original proof')
  pass('cross-ticket/anonymous reads are denied and forbidden or altered duplicate proof cannot reuse the immutable receipt', { cross_ticket_status: 403, unauthenticated_status: 401, forbidden_upload_status: 400, retained_duplicate_changed_proof_statuses: [409, 400], new_artifacts: 0 })
  await browserCheck(projectId, ticket.id)
  // Finish the separate permission-negative Task *before* the recovery boundary.
  // Leaving it running would create a legitimate fresh Agent turn after restart,
  // which would not be a replay of either existing Source or Grant.
  const beforeReopenOther = await terminal(other.id)
  assert.equal(beforeReopenOther.status, 'succeeded')
  assert.equal(beforeReopenOther.assignments.length, 1)
  await host.stop(); host = null
  await server.stop()
  await new Promise(resolve => setTimeout(resolve, 300))
  env.LOOM_FIXTURE_ENROLLMENT_CODE = ''
  server = await startRustConcierge({ root: join(root, 'rust'), env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: secrets[0] } })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
  const storedEnv = JSON.parse(JSON.stringify(env)); storedEnv.LOOM_FIXTURE_COORDINATOR_URL = server.baseUrl
  storedEnv.LOOM_FIXTURE_ENROLLMENT_CODE = ''; storedEnv.LOOM_FIXTURE_AGENT_SESSION_ID = sessionId
  host = await new FixtureHost(root, storedEnv, secrets).start(); await host.raw('session/resume', { sessionId })
  await host.waitFor(async () => (await admin.get('/api/v1/nodes')).nodes.some(row => row.id === node.id && row.installation_id === node.installation_id && row.status === 'online'), 45_000, 'same registered Node after restart')
  await sleep(2200)
  const restored = await readStoredAssignment(); assert.equal(restored.assignment_id, assignment.id)
  const reopenedControl = readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.type === 'tool-execute')
  assert.deepEqual(reopenedControl, control, 'No new DSH source execution may follow reopen')
  assert.equal(host.sessionEvents(sessionId, ['tool/call']).length, 0, 'Reopening must not execute another source read')
  const reopenedDetail = await admin.get(`/api/v1/tickets/${ticket.id}`)
  assert.deepEqual(reopenedDetail, detail); assert.deepEqual(await admin.get(`/api/v1/tickets/${other.id}`), beforeReopenOther)
  const reopened = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifactId}`); assert.deepEqual(reopened, download)
  assert.equal((await admin.get('/api/v1/nodes')).nodes.filter(row => row.id === node.id && row.installation_id === node.installation_id).length, 1)
  const otherDetail = await admin.get(`/api/v1/tickets/${other.id}`)
  // A separate non-sensitive assignment is allowed to finish after restart;
  // that is not evidence of replaying the original source or its Grant.
  assert.equal(otherDetail.assignments.length, 1)
  assert.notEqual(otherDetail.assignments[0].id, assignment.id)
  assert.equal(otherDetail.reports.length, 1)
  publicClean(otherDetail)
  assert.equal(restored.session_id, sessionId)
  pass('center and Host reopen keep immutable original proof with zero rereads or extra Reports; the separate ordinary Assignment is not a replay', { report_count: reopenedDetail.reports.length, artifact_count: reopenedDetail.artifacts.length, resumed_session: true, new_enrollment: false, other_assignment_is_distinct: true, source_effects_unchanged: true })
  settled = true
} catch (error) {
  console.error(redact(error.message || error, [...secrets, privateMarker, siblingMarker]))
  checks.push({ name: 'failure', status: 'FAIL', evidence: 'Bounded sanitized failure; see diagnostics.' })
} finally {
  if (context) await context.close().catch(() => {})
  if (preview?.httpServer) await new Promise(resolve => preview.httpServer.close(() => resolve())).catch(() => {})
  if (host) { secrets.push(...[host.env?.LOOM_FIXTURE_ENROLLMENT_CODE].filter(Boolean)); await host.stop().catch(() => {}) }
  if (server) await server.stop().catch(() => {})
  const diagnostics = host?.diagnostics?.() || ''
  const result = report(settled ? 'PASS' : 'FAIL', diagnostics)
  publicClean(result)
  if (output) { await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 }) }
  if (root && !keep && !process.env.LOOM_TEST_ROOT) {
    const canonicalTmp = await realpath(tmpdir())
    assert.equal(await realpath(root), root)
    assert.ok(root.startsWith(canonicalTmp + '/loom-dsh-'))
    await rm(root, { recursive: true, force: true })
  }
  console.log(JSON.stringify(result, null, 2)); if (!settled) process.exitCode = 1
}

async function browserCheck(projectId, ticketId) {
  const appRoot = resolve('apps/web'), origin = server.baseUrl
  const helper = join('scripts', 'fixtures', 'vite-server.mjs')
  await command('pnpm', ['--dir', 'apps/web', 'build'], { cwd: resolve('.'), env: { PATH: process.env.PATH }, timeoutMs: 120_000 })
  if (await access(helper).then(() => true, () => false)) {
    const { startViteServer } = await import(pathToFileURL(resolve(helper)).href)
    preview = await startViteServer({ root, serverUrl: origin, appRoot })
  } else {
    process.env.LOOM_TEST_CONCIERGE_URL = origin
    const { preview: createPreview } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
    preview = await createPreview({ root: appRoot, configFile: resolve('tests/browser/vite.config.mjs'), logLevel: 'error', cacheDir: join(root, 'vite-cache'),
      preview: { host: '127.0.0.1', port: 0, strictPort: true }, build: { outDir: join(appRoot, 'dist') },
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/api': { target: origin, changeOrigin: true } } } })
  }
  const appOrigin = preview.origin || `http://127.0.0.1:${preview.httpServer.address().port}`
  context = await chromium.launchPersistentContext(join(root, 'browser-profile'), { executablePath: process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true,
    viewport: { width: 1280, height: 960 }, args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--no-proxy-server'], env: { PATH: process.env.PATH, TMPDIR: root }, timeout: 30_000 })
  const page = context.pages()[0]; page.setDefaultTimeout(20_000)
  const screenshot = async name => { await page.screenshot({ path: join(root, `${name}.png`), fullPage: true }); await access(join(root, `${name}.png`)); browserScreenshots[name] = join(root, `${name}.png`) }
  const failures = []
  page.on('pageerror', error => failures.push(error.message))
  page.on('request', request => { const target = new URL(request.url()); if (![appOrigin, origin].includes(target.origin)) throw new Error('Browser escaped the owned fixture') })
  await page.goto(appOrigin, { waitUntil: 'domcontentloaded' }); await page.locator('.loom-app').waitFor()
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(server.clientToken)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
  try {
  await page.locator('.detail-actions').getByRole('button', { name: '新的任务', exact: true }).click()
  await page.locator('.ticket-item').first().waitFor()
  const selectedTicket = page.locator('.ticket-item').filter({ hasText: ticketId.slice(0, 6) })
  await selectedTicket.first().click()
  await page.locator('.ticket-id').filter({ hasText: ticketId }).waitFor()
  await page.locator('.ticket-detail').getByText('收到成功报告', { exact: true }).waitFor()
  await page.getByRole('tab', { name: '协作', exact: true }).click()
  const processToggle = page.getByRole('checkbox', { name: '展开过程消息', exact: true })
  if (!await processToggle.isChecked()) await page.locator('label.switch-label').filter({ hasText: '展开过程消息' }).click()
  await page.locator('.collab-message, .activity-intro').first().waitFor()
  await screenshot('sensitive-read-collaboration')
  await page.getByRole('tab', { name: '审计', exact: true }).click()
  await page.locator('.audit-event').first().waitFor()
  await screenshot('sensitive-read-audit')
  await page.getByRole('tab', { name: 'Activity', exact: true }).click()
  await page.locator('.artifact-card').click(); await page.locator('.code-artifact .facts').waitFor()
  await page.locator('.original-bytes summary').click()
  assert.equal(JSON.parse(await page.locator('.artifact-content').innerText()).raw_artifact_published, false)
  await page.locator('details.technical-details summary').click()
  assert.equal(await page.locator('details.technical-details').evaluate(row => row.open), true)
  const visibleControls = await page.getByRole('checkbox').evaluateAll(rows => rows.map(row => ({ aria: row.getAttribute('aria-label'), visible: row.getBoundingClientRect().width > 0, disabled: row.disabled })))
  assert.deepEqual(JSON.stringify(visibleControls).includes('undefined'), false)
  const perf = await page.evaluate(() => ({ navigation: performance.getEntriesByType('navigation').map(row => row.duration), resources: performance.getEntriesByType('resource').length }))
  assert.ok(perf.navigation.every(value => Number.isFinite(value) && value >= 0) && perf.resources > 0)
  await screenshot('sensitive-read-desktop')
  await page.setViewportSize({ width: 390, height: 900 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await screenshot('sensitive-read-narrow')
  publicClean(await page.locator('body').innerText()); assert.deepEqual(failures, [])
  } catch (error) {
    await page.screenshot({ path: join(root, 'sensitive-read-failure.png'), fullPage: true })
    browserScreenshots.failure = join(root, 'sensitive-read-failure.png')
    const body = await page.locator('body').innerText()
    console.error(redact(body.slice(-12000), [...secrets, privateMarker, siblingMarker]))
    throw error
  }
  await context.close(); context = null
  if (preview) await new Promise(resolve => preview.httpServer.close(() => resolve())); preview = null
  pass('production Vue shows collaboration/audit and opened immutable evidence without private bytes; one page narrows to 390px', { production_static_build: true, collaboration_and_audit_expanded: true, viewport_widths: [1280, 390], performance_observed: true, mobile_device: 'NOT RUN', project_id: projectId })
}
