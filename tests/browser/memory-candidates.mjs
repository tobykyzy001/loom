import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The caller provides real Tickets/Candidate. Only this controller-authenticated
 * browser may save/withdraw its submitted preference; no transcript listener,
 * background worker or actual DSH Profile/state is installed. */
export async function verifyMemoryCandidateBrowser({ server, root, candidateId }) {
  const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  assert.ok(existsSync(executable), `NOT RUN browser: ${executable}`)
  const appRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url))
  const { createServer } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
  const { chromium } = await import('playwright-core')
  await mkdir(join(root, 'memory-browser-profile'), { recursive: true, mode: 0o700 })
  const app = await createServer({ root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent', cacheDir: join(root, 'memory-vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, fs: { allow: [appRoot] }, proxy: { '/api': { target: server.baseUrl, changeOrigin: true } } } })
  let context
  const logs = []
  let page
  try {
    await app.listen()
    const address = app.httpServer.address()
    assert.ok(address?.port > 0)
    const origin = `http://127.0.0.1:${address.port}`
    context = await chromium.launchPersistentContext(join(root, 'memory-browser-profile'), {
      executablePath: executable, headless: true, viewport: { width: 1280, height: 980 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
      env: { PATH: process.env.PATH, TMPDIR: root }, timeout: 30000,
    })
    const pages = context.pages()
    assert.equal(pages.length, 1)
    page = pages[0]
    assert.equal(page.url(), 'about:blank')
    page.setDefaultTimeout(20000)
    const controller = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
    const reviewRequests = []
    let failCandidatesReadOnce = false
    let failCandidateReadAfterEdit = false
    let expectedRefreshFailures = 0
    let ignoredExpectedFailures = 0
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (![origin, server.baseUrl].includes(url.origin) || url.protocol !== 'http:') {
        logs.push(`blocked external ${url.origin}`); return route.abort('blockedbyclient')
      }
      if ((failCandidatesReadOnce || failCandidateReadAfterEdit) && url.pathname === '/api/v1/candidates' && route.request().method() === 'GET') {
        failCandidatesReadOnce = false
        failCandidateReadAfterEdit = false
        expectedRefreshFailures++
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'fixture_refresh_failed', message: 'Source candidate read intentionally failed' } }) })
      }
      if (url.pathname === `/api/v1/candidates/${encodeURIComponent(candidateId)}` && route.request().method() === 'PATCH') {
        assert.ok(route.request().headers().authorization)
        reviewRequests.push(route.request().postDataJSON())
      }
      await route.continue()
    })
    page.on('pageerror', error => logs.push(error.message))
    page.on('response', response => {
      const url = URL.parse(response.url())
      if (response.status() >= 400 && !(response.status() === 401 && url.pathname === '/api/v1/bootstrap')) {
        if (response.status() === 503 && url.pathname === '/api/v1/candidates' && ignoredExpectedFailures < expectedRefreshFailures) ignoredExpectedFailures++
        else logs.push(`${response.status()}: ${url.pathname}`)
      }
    })
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.locator('.loom-app').waitFor()
    await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
    await page.locator('#client-token').fill(server.clientToken)
    await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
    await page.locator('.main-nav').getByRole('button', { name: '记忆', exact: true }).click()
    const article = page.locator('.candidate-card').filter({ hasText: 'Concise reports with citations' }).first()
    await article.waitFor().catch(async error => {
      const text = await page.locator('body').innerText()
      const safe = text.replaceAll(server.clientToken, '[fixture-token-redacted]')
      console.error(JSON.stringify({ browser_phase: 'candidate_visibility_timeout', body: safe.slice(0, 8000), networked_errors: logs }, null, 2))
      if (!text.includes(server.clientToken)) await page.screenshot({ path: join(root, 'memory-ui-failure.png'), fullPage: true })
      throw error
    })
    assert.equal(await article.count(), 1)
    assert.match(await article.innerText(), /真实 Ticket|来源/)
    const dialog = page.locator('.confirm-modal')
    const rootId = candidateId
    const path = `/api/v1/candidates/${encodeURIComponent(rootId)}`
    const readCandidate = async id => {
      const body = await controller.get('/api/v1/candidates')
      const row = body.candidates.find(candidate => candidate.id === id)
      assert.ok(row, `The actual candidate projection must still exist: ${id}`)
      return row
    }
    const card = text => page.locator('.candidate-card').filter({ hasText: text }).first()
    const rootCard = () => page.locator(`.candidate-card[data-candidate-id="${rootId}"]`)
    async function review(candidateCard, button, confirmation) {
      await candidateCard.getByRole('button', { name: button, exact: true }).click()
      await dialog.waitFor()
      const next = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname.startsWith('/api/v1/candidates/'))
      await dialog.getByRole('button', { name: confirmation, exact: true }).click()
      const response = await next
      assert.ok(response.status() < 300, `Review ${button} failed: ${await response.text()}`)
      await dialog.waitFor({ state: 'hidden' })
      return response.json()
    }
    async function memories() { return (await controller.get('/api/v1/memories')).memories }
    async function memoryAudits(action, memoryId) {
      return (await controller.get('/api/v1/audit')).audit.filter(entry => entry.action === action
        && JSON.parse(entry.evidence).evidence.memory_id === memoryId)
    }
    const originalCandidate = await readCandidate(rootId)
    const originalProposal = JSON.parse(originalCandidate.content)
    const candidateOriginalSourceRefs = typeof originalCandidate.source_refs === 'string' ? JSON.parse(originalCandidate.source_refs) : originalCandidate.source_refs
    const correctedCandidateText = 'Human-reviewed project preference: concise visible evidence'
    await rootCard().getByRole('button', { name: '编辑候选', exact: true }).click()
    const editor = page.getByRole('textbox', { name: '编辑候选内容', exact: true })
    await editor.waitFor()
    assert.equal(await editor.inputValue(), originalProposal.content)
    await editor.fill('An unsaved candidate draft')
    await rootCard().getByRole('button', { name: '取消候选编辑', exact: true }).click()
    assert.equal(reviewRequests.length, 0, 'Cancelling an unconfirmed draft sends no candidate write')
    assert.equal((await readCandidate(rootId)).content, originalCandidate.content)

    await rootCard().getByRole('button', { name: '编辑候选', exact: true }).click()
    await editor.fill(correctedCandidateText)
    const editResponsePromise = page.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === path && response.request().postDataJSON().decision === 'edit')
    failCandidateReadAfterEdit = true
    await rootCard().getByRole('button', { name: '保存候选修改', exact: true }).click()
    const candidateEditResponse = await editResponsePromise
    assert.equal(candidateEditResponse.status(), 200)
    assert.deepEqual(candidateEditResponse.request().postDataJSON(), {
      decision: 'edit', expected_version: originalCandidate.version, content: correctedCandidateText,
    })
    await page.getByRole('alert').filter({ hasText: '服务端已接受这次操作，但最新状态尚未刷新' }).waitFor()
    assert.equal(await editor.inputValue(), correctedCandidateText, 'A failed resource refresh leaves the actual draft visible instead of falsely saving or discarding it')
    assert.equal(failCandidateReadAfterEdit, false, 'The dedicated edit-read failure was really injected')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.loom-app').waitFor()
    await page.locator('.main-nav').getByRole('button', { name: '记忆', exact: true }).click()
    await editor.waitFor({ state: 'hidden' }, { timeout: 5000 }).catch(error => { throw new Error('Editor must close only after genuine memory-page resource refresh', { cause: error }) })
    const editedCandidate = await readCandidate(rootId)
    const editedProposal = JSON.parse(editedCandidate.content)
    assert.equal(editedCandidate.status, 'pending')
    assert.equal(editedCandidate.version, originalCandidate.version + 1)
    assert.equal(editedProposal.content, correctedCandidateText)
    assert.equal(editedProposal.fingerprint, originalProposal.fingerprint)
    assert.deepEqual(JSON.parse(editedCandidate.source_refs), candidateOriginalSourceRefs)
    assert.equal(editedCandidate.scope, originalCandidate.scope)
    assert.deepEqual(await memories(), [], 'A candidate text edit alone is not acceptance')
    assert.equal(await dialog.count(), 0)
    const candidateEditAudits = (await controller.get('/api/v1/audit')).audit.filter(entry => entry.action === 'candidate.memory.edited'
      && JSON.parse(entry.evidence).evidence.candidate_id === rootId)
    assert.equal(candidateEditAudits.length, 1)
    const candidateEditEvidence = JSON.parse(candidateEditAudits[0].evidence).evidence
    assert.equal(candidateEditEvidence.fingerprint, originalProposal.fingerprint)
    assert.equal(candidateEditEvidence.scope, originalCandidate.scope)
    assert.equal(candidateEditEvidence.accepted_memory_created, false)
    assert.equal(candidateEditEvidence.authority_created, false)
    assert.equal(JSON.stringify(candidateEditAudits).includes(correctedCandidateText), false)
    await rootCard().getByText(correctedCandidateText, { exact: true }).waitFor()
    assert.ok(!(await page.locator('body').innerText()).includes(server.clientToken))
    await page.screenshot({ path: join(root, 'memory-candidate-edited.png'), fullPage: true })

    await review(rootCard(), '审阅后保存', '确认保存这条偏好')
    assert.equal((await readCandidate(rootId)).status, 'accepted')
    assert.equal((await memories()).length, 1)
    assert.equal((await memories())[0].content, correctedCandidateText, 'The separate explicit acceptance saves the corrected proposal')
    await dialog.waitFor({ state: 'hidden' })
    // The preference is explicitly edited after candidate acceptance. Its original
    // provenance and exact link are not silently rewritten into a new origin.
    const acceptedProjection = await readCandidate(rootId)
    const firstSourceId = (typeof acceptedProjection.source_refs === 'string' ? JSON.parse(acceptedProjection.source_refs) : acceptedProjection.source_refs)[0]
    const savedBeforeEdit = (await memories())[0]
    assert.equal(savedBeforeEdit.source_ticket_id, firstSourceId)
    await page.locator('.memory-list .memory-item').getByRole('button', { name: '编辑记忆', exact: true }).click()
    const correctedText = 'User corrected preference, preserving the original conservative source'
    await page.locator('#memory-content').fill(correctedText)
    await page.locator('#memory-scope').selectOption('user')
    const savedEdit = page.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/v1/memories/${savedBeforeEdit.id}`)
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    const editResponse = await savedEdit
    assert.equal(editResponse.status(), 200)
    const editBody = editResponse.request().postDataJSON()
    assert.equal(editBody.scope, 'user')
    assert.equal(editBody.project_id, null)
    assert.equal(Object.hasOwn(editBody, 'source_ticket_id'), false, 'Manual edit does not invent a new Ticket origin')
    const editedMemory = (await memories())[0]
    assert.equal(editedMemory.id, savedBeforeEdit.id)
    assert.equal(editedMemory.content, correctedText)
    assert.equal(editedMemory.scope, 'user')
    assert.equal(editedMemory.project_id, null)
    assert.equal(editedMemory.source_ticket_id, firstSourceId)
    const [editAudit, ...duplicateEditAudits] = await memoryAudits('memory.explicit_updated', savedBeforeEdit.id)
    assert.deepEqual(duplicateEditAudits, [], 'The real UI edit writes exactly one ordinary explicit-update audit')
    const editEnvelope = JSON.parse(editAudit.evidence)
    assert.equal(editAudit.actor, 'client')
    assert.equal(editAudit.ticket_id, firstSourceId, 'The event retains the accepted Memory origin, not a body-invented source')
    assert.equal(editEnvelope.event_type, 'memory.explicit_updated')
    assert.deepEqual(editEnvelope.evidence, {
      memory_id: savedBeforeEdit.id, previous_scope: 'project', scope: 'user', previous_version: 1, version: 2,
      content_changed: true, project_changed: true, authority_changed: false, origin_preserved: true,
      client_reason: 'explicit_memory_edit',
    }, 'The actual persisted UI edit is represented by bounded old/new state evidence')
    const preservedCandidate = await readCandidate(rootId)
    assert.equal(preservedCandidate.status, 'accepted')
    assert.equal(preservedCandidate.derived_memory_id, editedMemory.id)
    const originalSourceRefs = typeof acceptedProjection.source_refs === 'string' ? JSON.parse(acceptedProjection.source_refs) : acceptedProjection.source_refs
    assert.deepEqual(typeof preservedCandidate.source_refs === 'string' ? JSON.parse(preservedCandidate.source_refs) : preservedCandidate.source_refs, originalSourceRefs)
    const manualDelete = page.waitForResponse(response => response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === `/api/v1/memories/${savedBeforeEdit.id}`)
    await page.locator('.memory-list .memory-item').getByRole('button', { name: '删除记忆', exact: true }).click()
    await dialog.getByRole('button', { name: '删除这条记忆', exact: true }).click()
    const removal = await manualDelete
    assert.equal(removal.status(), 200)
    assert.equal((await removal.json()).candidate_withdrawal, true)
    assert.deepEqual(await memories(), [])
    assert.equal((await readCandidate(rootId)).status, 'pending')
    const reopened = await review(rootCard(), '审阅后保存', '确认保存这条偏好')
    assert.equal(reopened.status, 'accepted')
    assert.notEqual(reopened.derived_memory_id, savedBeforeEdit.id)
    await page.getByRole('heading', { name: '记住什么？', exact: true }).waitFor()
    assert.equal(await page.locator('#memory-content').inputValue(), '', 'Deleting the currently edited Memory clears its submitted identity instead of retaining stale private text')
    assert.equal(await page.locator('#memory-scope').inputValue(), 'project')
    assert.equal(await page.locator('#memory-project').inputValue(), '')
    assert.equal(await page.getByRole('button', { name: '保存记忆', exact: true }).isDisabled(), true, 'The cleared form cannot accidentally recreate a preference under no selected project')
    assert.deepEqual(await memoryAudits('memory.explicit_deleted', savedBeforeEdit.id), [], 'Linked UI deletion must never write an ordinary deletion audit')
    const linkedDeleteWithdrawals = await memoryAudits('candidate.memory.withdrawn', savedBeforeEdit.id)
    assert.equal(linkedDeleteWithdrawals.length, 1, 'The linked deletion retains exactly its established candidate withdrawal event')
    assert.equal((await memories()).length, 1)
    assert.equal((await memories())[0].source_ticket_id, firstSourceId)
    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('accepted')
    const accepted = rootCard()
    await accepted.getByRole('button', { name: '撤回保存的偏好', exact: true }).waitFor()
    assert.equal(await accepted.getByRole('button', { name: '编辑候选', exact: true }).count(), 0)
    assert.equal(await accepted.getByRole('button', { name: '拒绝来源建议', exact: true }).count(), 0)
    const safeText = await page.locator('body').innerText()
    assert.ok(!safeText.includes(server.clientToken))
    await page.screenshot({ path: join(root, 'memory-accepted-desktop.png'), fullPage: true })
    await review(accepted, '撤回保存的偏好', '确认撤回保存偏好')
    assert.equal((await readCandidate(rootId)).status, 'pending')
    assert.deepEqual(await memories(), [])

    // Use existing actual source references for a separate rejected-history example.
    const candidateData = await readCandidate(rootId)
    const refs = typeof candidateData.source_refs === 'string' ? JSON.parse(candidateData.source_refs) : candidateData.source_refs
    assert.ok(Array.isArray(refs) && refs.length > 0)
    const auxiliaryText = 'Auxiliary preference for rejected history'
    let auxiliaryId
    for (const ref of refs) {
      const result = await controller.post('/api/v1/candidates', { project_id: candidateData.scope, kind: 'memory', value: auxiliaryText, source_refs: [ref] })
      if (result.candidate) auxiliaryId = result.candidate.id
    }
    assert.ok(auxiliaryId, 'Rejected history must have a separate real same-project candidate')
    assert.equal((await readCandidate(auxiliaryId)).status, 'pending')

    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('pending')
    const later = await review(rootCard(), '稍后审阅', '确认稍后审阅')
    assert.equal(later.status, 'later')
    assert.deepEqual(await memories(), [])
    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('later')
    assert.match((await readCandidate(rootId)).status, /later/)
    await review(rootCard(), '不再建议', '确认不再建议')
    assert.equal((await readCandidate(rootId)).status, 'never')
    assert.deepEqual(await memories(), [])
    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('never')
    const neverCard = rootCard()
    await neverCard.getByRole('button', { name: '恢复候选', exact: true }).waitFor()
    assert.equal(await neverCard.getByRole('button', { name: '编辑候选', exact: true }).count(), 0)
    assert.equal(await neverCard.getByRole('button', { name: '拒绝来源建议', exact: true }).count(), 0)
    await neverCard.getByRole('button', { name: '恢复候选', exact: true }).click()
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /允许重新审阅|恢复候选/)
    assert.doesNotMatch(await dialog.innerText(), /撤回保存的偏好/)
    await dialog.getByRole('button', { name: '确认恢复候选', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal((await readCandidate(rootId)).status, 'pending')
    assert.deepEqual(await memories(), [])

    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('pending')
    failCandidatesReadOnce = true
    const nextCard = rootCard()
    await nextCard.getByRole('button', { name: '审阅后保存', exact: true }).click()
    await dialog.waitFor()
      const acceptedResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === path)
    await dialog.getByRole('button', { name: '确认保存这条偏好', exact: true }).click()
    const acceptedResponseValue = await acceptedResponse
    assert.equal(acceptedResponseValue.status(), 200)
    const acceptedBody = await acceptedResponseValue.json()
    assert.equal(acceptedBody.status, 'accepted')
    await dialog.getByRole('alert').filter({ hasText: '服务端已接受这次操作，但最新状态尚未刷新' }).waitFor()
    assert.ok(await dialog.isVisible(), 'Refresh failure must keep the confirmation open for inspection')
    assert.equal((await readCandidate(rootId)).status, 'accepted', 'The real controller write must not be reclassified as a failure')
    const writtenMemories = await memories()
    assert.equal(writtenMemories.length, 1)
    assert.equal(writtenMemories[0].id, acceptedBody.derived_memory_id)
    await dialog.getByRole('button', { name: '返回检查', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.locator('.main-nav').getByRole('button', { name: '记忆', exact: true }).click()
      await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('accepted')
    await review(rootCard(), '撤回保存的偏好', '确认撤回保存偏好')
    assert.equal((await readCandidate(rootId)).status, 'pending')
    assert.deepEqual(await memories(), [])
    assert.equal(expectedRefreshFailures, 2, 'One edit-read and one accept-read failure are both actually exercised')
    assert.equal(ignoredExpectedFailures, expectedRefreshFailures)
    assert.equal(failCandidateReadAfterEdit, false)
    assert.equal(failCandidatesReadOnce, false)

    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('pending')
    await review(card(auxiliaryText), '拒绝来源建议', '确认拒绝建议')
    const rejected = await readCandidate(auxiliaryId)
    assert.equal(rejected.status, 'rejected')
    const repeated = await controller.patch(`/api/v1/candidates/${encodeURIComponent(auxiliaryId)}`, { decision: 'reject' })
    assert.equal(repeated.status, 'rejected')
    assert.equal(repeated.version, rejected.version, 'Repeated rejection remains idempotent, not a status rewrite')
    await assert.rejects(() => controller.patch(`/api/v1/candidates/${encodeURIComponent(auxiliaryId)}`, { decision: 'later' }), /history|rejected/)
    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('rejected')
    const rejectedCard = card(auxiliaryText)
    await rejectedCard.waitFor()
    assert.doesNotMatch(await rejectedCard.innerText(), /撤回保存的偏好|恢复候选/)
    assert.equal(await rejectedCard.getByRole('button', { name: '编辑候选', exact: true }).count(), 0)
    for (const action of ['审阅后保存', '不再建议', '拒绝来源建议', '恢复候选', '撤回保存的偏好']) {
      assert.equal(await rejectedCard.getByRole('button', { name: action, exact: true }).count(), 0)
    }
    await rejectedCard.getByRole('button', { name: '查看最早来源 Ticket', exact: false }).click()
    await page.locator('.ticket-detail').waitFor()
    assert.match(await page.locator('.ticket-detail').innerText(), /Established source observation 1/)
    await page.locator('.main-nav').getByRole('button', { name: '记忆', exact: true }).click()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.loom-app').waitFor()
    const reloaded = rootCard()
    const reloadedCandidateVersion = (await readCandidate(rootId)).version
    await reloaded.waitFor()
    assert.match(await reloaded.innerText(), /pending/)
    await page.setViewportSize({ width: 390, height: 844 })
    await reloaded.getByRole('button', { name: '编辑候选', exact: true }).click()
    const narrowEditor = page.getByRole('textbox', { name: '编辑候选内容', exact: true })
    await narrowEditor.waitFor()
    assert.equal(await narrowEditor.inputValue(), correctedCandidateText)
    const narrowEditorBounds = await narrowEditor.boundingBox()
    assert.ok(narrowEditorBounds && narrowEditorBounds.x >= 0 && narrowEditorBounds.x + narrowEditorBounds.width <= 390, 'The actual draft input must fit the narrow viewport')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'Narrow viewport must remain readable after direct-page reload')
    const body = await page.locator('body').innerText()
    assert.ok(!body.includes(server.clientToken))
    await page.screenshot({ path: join(root, 'memory-pending-narrow.png'), fullPage: true })
    await reloaded.getByRole('button', { name: '取消候选编辑', exact: true }).click()
    assert.equal((await readCandidate(rootId)).version, reloadedCandidateVersion, 'Narrow-preview cancellation must not issue another edit')
    assert.deepEqual(reviewRequests.map(request => request.decision), ['edit', 'accept', 'accept', 'undo', 'later', 'never', 'undo', 'accept', 'undo'])
    assert.deepEqual(logs, [], `Unexpected browser error: ${logs.join('\n')}`)
    assert.equal((await controller.get('/api/v1/grants')).grants.length, 2, 'No review action invents a new Grant')
    assert.deepEqual(await memoryAudits('memory.explicit_deleted', reopened.derived_memory_id), [], 'Repeated re-accept/undo never fabricates ordinary deletion history')
    const undoWithdrawals = await memoryAudits('candidate.memory.withdrawn', reopened.derived_memory_id)
    assert.equal(undoWithdrawals.length, 1, 'The last re-accepted linked Memory has one and only one candidate withdrawal')
    assert.equal((await memoryAudits('memory.explicit_updated', savedBeforeEdit.id)).length, 1, 'No later UI action duplicates the original explicit edit')
    return { actual_ui_candidate_accept: true, actual_ui_withdraw: true,
      actual_ui_candidate_edit_before_accept: true, cancelled_candidate_draft_no_write: true,
      candidate_edit_preserves_fingerprint_and_sources: true, candidate_edit_alone_creates_no_memory: true,
      candidate_edit_refresh_failure_keeps_draft_until_real_reload: true,
      explicit_accept_after_candidate_edit_saves_corrected_text: true,
      explicit_ui_edit_preserves_original_source_link: true,
      deleted_memory_editor_resets_before_next_accept: true,
      ordinary_edit_and_linked_delete_audited_without_duplicate: true,
      explicit_ui_delete_withdraws_only_same_linked_memory: true,
      later_and_never_restore: true, rejected_history_read_only: true,
      refresh_failure_remains_visible_and_recovers: true,
      actual_backend_snapshot_matches_ui: true,
      isolated_edge: true, no_grant_or_ticket_created: true, narrow_no_overflow: true,
      screenshots: ['memory-candidate-edited.png', 'memory-accepted-desktop.png', 'memory-pending-narrow.png'], status_restored_to_pending: true }

  } finally {
    if (page && !page.isClosed()) await page.evaluate(() => localStorage.clear()).catch(() => {})
    if (context) await context.close().catch(() => {})
    await rm(join(root, 'memory-browser-profile'), { recursive: true, force: true })
    await app.close()
  }
}
