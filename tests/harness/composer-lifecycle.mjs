import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { chromium } from '../browser/node_modules/playwright-core/index.mjs'
import { installation, isolatedEnv, fixtureRoot, installBundles, redact, sleep } from './environment.mjs'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

// This driver composes existing behavior, not a second lifecycle implementation.
// It creates Tickets ONLY from the production Vue main TicketComposer. The
// explicit Binding/Grant are administrator setup; no Source phrase parser is used.
const started = Date.now()
const root = await realpath(await fixtureRoot(process.env.LOOM_TEST_ROOT))
const keep = process.env.LOOM_TEST_KEEP_EVIDENCE === 'true'
const output = resolve(process.env.LOOM_TEST_OUTPUT || '/tmp/loom-composer-lifecycle-proof.json')
const sourceMarker = 'ORBITAL-731-private-composer-source'
const sourceBytes = Buffer.from(`${sourceMarker}\nbounded synthetic composer input\n`)
const edge = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const browserDependency = JSON.parse(await readFile('tests/browser/node_modules/playwright-core/package.json', 'utf8'))
assert.equal(browserDependency.version, '1.65.1')
assert.ok((await stat(edge)).isFile())
const selectedRuntime = installation()
process.env.ELECTRON_RUN_AS_NODE = '1'
const dsh = JSON.parse(execFileSync(selectedRuntime.executable, ['-e', `console.log(require('node:fs').readFileSync(${JSON.stringify(join(selectedRuntime.install, 'package.json'))}, 'utf8'))`], { encoding: 'utf8', env: { PATH: process.env.PATH, DSH_INSTALL_DIR: selectedRuntime.install, ELECTRON_RUN_AS_NODE: '1' } }))
assert.equal(dsh.version, '0.2.2-rc.5')
const runtime = { dsh_package: dsh.name, dsh_version: dsh.version, electron: process.versions.electron || 'not-a-process-electron-version', node: process.version,
  playwright_core: browserDependency.version, edge: await realpath(edge), rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim() }
runtime.electron = execFileSync(selectedRuntime.executable, ['-e', 'console.log(process.versions.electron)'], { encoding: 'utf8', env: { PATH: process.env.PATH, DSH_INSTALL_DIR: selectedRuntime.install, ELECTRON_RUN_AS_NODE: '1' } }).trim()
const secrets = [], checks = [], screenshots = [], errors = [], outsidePaths = []
let server, admin, host, context, page
let failed
let finalFactsSnapshot
let finalAuditSnapshot
let resumeSnapshot
const createdTicketIds = new Set()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const clean = value => {
  const text = JSON.stringify(value)
  for (const secret of [...secrets, sourceMarker]) assert.equal(text.includes(secret), false)
  return value
}
const pass = (name, evidence) => { checks.push({ name, status: 'PASS', evidence }); console.log(`PASS composer-lifecycle: ${name}`) }
async function bounded(promise, label, ms = 20000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Bounded ${label} timeout: ${ms}ms`)), ms) })]) }
  finally { clearTimeout(timer) }
}
function control() {
  try { return readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) }
  catch { return [] }
}
function mapping() {
  try { return JSON.parse(readFileSync(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')).assignments }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
function sessionFor(id) { const idFound = mapping().find(row => row.assignment_id === id)?.session_id; assert.ok(idFound); return idFound }
async function waitFor(fn, label, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; assert.equal(host?.earlyExit, null, JSON.stringify(host?.earlyExit)); await sleep(120) }
  throw new Error(`Bounded wait exhausted: ${label}`)
}
async function ticket(id, status, ms = 45000) {
  const result = await waitFor(async () => { const detail = await admin.get(`/api/v1/tickets/${id}`); return !status || detail.status === status ? detail : undefined }, `Ticket ${id} -> ${status}`, ms)
  assert.equal(result.id, id)
  return result
}
async function screenshot(name) {
  assert.equal(await page.locator('#client-token, .enrollment-code').count(), 0)
  const body = await page.locator('body').innerText()
  for (const secret of [...secrets, sourceMarker]) assert.equal(body.includes(secret), false)
  const path = join(root, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  screenshots.push({ name, bytes: (await stat(path)).size, sha256: hash(await readFile(path)) })
}
function counts() {
  const rows = control()
  return { requests: rows.filter(row => row.type === 'request').length,
    holds: rows.filter(row => row.type === 'hold').length,
    inspect_execute: rows.filter(row => row.type === 'tool-execute' && row.name === 'loom_fixture_inspect').length,
    write_execute: rows.filter(row => row.type === 'tool-execute' && row.name === 'loom_fixture_write').length }
}
function dbFacts() {
  // A read-only fact projection. This driver never changes center state by SQL.
  const db = new DatabaseSync(join(server.dataDir, 'loom.sqlite3'), { readOnly: true })
  try {
    const count = table => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
    const tickets = db.prepare('SELECT id,objective,kind,status,grant_id,grant_digest,node_id,installation_id,worker_id,cancel_requested FROM tickets ORDER BY created_at,id').all()
    const relations = tickets.filter(t => createdTicketIds.has(t.id)).map(t => ({
      ...t,
      assignments: db.prepare('SELECT id,ticket_id,attempt,lease_id,lease_epoch,acknowledged_at,last_report_at FROM assignments WHERE ticket_id=? ORDER BY created_at').all(t.id),
      reports: db.prepare('SELECT id,ticket_id,assignment_id,request_id,state,cancel_acknowledged,lease_epoch,node_id FROM reports WHERE ticket_id=? ORDER BY created_at').all(t.id),
      artifacts: db.prepare('SELECT id,assignment_id,origin_node_id,size_bytes,sha256,read_evidence_json FROM artifacts WHERE ticket_id=? ORDER BY id').all(t.id),
      effects: db.prepare('SELECT id,assignment_id,node_id,status FROM effects WHERE ticket_id=?').all(t.id),
      sessions: db.prepare("SELECT id,request_id,session_ref,sender FROM messages WHERE ticket_id=? AND kind='session_link' ORDER BY id").all(t.id),
    }))
    return { schema: Number(db.prepare('PRAGMA user_version').get().user_version), quick_check: db.prepare('PRAGMA quick_check').get().quick_check,
      counts: Object.fromEntries(['tickets','assignments','reports','artifacts','effects','grants','source_events','source_work_specs','memories','install_plans'].map(table => [table, count(table)])),
      requestReceipts: Object.fromEntries(db.prepare("SELECT request_id,response FROM requests WHERE route='events'").all().map(row => [row.request_id, row.response])),
      admissionAudits: db.prepare("SELECT action,ticket_id,evidence FROM audits WHERE action='assignment.acknowledged'").all(), relations }
  } finally { db.close() }
}
function cleanFacts(value) { const { requestReceipts, ...stable } = value; return JSON.parse(JSON.stringify(stable, (key, item) => ['acknowledged_at','last_report_at'].includes(key) ? Boolean(item) : item)) }
async function stablePublic() {
  const audit = await admin.get('/api/v1/audit/verify'); assert.equal(audit.valid, true)
  assert.equal(audit.algorithm, 'sha256_chain_v1')
  return clean({ tickets: (await admin.get('/api/v1/tickets')).tickets, grants: (await admin.get('/api/v1/grants')).grants, audit })
}
async function stopHost() { if (!host) return; const result = await bounded(host.stop(), 'host shutdown', 28000); assert.equal(result?.code, 0, JSON.stringify(result)); assert.equal(result?.signal, null); host = null }
async function stopCenter() { if (!server) return; await bounded(server.stop(), 'Rust shutdown', 10000); assert.doesNotMatch(server.diagnostics(), /Error|panic/i); server = null }
async function createTicket(objective, path = 'input.txt') {
  if (await page.locator('.ticket-detail').count()) await page.getByRole('button', { name: '新的任务', exact: true }).click()
  await page.locator('.composer[aria-label="新任务"]').waitFor()
  await page.locator('#task-objective').fill(objective)
  assert.equal(await page.locator('#task-objective').inputValue(), objective)
  await page.locator('#read-relative-path').fill(path)
  const posted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/tickets')
  await page.getByRole('button', { name: '开始任务', exact: true }).click()
  const response = await posted
  assert.equal(response.status(), 200)
  const actual = JSON.parse(response.request().postData())
  assert.deepEqual(actual, { project_id: actual.project_id, objective, kind: 'read_summary', relative_path: path })
  const accepted = await response.json()
  createdTicketIds.add(accepted.id)
  assert.equal(accepted.objective, objective)
  await page.locator('.ticket-detail .ticket-id').filter({ hasText: accepted.id }).waitFor()
  return accepted
}
async function openTicket(id) {
  if (await page.locator('.ticket-detail').count()) await page.getByRole('button', { name: '新的任务', exact: true }).click()
  assert.equal(await page.locator('.ticket-detail').count(), 0)
  await page.locator('.composer[aria-label="新任务"]').waitFor()
  const summary = (await admin.get('/api/v1/tickets')).tickets.find(row => row.id === id); assert.ok(summary)
  await page.locator('.ticket-item').filter({ hasText: summary.objective }).click()
  await page.locator('.ticket-detail .ticket-id').filter({ hasText: id }).waitFor()
}
async function verifySqlRelations(facts, setup, byObjective) {
  assert.equal(facts.quick_check, 'ok'); assert.equal(facts.schema, 16)
  for (const row of facts.relations) {
    assert.equal(row.grant_id, setup.grant.id); assert.equal(row.node_id, setup.node.id); assert.equal(row.installation_id, setup.node.installation_id); assert.equal(row.worker_id, 'default')
    assert.equal(row.assignments.length, 1)
    const assignment = row.assignments[0]
    assert.equal(assignment.ticket_id, row.id)
    assert.equal(Number.isNaN(Date.parse(assignment.acknowledged_at)), false)
    assert.notEqual(Date.parse(assignment.acknowledged_at), Date.parse('invalid'))
    const admission = facts.admissionAudits.filter(audit => audit.ticket_id === row.id && JSON.parse(audit.evidence)?.evidence?.assignment_id === assignment.id)
    assert.ok(admission.length >= 1)
    for (const audit of admission) {
      const envelope = JSON.parse(audit.evidence)
      assert.equal(envelope.event_type, 'assignment.acknowledged')
      assert.equal(envelope.evidence.assignment_id, assignment.id)
      assert.equal(envelope.evidence.delivered_is_not_read, true)
      assert.equal(Number.isNaN(Date.parse(envelope.created_at)), false)
      assert.equal(Number.isNaN(Date.parse(assignment.acknowledged_at)), false)
    }
    if (assignment.last_report_at !== null) assert.equal(Number.isNaN(Date.parse(assignment.last_report_at)), false)
    assert.equal(row.reports.length, 1)
    assert.equal(row.reports[0].assignment_id, assignment.id)
    assert.equal(row.reports[0].ticket_id, row.id)
    assert.equal(row.reports[0].node_id, setup.node.id)
    assert.equal(row.reports[0].lease_epoch, assignment.lease_epoch)
    if (row.status === 'succeeded') assert.equal(row.reports[0].state, 'succeeded')
    else if (row.status === 'failed') assert.equal(row.reports[0].state, 'failed')
    else if (row.status === 'cancelled') {
      assert.equal(row.reports[0].state, 'cancelled')
      assert.ok([true, 1].includes(row.reports[0].cancel_acknowledged))
    } else assert.fail(`Unexpected Composer lifecycle task state ${row.status}`)
    assert.equal(row.sessions.length, 1)
    const session = sessionFor(assignment.id)
    const link = row.sessions[0]
    assert.ok(link.request_id, 'Authenticated Node event receipt name is the link to the immutable request')
    const ref = typeof link.session_ref === 'string' ? JSON.parse(link.session_ref) : link.session_ref
    assert.equal(ref.session_id, session); assert.equal(ref.harness, 'dsh')
    const receipt = facts.requestReceipts[link.request_id]
    assert.ok(receipt, 'Persisted event request receipt exists')
    const delivery = JSON.parse(receipt)
    assert.equal(delivery.accepted, true); assert.equal(delivery.message_id, link.id)
    assert.deepEqual(delivery.stored_session_ref, ref)
    assert.equal(row.assignments[0].lease_epoch, row.reports[0].lease_epoch)
    for (const artifact of row.artifacts) { assert.equal(artifact.assignment_id, row.assignments[0].id); assert.equal(artifact.origin_node_id, setup.node.id) }
    for (const report of row.reports) assert.equal(report.node_id, setup.node.id)
  }
  for (const [name, objective] of Object.entries(byObjective)) {
    const row = facts.relations.find(row => row.objective === objective); assert.ok(row, name)
    assert.equal(row.assignments.length, 1); assert.equal(row.assignments[0].acknowledged_at ? true : false, true); assert.equal(Boolean(row.assignments[0].last_report_at), true)
  }
}
async function main() {
  await cp('apps/web/dist', join(root, 'web-dist'), { recursive: true })
  await mkdir(join(root, 'rust'), { mode: 0o700 })
  await writeFile(join(root, 'project', 'input.txt'), sourceBytes, { mode: 0o600 })
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  const wrapperPath = join(root, 'serve.mjs')
  const wrapper = `import{spawn}from'node:child_process';const c=spawn(${JSON.stringify(join(process.cwd(),'target/debug/loom'))},[...process.argv.slice(2),'--web-dir',${JSON.stringify(join(root,'web-dist'))}],{shell:false,stdio:'inherit'});const by=c;for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>by.kill(s));c.on('exit',(code,signal)=>process.exit(code??(signal?1:1)));`
  await writeFile(wrapperPath, wrapper, { mode: 0o700 })
  const baseEnv = isolatedEnv(root)
  server = await startRustConcierge({ root: join(root, 'rust'), env: { ...baseEnv, LOOM_SERVER_CMD: `${process.execPath} ${wrapperPath}` } })
  secrets.push(server.clientToken)
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 10000 })
  const project = await admin.post('/api/v1/projects', { name: 'Composer owned fixture', root: join(root, 'project'), mode: 'read_write' })
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  secrets.push(enrollment.code)
  const { executable, cli } = installation()
  let env = isolatedEnv(root, { LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl, LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code, LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [project.project.id]: join(root, 'project') }) })
  const installed = await installBundles({ env, root, cli, executable, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
  const sourceConsistency = []
  async function comparePackage(relative = '') {
    const source = join('plugins/dsh-loom', relative), delivered = join(root, 'fixture-packages/dsh-loom', relative)
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(relative, entry.name)
      if (child === 'test' || child.startsWith('test/')) continue
      if (entry.isDirectory()) await comparePackage(child)
      else if (entry.isFile()) {
        const original = await readFile(join(source, entry.name)); const actual = await readFile(join(delivered, entry.name))
        assert.ok(original.equals(actual), `Installed package changed: ${child}`)
        sourceConsistency.push({ path: child, sha256: hash(original) })
      }
    }
  }
  await comparePackage()
  host = new FixtureHost(root, env, secrets); await host.start()
  const node = await waitFor(async () => (await admin.get('/api/v1/nodes')).nodes.find(row => row.status === 'online' && row.inventory?.project_roots?.[project.project.id] === join(root, 'project')), 'real Node registration')
  const binding = await admin.post('/api/v1/project-bindings', { project_id: project.project.id, node_id: node.id, worker_id: 'default', root_scope: join(root, 'project') })
  const grant = (await admin.post('/api/v1/grants', { project_id: project.project.id, project_binding_id: binding.id, node_id: node.id, worker_id: 'default', operations: ['read', 'write'] })).grant
  pass('isolated rc.5 installation, real center/Node and explicit immutable authority', { dsh: dsh.version, profile: installed.profile, project_binding: binding.id, node_id: node.id, grant_id: grant.id, copied_lib_sources_match: true })
  context = await bounded(chromium.launchPersistentContext(join(root, 'browser-profile'), { executablePath: edge, headless: true, viewport: { width: 1280, height: 1000 },
    args: ['--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-component-update','--no-proxy-server'], env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, timeout: 25000 }), 'owned Edge launch', 30000)
  page = context.pages()[0]; page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (['http:','https:'].includes(url.protocol) && url.origin !== server.baseUrl) { outsidePaths.push(`${url.protocol}//${url.hostname}`); return route.abort('blockedbyclient') }
    return route.continue()
  })
  await page.goto(server.baseUrl)
  await page.locator('.loom-app').waitFor()
  const asset = await page.locator('script[type="module"]').getAttribute('src'); assert.ok(asset?.startsWith('/assets/'))
  const js = await page.evaluate(async path => { const response = await fetch(path); return { type: response.headers.get('content-type'), prefix: (await response.text()).slice(0, 80) } }, asset)
  assert.match(js.type, /javascript/); assert.ok(!js.prefix.includes('<!doctype'))
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(server.clientToken)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
  await page.locator('.composer[aria-label="新任务"]').waitFor()
  const objectives = {
    read: 'LOOM_FIXTURE_READ composer literal input.txt; invoke exactly one controlled inspect.',
    traversal: 'LOOM_FIXTURE_TRAVERSAL composer literal ../escape.html; let the actual tool reject traversal.',
    cancel: 'LOOM_FIXTURE_CANCEL composer; hold until the user cancels this actual running turn.',
    resume: 'LOOM_FIXTURE_RESUME composer ordinary objective; inspect retained read history only.',
  }
  const beforeBrowserTicketPosts = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/tickets' && request.method() === 'POST') beforeBrowserTicketPosts.push(request.postData())
  })
  const read = await createTicket(objectives.read)
  await host.waitFor(() => mapping().some(row => row.assignment_id === read.assignments[0].id), 15000, 'read Session mapping')
  const readSession = sessionFor(read.assignments[0].id)
  const readDone = await ticket(read.id, 'succeeded')
  assert.equal(readDone.artifacts.length, 1); assert.equal(readDone.reports.length, 1); assert.equal(readDone.effects.length, 0)
  const readArtifact = await admin.get(`/api/v1/tickets/${read.id}/artifacts/${readDone.artifacts[0].id}`)
  const proof = JSON.parse(readArtifact.content)
  assert.equal(proof.source.sha256 ?? proof.source.bytes, hash(sourceBytes)); assert.equal(proof.source.size_bytes, sourceBytes.length); assert.equal(proof.source.path, 'input.txt'); assert.equal(proof.raw_artifact_published, false); assert.equal(proof.text, undefined)
  assert.equal(readArtifact.artifact.read_evidence.sha256, hash(sourceBytes)); assert.equal(readArtifact.artifact.read_evidence.call_id, 'loom-fixture-controlled-read')
  assert.equal(host.sessionEvents(readSession, ['tool/call']).filter(e => e.event.data.name === 'loom_fixture_inspect').length, 1)
  assert.equal(host.sessionEvents(readSession, ['tool/result']).filter(e => e.event.data.message.toolCallId === 'loom-fixture-controlled-read').length, 1)
  await page.locator('.artifact-card').click(); await page.locator('.code-artifact .facts').waitFor()
  assert.match(await page.locator('.code-artifact .facts').innerText(), /loom_fixture|input\.txt/)
  await page.locator('.original-bytes summary').click()
  assert.deepEqual(JSON.parse(await page.locator('.code-artifact .artifact-content').innerText()), proof)
  assert.equal(JSON.stringify(readArtifact.content).includes(sourceMarker), false)
  assert.deepEqual(await readFile(join(server.dataDir, 'artifacts', `${readDone.artifacts[0].id}.artifact`)), Buffer.from(readArtifact.content))
  await page.locator('.next-action-card.success-action').waitFor()
  await screenshot('01-read-public-proof')
  pass('normal main Composer creates one genuine inspect/proof; source bytes correspond but are not public', { ticket_id: read.id, artifact_id: readDone.artifacts[0].id, session_id: readSession, sha256: hash(sourceBytes), inspect_calls: 1, raw_public: false })

  const traversal = await createTicket(objectives.traversal)
  const traversalDone = await ticket(traversal.id, 'failed')
  assert.equal(traversalDone.artifacts.length, 0); assert.equal(traversalDone.effects.length, 0); assert.equal(traversalDone.reports.length, 1)
  const traversalSession = sessionFor(traversal.assignments[0].id)
  const invalid = host.sessionEvents(traversalSession, ['tool/result']).find(e => e.event.data.message.toolCallId === 'loom-fixture-invalid-write'); assert.ok(invalid)
  assert.equal(invalid.event.data.message.isError, true); assert.match(invalid.event.data.message.content.map(x => x.text || '').join(''), /limited to demo\.html/)
  assert.match(traversalDone.reports[0].summary, /limited to demo\.html/)
  await page.locator('.next-action-card.danger-action').waitFor()
  await screenshot('02-tool-rejection')
  await access(join(root, 'escape.html')).then(() => assert.fail('outside file exists'), error => assert.equal(error.code, 'ENOENT'))
  pass('Composer objective is not an escape hatch: real ToolResult fails and no outside bytes exist', { ticket_id: traversal.id, session_id: traversalSession, tool_error: true, outside_file_created: false })

  const cancel = await createTicket(objectives.cancel)
  await host.waitFor(() => control().some(row => row.type === 'hold'), 15000, 'running hold')
  await openTicket(cancel.id)
  const stopRequest = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/tickets/${cancel.id}/cancel`)
  await page.getByRole('button', { name: '取消任务', exact: true }).click(); await page.getByRole('button', { name: '确认取消任务', exact: true }).click()
  const stopResponse = await stopRequest; assert.equal(stopResponse.status(), 200)
  const stopReceipt = await stopResponse.json(); assert.equal(stopReceipt.status, 'cancel_requested')
  const persistedStop = await ticket(cancel.id)
  assert.ok([true,1].includes(persistedStop.cancel_requested), 'The durable stop intent outlives the transitional DOM note.')
  const cancelDone = await ticket(cancel.id, 'cancelled')
  const cancelSession = sessionFor(cancel.assignments[0].id)
  await host.waitFor(() => host.stderr.some(text => text.includes(`actual cancel request ${cancel.assignments[0].id}: sent-to-running-agent`)), 10000, 'actual adapter bound cancel')
  const aborted = host.sessionEvents(cancelSession, ['turn/end']).filter(e => e.event.data.reason.kind === 'aborted' && e.event.data.reason.reason?.kind === 'user')
  assert.equal(aborted.length, 1); assert.equal(aborted[0].event.data.reason.kind, 'aborted'); assert.equal(aborted[0].event.data.reason.reason.kind, 'user')
  assert.equal(cancelDone.reports.length, 1); assert.ok([true,1].includes(cancelDone.reports[0].cancel_acknowledged)); assert.equal(cancelDone.artifacts.length, 0); assert.equal(cancelDone.effects.length, 0)
  assert.equal(beforeBrowserTicketPosts.length, 3)
  assert.deepEqual(beforeBrowserTicketPosts.map(body => JSON.parse(body).objective), [objectives.read, objectives.traversal, objectives.cancel])
  for (const body of beforeBrowserTicketPosts.map(JSON.parse)) {
    assert.equal(body.project_id, project.project.id)
    assert.equal(body.kind, 'read_summary')
    assert.equal(body.relative_path, 'input.txt')
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.ticket-detail .ticket-id').filter({ hasText: cancel.id }).waitFor()
  await page.locator('.detail-title .status-badge').filter({ hasText: '已取消' }).waitFor()
  await page.locator('.next-action-card.neutral-action').filter({ hasText: '任务已取消' }).waitFor()
  await screenshot('03-cancel-acknowledged')
  pass('UI cancel_requested reaches the exact running Agent cancel and durable canceled Report', { ticket_id: cancel.id, session_id: cancelSession, native_abort: 'user', cancellation_acknowledged: true, artifacts: 0, effects: 0 })
  await page.setViewportSize({ width: 396, height: 1000 }); await sleep(150)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 397)
  await screenshot('04-396-desktop-viewport')
  await page.setViewportSize({ width: 1280, height: 1000 })
  const beforeDetails = Object.fromEntries(createdTicketIds.size ? (await Promise.all([...createdTicketIds].map(async id => [id, await admin.get(`/api/v1/tickets/${id}`)]))) : [])
  const beforeFacts = await dbFacts(), beforePublic = await stablePublic(), beforeControls = counts(), beforeMapping = readFileSync(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')
  assert.equal(beforeControls.inspect_execute, 1); assert.equal(beforeControls.write_execute, 0); assert.equal(beforeControls.requests, 5)
  const beforeBrowserWrites = []
  page.on('request', request => { if (['POST','PUT','PATCH','DELETE'].includes(request.method())) beforeBrowserWrites.push({ method: request.method(), path: new URL(request.url()).pathname }) })
  const persistedSession = join(root, 'dsh-test-state', 'sessions')
  assert.ok((await readdir(persistedSession)).length > 0)
  await stopHost()
  await bounded(context.browser().close(), 'intentional browser process close before center restart', 15000); context = null; page = null
  const port = server.baseUrl, token = server.clientToken, dataDir = server.dataDir
  await stopCenter()
  server = await startRustConcierge({ root: join(root, 'rust'), dataDir, baseUrl: port, env: { ...baseEnv, LOOM_CLIENT_TOKEN: token, LOOM_SERVER_CMD: `${process.execPath} ${wrapperPath}` } })
  admin = new LoomHttpClient({ baseUrl: port, clientToken: token, timeoutMs: 10000 })
  env = { ...env, LOOM_FIXTURE_ENROLLMENT_CODE: '', LOOM_FIXTURE_AGENT_SESSION_ID: readSession }
  host = new FixtureHost(root, env, secrets); await host.writePatch()
  const patch = await readFile(join(root, 'patch', 'fixture.yml'), 'utf8'); assert.match(patch, /agent_session_id: !!js process\.env\.LOOM_FIXTURE_AGENT_SESSION_ID \|\| ''/)
  await bounded(host.start(), 'reopened Host', 45000)
  const response = await bounded(host.raw('session/resume', { sessionId: readSession }), 'public Session resume')
  assert.deepEqual(response, {})
  await waitFor(() => mapping().some(row => row.assignment_id === read.assignments[0].id && row.session_id === readSession), 'original mapping retained')
  resumeSnapshot = { evidence: 'public session/resume returned empty success before UI reload' }
  assert.deepEqual(counts(), beforeControls); assert.deepEqual(readFileSync(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'), beforeMapping)
  assert.deepEqual(cleanFacts(await dbFacts()), cleanFacts(beforeFacts)); assert.deepEqual(await stablePublic(), beforePublic)
  for (const [id, previous] of Object.entries(beforeDetails)) assert.deepEqual(await admin.get(`/api/v1/tickets/${id}`), previous)
  await verifySqlRelations(beforeFacts, { node, grant }, { read: objectives.read, traversal: objectives.traversal, cancel: objectives.cancel })

  context = await bounded(chromium.launchPersistentContext(join(root, 'browser-profile'), { executablePath: edge, headless: true, viewport: { width: 1280, height: 1000 },
    args: ['--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-component-update','--no-proxy-server'], env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, timeout: 25000 }), 'same owned Edge profile reopen')
  page = context.pages()[0]; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
  beforeBrowserTicketPosts.length = 0
  beforeBrowserWrites.length = 0
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (['http:','https:'].includes(url.protocol) && url.origin !== server.baseUrl) { outsidePaths.push(`${url.protocol}//${url.hostname}`); return route.abort('blockedbyclient') }; return route.continue() })
  await page.goto(server.baseUrl); await page.locator('.ticket-detail h1').waitFor()
  // The last selected view can vary by navigation. Select the original explicitly.
  if (!(await page.locator('.ticket-detail .ticket-id').innerText().catch(() => '')).includes(read.id)) await openTicket(read.id)
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, 3)
  await page.locator('.artifact-card').click()
  await page.locator('.code-artifact .facts').waitFor()
  const reopenedProof = await admin.get(`/api/v1/tickets/${read.id}/artifacts/${readDone.artifacts[0].id}`)
  assert.deepEqual(reopenedProof, readArtifact)
  assert.deepEqual(await readFile(join(server.dataDir, 'artifacts', `${readDone.artifacts[0].id}.artifact`)), Buffer.from(reopenedProof.content))
  assert.match(await page.locator('.code-artifact .facts').innerText(), /input\.txt|loom_fixture/)
  assert.deepEqual(counts(), beforeControls); assert.equal(beforeBrowserTicketPosts.length, 0); assert.deepEqual(beforeBrowserWrites, [])
  assert.deepEqual(cleanFacts(await dbFacts()), cleanFacts(beforeFacts)); assert.deepEqual(await stablePublic(), beforePublic)
  for (const [id, previous] of Object.entries(beforeDetails)) assert.deepEqual(await admin.get(`/api/v1/tickets/${id}`), previous)
  await screenshot('05-reopen-original')
  pass('same db/token/port and same Host root plus browser reopen: no new Ticket/Grant/tool/provider', { same_session: readSession, before_counts: beforeCountsSummary(beforeFacts.counts), session_resume_receipt: resumeSnapshot, reload_new_ticket_posts: 0, new_grant: false, repeat_provider_calls: 0, repeat_tools: 0 })

  if (await page.locator('.ticket-detail').count()) await page.getByRole('button', { name: '新的任务', exact: true }).click()
  const resumed = await createTicket(objectives.resume)
  const resumedDone = await ticket(resumed.id, 'succeeded')
  assert.equal(resumedDone.artifacts.length, 1); assert.equal(sessionFor(resumed.assignments[0].id), readSession)
  const followup = control().filter(row => row.type === 'request' && row.session_id === readSession).at(-1); assert.equal(followup.tool_calls.includes('loom_fixture_inspect'), true)
  assert.equal(followup.call_count > control().filter(row => row.type === 'request' && row.session_id === readSession)[0].call_count, true)
  const resumedArtifact = await admin.get(`/api/v1/tickets/${resumed.id}/artifacts/${resumedDone.artifacts[0].id}`)
  const resumedProof = JSON.parse(resumedArtifact.content); assert.equal(resumedTextKind(resumedProof.text), 'history-accepted')
  assert.equal(JSON.parse(resumedDone.reports[0].evidence)[0].session_id, readSession)
  assert.deepEqual(counts(), { ...beforeControls, requests: beforeControls.requests + 1 })
  assert.deepEqual(readFileSync(join(root, 'project', 'input.txt')), sourceBytes)
  await page.locator('.artifact-card').click()
  await page.locator('.code-artifact .artifact-content').waitFor()
  await page.locator('.next-action-card.success-action').waitFor()
  await screenshot('06-original-session-resume')
  pass('new ordinary Composer followup uses the same persisted Session and observed prior inspect Artifact history', { ticket_id: resumed.id, original_ticket_id: read.id, session_id: readSession, session_identity_not_sql_fabricated: true, earlier_history_visible_to_stub: true, additional_provider_requests: 1, repeat_read: 0 })
  await verifySqlRelations(await dbFacts(), { node, grant }, { read: objectives.read, traversal: objectives.traversal, cancel: objectives.cancel, resume: objectives.resume })
  finalFactsSnapshot = await dbFacts()
  finalAuditSnapshot = (await admin.get('/api/v1/audit')).audit
  const finalFacts = finalFactsSnapshot
  assert.deepEqual(finalFacts.counts, { ...beforeFacts.counts, tickets: 4, assignments: 4, reports: 4, artifacts: 2, effects: 0 })
  const cancelledSql = finalFacts.relations.find(row => row.objective === objectives.cancel); assert.equal(cancelledSql.cancel_requested, 1); assert.equal(cancelledSql.status, 'cancelled'); assert.ok([1,true].includes(cancelledSql.reports[0].cancel_acknowledged))
  assert.deepEqual(outsidePaths, []); assert.deepEqual(errors, [])
  await artifactLastFreshReload(read.id)
  assert.deepEqual(counts(), { ...beforeControls, requests: beforeControls.requests + 1 })
  assert.deepEqual(await readFile(join(server.dataDir, 'artifacts', `${readDone.artifacts[0].id}.artifact`)), Buffer.from(readArtifact.content))
  await screenshot('07-final-public-history')
  pass('final read-only reload preserves original Artifact/Grant and exact four distinct Ticket graphs', { overall_counts: { tickets:4, assignments:4, reports:4, artifacts:2, effects:0, grants:1 }, cancelled_no_artifact: true, original_artifact_bytes_unchanged: true, source_specs_created: 0 })
}
function beforeCountsSummary(counts) { return { tickets: counts.tickets, assignments: counts.assignments, reports: counts.reports, artifacts: counts.artifacts, effects: counts.effects, grants: counts.grants } }
function resumedTextKind(text) { assert.match(text, /resumed Session reused loom_fixture_inspect/); assert.match(text, /retained synthetic input/); return 'history-accepted' }
async function artifactLastFreshReload(id) {
  await openTicket(id)
  await page.locator('.artifact-card').click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.ticket-detail .ticket-id').filter({ hasText: id }).waitFor()
  assert.equal(await page.locator('.composer .source-open-button').count(), 0)
  await page.locator('.artifact-card').click(); await page.locator('.code-artifact .facts').waitFor()
  const originalSourceDigest = await page.locator('.code-artifact .facts').innerText()
  assert.match(originalSourceDigest, /input\.txt/)
}
try { await bounded(main(), 'full composer lifecycle', 160000) }
catch (error) { failed = error; console.error(redact(error.stack || error, [...secrets, sourceMarker])); process.exitCode = 1 }
finally {
  try {
    await bounded((async () => {
      if (context) { const browser = context.browser(); if (browser) await bounded(browser.close(), 'browser close', 15000); else await bounded(context.close(), 'browser context close', 15000); context = null; page = null }
      if (host) await stopHost()
      if (server) await stopCenter()
      await writeFile(join(root, 'private', 'driver-exit.json'), JSON.stringify({ actual_exit: 'bounded processes closed', real_driver_exit: failed ? 1 : 0 }) + '\n', { mode: 0o600 })
    })(), 'cleanup', 40000)
  } catch (error) {
    failed ||= error; process.exitCode = 1; console.error('Cleanup assertion:', error.message)
    // Last-resort stopping is owned-instance-only, never a profile/name pattern.
    if (host?.child && !host.earlyExit) host.child.kill('SIGKILL')
    if (server) await server.stop().catch(() => {})
    if (context) await context.close().catch(() => {})
  }
  const dbPath = join(root, 'rust', 'concierge', 'loom.sqlite3')
  let finalFacts = finalFactsSnapshot ? { schema: finalFactsSnapshot.schema, quick_check: finalFactsSnapshot.quick_check, counts: finalFactsSnapshot.counts } : null
  if (await access(dbPath).then(() => true, () => false)) {
    const finalDatabase = new DatabaseSync(dbPath, { readOnly: true })
    try { finalFacts = { quick_check: finalDatabase.prepare('PRAGMA quick_check').get().quick_check, schema: Number(finalDatabase.prepare('PRAGMA user_version').get().user_version) } }
    finally { finalDatabase.close() }
  }
  const report = { schema: 'loom.composer-lifecycle.v1', overall: failed ? 'FAIL' : 'PASS', command: 'LOOM_TEST_OUTPUT=/tmp/loom-composer-lifecycle-proof.json LOOM_TEST_KEEP_EVIDENCE=true node tests/harness/composer-lifecycle.mjs',
    real_dsh: host === null ? 'executed rc.5 fixture with bounded exits' : 'NOT SETTLED', checks, runtime, screenshots, errors, diagnostics: redact(failed?.stack || '', [...secrets, sourceMarker]).slice(-8000),
    actual_cleanup: { browser_closed: context === null, host_closed: host === null, center_closed: server === null, owned_fixture_exits_observed: host === null && server === null && context === null, sql_final: finalFacts, output },
    not_claimed: ['general natural-language routing or automatic Grant inference', 'live model/provider quality', 'physical mobile or 396px phone lifecycle', 'second physical Host', 'generic DLP/transcript public projection', 'global exactly-once'] }
  await writeFile(output, JSON.stringify(clean(report), null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ overall: report.overall, output, elapsed_ms: Date.now() - started, checks: checks.length }))
  if (!keep && !process.env.LOOM_TEST_ROOT && !failed) {
    const tmp = await realpath(tmpdir()); assert.equal(await realpath(root), root); assert.ok(root.startsWith(`${tmp}/loom-dsh-`)); await rm(root, { recursive:true, force:true })
  }
}
