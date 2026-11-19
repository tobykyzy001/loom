import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile, rm, access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installation, isolatedEnv, fixtureRoot, installBundles, redact, sleep } from './environment.mjs'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { chromium } from '../browser/node_modules/playwright-core/index.mjs'

const root = await realpath(await fixtureRoot(process.env.LOOM_TEST_ROOT))
const keep = process.env.LOOM_TEST_KEEP_EVIDENCE === 'true'
const output = resolve(process.env.LOOM_TEST_OUTPUT || '/tmp/loom-source-intent-proof.json')
const appRoot = resolve('apps/web')
const projectRoot = join(root, 'project')
const marker = 'SYNTHETIC-CONVERSE-ONLY-8a45df93d803'
const secrets = [], checks = [], requests = [], browserErrors = []
let server, admin, host, node, projectId, grant, sessionId, ticket, context, preview, page
let origin
const outcome = { status: 'FAIL' }
const clean = value => {
  const serialized = JSON.stringify(value)
  for (const privateValue of [...secrets, marker]) assert.equal(serialized.includes(privateValue), false)
  return value
}
const pass = (name, evidence = {}) => { checks.push({ name, status: 'PASS', evidence }); console.log(`PASS source-intent: ${name}`) }
async function terminal(id) {
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    const detail = await admin.get(`/api/v1/tickets/${id}`)
    if (['succeeded', 'failed', 'cancelled', 'reconciling'].includes(detail.status)) return detail
    await sleep(150)
  }
  throw new Error('Owned conversation Ticket did not settle')
}
async function thread() {
  const source = (await admin.get('/api/v1/sources')).sources.find(row => row.source_key === 'browser-source')
  assert.ok(source)
  const page = await admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(source.id)}&thread_id=browser-thread&limit=200`)
  for (const event of page.events) {
    assert.equal(event.source_id, source.id)
    assert.equal(event.client_thread_id, 'browser-thread')
  }
  return { source, page }
}
async function screenshot(page, name) {
  assert.equal(await realpath(root), root)
  assert.ok(root.includes('loom-dsh-'))
  await page.screenshot({ path: join(root, `${name}.png`), fullPage: true })
}
async function preparePair(page, currentGrant) {
  let count = await page.locator('.source-event-card').count()
  const record = async text => {
    // A Playwright click returns after dispatch, not after the handler finishes.
    // Wait until both local opening and global Source read/write latches settle
    // on the actual rendered control before issuing the next distinct record.
    await page.waitForFunction(() => {
      const button = document.querySelector('.source-work-panel .button-row .button.secondary:nth-child(2)')
      return button instanceof HTMLButtonElement && !button.disabled
    })
    await page.locator('#source-message').fill(text)

    const postedResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/source-events' && response.status() === 200)
    const storedResponse = page.waitForResponse(async response => {
      if (response.request().method() !== 'GET' || new URL(response.url()).pathname !== '/api/v1/source-events' || response.status() !== 200) return false
      const body = await response.json().catch(() => null)
      return body?.events?.length === count + 1 && body.events[count]?.content === text
    })
    await page.getByRole('button', { name: '记录完整消息（不创建 Ticket）', exact: true }).click()
    const posted = await postedResponse
    assert.equal((await posted.json()).content, text)
    const fetched = await storedResponse
    await fetched.finished()
    const history = await fetched.json()
    assert.equal(history.events.length, count + 1, 'The new protected source read must contain the newly accepted event')
    await page.locator('.source-event-card').nth(count).waitFor({ state: 'attached' })
    count += 1
  }
  const firstText = '读取 input.txt'
  await record(firstText)
  await page.locator('.source-event-card').last().getByRole('button', { name: '基于此消息创建摘要', exact: true }).click()
  assert.equal(await page.locator('#source-grant').inputValue(), '', 'First utterance never chooses an implicit Grant')
  await record(`用 Grant ${currentGrant.id}`)
  await page.locator('.source-event-card').last().getByRole('button', { name: '基于此消息创建摘要', exact: true }).click()
  await page.locator('#source-grant').waitFor({ state: 'visible' })
  return { firstText }
}

try {
  assert.equal(process.env.DSH_PROFILE, 'desktop', 'Only runtime facts; only the isolated fixture is modified')
  await access(join(appRoot, 'dist', 'index.html'))
  await mkdir(projectRoot, { recursive: true })
  const bytes = Buffer.from(`${marker}\nSynthetic source for a two-utterance bounded read.\n`)
  await writeFile(join(projectRoot, 'input.txt'), bytes, { mode: 0o600 })
  await mkdir(join(root, 'private'), { recursive: true })
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  const { executable, cli } = installation()
  server = await startRustConcierge({ root: join(root, 'rust') })
  origin = server.baseUrl
  process.env.LOOM_TEST_CONCIERGE_URL = origin
  admin = new LoomHttpClient({ baseUrl: origin, clientToken: server.clientToken })
  secrets.push(server.clientToken)
  const project = await admin.post('/api/v1/projects', { name: 'Two utterances, one bounded read', root: projectRoot, mode: 'read_write' })
  projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  secrets.push(enrollment.code)
  const env = isolatedEnv(root, { LOOM_FIXTURE_COORDINATOR_URL: origin, LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code,
    LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [projectId]: projectRoot }) })
  await installBundles({ env, root, cli, executable, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
  host = new FixtureHost(root, env, secrets)
  await host.writePatch(); await host.start()
  const deadline = Date.now() + 60_000
  while (!node && Date.now() < deadline) {
    node = (await admin.get('/api/v1/nodes')).nodes.find(row => row.status === 'online' && row.inventory?.project_roots?.[projectId] === projectRoot)
    if (!node) await sleep(150)
  }
  assert.ok(node)
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: projectRoot })
  grant = (await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: node.id, worker_id: 'default', operations: ['read'] })).grant
  const { preview: createPreview } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
  preview = await createPreview({ root: appRoot, configFile: resolve('tests/browser/vite.config.mjs'), logLevel: 'error', cacheDir: join(root, 'vite-cache'),
    preview: { host: '127.0.0.1', port: 0, strictPort: true }, build: { outDir: join(appRoot, 'dist') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/api': { target: origin, changeOrigin: true } } } })
  const appOrigin = `http://127.0.0.1:${preview.httpServer.address().port}`
  context = await chromium.launchPersistentContext(join(root, 'browser-profile'), {
    executablePath: process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true,
    viewport: { width: 1280, height: 1000 }, args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--no-proxy-server'],
    env: { PATH: process.env.PATH, TMPDIR: root }, timeout: 30_000,
  })
  page = context.pages()[0]
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => browserErrors.push(error.message))



  page.on('request', request => {
    const url = new URL(request.url())
    if (![appOrigin, origin].includes(url.origin)) throw new Error('Browser escaped the owned fixture')
    if (url.pathname.startsWith('/api/v1/')) requests.push({ path: url.pathname, method: request.method(), body: request.postData() })
  })
  await page.goto(appOrigin, { waitUntil: 'domcontentloaded' })
  await page.locator('.loom-app').waitFor()
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(server.clientToken)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
  await page.locator('.source-open-button').click()
  await page.locator('#source-message').waitFor()
  await page.getByRole('button', { name: '打开单 Source / thread', exact: true }).click()
  const ticketPosts = () => requests.filter(row => row.path === '/api/v1/tickets' && row.method === 'POST')
  await preparePair(page, grant)
  assert.equal(ticketPosts().length, 0, 'Neither utterance may issue a Ticket before explicit confirmation')
  const sourceInfo = await thread()
  const first = sourceInfo.page.events.find(row => row.content === '读取 input.txt')
  assert.ok(first)
  const ready = await thread()
  const preparedFirst = ready.page.events.find(row => row.id === first.id)
  const preparedSecond = ready.page.events.find(row => row.thread_sequence === first.thread_sequence + 1)
  assert.equal(preparedSecond.content, `用 Grant ${grant.id}`)
  assert.equal(preparedSecond.thread_id, preparedFirst.thread_id)
  assert.equal(preparedSecond.client_thread_id, preparedFirst.client_thread_id)
  assert.equal(preparedSecond.task_ticket_id, null)
  assert.equal(preparedFirst.task_ticket_id, null)
  assert.equal(await page.locator('.source-review-card').getAttribute('data-selected-event'), first.id)
  assert.equal(await page.locator('#source-relative-path').inputValue(), 'input.txt')
  assert.equal(await page.locator('#source-grant').inputValue(), grant.id)
  await screenshot(page, 'source-intent-prepared')
  await page.getByRole('button', { name: '提交给父层，第二次确认后创建摘要', exact: true }).click()
  await page.getByRole('dialog', { name: '根据已保存消息创建只读摘要？', exact: true }).waitFor()
  assert.equal(ticketPosts().length, 0)
  pass('two ordinary exact-Source messages prepare scope but cannot authorize work before explicit confirmation', { first_event: first.id, original_text: first.content, explicit_grant: true, cross_thread_merging: false })

  // Revoke the real grant after the one parent confirmation is shown. Both the
  // client fence and actual current-Grant read reject BEFORE any Ticket POST.
  await admin.post(`/api/v1/grants/${grant.id}/revoke`, {})
  await page.getByRole('button', { name: '确认创建只读摘要', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Grant' }).first().waitFor()
  assert.equal(ticketPosts().length, 0, 'Revocation after preparation must prevent the Ticket POST')
  await page.getByRole('button', { name: '返回检查', exact: true }).click()
  await page.locator('#source-message').waitFor()
  assert.deepEqual(browserErrors, [])
  pass('a real Grant revoked after preparation cannot create or rebind work', { tickets_created: 0, old_grant_reused: false })
  grant = (await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: node.id, worker_id: 'default', operations: ['read'] })).grant
  await page.getByRole('button', { name: '关闭 Source 面板', exact: true }).click()
  await page.getByRole('button', { name: '重新读取工作空间', exact: true }).click()
  await page.locator('.source-open-button').click()
  await page.locator('#source-grant option').filter({ hasText: grant.id }).waitFor({ state: 'attached' })
  const openedHistory = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v1/source-events' && response.status() === 200)
  await page.getByRole('button', { name: '打开单 Source / thread', exact: true }).click()
  const historyResponse = await openedHistory
  await historyResponse.finished()
  assert.equal((await historyResponse.json()).events.length, 2)
  await page.locator('.source-event-card').nth(1).waitFor({ state: 'attached' })
  const laterPairs = await page.locator('.source-event-card').count()
  await preparePair(page, grant)
  assert.equal(await page.locator('.source-event-card').count(), laterPairs + 2)
  assert.equal(ticketPosts().length, 0)
  await page.getByRole('button', { name: '提交给父层，第二次确认后创建摘要', exact: true }).click()
  const acceptingResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/tickets' && response.status() === 200)
  await page.getByRole('button', { name: '确认创建只读摘要', exact: true }).click()
  const acceptedJson = await (await acceptingResponse).json()
  assert.equal(acceptedJson.task_created, true)
  assert.equal(acceptedJson.duplicate, false)
  assert.equal(acceptedJson.linked_existing_authorized_ticket, false)
  assert.ok(acceptedJson.ticket?.id, 'An accepted new Source Ticket needs its concrete immutable ID')
  ticket = acceptedJson.ticket
  await page.locator('text=收到成功报告', { exact: true }).waitFor()
  assert.equal(ticketPosts().length, 1, 'Exactly one parent confirmation calls the existing Ticket endpoint')
  const actual = JSON.parse(ticketPosts()[0].body)
  assert.deepEqual(Object.keys(actual).sort(), ['grant_id', 'kind', 'node_id', 'objective', 'project_id', 'relative_path', 'source_event_id', 'worker_id'].sort())
  assert.equal(actual.objective, '读取 input.txt')
  assert.equal(actual.relative_path, 'input.txt')
  assert.equal(actual.grant_id, grant.id)
  assert.equal(actual.node_id, node.id)
  const latest = await thread()

  const requested = latest.page.events.find(row => row.task_ticket_id === ticket.id)
  assert.ok(requested, 'The actual returned Ticket must reference its bound immutable source event')
  assert.equal(requested.id, actual.source_event_id)
  assert.equal(requested.content, actual.objective)
  assert.ok(Number.isSafeInteger(requested.thread_sequence) && requested.thread_sequence >= 1)
  // The user prepares a REQUEST's frozen task from a LATER consecutive Grant
  // supplement. It never means the previous, revoked GRANT supplement issued it.
  const siblingGrantMessage = latest.page.events.find(row => row.thread_sequence === requested.thread_sequence + 1)
  assert.equal(siblingGrantMessage.content, `用 Grant ${grant.id}`)
  assert.equal(siblingGrantMessage.task_ticket_id, null)
  assert.equal(siblingGrantMessage.task_spec, null)
  assert.equal(siblingGrantMessage.source_id, requested.source_id)
  assert.equal(siblingGrantMessage.thread_id, requested.thread_id)
  assert.equal(siblingGrantMessage.client_thread_id, requested.client_thread_id)
  assert.equal(requested.task_ticket_id, acceptedJson.ticket.id)
  ticket = await terminal(acceptedJson.ticket.id)
  assert.equal(ticket.status, 'succeeded')
  assert.equal(ticket.objective, '读取 input.txt')
  assert.equal(ticket.effects.length, 0)
  assert.equal(ticket.artifacts.length, 1)
  assert.equal(ticket.reports.length, 1)
  const artifactId = ticket.artifacts[0].id
  const artifact = clean(await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifactId}`))
  assert.equal(artifact.artifact.read_evidence.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(artifact.artifact.read_evidence.path, 'input.txt')
  assert.equal(artifact.artifact.read_evidence.call_id, 'loom-fixture-controlled-read')
  sessionId = artifact.artifact.read_evidence.session.session_id
  assert.equal(JSON.parse(artifact.content).proof.name, 'loom_fixture_inspect')
  assert.equal(JSON.parse(ticket.reports[0].evidence)[0].session_id, sessionId)
  assert.equal(readFileSync(join(projectRoot, 'input.txt')).equals(bytes), true)
  const mapped = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')).assignments.find(row => row.session_id === sessionId)
  assert.equal(mapped.assignment_id, ticket.assignments[0].id)
  const recent = await thread()
  const sent = recent.page.events.find(row => row.task_ticket_id === ticket.id)
  assert.equal(sent.content, '读取 input.txt')
  assert.equal(sent.task_spec.relative_path, 'input.txt')
  assert.equal(sent.task_spec.grant_id, grant.id)
  assert.equal(sent.id, actual.source_event_id)
  assert.equal(sent.task_spec.source_event_id, sent.id)
  const grantMessages = recent.page.events.filter(row => row.content.startsWith('用 Grant'))
  assert.equal(grantMessages.length, 2)
  for (const event of grantMessages) assert.equal(event.task_ticket_id, null, 'Authorization supplement cannot create another task')
  await page.locator('.artifact-card').click(); await page.locator('.code-artifact .facts').waitFor()
  clean(await page.locator('body').innerText())
  await page.locator('.original-bytes summary').click()
  await page.setViewportSize({ width: 390, height: 1000 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await screenshot(page, 'source-intent-delivery')
  assert.deepEqual(browserErrors, [])
  pass('explicit confirmation creates one real DSH read proof with original bytes preserved and an actual Source-to-Ticket association', { ticket_id: ticket.id, source_session: sessionId, artifact_id: artifactId, report_count: 1, effect_count: 0, total_tickets: 1, provider: 'installed zero-network Stub', narrow_desktop_viewport_only: true })

  const beforeDetail = await admin.get(`/api/v1/tickets/${ticket.id}`)
  const beforeArtifact = await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifactId}`)
  const control = readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8')
  await host.stop(); host = null
  const originalToken = server.clientToken
  const originalDataDir = server.dataDir
  await server.stop(); server = null
  server = await startRustConcierge({ root: join(root, 'rust'), env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: originalToken }, dataDir: originalDataDir, baseUrl: origin })
  admin = new LoomHttpClient({ baseUrl: origin, clientToken: server.clientToken })
  host = new FixtureHost(root, env, secrets); await host.start()
  assert.equal(host.sessionEvents(sessionId, ['tool/call']).length, 0)
  assert.equal(host.sessionEvents(sessionId, ['tool/result']).length, 0)
  const sameModelRequests = () => readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(row => row.type === 'request')
  assert.deepEqual(sameModelRequests().length, control.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.type === 'request').length, 'No additional provider request after reopen')
  assert.deepEqual(await admin.get(`/api/v1/tickets/${ticket.id}`), beforeDetail)
  assert.deepEqual(await admin.get(`/api/v1/tickets/${ticket.id}/artifacts/${artifactId}`), beforeArtifact)
  assert.equal((await readFile(join(projectRoot, 'input.txt'))).equals(bytes), true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.ticket-id').filter({ hasText: ticket.id }).waitFor()
  await page.getByRole('tab', { name: '协作', exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { name: '展开过程消息', exact: true }).isChecked(), false)
  clean(await page.locator('body').innerText())
  assert.deepEqual(browserErrors, [])
  pass('center/Host restart and browser reload preserve immutable Source relations and proof without producing a second Task or rereading source', { repeat_tool_calls: 0, repeat_tool_results: 0, new_tickets: 0, grant_supplement_creates_no_task: true })
  outcome.status = 'PASS'
} catch (error) {
  if (page) {
    await screenshot(page, 'source-intent-failure').catch(() => {})
    const safePanel = await page.locator('.source-work-panel').innerText().catch(() => '')
    console.error(redact(safePanel.slice(-10000), [...secrets, marker]))
    console.error('OWNED_UI_TRANSITIONS', redact(JSON.stringify(requests.slice(-8)), [...secrets, marker]))
    if (admin && node && projectId) {
      const facts = await Promise.all([admin.get('/api/v1/nodes'), admin.get('/api/v1/projects')]).catch(() => [])
      console.error('OWNED_PUBLIC_SCOPE', JSON.stringify({ nodes: facts[0]?.nodes.map(row => ({ id: row.id, installation_id: row.installation_id, roots: row.inventory?.project_roots, canonical: row.inventory?.canonical_project_roots })), projects: facts[1]?.projects, grant }))
    }
  }
  checks.push({ name: 'failure', status: 'FAIL', evidence: 'Inspect this owned fixture; no generic natural-language/mobility claim follows.' })
  outcome.diagnostics = redact(error.stack || error, [...secrets, marker]).slice(-8000)
  console.error(outcome.diagnostics)
  process.exitCode = 1
} finally {
  if (context) await context.close().catch(() => {})
  if (preview?.httpServer) await new Promise(resolve => preview.httpServer.close(() => resolve())).catch(() => {})
  if (host) await host.stop().catch(() => {})
  if (server) await server.stop().catch(() => {})
  const proof = { schema: 'loom.source-intent.v1', overall: outcome.status, checks, diagnostics: outcome.diagnostics || '',
    real_dsh: outcome.status, external_llm: 'NOT RUN (zero-network Stub)', production_profile_used: false,
    mobile_device: 'NOT RUN (390px desktop viewport only)',
    not_claimed: ['general natural-language parsing', 'arbitrary Grant inference', 'general Transcript DLP', 'live provider', 'physical multi-host', 'mobile lifecycle'], output }
  await writeFile(output, JSON.stringify(clean(proof), null, 2), { mode: 0o600 })
  if (!keep && !process.env.LOOM_TEST_ROOT) {
    const canonicalTmp = await realpath((await import('node:os')).tmpdir())
    assert.equal(await realpath(root), root)
    assert.ok(root.startsWith(`${canonicalTmp}/loom-dsh-`))
    await rm(root, { recursive: true, force: true })
  }
}
