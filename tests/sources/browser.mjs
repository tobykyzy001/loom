import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { sha256 } from '../../packages/node-client/src/util.js'
import { startRustConcierge, prepareProject, testingClientToken } from '../../scripts/fixtures/rust-server.mjs'
import { chromium } from '../browser/node_modules/playwright-core/index.mjs'

// Real bundled Vue + a fresh Edge profile + genuine Rust/LocalNode chain.
// Requests are passively observed, never intercepted, mocked or replayed by Playwright.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appRoot = join(repository, 'apps/web')
const root = await mkdtemp(join(tmpdir(), 'loom-source-browser-'))
const token = testingClientToken()
const projectRoot = await prepareProject(root)
const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
let server, context, preview
const browserFailures = []
const requests = []
const completed = []
const scalar = sql => {
  const db = new DatabaseSync(join(root, 'concierge', 'loom.sqlite3'), { readOnly: true })
  try { return Object.values(db.prepare(sql).get())[0] } finally { db.close() }
}
async function run() {
  await promisify(execFile)('pnpm', ['--dir', appRoot, 'build'], { cwd: repository, timeout: 120_000 })
  assert.equal(await realpath(executable), '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'This driver uses only the requested public standalone Edge binary')
  server = await startRustConcierge({ root, env: { LOOM_CLIENT_TOKEN: token, PATH: process.env.PATH } })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const project = await admin.post('/api/v1/projects', { name: 'Explicit Source work in a real browser', root: projectRoot, mode: 'read_only' })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const runner = new LocalNodeRunner({ stateDir: join(root, 'node-state'), artifactDir: join(root, 'node-artifacts'), baseUrl: server.baseUrl, projectRoots: { [projectId]: projectRoot } })
  await runner.start({ enrollmentCode: enrollment.code })
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: runner.nodeId, worker_id: 'default', root_scope: projectRoot })
  const grant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: runner.nodeId, worker_id: 'default', operations: ['read'] })
  assert.equal(grant.grant.operations.includes('read'), true)

  process.env.LOOM_TEST_CONCIERGE_URL = server.baseUrl
  const { preview: startPreview } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
  preview = await startPreview({
    root: appRoot, configFile: join(repository, 'tests/browser/vite.config.mjs'), logLevel: 'error',
    cacheDir: join(root, 'source-preview-cache'),
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
    build: { outDir: join(appRoot, 'dist') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, fs: { allow: [appRoot] },
      proxy: { '/api': { target: server.baseUrl, changeOrigin: true } } },
  })
  const appOrigin = `http://127.0.0.1:${preview.httpServer.address().port}`
  context = await chromium.launchPersistentContext(join(root, 'edge-profile'), {
    executablePath: executable, headless: true, viewport: { width: 1280, height: 980 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--no-service-autorun', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
    env: { PATH: process.env.PATH, TMPDIR: root, HOME: root, XDG_CONFIG_HOME: join(root, 'xdg') }, timeout: 30_000,
  })
  const pages = context.pages()
  assert.equal(pages.length, 1)
  const page = pages[0]
  assert.equal(page.url(), 'about:blank')
  page.setDefaultTimeout(15_000)
  const failure = error => browserFailures.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
  page.on('pageerror', error => failure(`PAGEERROR ${error.message}`))
  page.on('crash', () => failure('PAGE CRASH'))
  page.on('console', message => {
    const text = message.text()
    if (message.type() === 'error') {
      const initialUnauthorized = completed.filter(response => response.path === '/api/v1/bootstrap' && response.method === 'GET')
      if (initialUnauthorized.length === 1 && initialUnauthorized[0].status === 401
        && requests.filter(request => request.path === '/api/v1/bootstrap' && request.method === 'GET').length === 1) return
      failure(`CONSOLE ${text.slice(0, 800)}`)
    }
  })
  page.on('requestfailed', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/v1/')) failure(`REQUEST FAILED ${request.failure()?.errorText} ${url.pathname}`)
  })
  page.on('request', request => {
    try {
      const url = new URL(request.url())
      if (![appOrigin, server.baseUrl].includes(url.origin)) throw new Error(`Browser reached a non-owned origin: ${url.origin}`)
      const method = request.method()
      if (url.pathname.startsWith('/api/v1/') && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        const body = method === 'GET' ? null : request.postDataJSON()
        // Keep raw headers out of retained diagnostics: Authorization is required
        // on the actual loopback request but must never enter result/log payloads.
        requests.push({ path: url.pathname + url.search, method, body })
      }
    } catch (error) { failure(error) }
  })
  page.on('response', response => {
    try {
      const url = new URL(response.url())
      const status = response.status()
      if (url.pathname.startsWith('/api/v1/')) {
        const record = { method: response.request().method(), path: url.pathname + url.search, status }
        completed.push(record)
        if (requests.length > 30_000 || completed.length > 30_000) throw new Error('Unbounded browser request capture')
        if (status >= 400) {
          const expectsInitialAuthFailure = requests.filter(request => request.path === '/api/v1/bootstrap' && request.method === 'GET').length === 1
          if (!(status === 401 && url.pathname === '/api/v1/bootstrap' && expectsInitialAuthFailure)) failure(`HTTP ${status} ${url.pathname}`)
        }
      }
    } catch (error) { failure(error) }
  })
  const captures = (path, method = 'POST') => requests.filter(request => request.path === path && request.method === method)
  const deliver = async () => {
    console.error('SOURCE NODE poll start')
    const outcome = await runner.pollAndRun()
    console.error('SOURCE NODE poll result', outcome.status, outcome.assignmentId)
    const outbox = await runner.client.dispatchOutbox()
    console.error('SOURCE NODE outbox settled', outbox.length)
    assert.ok(outbox.every(entry => entry.status !== 'deferred'), `Real receipts must reach the center: ${JSON.stringify(outbox)}`)
    return outcome
  }
  const geometry = async expectedTicketId => {
    const metrics = await page.evaluate(() => {
      const rect = selector => {
        const element = document.querySelector(selector)
        if (!element) return null
        const { width, left, right, top } = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return { width, left, right, top, display: style.display, visibility: style.visibility }
      }
      const workspace = document.querySelector('.workspace-content')
      const workspaceStyle = getComputedStyle(workspace)
      const workspacePadding = { left: parseFloat(workspaceStyle.paddingLeft), right: parseFloat(workspaceStyle.paddingRight) }
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        workspaceContentWidth: workspace.clientWidth - workspacePadding.left - workspacePadding.right, workspacePadding,
        workspace: rect('.workspace-content'), column: rect('.conversation-column'), detail: rect('.ticket-detail'),
        activity: rect('.activity-panel'), artifact: rect('.artifact-viewer') }
    })
    assert.equal(metrics.detail?.width > 240 && metrics.column?.width > 240, true, `Ticket must remain readable, not a collapsed rail: ${JSON.stringify(metrics)}`)
    assert.notEqual(metrics.detail?.display, 'none')
    assert.notEqual(metrics.detail?.visibility, 'hidden')
    assert.ok(metrics.artifact?.width > 240)
    console.error('SOURCE OVERFLOW', await page.evaluate(() => [...document.querySelectorAll('body *')].map(element => {
      const { left, right, width } = element.getBoundingClientRect()
      return { selector: element.tagName + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().replaceAll(' ', '.') : ''), left, right, width }
    }).filter(rect => rect.right > innerWidth + 1 || rect.left < -1).slice(0, 15)))
    console.error('SOURCE SCROLL ANCESTORS', await page.evaluate(() => [...document.querySelectorAll('html,body,body *')].map(element => {
      const style = getComputedStyle(element)
      return { selector: element.tagName + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().replaceAll(' ', '.') : ''),
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: style.overflowX, whiteSpace: style.whiteSpace,
        minWidth: style.minWidth, maxWidth: style.maxWidth }
    }).filter(item => item.scrollWidth > item.clientWidth + 1).sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth)).slice(0, 18)))
    assert.ok(metrics.scrollWidth <= metrics.viewport, `No horizontal overflow: ${JSON.stringify(metrics)}`)
    assert.ok(metrics.column.right <= metrics.workspace.right + 1)
    if (metrics.viewport >= 931) assert.ok(metrics.column.width >= metrics.workspace.width * 0.45, `Desktop detail must get its available flex share: ${JSON.stringify(metrics)}`)
    if (metrics.viewport <= 930) {
      assert.ok(Math.abs(metrics.column.left - (metrics.workspace.left + metrics.workspacePadding.left)) < 1,
        `Narrow detail uses the real parent content origin: ${JSON.stringify(metrics)}`)
      assert.ok(Math.abs(metrics.column.width - metrics.workspaceContentWidth) < 1, `Narrow detail stacks at real parent width: ${JSON.stringify(metrics)}`)
      assert.ok(metrics.activity?.width >= metrics.column.width - 1 && metrics.activity.top >= metrics.column.top + 100)
    }
    assert.equal(await page.locator('.ticket-detail .ticket-id').innerText(), `Ticket / ${expectedTicketId}`)
    console.error('SOURCE GEOMETRY', JSON.stringify(metrics))
    assert.ok(metrics.activity, 'The real ticket Activity must be present rather than another page supplying geometry')
  }
  const screenshot = async name => {
    assert.ok(!(await page.locator('body').innerText()).includes(token), 'Client token must not appear in screenshots')
    await page.screenshot({ path: join(root, `${name}.png`), fullPage: true })
  }
  const scope = { projectId, grantId: grant.grant.id, nodeId: runner.nodeId, worker: 'default', path: 'input.txt' }
  const input = join(projectRoot, 'input.txt')
  const missingInput = join(root, 'held-input.txt')
  const originalInputBytes = await readFile(input)
  await rename(input, missingInput)
  assert.deepEqual(await readFile(missingInput), originalInputBytes)
  await page.goto(appOrigin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
  await page.locator('#client-token').fill(token)
  await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
  await page.locator('#connection-dialog').waitFor({ state: 'hidden' })

  const sourceId = await recordMessage(page, ' Read authorized input.txt — 保留原始原文与 immutable Source lineage。 ')
  const threadEvents = () => admin.get(`/api/v1/source-events?source_id=${encodeURIComponent(sourceId)}&thread_id=browser-thread&limit=200`)
  const events = () => threadEvents().then(page => page.events)
  const firstEvent = (await events())[0]
  assert.equal(firstEvent.content, ' Read authorized input.txt — 保留原始原文与 immutable Source lineage。 ')
  assert.equal(firstEvent.ticket_id, null)
  assert.equal(firstEvent.task_ticket_id, null)
  assert.equal(firstEvent.creation_kind, 'unbound')
  assert.equal(scalar('SELECT COUNT(*) FROM tickets'), 0)
  assert.equal((await threadEvents()).permission_granted, false)
  await prepareSourceWork(page, scope)
  assert.equal(captures('/api/v1/tickets').length, 0, 'Prepare only opens the parent confirmation')
  const accepted = await confirmSourceWork(page, { duplicate: false })
  assert.deepEqual(captures('/api/v1/tickets').map(request => request.body),
    [{ source_event_id: firstEvent.id, objective: firstEvent.content, project_id: projectId, grant_id: grant.grant.id,
      node_id: runner.nodeId, worker_id: 'default', kind: 'read_summary', relative_path: 'input.txt' }])
  await page.locator('.confirm-modal').waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '正在提交…', exact: true }).count(), 0, 'Busy clears after accepted receipt and follow-up reads')
  await page.locator('.ticket-detail').waitFor()
  assert.equal(await page.locator('.help-view').count(), 0, 'An unrelated Help section must not enter the Ticket flex row')
  assert.equal(await page.locator('.ticket-detail').count(), 1)
  assert.equal((await admin.get(`/api/v1/tickets/${encodeURIComponent(accepted.ticket.id)}`)).status, 'running')
  const firstOutcome = await deliver()
  assert.equal(firstOutcome.status, 'failed')
  const ticketId = accepted.ticket.id
  const failedTicket = await admin.get(`/api/v1/tickets/${encodeURIComponent(ticketId)}`)
  assert.equal(failedTicket.status, 'failed')
  assert.equal(failedTicket.assignments.length, 1)
  assert.equal(failedTicket.reports.length, 1)
  assert.equal(failedTicket.reports[0].state, 'failed')
  assert.ok(!failedTicket.artifacts?.length)
  await page.locator('.ticket-detail').getByText('这项任务未能完成', { exact: true }).waitFor()
  await page.locator('.ticket-detail').getByRole('button', { name: '明确新尝试', exact: true }).click()
  await page.getByRole('button', { name: '创建新尝试', exact: true }).click()
  await page.locator('.confirm-modal').waitFor({ state: 'hidden' })
  await rename(missingInput, input)
  assert.deepEqual(await readFile(input), originalInputBytes, 'Retry must read exactly the original unchanged bytes')
  const retryOutcome = await deliver()
  assert.equal(retryOutcome.status, 'succeeded')
  await page.locator('.ticket-detail').getByText('收到成功报告', { exact: true }).waitFor()
  const ticket = await admin.get(`/api/v1/tickets/${encodeURIComponent(ticketId)}`)
  assert.equal(ticket.status, 'succeeded')
  assert.equal(ticket.assignments.length, 2)
  assert.notEqual(ticket.assignments[0].id, ticket.assignments[1].id)
  assert.equal(ticket.reports.length, 2)
  assert.equal(ticket.reports[0].state, 'failed')
  assert.equal(ticket.reports[1].state, 'succeeded')
  assert.equal(ticket.effects.length, 1)
  assert.equal(ticket.effects[0].status, 'confirmed')
  assert.equal(ticket.artifacts.length, 1)
  assert.equal(retryOutcome.assignmentId, ticket.assignments[1].id)
  const artifact = ticket.artifacts[0]
  const artifactPath = `/api/v1/tickets/${encodeURIComponent(ticketId)}/artifacts/${encodeURIComponent(artifact.id)}`
  const nativeDownload = await page.evaluate(async ({ clientToken, path }) => {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${clientToken}`, Accept: 'application/json' } })
    return { status: response.status, body: await response.json() }
  }, { clientToken: token, path: artifactPath })
  assert.equal(nativeDownload.status, 200)
  const sourceBytes = await readFile(join(projectRoot, 'input.txt'))
  const summary = JSON.parse(nativeDownload.body.content)
  assert.equal(summary.path, 'input.txt')
  assert.equal(summary.byte_length, sourceBytes.length)
  assert.equal(summary.input_sha256, sha256(sourceBytes))
  assert.ok(summary.lines.includes('Real isolated project input.'))
  assert.deepEqual(sourceBytes, originalInputBytes)
  assert.equal(sha256(nativeDownload.body.content), artifact.sha256)
  assert.equal(nativeDownload.body.artifact.sha256, artifact.sha256)
  assert.notEqual(summary.input_sha256, artifact.sha256)
  const linkedEvent = (await events()).find(event => event.id === firstEvent.id)
  assert.equal(linkedEvent.content, firstEvent.content)
  assert.equal(linkedEvent.ticket_id, null)
  assert.equal(linkedEvent.task_ticket_id, ticketId)
  assert.equal(linkedEvent.creation_kind, 'explicit_task_created_after_intake')
  assert.equal(linkedEvent.task_spec.ticket_id, ticketId)
  assert.equal(linkedEvent.task_spec.event_request_digest, firstEvent.payload_digest)
  assert.equal(linkedEvent.task_spec.grant_id, grant.grant.id)
  assert.equal(linkedEvent.task_spec.project_binding_id, binding.id)
  assert.equal(linkedEvent.task_spec.root_scope, projectRoot)
  assert.equal(linkedEvent.task_spec.installation_id, runner.installationId)

  console.error('SOURCE Artifact verification stage', ticketId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('收到成功报告', { exact: true }).waitFor()
  const artifactResponse = page.waitForResponse(response => new URL(response.url()).pathname === artifactPath && response.request().method() === 'GET')
  artifactResponse.catch(error => console.error('SOURCE ARTIFACT WAIT', error.message))
  await page.locator('.artifact-card').click()
  assert.equal((await artifactResponse).status(), 200)
  await page.locator('.artifact-viewer').waitFor()
  assert.equal(await page.locator('.artifact-content').innerText(), nativeDownload.body.content)
  assert.equal(await page.locator('.artifact-metadata').innerText().then(text => text.includes(artifact.sha256)), true)
  await geometry(ticketId)
  await screenshot('source-work-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await geometry(ticketId)
  await screenshot('source-work-narrow')

  await openSourcePanel(page)
  await prepareSourceWork(page, scope)
  const replay = await confirmSourceWork(page, { duplicate: true })
  assert.equal(replay.ticket.id, ticketId)
  assert.equal(replay.task_created, false)
  assert.equal(replay.linked_existing_authorized_ticket, true)
  assert.equal(replay.task_digest, accepted.task_digest)
  assert.equal(captures('/api/v1/tickets').length, 2, 'Duplicate is a second explicit user POST, not a bypassed callback')
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, 1)
  const replayedTicket = await admin.get(`/api/v1/tickets/${encodeURIComponent(ticketId)}`)
  assert.deepEqual(replayedTicket.assignments, ticket.assignments)
  assert.deepEqual(replayedTicket.reports, ticket.reports)
  assert.deepEqual(replayedTicket.artifacts, ticket.artifacts)
  assert.deepEqual(replayedTicket.effects, ticket.effects)
  assert.equal(scalar('SELECT COUNT(*) FROM assignments'), 2, 'Only the two real failed/retry attempts exist')
  assert.equal(scalar('SELECT COUNT(*) FROM reports'), 2, 'Both actual failure and success Reports are preserved')
  assert.equal(scalar('SELECT COUNT(*) FROM artifacts'), 1, 'Only the successful attempt has one byte-backed Artifact')
  assert.equal(scalar('SELECT COUNT(*) FROM effects'), 1, 'The read has one confirmed Effect')
  assert.equal(scalar('SELECT COUNT(*) FROM source_work_specs'), 1)
  const duplicateSpec = (await events()).find(event => event.id === firstEvent.id).task_spec
  assert.equal(duplicateSpec.digest, accepted.task_digest)
  assert.equal(duplicateSpec.grant_id, grant.grant.id)
  assert.equal(duplicateSpec.project_binding_id, binding.id)
  assert.equal(duplicateSpec.installation_id, runner.installationId)
  assert.equal(await runner.pollAndRun().then(result => result.status), 'idle', 'Duplicate cannot be re-executed by a watcher')
  await runner.client.dispatchOutbox()
  assert.deepEqual(await admin.get(`/api/v1/tickets/${encodeURIComponent(ticketId)}`), replayedTicket)

  // A second immutable Source message runs once; exact replay does not re-execute.
  const secondSourceObjective = ' A second Source message has its own single file execution。 '
  await recordMessage(page, secondSourceObjective)
  await prepareSourceWork(page, { ...scope, contains: secondSourceObjective })
  const secondAccepted = await confirmSourceWork(page, { duplicate: false })
  assert.equal((await deliver()).status, 'succeeded')
  const secondTicketId = secondAccepted.ticket.id
  const secondTicket = await admin.get(`/api/v1/tickets/${encodeURIComponent(secondTicketId)}`)
  assert.equal(secondTicket.assignments.length, 1)
  assert.equal(secondTicket.reports.length, 1)
  assert.equal(secondTicket.artifacts.length, 1)
  assert.equal(secondTicket.effects.length, 1)
  await page.locator('.ticket-detail').getByText('收到成功报告', { exact: true }).waitFor()
  await openSourcePanel(page)
  await prepareSourceWork(page, { ...scope, contains: secondSourceObjective })
  const secondReplay = await confirmSourceWork(page, { duplicate: true })
  assert.equal(secondReplay.ticket.id, secondTicketId)
  assert.deepEqual(await admin.get(`/api/v1/tickets/${encodeURIComponent(secondTicketId)}`), secondTicket)
  assert.equal(await runner.pollAndRun().then(result => result.status), 'idle')
  await runner.client.dispatchOutbox()
  assert.deepEqual(await admin.get(`/api/v1/tickets/${encodeURIComponent(secondTicketId)}`), secondTicket)
  // Use the real visible permission form to revoke this one exact current Grant.
  const secondObjective = ' Revoked authority must not cause a new execution。 '
  await recordMessage(page, secondObjective)
  await page.getByRole('button', { name: '关闭 Source 面板', exact: true }).click()
  await page.locator('.mobile-tabs').getByRole('button', { name: '更多', exact: true }).click()
  await page.locator('.mobile-more').getByRole('button', { name: '权限', exact: true }).click()
  const grantCard = page.locator('.grant-item').filter({ hasText: grant.grant.id })
  await grantCard.getByRole('button', { name: '撤销授权', exact: true }).click()
  const revokeRequest = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/grants/${grant.grant.id}/revoke` && response.request().method() === 'POST')
  revokeRequest.catch(error => console.error('SOURCE REVOKE WAIT', error.message))
  await page.getByRole('button', { name: '确认撤销授权', exact: true }).click()
  assert.equal((await revokeRequest).status(), 200)
  await page.locator('.confirm-modal').waitFor({ state: 'hidden' })
  assert.ok((await admin.get('/api/v1/grants')).grants.find(row => row.id === grant.grant.id)?.revoked_at)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.access-boundary').waitFor()
  await page.locator('.mobile-tabs').getByRole('button', { name: '对话', exact: true }).click()
  if (await page.locator('.ticket-detail').count()) await page.locator('.ticket-detail').getByRole('button', { name: '新的任务', exact: true }).click()
  await openSourcePanel(page)
  await page.getByRole('button', { name: '打开单 Source / thread', exact: true }).click()
  await page.locator('.source-event-card').filter({ hasText: secondObjective }).getByRole('button', { name: '基于此消息创建摘要', exact: true }).click()
  assert.equal(await page.locator('#source-grant option').count(), 1, 'Revoked Grant is not offered after a real thread reread')
  assert.ok(!(await page.locator('body').innerText()).includes(secondObjective.trim() + '\nNo normalization'))
  const beforeRevoke = captures('/api/v1/tickets').length
  assert.equal(await page.getByRole('button', { name: '提交给父层，第二次确认后创建摘要', exact: false }).isDisabled(), true)
  assert.equal(captures('/api/v1/tickets').length, beforeRevoke)
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, 2, 'Revocation must not add to the two already delivered Source jobs')
  assert.equal((await events()).filter(event => event.content === secondObjective)[0].task_ticket_id, null)
  const firstAfterRevocation = await admin.get(`/api/v1/tickets/${encodeURIComponent(ticketId)}`)
  assert.equal(firstAfterRevocation.assignments.length, ticket.assignments.length)
  assert.equal(firstAfterRevocation.id, ticket.id)
  assert.equal(firstAfterRevocation.status, 'succeeded')
  assert.equal(firstAfterRevocation.objective, ticket.objective)
  assert.equal(firstAfterRevocation.grant_digest, ticket.grant_digest)
  assert.deepEqual(firstAfterRevocation.assignments.map(({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id }) =>
    ({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id })),
  ticket.assignments.map(({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id }) =>
    ({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id })),
  'Revoking current authority fences old leases but cannot change the original assignment identities')
  assert.ok(firstAfterRevocation.assignments.every(assignment => Date.parse(assignment.lease_expires_at) <= Date.now()))
  assert.deepEqual(firstAfterRevocation.reports, ticket.reports)
  assert.deepEqual(firstAfterRevocation.artifacts, ticket.artifacts)
  assert.deepEqual(firstAfterRevocation.effects, ticket.effects)
  const secondAfterRevocation = await admin.get(`/api/v1/tickets/${encodeURIComponent(secondTicketId)}`)
  assert.equal(secondAfterRevocation.id, secondTicket.id)
  assert.equal(secondAfterRevocation.status, 'succeeded')
  assert.equal(secondAfterRevocation.objective, secondTicket.objective)
  assert.equal(secondAfterRevocation.grant_digest, secondTicket.grant_digest)
  assert.deepEqual(secondAfterRevocation.artifacts, secondTicket.artifacts)
  assert.deepEqual(secondAfterRevocation.effects, secondTicket.effects)
  assert.deepEqual(secondAfterRevocation.reports, secondTicket.reports)
  assert.deepEqual(secondAfterRevocation.assignments.map(({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id }) =>
    ({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id })),
  secondTicket.assignments.map(({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id }) =>
    ({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id })))
  assert.ok(secondAfterRevocation.assignments.every(assignment => Date.parse(assignment.lease_expires_at) <= Date.now()))
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, 2)

  // Exercise the explicit current-Grant failure as well, then explicitly recreate only the test Grant.
  await admin.post(`/api/v1/grants/${encodeURIComponent(grant.grant.id)}/revoke`, {})
  const replacementGrant = await admin.post('/api/v1/grants', { project_id: projectId, project_binding_id: binding.id, node_id: runner.nodeId, worker_id: 'default', operations: ['read'] })
  await page.getByRole('button', { name: '关闭 Source 面板', exact: true }).click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const thirdObjective = ' Current Grant reread must reject mutation before new work。 '
  await recordMessage(page, thirdObjective)
  await prepareSourceWork(page, { ...scope, grantId: replacementGrant.grant.id })
  const beforeMutation = captures('/api/v1/tickets').length
  await admin.post(`/api/v1/grants/${encodeURIComponent(replacementGrant.grant.id)}/revoke`, {})
  await page.getByRole('button', { name: '确认创建只读摘要', exact: true }).click()
  await page.locator('.form-error').filter({ hasText: 'Grant/Project/Node/Worker' }).waitFor()
  assert.equal(captures('/api/v1/tickets').length, beforeMutation)
  assert.equal((await events()).filter(event => event.content === thirdObjective)[0].task_ticket_id, null)
  await page.getByRole('button', { name: '返回检查', exact: true }).click()
  await page.getByRole('button', { name: '关闭 Source 面板', exact: true }).click()
  assert.deepEqual(browserFailures, [])
  assert.ok(completed.every(response => response.status < 400 || (response.status === 401 && response.path === '/api/v1/bootstrap')))
  assert.equal(scalar('SELECT COUNT(*) FROM tickets'), 2)
  for (const id of [ticketId, secondTicketId]) {
    const detail = await admin.get(`/api/v1/tickets/${encodeURIComponent(id)}`)
    console.error('SOURCE FINAL REPORTS', id, JSON.stringify(detail.reports.map(report => ({ id: report.id, assignment_id: report.assignment_id, state: report.state }))))
  }
  console.error('SOURCE FINAL SQL REPORTS', scalar('SELECT COUNT(*) FROM reports'))
  assert.equal(scalar('SELECT COUNT(*) FROM assignments'), 3)
  assert.equal(scalar('SELECT COUNT(*) FROM reports'), 3, 'Two first-Ticket failure/retry Reports and one second-Ticket success Report')
  assert.equal(firstAfterRevocation.reports.filter(report => report.state === 'failed').length, 1)
  assert.equal(firstAfterRevocation.reports.filter(report => report.state === 'succeeded').length, 1)
  assert.equal(secondAfterRevocation.reports.filter(report => report.state === 'succeeded').length, 1)
  assert.equal(scalar('SELECT COUNT(*) FROM artifacts'), 2)
  assert.equal(scalar('SELECT COUNT(*) FROM effects'), 2)
  assert.equal(scalar('SELECT COUNT(*) FROM source_work_specs'), 2)
  assert.equal(captures('/api/v1/grants').length, 0, 'Source work must not create a Grant')
  assert.equal(captures('/api/v1/project-bindings').length, 0, 'Source work must not create/rebind a root')
  assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
  console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.source-browser.v1', edge_binary: executable,
    recorded_message_created_zero_tickets: true, exact_unicode_whitespace_objective: true,
    artifact_sha256: artifact.sha256, input_sha256: summary.input_sha256,
    final_sql: { tickets: scalar('SELECT COUNT(*) FROM tickets'), assignments: scalar('SELECT COUNT(*) FROM assignments'),
      reports: scalar('SELECT COUNT(*) FROM reports'), artifacts: scalar('SELECT COUNT(*) FROM artifacts'), effects: scalar('SELECT COUNT(*) FROM effects'), source_work_specs: scalar('SELECT COUNT(*) FROM source_work_specs') },
    parent_second_confirm_only_post: true, explicit_grant_binding_root_node_worker: true,
    immutable_spec_and_legacy_history_separate: true, actual_download_sha_input_sha_status_report_effect: true,
    replay_does_not_new_assignment_artifact_report_effect: true, watcher_does_not_duplicate: true,
    retry_real_failure_then_failure_report_and_new_assignment_succeeded: true, two_distinct_source_executions_no_duplicate: true,
    revoke_and_mutated_current_grant_no_new_job: true,
    narrow_viewport_real_column_no_overflow: true, screenshots: [join(root, 'source-work-desktop.png'), join(root, 'source-work-narrow.png')],
    not_claimed: ['physical mobile/browser lifecycle', 'actual IM/OAuth', 'Live LLM/intent inference', 'DSH code Agent',
      'second physical Host/Installation', 'one-concierge-three-workers Compose'], owned_cleanup: true }, null, 2))
}

async function openSourcePanel(page) {
  if (await page.locator('.source-work-panel').count()) return
  await page.locator('.conversation-column').waitFor()
  await page.waitForFunction(() => !document.querySelector('.workspace-loading')
    && (document.querySelector('.ticket-detail') || document.querySelector('.source-open-button')))
  if (await page.locator('.ticket-detail').count()) {
    await page.locator('.ticket-detail').getByRole('button', { name: '新的任务', exact: true }).click()
  }
  const openButton = page.getByRole('button', { name: '打开受限 Source', exact: true })
  await openButton.waitFor({ state: 'visible' })
  await openButton.click()
  await page.locator('.source-work-panel').waitFor({ state: 'visible' })
}

async function recordMessage(page, content) {
  await openSourcePanel(page)
  await page.locator('#source-message').fill(content)
  const before = requests.filter(request => request.path === '/api/v1/source-events' && request.method === 'POST').length
  const ticketCount = requests.filter(request => request.path === '/api/v1/tickets' && request.method === 'POST').length
  const receivedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/source-events' && response.request().method() === 'POST')
  receivedResponse.catch(error => console.error('SOURCE INTAKE WAIT', error.message))
  await page.getByRole('button', { name: '记录完整消息（不创建 Ticket）', exact: true }).click()
  const response = await receivedResponse
  assert.equal(response.status(), 200)
  assert.equal(requests.filter(request => request.path === '/api/v1/source-events' && request.method === 'POST').length, before + 1)
  await page.getByRole('button', { name: '打开单 Source / thread', exact: true }).click()
  const saved = page.locator('.source-event-card').filter({ hasText: content }).first()
  await saved.waitFor()
  await saved.getByRole('button', { name: '基于此消息创建摘要', exact: true }).click()
  assert.equal(await page.locator('#source-message').inputValue(), content)
  assert.equal(await page.locator('.source-recorded-state').innerText().then(text => text.includes('task_created=false，permission_granted=false')), true)
  await page.locator('.source-review-card[data-selected-event]').waitFor()
  assert.equal(completed.filter(response => response.path === '/api/v1/tickets' && response.method === 'POST').length, ticketCount, 'Recording alone must not accept a Ticket')
  assert.equal(requests.filter(request => request.path === '/api/v1/tickets' && request.method === 'POST').length, ticketCount)
  const registrationRequest = requests.filter(request => request.path === '/api/v1/sources' && request.method === 'POST').at(-1)
  assert.deepEqual(registrationRequest.body, { schema: 'loom.source-instance.v1', source_key: 'browser-source', kind: 'web', label: 'User-authorized web messages' })
  const eventRequest = requests.filter(request => request.path === '/api/v1/source-events' && request.method === 'POST').at(-1)
  assert.equal(eventRequest.body.content, content)
  assert.equal(eventRequest.body.thread_id, 'browser-thread')
  const responseBody = await response.json()
  assert.equal(eventRequest.body.source_id, responseBody.source_id)
  assert.equal(responseBody.ticket_id, null)
  return responseBody.source_id
}

async function prepareSourceWork(page, input) {
  await openSourcePanel(page)
  const panel = page.locator('.source-work-panel')
  if (!await panel.locator('.source-review-card[data-selected-event]').count()) {
    await panel.getByRole('button', { name: '打开单 Source / thread', exact: true }).click()
    await panel.locator('.source-event-card').first().waitFor()
    const event = input.contains ? panel.locator('.source-event-card').filter({ hasText: input.contains }).first() : panel.locator('.source-event-card').first()
    await event.getByRole('button', { name: '基于此消息创建摘要', exact: true }).click()
  }
  const grantSelect = panel.locator('#source-grant')
  if (await panel.locator('.source-review-card[data-selected-event]').evaluate(element => Boolean(element.querySelector('.source-scope-confirmation[aria-label="原 Source Work Spec 证据"]')))) {
    assert.equal(await grantSelect.inputValue(), input.grantId, 'Replay must retain the immutable Grant without another selection')
    assert.equal(await grantSelect.isDisabled(), true, 'Bound Source work cannot switch its Grant')
    assert.equal(await panel.locator('#source-relative-path').isDisabled(), true)
    assert.equal(await panel.locator('#source-relative-path').inputValue(), input.path, 'Replay must retain the immutable file path')
  } else {
    await grantSelect.selectOption(input.grantId)
    await panel.locator('#source-relative-path').fill(input.path)
  }
  const scope = await panel.locator('.source-scope-confirmation:not([aria-label])').innerText()
  for (const value of [input.projectId, input.grantId, input.nodeId, input.worker, input.path]) assert.ok(scope.includes(value))
  await panel.getByRole('button', { name: '提交给父层，第二次确认后创建摘要', exact: false }).click()
  const confirmation = page.locator('.confirm-modal')
  await confirmation.waitFor()
  const confirmationText = await confirmation.innerText()
  for (const value of [input.projectId, input.grantId, input.nodeId, input.worker, input.path]) assert.ok(confirmationText.includes(value))
}

async function confirmSourceWork(page, { duplicate }) {
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/tickets' && response.request().method() === 'POST')
  accepted.catch(error => console.error('SOURCE TICKET WAIT', error.message))
  const confirmation = page.locator('.confirm-modal')
  const acceptButton = confirmation.locator('.modal-actions .button.primary')
  assert.equal(await acceptButton.isDisabled(), false)
  assert.equal(await acceptButton.evaluate(button => {
    const bounds = button.getBoundingClientRect()
    return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === button
  }), true, 'Parent authorization must be hit-testable, not covered by the Source modal')
  await acceptButton.click()
  if (await acceptButton.count()) assert.equal(await acceptButton.isDisabled(), true, 'Pending parent confirmation must not accept another click')
  console.error('SOURCE CONFIRM CLICKED', completed.slice(-8))
  const response = await accepted.catch(async error => {
    console.error('SOURCE CONFIRM TRACE', JSON.stringify(completed))
    console.error('SOURCE CONFIRM ERRORS', JSON.stringify(browserFailures))
    throw new Error(`${error.message}; panels=${await page.locator('.source-work-panel,.confirm-modal,.form-error').allTextContents()}; http=${JSON.stringify(completed)}`)
  })
  const body = await response.json()
  assert.equal(response.status(), 200)
  assert.equal(body.duplicate, duplicate)
  assert.equal(body.task_created, !duplicate)
  assert.equal(body.linked_existing_authorized_ticket, duplicate)
  assert.ok(body.ticket.id && body.source_event_id && body.task_digest)
  await page.locator('.confirm-modal').waitFor({ state: 'hidden' })
  return body
}

try {
  await run()
} catch (error) {
  console.error('SOURCE DRIVER FAILURE', error instanceof Error ? error.stack : String(error))
  console.error('SOURCE HTTP TRACE', JSON.stringify(completed.slice(-80)))
  console.error('SOURCE ERRORS', JSON.stringify(browserFailures))
  throw error
} finally {
  const cleanupErrors = []
  const cleanup = async action => { try { await action() } catch (error) { cleanupErrors.push(error) } }
  if (context) await cleanup(() => context.close())
  if (preview) await cleanup(() => new Promise((resolve, reject) => preview.httpServer.close(error => error ? reject(error) : resolve())))
  if (server) await cleanup(() => server.stop())
  await cleanup(() => rm(root, { recursive: true, force: true }))
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned browser/Rust/preview cleanup failed')
}
