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
// Requests are observed; the explicit approval-navigation case only delays
// forwarding of the unchanged real POST, then route.continue()s to the owned center.
// No request payload, response or approval receipt is fabricated or replayed.
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
const mutate = (sql, ...params) => {
  const db = new DatabaseSync(join(root, 'concierge', 'loom.sqlite3'))
  try { return db.prepare(sql).run(...params) } finally { db.close() }
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

  // Third Source job: this SQL is only a deterministic fixture input gate, not
  // authentication or approval. Recovery must come from the real Node heartbeat.
  const thirdSourceObjective = ' Third Source requires reject, restore, then one actual approval。 '
  const rejectReason = 'Hold before selecting the restored exact source-reading host.'
  const approveReason = 'The exact original Grant, project, file and restored worker are approved once.'
  const offlineBeforeHeartbeat = scalar(`SELECT last_heartbeat FROM nodes WHERE id='${runner.nodeId}' AND installation_id='${runner.installationId}'`)
  assert.equal(mutate('UPDATE nodes SET status=? WHERE id=? AND installation_id=?', 'offline', runner.nodeId, runner.installationId).changes, 1)
  const thirdSourceId = await recordMessage(page, thirdSourceObjective)
  assert.equal(thirdSourceId, sourceId)
  await prepareSourceWork(page, { ...scope, contains: thirdSourceObjective })
  const thirdAccepted = await confirmSourceWork(page, { duplicate: false })
  const thirdTicketId = thirdAccepted.ticket.id
  const rejectPath = `/api/v1/tickets/${thirdTicketId}/approval`
  assert.equal(thirdAccepted.ticket.status, 'waiting_approval')
  assert.equal(thirdAccepted.duplicate, false)
  const thirdEvent = (await events()).find(event => event.content === thirdSourceObjective)
  assert.equal(thirdEvent.id, thirdAccepted.source_event_id)
  assert.equal(thirdEvent.ticket_id, null)
  assert.equal(thirdEvent.task_ticket_id, thirdTicketId)
  assert.equal(thirdEvent.creation_kind, 'explicit_task_created_after_intake')
  assert.equal(thirdEvent.task_spec.ticket_id, thirdTicketId)
  assert.equal(thirdEvent.task_spec.event_request_digest, thirdEvent.payload_digest)
  assert.equal(thirdEvent.task_spec.project_id, projectId)
  assert.equal(thirdEvent.task_spec.grant_id, grant.grant.id)
  assert.equal(thirdEvent.task_spec.grant_digest, grant.grant.digest)
  assert.equal(thirdEvent.task_spec.project_binding_id, binding.id)
  assert.equal(thirdEvent.task_spec.root_scope, projectRoot)
  assert.equal(thirdEvent.task_spec.node_id, runner.nodeId)
  assert.equal(thirdEvent.task_spec.installation_id, runner.installationId)
  assert.equal(thirdEvent.task_spec.worker_id, 'default')
  assert.equal(thirdEvent.task_spec.relative_path, 'input.txt')
  assert.equal(thirdEvent.task_spec.digest, thirdAccepted.task_digest)
  const waitingDetail = page.locator('.ticket-detail')
  await waitingDetail.locator('.ticket-id').getByText(thirdTicketId, { exact: false }).waitFor()
  assert.equal(await waitingDetail.locator('.ticket-id').innerText(), `Ticket / ${thirdTicketId}`)
  await waitingDetail.locator('h1').getByText(thirdSourceObjective, { exact: true }).waitFor()
  await waitingDetail.getByText('等待批准', { exact: true }).waitFor()
  const visibleApprovalMeta = await waitingDetail.locator('.detail-meta').innerText()
  assert.ok(visibleApprovalMeta.includes('Explicit Source work in a real browser'), `Approval must show the actual selected Project: ${visibleApprovalMeta}`)
  assert.ok(visibleApprovalMeta.includes('input.txt'), `Approval must show the exact relative input path: ${visibleApprovalMeta}`)
  assert.ok(visibleApprovalMeta.includes('第 0 次尝试'), visibleApprovalMeta)
  const waitingTicket = await admin.get(`/api/v1/tickets/${encodeURIComponent(thirdTicketId)}`)
  assert.equal(waitingTicket.status, 'waiting_approval')
  assert.equal(waitingTicket.project_id, projectId)
  assert.equal(waitingTicket.attempt, 0)
  assert.equal(waitingTicket.grant_id, grant.grant.id)
  assert.equal(waitingTicket.grant_digest, grant.grant.digest)
  assert.equal(waitingTicket.node_id, runner.nodeId)
  assert.equal(waitingTicket.installation_id, runner.installationId)
  assert.equal(waitingTicket.worker_id, 'default')
  assert.equal(waitingTicket.relative_path, 'input.txt')
  assert.equal(waitingTicket.cancel_requested, false)
  for (const field of ['assignments', 'reports', 'artifacts', 'effects']) assert.deepEqual(waitingTicket[field], [])

  // Open the exact persisted Source → Ticket relationship through its historical
  // message, not the fast path which just created that same Ticket. The operator
  // must be able to use its waiting-approval control without closing Source manually.
  if (await page.getByRole('button', { name: '关闭 Source 面板', exact: true }).count()) {
    await page.getByRole('button', { name: '关闭 Source 面板', exact: true }).click()
  }
  await openSourcePanel(page)
  await page.locator('.source-work-panel').getByRole('button', { name: '打开单 Source / thread', exact: true }).click()
  const historicalSource = page.locator('.source-event-card').filter({ hasText: thirdSourceObjective })
  await historicalSource.waitFor()
  const beforeOpenTicketPost = captures('/api/v1/tickets').length
  const historicalOpen = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/tickets/${thirdTicketId}` && response.request().method() === 'GET')
  await historicalSource.getByRole('button', { name: `打开独立任务：${thirdTicketId}`, exact: true }).click()
  assert.equal((await historicalOpen).status(), 200)
  await page.locator('.source-work-modal').waitFor({ state: 'hidden' })
  await waitingDetail.locator('.ticket-id').getByText(thirdTicketId, { exact: false }).waitFor()
  await waitingDetail.getByRole('button', { name: '检查并决定', exact: true }).waitFor({ state: 'visible' })
  const visibleApprovalDecision = waitingDetail.getByRole('button', { name: '检查并决定', exact: true })
  await visibleApprovalDecision.scrollIntoViewIfNeeded()
  assert.equal(await visibleApprovalDecision.evaluate(button => {
    const rect = button.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === button || button.contains(hit)
  }), true, 'The reopened historical approval must be a real visible/hit-testable control, not hidden under Source')
  assert.equal(captures('/api/v1/tickets').length, beforeOpenTicketPost, 'Opening a historical event is a read-only navigation, never a second Task creation')
  assert.equal(captures(rejectPath).length, 0, 'Opening a historical task does not submit any approval on its own')
  for (const field of ['assignments', 'reports', 'artifacts', 'effects']) assert.deepEqual((await admin.get(`/api/v1/tickets/${encodeURIComponent(thirdTicketId)}`))[field], [])
  const beforeRejectCounts = { tickets: 3, assignments: scalar('SELECT COUNT(*) FROM assignments'), reports: scalar('SELECT COUNT(*) FROM reports'), artifacts: scalar('SELECT COUNT(*) FROM artifacts'), effects: scalar('SELECT COUNT(*) FROM effects'), specs: scalar('SELECT COUNT(*) FROM source_work_specs') }
  assert.deepEqual(beforeRejectCounts, { tickets: 3, assignments: 3, reports: 3, artifacts: 2, effects: 2, specs: 3 })
  assert.equal((await admin.get('/api/v1/grants')).grants.length, 1)

  await waitingDetail.getByRole('button', { name: '检查并决定', exact: true }).click()
  await page.locator('#approval-reason').fill(rejectReason)
  await waitingDetail.getByRole('button', { name: '拒绝本次操作', exact: true }).click()
  await page.getByText('拒绝这次工作区操作？', { exact: true }).waitFor()
  assert.equal(await page.locator('.confirm-modal').innerText().then(text => text.includes(rejectReason) && text.includes('input.txt')), true)
  const rejectResponse = page.waitForResponse(response => new URL(response.url()).pathname === rejectPath && response.request().method() === 'POST')
  rejectResponse.catch(error => console.error('SOURCE APPROVAL REJECT WAIT', error.message))
  await page.getByRole('button', { name: '确认拒绝', exact: true }).click()
  const rejectedHttp = await rejectResponse
  assert.equal(rejectedHttp.status(), 200)
  const rejectedBody = await rejectedHttp.json()
  const rejectionRequest = requests.filter(request => request.path === rejectPath && request.method === 'POST').at(-1)
  assert.deepEqual(Object.keys(rejectionRequest.body).sort(), ['approval_id', 'decision', 'reason'])
  assert.match(rejectionRequest.body.approval_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(rejectionRequest.body.decision, 'reject')
  assert.equal(rejectionRequest.body.reason, rejectReason)
  assert.equal(rejectedBody.status, 'waiting_approval')
  assert.equal(rejectedBody.attempt, 0)
  assert.equal(rejectedBody.assignments.length, 0)
  assert.equal(rejectedBody.cancel_requested, false)
  await page.locator('.confirm-modal').waitFor({ state: 'hidden' })
  await waitingDetail.getByText('等待批准', { exact: true }).waitFor()
  const rejectedTicket = await admin.get(`/api/v1/tickets/${encodeURIComponent(thirdTicketId)}`)
  assert.equal(rejectedTicket.status, 'waiting_approval')
  assert.equal(rejectedTicket.cancel_requested, false)
  for (const field of ['assignments', 'reports', 'artifacts', 'effects']) assert.deepEqual(rejectedTicket[field], [])
  const rejectionAudits = (await admin.get(`/api/v1/audit?ticket_id=${encodeURIComponent(thirdTicketId)}`)).audit.filter(entry => entry.action === 'task.approval_rejected')
  assert.equal(rejectionAudits.length, 1)
  assert.equal(rejectionAudits[0].actor, 'client')
  assert.deepEqual(JSON.parse(rejectionAudits[0].evidence).evidence, {
    approval_id: rejectionRequest.body.approval_id, reason: rejectReason, decision: 'reject', assignment_created: false, remains: 'waiting_approval' })
  assert.equal(await runner.pollAndRun().then(result => result.status), 'idle', 'Rejection and offline host cannot emit executable work')
  await runner.client.dispatchOutbox()
  const beforeEmitCounts = { tickets: scalar('SELECT COUNT(*) FROM tickets'), assignments: scalar('SELECT COUNT(*) FROM assignments'), reports: scalar('SELECT COUNT(*) FROM reports'), artifacts: scalar('SELECT COUNT(*) FROM artifacts'), effects: scalar('SELECT COUNT(*) FROM effects'), specs: scalar('SELECT COUNT(*) FROM source_work_specs') }
  assert.deepEqual(beforeEmitCounts, beforeRejectCounts)
  assert.deepEqual(await admin.get(`/api/v1/tickets/${encodeURIComponent(thirdTicketId)}`), rejectedTicket)

  const restoredHeartbeat = await runner.client.heartbeat({ capabilities: runner.capabilities, workers: [{ worker_id: 'default' }], inventory: { project_roots: { [projectId]: projectRoot } } })
  assert.equal(restoredHeartbeat.accepted, true)
  assert.equal(scalar(`SELECT status FROM nodes WHERE id='${runner.nodeId}' AND installation_id='${runner.installationId}'`), 'online', 'Only the genuine Node heartbeat restores status')
  const restoredHeartbeatAt = scalar(`SELECT last_heartbeat FROM nodes WHERE id='${runner.nodeId}' AND installation_id='${runner.installationId}'`)
  assert.ok(Date.parse(restoredHeartbeatAt) > Date.parse(offlineBeforeHeartbeat), 'The accepted authenticated heartbeat gives genuinely fresh placement evidence')
  assert.ok(Date.parse(restoredHeartbeatAt) >= Date.parse(waitingTicket.created_at), 'Waiting approval cannot manufacture online freshness or success')
  await waitingDetail.getByRole('button', { name: '检查并决定', exact: true }).click()
  await page.locator('#approval-reason').fill(approveReason)
  await waitingDetail.getByRole('button', { name: '批准，仅限这一次', exact: true }).click()
  await page.getByText('批准这次工作区操作？', { exact: true }).waitFor()
  assert.equal(await page.locator('.confirm-modal').innerText().then(text => text.includes(approveReason) && text.includes('input.txt')), true)
  const approveResponse = page.waitForResponse(response => new URL(response.url()).pathname === rejectPath && response.request().method() === 'POST')
  approveResponse.catch(error => console.error('SOURCE APPROVAL GRANT WAIT', error.message))
  let releaseApproval
  const approvalFlight = new Promise(resolve => { releaseApproval = resolve })
  await page.route(`**${rejectPath}`, async route => {
    // Delay only the real network hop, then forward the original request with
    // its existing authentication and normalized reason into the actual Rust center.
    await approvalFlight
    await route.continue()
  })
  const approvalInFlight = page.waitForRequest(request => new URL(request.url()).pathname === rejectPath && request.method() === 'POST')
  await page.getByRole('button', { name: '确认一次性批准', exact: true }).click()
  await approvalInFlight
  // Do not bypass the overlay via a forced pointer click. The actual current
  // modal has no enabled controls while its action is pending; verify reachable
  // keyboard navigation so this is an achievable UI path, not a synthetic state edit.
  let reachedProjects = false
  const focusTrace = []
  for (let attempt = 0; attempt < 24; attempt++) {
    reachedProjects = await page.evaluate(() => {
      const active = document.activeElement
      return active instanceof HTMLButtonElement && active.matches('nav.main-nav button, nav.mobile-tabs button')
        && active.textContent.trim() === '项目' && active.getBoundingClientRect().width > 0 && active.getBoundingClientRect().height > 0
    })
    if (!reachedProjects) focusTrace.push(await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      label: document.activeElement instanceof HTMLButtonElement ? document.activeElement.textContent.trim().slice(0, 60) : null,
      aria: document.activeElement?.getAttribute('aria-label') ?? null,
      parents: document.activeElement ? [...document.activeElement.parentElement?.classList ?? [], ...document.activeElement.parentElement?.parentElement?.classList ?? []] : [],
    })))
    if (reachedProjects) break
    await page.keyboard.press('Tab')
  }
  assert.equal(reachedProjects, true, `The busy confirmation must allow actual keyboard focus to reach the existing Projects navigation; actual focus trace: ${JSON.stringify(focusTrace)}`)
  await page.keyboard.press('Enter')
  await page.locator('.page-title').getByRole('heading', { name: '项目有位置，授权有范围。', exact: true }).waitFor({ state: 'attached' })
  releaseApproval()
  const approvedHttp = await approveResponse
  await page.unroute(`**${rejectPath}`)
  assert.equal(approvedHttp.status(), 200)
  const approvedBody = await approvedHttp.json()
  const approveRequest = requests.filter(request => request.path === rejectPath && request.method === 'POST').at(-1)
  assert.deepEqual(Object.keys(approveRequest.body).sort(), ['approval_id', 'decision', 'reason'])
  assert.match(approveRequest.body.approval_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.notEqual(approveRequest.body.approval_id, rejectionRequest.body.approval_id)
  assert.equal(approveRequest.body.decision, 'approve')
  assert.equal(approveRequest.body.reason, approveReason)
  assert.equal(approvedBody.status, 'running')
  assert.equal(approvedBody.attempt, 1)
  assert.equal(approvedBody.assignments.length, 1)
  await page.locator('.confirm-modal').waitFor({ state: 'hidden' })
  // The approved decision completed, but this delayed operator's own Projects
  // navigation must not be overwritten by an unconditional old-Ticket selection.
  await page.getByRole('heading', { name: '项目有位置，授权有范围。', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('.ticket-detail').count(), 0)
  const approvalNavigationWasProjects = (await page.locator('.page-title h1').filter({ hasText: '项目有位置，授权有范围。' }).count()) === 1
  assert.equal(approvalNavigationWasProjects, true)
  const approvedTicket = await admin.get(`/api/v1/tickets/${encodeURIComponent(thirdTicketId)}`)
  assert.equal(approvedTicket.status, 'running')
  assert.equal(approvedTicket.attempt, 1)
  assert.equal(approvedTicket.assignments.length, 1)
  const newAssignment = approvedTicket.assignments[0]
  assert.notEqual(newAssignment.id, secondTicket.assignments[0].id)
  assert.ok(newAssignment.lease_id)
  assert.equal(newAssignment.ticket_id, thirdTicketId)
  assert.equal(newAssignment.node_id, runner.nodeId)
  assert.equal(newAssignment.worker_id, 'default')
  assert.equal(newAssignment.attempt, 1)
  assert.equal(newAssignment.lease_epoch, 1)
  assert.equal(approvedTicket.grant_id, grant.grant.id)
  assert.equal(approvedTicket.grant_digest, grant.grant.digest)
  assert.equal(approvedTicket.installation_id, runner.installationId)
  assert.equal(approvedTicket.reports.length, 0)
  assert.equal(approvedTicket.artifacts.length, 0)
  assert.equal(approvedTicket.effects.length, 0)
  assert.equal(scalar('SELECT COUNT(*) FROM assignments'), beforeEmitCounts.assignments + 1)
  assert.equal(scalar('SELECT COUNT(*) FROM reports'), beforeEmitCounts.reports)
  assert.equal(scalar('SELECT COUNT(*) FROM artifacts'), beforeEmitCounts.artifacts)
  assert.equal(scalar('SELECT COUNT(*) FROM effects'), beforeEmitCounts.effects)
  assert.equal(scalar('SELECT COUNT(*) FROM grants'), 1)
  assert.deepEqual(await admin.get(`/api/v1/tickets/${encodeURIComponent(ticketId)}`), ticket)
  assert.deepEqual(await admin.get(`/api/v1/tickets/${encodeURIComponent(secondTicketId)}`), secondTicket)
  const approvalAudits = (await admin.get(`/api/v1/audit?ticket_id=${encodeURIComponent(thirdTicketId)}`)).audit.filter(entry => entry.action === 'task.approval_granted')
  assert.equal(approvalAudits.length, 1)
  assert.equal(approvalAudits[0].actor, 'client')
  const grantedEvidence = JSON.parse(approvalAudits[0].evidence).evidence
  assert.equal(grantedEvidence.approval_id, approveRequest.body.approval_id)
  assert.equal(grantedEvidence.reason, approveReason)
  assert.equal(grantedEvidence.decision, 'approve')
  assert.equal(grantedEvidence.assignment_id, newAssignment.id)
  assert.equal(grantedEvidence.lease_id, newAssignment.lease_id)
  assert.equal(grantedEvidence.lease_epoch, 1)
  assert.equal(grantedEvidence.attempt, 1)
  assert.equal(grantedEvidence.node_id, runner.nodeId)
  assert.equal(grantedEvidence.grant_id, grant.grant.id)
  assert.equal(grantedEvidence.grant_digest, grant.grant.digest)
  assert.equal(grantedEvidence.source_authority_preserved, true)
  assert.equal(grantedEvidence.grant_created, false)

  // Revisit the accepted ticket intentionally for its real Node/report evidence,
  // rather than relying on completion to force this page on the operator.
  const conversationNavigation = page.getByRole('button', { name: '对话', exact: true })
  let reopenedConversation = false
  for (let index = 0; index < await conversationNavigation.count(); index++) {
    if (await conversationNavigation.nth(index).isVisible()) {
      await conversationNavigation.nth(index).click()
      reopenedConversation = true
      break
    }
  }
  assert.equal(reopenedConversation, true, 'Use the actual visible navigation to reopen the approved Ticket after preserving Projects')
  await waitingDetail.locator('.ticket-id').getByText(thirdTicketId, { exact: false }).waitFor()
  const thirdOutcome = await deliver()
  assert.equal(thirdOutcome.status, 'succeeded')
  assert.equal(thirdOutcome.assignmentId, newAssignment.id)
  await waitingDetail.locator('.ticket-id').getByText(thirdTicketId, { exact: false }).waitFor()
  await waitingDetail.getByText('收到成功报告', { exact: true }).waitFor()
  const thirdTicket = await admin.get(`/api/v1/tickets/${encodeURIComponent(thirdTicketId)}`)
  assert.equal(thirdTicket.status, 'succeeded')
  assert.equal(thirdTicket.attempt, 1)
  assert.equal(thirdTicket.assignments.length, 1)
  assert.equal(thirdTicket.reports.length, 1)
  assert.equal(thirdTicket.reports[0].state, 'succeeded')
  assert.equal(thirdTicket.reports[0].assignment_id, newAssignment.id)
  assert.equal(thirdTicket.reports[0].lease_epoch, 1)
  assert.equal(thirdTicket.artifacts.length, 1)
  assert.equal(thirdTicket.artifacts[0].assignment_id, newAssignment.id)
  assert.equal(thirdTicket.artifacts[0].origin_node_id, runner.nodeId)
  assert.equal(thirdTicket.effects.length, 1)
  assert.equal(thirdTicket.effects[0].status, 'confirmed')
  assert.equal(thirdTicket.effects[0].assignment_id, newAssignment.id)
  const thirdArtifactId = thirdTicket.artifacts[0].id ?? thirdTicket.artifacts[0].artifact_id
  assert.match(thirdArtifactId, /^[0-9a-f-]{36}$/i)
  const thirdArtifactPath = `/api/v1/tickets/${thirdTicketId}/artifacts/${thirdArtifactId}`
  const thirdNativeDownload = await page.evaluate(async ({ clientToken, path }) => {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${clientToken}`, Accept: 'application/json' } })
    return { status: response.status, body: await response.json() }
  }, { clientToken: token, path: thirdArtifactPath })
  assert.equal(thirdNativeDownload.status, 200)
  assert.equal(thirdNativeDownload.body.artifact.assignment_id, newAssignment.id, 'The native download artifact must name the exact approved Assignment')
  const thirdSummary = JSON.parse(thirdNativeDownload.body.content)
  assert.equal(thirdSummary.path, 'input.txt')
  assert.equal(thirdSummary.byte_length, originalInputBytes.length)
  assert.equal(thirdSummary.input_sha256, sha256(originalInputBytes))
  assert.ok(thirdSummary.lines.includes('Real isolated project input.'))
  assert.equal(sha256(thirdNativeDownload.body.content), thirdTicket.artifacts[0].sha256)
  assert.equal(thirdNativeDownload.body.artifact.sha256, thirdTicket.artifacts[0].sha256)
  const thirdArtifactResponse = page.waitForResponse(response => new URL(response.url()).pathname === thirdArtifactPath && response.request().method() === 'GET')
  thirdArtifactResponse.catch(error => console.error('SOURCE THIRD ARTIFACT WAIT', error.message))
  await waitingDetail.locator('.artifact-card').click()
  assert.equal((await thirdArtifactResponse).status(), 200)
  await waitingDetail.locator('.artifact-content').waitFor()
  assert.equal(await waitingDetail.locator('.artifact-content').innerText(), thirdNativeDownload.body.content)
  assert.equal(await waitingDetail.locator('.artifact-metadata').innerText().then(text => text.includes(thirdTicket.artifacts[0].sha256)), true)
  const thirdApprovalHistory = (await admin.get(`/api/v1/audit?ticket_id=${encodeURIComponent(thirdTicketId)}`)).audit.filter(entry => ['task.approval_rejected', 'task.approval_granted'].includes(entry.action))
  assert.equal(thirdApprovalHistory.filter(entry => entry.action === 'task.approval_rejected').length, 1)
  assert.equal(thirdApprovalHistory.filter(entry => entry.action === 'task.approval_granted').length, 1)
  const thirdSpec = (await events()).find(event => event.id === thirdEvent.id).task_spec
  assert.deepEqual(thirdSpec, thirdEvent.task_spec)
  assert.deepEqual((await admin.get('/api/v1/grants')).grants.filter(row => row.id === grant.grant.id).map(row => row.digest), [grant.grant.digest])
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
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, 3, 'Revocation must not add to the three legitimately delivered Source jobs')
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
  const thirdAfterRevocation = await admin.get(`/api/v1/tickets/${encodeURIComponent(thirdTicketId)}`)
  assert.equal(thirdAfterRevocation.id, thirdTicket.id)
  assert.equal(thirdAfterRevocation.status, 'succeeded')
  assert.equal(thirdAfterRevocation.objective, thirdTicket.objective)
  assert.equal(thirdAfterRevocation.grant_id, thirdTicket.grant_id)
  assert.equal(thirdAfterRevocation.grant_digest, thirdTicket.grant_digest)
  assert.deepEqual(thirdAfterRevocation.artifacts, thirdTicket.artifacts)
  assert.deepEqual(thirdAfterRevocation.effects, thirdTicket.effects)
  assert.deepEqual(thirdAfterRevocation.reports, thirdTicket.reports)
  assert.deepEqual(thirdAfterRevocation.assignments.map(({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id }) =>
    ({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id })),
  thirdTicket.assignments.map(({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id }) =>
    ({ acknowledged_at, attempt, cancelled_at, created_at, grant_digest, id, lease_epoch, lease_id, node_id, ticket_id, worker_id })))
  assert.ok(thirdAfterRevocation.assignments.every(assignment => Date.parse(assignment.lease_expires_at) <= Date.now()))
  assert.equal((await admin.get('/api/v1/tickets')).tickets.length, 3)
  assert.equal((await events()).filter(event => event.id === thirdEvent.id)[0].task_ticket_id, thirdTicketId)

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
  assert.equal(scalar('SELECT COUNT(*) FROM tickets'), 3)
  const finalDetails = []
  for (const id of [ticketId, secondTicketId, thirdTicketId]) {
    const detail = await admin.get(`/api/v1/tickets/${encodeURIComponent(id)}`)
    finalDetails.push(detail)
    console.error('SOURCE FINAL REPORTS', id, JSON.stringify(detail.reports.map(report => ({ id: report.id, assignment_id: report.assignment_id, state: report.state }))))
  }
  console.error('SOURCE FINAL SQL REPORTS', scalar('SELECT COUNT(*) FROM reports'))
  assert.equal(scalar('SELECT COUNT(*) FROM assignments'), 4)
  assert.equal(scalar('SELECT COUNT(*) FROM reports'), 4, 'Two first-Ticket failure/retry Reports and two subsequent one-attempt successes')
  assert.equal(firstAfterRevocation.reports.filter(report => report.state === 'failed').length, 1)
  assert.equal(firstAfterRevocation.reports.filter(report => report.state === 'succeeded').length, 1)
  assert.equal(secondAfterRevocation.reports.filter(report => report.state === 'succeeded').length, 1)
  assert.equal(thirdAfterRevocation.reports.filter(report => report.state === 'succeeded').length, 1)
  assert.equal(finalDetails.flatMap(detail => detail.reports).filter(report => report.state === 'failed').length, 1)
  assert.equal(finalDetails.flatMap(detail => detail.reports).filter(report => report.state === 'succeeded').length, 3)
  assert.equal(scalar('SELECT COUNT(*) FROM artifacts'), 3)
  assert.equal(scalar('SELECT COUNT(*) FROM effects'), 3)
  assert.equal(scalar('SELECT COUNT(*) FROM source_work_specs'), 3)
  assert.equal((await events()).filter(event => event.creation_kind === 'explicit_task_created_after_intake').length, 3)
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
    historical_source_open_ticket_closes_modal_and_exposes_waiting_approval: true,
    historical_navigation_is_read_only_without_new_ticket_or_approval: true,
    actual_reject_then_approve_source_first_attempt: true,
    approval_reason_persisted_as_actual_audit: { reject: rejectReason, approve: approveReason },
    approval_distinct_opaque_ids: true,
    approval_issued_one_assignment_only: newAssignment.id,
    approval_actual_download_matches_original_source: { input_sha256: thirdSummary.input_sha256, artifact_sha256: thirdTicket.artifacts[0].sha256, assignment_id: newAssignment.id },
    heartbeat_restored_before_approval: true,
    rejection_zero_runtime_and_not_cancelled: true,
    approval_source_authority_preserved_without_new_grant: true,
    approval_navigation_preserved_after_in_flight: approvalNavigationWasProjects,
    approval_keyboard_navigation_actual: true,
    three_source_tasks_three_immutable_specs: true,
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
