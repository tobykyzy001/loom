import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

const appRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url))
const NAME = 'Bounded exact deterministic read_summary'
const expectedSummary = {
  actual_ui_replay_confirmed: true,
  real_ordinary_worker_observed: true,
  explicit_accept_persisted: true,
  source_replay_sha_match: true,
  no_new_grant_or_memory: true,
  no_standing_permission: true,
  narrow_no_overflow: true,
}

/** The caller already completed exactly one ordinary read_summary source Ticket
 * and generated one pending Skill candidate. Only this new Browser starts replay.
 * Never auto-launch Worker, install a Skill or mutate a real/user DSH profile.
 */
export async function verifySkillsBrowser({ server, admin, node, root, candidateId, source, runWorker }) {
  assert.ok(server?.baseUrl && server.clientToken && root && candidateId && source?.id)
  assert.equal(typeof runWorker, 'function', 'Real supplied LocalNode runner callback required')
  assert.ok(isAbsolute(root) && resolve(root) !== '/' && resolve(root) !== process.env.HOME)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const parsedBase = new URL(server.baseUrl)
  assert.equal(parsedBase.protocol, 'http:')
  assert.equal(parsedBase.hostname, '127.0.0.1')
  assert.ok(parsedBase.port && !parsedBase.username && !parsedBase.password && parsedBase.pathname === '/' && !parsedBase.search && !parsedBase.hash)
  const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(executable)), true, `NOT RUN: no installed browser at ${executable}`)
  const output = join(root, 'skills-proof.json')
  const desktop = join(root, 'skills-proof-desktop.png')
  const narrow = join(root, 'skills-proof-narrow.png')
  const auth = admin || new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 15000 })
  const read = (path) => auth.get(path)
  const pad = (id) => encodeURIComponent(id)
  const redact = (input) => String(input).replaceAll(server.clientToken, '[redacted-fixture-token]').replaceAll(root, '<synthetic-fixture>').slice(0, 6500)
  let browser, preview, page, failure
  const logs = []
  let bootstrap401 = 0
  let bootstrapConsole401 = 0
  const deadline = async (promise, label, timeoutMs = 30000) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) })]) }
    finally { clearTimeout(timer) }
  }
  const getWaitingProof = async () => {
    const end = Date.now() + 20000
    let value
    while (Date.now() < end) {
      value = await read(`/api/v1/candidates/${pad(candidateId)}/replay`)
      if (value.status === 'verified') return value
      assert.ok(['awaiting_execution', 'verified'].includes(value.status), `Replay failed before accepting proof: ${redact(JSON.stringify(value))}`)
      await new Promise((ok) => setTimeout(ok, 150))
    }
    return value
  }
  try {
    // Reload the live terminal source; requests containing original Assignment
    // can predate the real worker report, while raw data remains authoritative.
    const sourceTicket = await read(`/api/v1/tickets/${pad(source.id)}`)
    assert.equal(sourceTicket.id, source.id)
    assert.equal(sourceTicket.kind, 'read_summary')
    assert.equal(sourceTicket.status, 'succeeded', JSON.stringify({ source_ticket: sourceTicket, prior_source: source }))
    assert.equal(sourceTicket.cancel_requested !== true, true)
    assert.equal(sourceTicket.reports.length, 1)
    assert.equal(sourceTicket.reports[0].state, 'succeeded')
    assert.equal(sourceTicket.assignments.length, 1)
    assert.equal(sourceTicket.artifacts.length, 1)
    const sourceArtifact = sourceTicket.artifacts[0]
    const sourceId = sourceArtifact.artifact_id ?? sourceArtifact.id
    assert.ok(sourceId)
    if (sourceArtifact.artifact_id && sourceArtifact.id) assert.equal(sourceArtifact.artifact_id, sourceArtifact.id)
    if (source.artifact_id) assert.equal(source.artifact_id, sourceId)
    const sourceDownload = await read(`/api/v1/tickets/${pad(source.id)}/artifacts/${pad(sourceId)}`)
    assert.equal(sourceDownload.artifact.id, sourceId)
    assert.equal(sourceDownload.artifact.ticket_id, source.id)
    assert.equal(typeof sourceDownload.content, 'string')
    const sourceSha = createHash('sha256').update(sourceDownload.content).digest('hex')
    assert.equal(sourceSha, sourceArtifact.sha256)
    const initial = await read('/api/v1/candidates')
    const candidate = initial.candidates.find((entry) => entry.id === candidateId)
    assert.ok(candidate)
    assert.equal(candidate.kind, 'skill')
    assert.equal(initial.candidates.length, 1, 'This fixture contains exactly one real Skill candidate')
    assert.equal(candidate.status, 'pending', 'Before replay the real candidate must be pending, not pre-accepted')
    let content
    if (typeof candidate.content === 'string') content = JSON.parse(candidate.content)
    assert.equal(content?.content, NAME)
    const rawRefs = typeof candidate.source_refs === 'string' ? JSON.parse(candidate.source_refs) : candidate.source_refs
    assert.ok(Array.isArray(rawRefs) && rawRefs.some((ref) => (typeof ref === 'string' ? ref : ref.ticket_id) === source.id))
    assert.ok(!initial.skill_replays.some((replay) => replay.candidate_id === candidateId))
    assert.equal(initial.skills.length, 0)
    const [beforeGrants, beforeMemory, beforeTickets] = await Promise.all([read('/api/v1/grants'), read('/api/v1/memories'), read('/api/v1/tickets')])
    const beforeGrantIds = beforeGrants.grants.map((grant) => grant.id).sort()
    const grant = beforeGrants.grants.find((grant) => !grant.revoked_at && grant.operations?.includes('read'))
    assert.ok(grant, 'The original Grant must still authorize ordinary bounded reading on first validation')
    assert.ok(beforeTickets.tickets.some((ticket) => ticket.id === source.id))
    if (node?.nodeId) assert.equal(sourceTicket.node_id, node.nodeId)

    const { createServer } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
    const { chromium } = await import('playwright-core')
    preview = await createServer({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', cacheDir: join(root, '.skills-proof-vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, fs: { allow: [appRoot] },
        proxy: { '/api': { target: server.baseUrl, changeOrigin: true } } } })
    await preview.listen()
    const previewAddress = preview.httpServer.address()
    assert.ok(previewAddress && previewAddress.address === '127.0.0.1' && previewAddress.port > 0)
    const appOrigin = `http://127.0.0.1:${previewAddress.port}`
    const context = await chromium.launchPersistentContext(join(root, 'skills-proof-browser-profile'), {
      executablePath: executable, headless: true, viewport: { width: 1280, height: 1000 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-default-apps',
        '--disable-background-networking', '--disable-component-update', '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server',
        '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
      env: { PATH: process.env.PATH, TMPDIR: root }, timeout: 30000,
    })
    browser = context
    const initialPages = context.pages()
    assert.equal(initialPages.length, 1)
    page = initialPages[0]
    assert.equal(page.url(), 'about:blank', 'Only a new standalone test session is allowed')
    page.setDefaultTimeout(20000)
    page.setDefaultNavigationTimeout(30000)
    let replayRequest, replayResponsePromise, acceptRequest, acceptResponsePromise
    await page.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.protocol !== 'http:' || ![appOrigin, server.baseUrl].includes(url.origin)) {
        logs.push(`BLOCKED_EXTERNAL_REQUEST ${url.protocol}//${url.hostname}:${url.port}${url.pathname}`)
        return route.abort('blockedbyclient')
      }
      const path = url.pathname
      const prefix = `/api/v1/candidates/${pad(candidateId)}`
      if (path === `${prefix}/replay` && request.method() === 'POST' && !replayRequest) {
        assert.equal(Object.hasOwn(request.headers(), 'authorization'), true)
        replayRequest = request
        replayResponsePromise = page.waitForResponse((response) => response.request() === request)
      }
      if (path === prefix && request.method() === 'PATCH' && !acceptRequest) {
        assert.equal(Object.hasOwn(request.headers(), 'authorization'), true)
        acceptRequest = request
        acceptResponsePromise = page.waitForResponse((response) => response.request() === request)
      }
      return route.continue()
    })
    page.on('pageerror', (error) => logs.push(`PAGEERROR ${error.message}`))
    page.on('console', (message) => {
      const initialBootstrap401 = message.type() === 'error' && bootstrapConsole401 === 0
        && message.location().url.includes('/api/v1/bootstrap')
        && message.text().includes('401 (Unauthorized)')
      if (initialBootstrap401) { bootstrapConsole401++; return }
      if (['error', 'warning'].includes(message.type())) logs.push(`CONSOLE_${message.type().toUpperCase()} ${message.text().slice(0, 1600)}`)
    })
    page.on('requestfailed', (request) => logs.push(`REQUEST_FAILED ${new URL(request.url()).pathname}`))
    page.on('response', (response) => {
      if (response.status() >= 400) {
        const url = URL.parse(response.url())
        const unauthenticated = !Object.hasOwn(response.request().headers(), 'authorization')
        if (response.status() === 401 && url?.pathname === '/api/v1/bootstrap' && unauthenticated && bootstrap401 === 0) {
          bootstrap401++
          return
        }
        logs.push(`HTTP_${response.status()} ${url?.pathname ?? response.url()}`)
      }
    })
    const safe = async () => {
      const body = await page.locator('body').innerText()
      assert.equal(await page.locator('#client-token, .enrollment-code').count(), 0)
      assert.equal(body.includes(server.clientToken), false, 'Screenshot credential guard')
    }
    await page.goto(appOrigin, { waitUntil: 'domcontentloaded' })
    await page.locator('.loom-app').waitFor()
    await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
    assert.equal(await page.locator('#client-token').getAttribute('type'), 'password')
    await page.locator('#client-token').fill(server.clientToken)
    await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
    await page.locator('.main-nav').getByRole('button', { name: '技能', exact: true }).click()
    const skills = page.locator('.skills-view')
    await skills.waitFor()
    const candidateCard = () => skills.locator(`.skill-card[data-candidate-id="${candidateId}"]`)
    const initialCard = candidateCard()
    await initialCard.waitFor()
    assert.equal(await initialCard.count(), 1)
    assert.match(await initialCard.innerText(), /Bounded exact deterministic read_summary/)
    await initialCard.locator('select').selectOption(source.id)
    assert.equal(await initialCard.getByRole('button', { name: '接受已验证证据', exact: true }).count(), 0, 'No accept may happen before real replay proof')
    await initialCard.getByRole('button', { name: '审阅回放影响', exact: true }).click()
    const replayModal = page.locator('.confirm-modal')
    await replayModal.waitFor()
    assert.match(await replayModal.innerText(), /确认这次有限回放？/)
    const modalText = await replayModal.innerText()
    assert.ok(modalText.includes(source.id) && modalText.includes('生成独立 Ticket') && modalText.includes('不创建 Grant'))
    await Promise.all([replayResponsePromise, page.getByRole('button', { name: '确认发起普通只读回放', exact: true }).click()])
    const replayResponse = await replayResponsePromise
    assert.ok(replayRequest && replayResponse)
    assert.deepEqual(replayRequest.postDataJSON(), { source_ticket_id: source.id }, 'Only actual scoped source ticket, never boolean proof/root/artifact authority')
    assert.ok(replayResponse.status() < 300)
    const issued = await replayResponse.json()
    assert.equal(issued.status, 'awaiting_execution')
    assert.notEqual(issued.replay_ticket_id, source.id)
    assert.ok(issued.replay_ticket_id)
    assert.equal(issued.source_artifact_id, sourceId)
    assert.equal(issued.replay_artifact_id, null)
    assert.equal(issued.authority_created, false)
    assert.equal((await read('/api/v1/candidates')).skills.length, 0)
    await candidateCard().getByRole('button', { name: '接受已验证证据', exact: true }).waitFor({ state: 'visible' })
    assert.equal(await candidateCard().getByRole('button', { name: '接受已验证证据', exact: true }).isDisabled(), true, 'UI accept must remain disabled until actual verified replay')
    assert.match(await candidateCard().innerText(), /等待真实执行|等待普通节点的真实报告/)
    assert.equal((await read('/api/v1/tickets')).tickets.length, beforeTickets.tickets.length + 1, 'Exactly one ordinary replay Ticket')
    const workerOutcome = await deadline(runWorker(), 'Explicit caller-supplied ordinary LocalNode execution', 60000)
    assert.equal(workerOutcome?.status, 'succeeded', `Actual replay must complete a real ordinary worker outcome: ${JSON.stringify(workerOutcome)}`)
    const proof = await deadline(getWaitingProof(), 'Backend replay verification')
    assert.equal(proof.status, 'verified')
    assert.ok(proof.verified_at)
    assert.equal(proof.authority_created, false)
    assert.equal(proof.current_project_valid, true)
    assert.equal(proof.expected_sha256, sourceSha)
    assert.equal(proof.source_artifact_id, sourceId)
    assert.notEqual(proof.replay_artifact_id, sourceId)
    assert.equal(proof.source_ticket_id, source.id)
    assert.notEqual(proof.replay_ticket_id, source.id)
    assert.equal(proof.replay_ticket_id, issued.replay_ticket_id)
    const [replayTicket, replayDownload, oldTicketAgain] = await Promise.all([
      read(`/api/v1/tickets/${pad(proof.replay_ticket_id)}`),
      read(`/api/v1/tickets/${pad(proof.replay_ticket_id)}/artifacts/${pad(proof.replay_artifact_id)}`),
      read(`/api/v1/tickets/${pad(source.id)}`),
    ])
    assert.equal(replayTicket.status, 'succeeded')
    assert.equal(replayTicket.kind, 'read_summary')
    assert.equal(replayTicket.assignments.length, 1)
    assert.equal(replayTicket.reports[0].state, 'succeeded')
    assert.notEqual(replayTicket.assignments[0].id, sourceTicket.assignments[0].id)
    assert.notEqual(replayTicket.assignments[0].lease_id, sourceTicket.assignments[0].lease_id)
    assert.equal(replayDownload.artifact.id, proof.replay_artifact_id)
    assert.notEqual(replayDownload.artifact.assignment_id, sourceArtifact.assignment_id)
    assert.equal(createHash('sha256').update(replayDownload.content).digest('hex'), sourceSha)
    assert.equal(replayDownload.content, sourceDownload.content)
    assert.equal(oldTicketAgain.artifacts[0].id ?? oldTicketAgain.artifacts[0].artifact_id, sourceId)
    assert.equal(oldTicketAgain.artifacts[0].sha256, sourceSha)
    assert.equal((await read(`/api/v1/tickets/${pad(source.id)}/artifacts/${pad(sourceId)}`)).content, sourceDownload.content)
    await skills.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(({ id, replayTicketId }) => {
      const el = [...document.querySelectorAll('.skills-view .skill-card')].find(card => card.getAttribute('data-candidate-id') === id)
      return !!el && el.textContent.includes('回放证据已通过') && el.textContent.includes('服务端报告已验证') && el.textContent.includes(replayTicketId)
    }, { id: candidateId, replayTicketId: proof.replay_ticket_id })
    const verifiedText = await candidateCard().innerText()
    assert.ok(verifiedText.includes(proof.source_artifact_id) && verifiedText.includes(proof.replay_artifact_id))
    assert.ok(verifiedText.includes(sourceSha))
    assert.ok(verifiedText.includes(source.id) && verifiedText.includes(proof.replay_ticket_id))
    const accept = candidateCard().getByRole('button', { name: '接受已验证证据', exact: true })
    assert.equal(await accept.isDisabled(), false)
    await accept.click()
    await replayModal.waitFor()
    assert.match(await replayModal.innerText(), /接受这项回放证据？/)
    const saveInformation = await replayModal.innerText()
    assert.ok(saveInformation.includes(source.id) && saveInformation.includes(proof.replay_ticket_id) && saveInformation.includes(sourceSha))
    assert.match(saveInformation, /不会提供 Skill 运行、激活或后续执行权限/)
    await Promise.all([acceptResponsePromise, page.getByRole('button', { name: '确认保存证明', exact: true }).click()])
    const acceptResponse = await acceptResponsePromise
    assert.deepEqual(acceptRequest.postDataJSON(), { decision: 'accept' }, 'Explicit acceptance only; no new activation or arbitrary Grant')
    assert.ok(acceptResponse.status() < 300)
    const saved = await read('/api/v1/candidates')
    assert.equal(saved.skills.length, 1)
    assert.equal(saved.skill_replays.length, 1)
    const stored = saved.skills[0]
    assert.equal(stored.candidate_id, candidateId)
    assert.equal(stored.replay_ticket_id, proof.replay_ticket_id)
    assert.equal(stored.replay_artifact_id, proof.replay_artifact_id)
    const savedProof = JSON.parse(stored.proof_json)
    assert.equal(savedProof.standing_grant, false)
    assert.equal(savedProof.activation, false)
    assert.equal(savedProof.replay_verified, true)
    assert.equal(savedProof.bounded_operation, 'read_summary')
    assert.equal(savedProof.sha256, sourceSha)
    const candidateAfter = saved.candidates.find((entry) => entry.id === candidateId)
    assert.equal(candidateAfter.status, 'accepted')
    const [afterGrants, afterMemory, afterTickets] = await Promise.all([read('/api/v1/grants'), read('/api/v1/memories'), read('/api/v1/tickets')])
    assert.deepEqual(afterGrants.grants.map((item) => item.id).sort(), beforeGrantIds)
    assert.equal(afterMemory.memories.length, beforeMemory.memories.length)
    assert.equal(afterTickets.tickets.length, beforeTickets.tickets.length + 1)
    await page.locator('.saved-skills .saved-proof').filter({ hasText: candidateId }).waitFor()
    const proofText = await page.locator('.saved-skills .saved-proof').filter({ hasText: candidateId }).innerText()
    assert.match(proofText, /历史证明 · 非激活/)
    assert.match(proofText, /不是可执行 Skill，不是新授权/)
    assert.ok(proofText.includes(source.id) && proofText.includes(proof.replay_ticket_id))
    assert.ok(proofText.includes(sourceId) && proofText.includes(proof.replay_artifact_id))
    assert.ok(proofText.includes(sourceSha))
    await safe()
    await page.screenshot({ path: desktop, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => document.documentElement.scrollWidth <= 390)
    await page.locator('.saved-proof').filter({ hasText: candidateId }).scrollIntoViewIfNeeded()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true)
    await safe()
    await page.screenshot({ path: narrow, fullPage: true })
    assert.equal(logs.some((entry) => entry.includes(server.clientToken)), false)
    assert.deepEqual(logs, [], `Unexpected browser/API errors: ${logs.join(' | ')}`)
  } catch (error) {
    failure = error
    if (page) {
      await page.screenshot({ path: join(root, 'skills-proof-failure.png'), fullPage: true }).catch(() => {})
      const diagnostic = await page.evaluate(() => ({ url: location.href,
        content: document.body.innerText.slice(0, 4500),
        connection_error: document.querySelector('.connection-banner')?.textContent || null,
        pending_errors: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent.slice(0, 1000)),
        skillsPresent: !!document.querySelector('.skills-view'),
        nav: [...document.querySelectorAll('.main-nav button')].map(node => node.textContent) })).catch(() => null)
      if (diagnostic) {
        await writeFile(join(root, 'skills-proof-diagnostic.json'), redact(JSON.stringify(diagnostic, null, 2)), { mode: 0o600 })
      }
    }
  } finally {
    await browser?.close().catch((error) => { failure ||= error })
    if (browser) await rm(join(root, 'skills-proof-browser-profile'), { recursive: true, force: true })
    await preview?.close().catch((error) => { failure ||= error })
    await rm(join(root, '.skills-proof-vite-cache'), { recursive: true, force: true }).catch(() => {})
    if (failure) {
      await writeFile(output, JSON.stringify({ status: 'FAIL', error: redact(failure.stack || failure), logs: logs.map(redact) }, null, 2), { mode: 0o600 })
      throw new Error(`SKILLS_BROWSER_FAIL ${redact(failure.stack || failure)}\nDiagnostic files live only in the test-owned fixture: ${output}`, { cause: failure })
    }
    await writeFile(output, JSON.stringify({ ...expectedSummary, screenshot_paths: { desktop, narrow } }, null, 2), { mode: 0o600 })
    console.log(`SKILLS_BROWSER_PASS screenshots=${desktop},${narrow}`)
    return { ...expectedSummary, screenshot_paths: { desktop, narrow } }
  }
}
