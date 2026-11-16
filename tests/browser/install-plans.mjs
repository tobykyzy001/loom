import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url))

/** Browser calls the existing UI, not an installer runner. Callers supply an
 * already running synthetic-inventory Concierge and a test-owned output root.
 */
export async function verifyInstallPlansBrowser({ server, admin, root }) {
  assert.ok(server?.baseUrl?.startsWith('http://127.0.0.1:') && server?.clientToken && admin?.get && admin?.post && typeof root === 'string')
  assert.ok(isAbsolute(root) && resolve(root) !== '/' && resolve(root) !== resolve(process.env.HOME || '__missing_home__'))
  await mkdir(root, { recursive: true, mode: 0o700 })
  assert.ok(isAbsolute(root) && resolve(root) !== '/' && resolve(root) !== process.env.HOME, 'Browser output must be an explicitly owned isolated directory')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const { chromium } = await import('playwright-core')
  const { createServer } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
  const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  assert.equal(existsSync(executable), true, 'NOT RUN: configured local Edge executable must exist')
  const screenshotPaths = { desktop: join(root, 'install-plans-desktop.png'), narrow: join(root, 'install-plans-narrow.png') }
  const evidencePath = join(root, 'install-plans-result.json')
  const debugPath = join(root, 'install-plans-browser-debug.json')
  const origins = new Set([server.baseUrl])
  const errors = []
  const output = { schema: 'loom.install-plan-browser.v1', mode: 'synthetic_inventory_only', host_execution: false }
  let preview, context, page, failure
  const request = (route, payload) => admin.post(route, payload)
  const redact = value => String(value).replaceAll(server.clientToken, '[redacted-fixture-token]').replaceAll(root, '[test-owned-root]').slice(0, 8000)
  const read = path => admin.get(path)

  try {
    const initialPlans = await read('/api/v1/install-plans')
    assert.equal(initialPlans.plans.length, 0, 'This owned test starts with no plans or pre-generated UI data')
    const [beforeTickets, beforeGrants, beforeNodes] = await Promise.all([read('/api/v1/tickets'), read('/api/v1/grants'), read('/api/v1/nodes')])

    preview = await createServer({
      root: appRoot, configFile: join(appRoot, 'vite.config.ts'), logLevel: 'silent',
      cacheDir: join(root, '.install-plans-vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, fs: { allow: [appRoot] }, proxy: { '/api': { target: server.baseUrl, changeOrigin: true } } },
    })
    await preview.listen()
    const address = preview.httpServer.address()
    assert.ok(address?.address === '127.0.0.1' && address?.port)
    const appOrigin = `http://127.0.0.1:${address.port}`
    origins.add(appOrigin)
    context = await chromium.launchPersistentContext(join(root, 'install-plans-browser-profile'), {
      executablePath: executable, headless: true, viewport: { width: 1280, height: 960 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'xdg-config'), TMPDIR: root }, timeout: 30000,
    })
    page = context.pages()[0]
    assert.equal(context.pages().length, 1)
    assert.equal(page.url(), 'about:blank')
    page.setDefaultTimeout(20000)
    page.setDefaultNavigationTimeout(30000)
    let anonymousBootstrap = 0
    let bootstrapConsole401 = 0
    const routes = []
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !origins.has(url.origin)) {
        errors.push(`BLOCKED ${url.protocol}//${url.hostname}:${url.port}`)
        return route.abort('blockedbyclient')
      }
      if (url.pathname.startsWith('/api/v1/install-plans')) routes.push({ path: url.pathname, method: route.request().method() })
      await route.continue()
    })
    page.on('pageerror', error => errors.push(`PAGEERROR ${error.message}`))
    page.on('requestfailed', request => errors.push(`REQUEST_FAILED ${new URL(request.url()).pathname}`))
    page.on('response', response => {
      if (response.status() < 400) return
      const request = response.request()
      if (response.status() === 401 && response.url().endsWith('/api/v1/bootstrap') && !request.headers().authorization && anonymousBootstrap === 0) {
        anonymousBootstrap++
        return
      }
      errors.push(`HTTP_${response.status()} ${new URL(response.url()).pathname}`)
    })
    page.on('console', message => {
      const firstBootstrap = message.type() === 'error' && bootstrapConsole401 === 0 && message.location().url.includes('/api/v1/bootstrap') && message.text().includes('401 (Unauthorized)')
      if (firstBootstrap) { bootstrapConsole401++; return }
      if (['error', 'warning'].includes(message.type())) errors.push(`CONSOLE ${message.type()}: ${message.text().slice(0, 600)}`)
    })
    const responseForPost = path => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST')
    const confirm = async (label, scopeRoot) => {
      await scopeRoot.getByRole('dialog').waitFor()
      assert.equal(await scopeRoot.locator('.confirm-modal').count(), 1)
      await scopeRoot.getByRole('button', { name: label, exact: true }).click()
    }
    const submitWithResponse = async (path, label) => {
      const pending = responseForPost(path)
      await page.getByRole('button', { name: label, exact: true }).click()
      const response = await pending
      assert.ok(response.status() < 300, `${path} failed ${response.status()}`)
      return response.request().postDataJSON()
    }
    const status = async (targetId, expected) => {
      await page.waitForFunction(({ id, expected }) => document.querySelector(`[data-target-id="${id}"]`)?.getAttribute('data-status') === expected, { id: targetId, expected })
    }
    const target = id => page.locator(`[data-target-id="${id}"]`)
    const readTarget = (plan, targetId) => plan.targets.find(row => row.id === targetId)
    const capture = async path => {
      assert.equal(await page.locator('#client-token, .enrollment-code').count(), 0)
      assert.equal((await page.locator('body').innerText()).includes(server.clientToken), false)
      await page.screenshot({ path, fullPage: true })
    }

    await page.goto(appOrigin, { waitUntil: 'domcontentloaded' })
    await page.locator('.loom-app').waitFor()
    await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
    assert.equal(await page.locator('#client-token').getAttribute('type'), 'password')
    await page.locator('#client-token').fill(server.clientToken)
    await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
    await page.locator('.main-nav').getByRole('button', { name: '部署', exact: true }).click()
    await page.locator('.install-plans-view').waitFor()
    assert.equal(routes.filter(row => row.path === '/api/v1/install-plans' && row.method === 'POST').length, 0)
    await page.locator('.fixture-choice').filter({ hasText: 'fixture-linux' }).locator('input[type="checkbox"]').check()
    const createResponse = responseForPost('/api/v1/install-plans')
    await page.getByRole('button', { name: '检查计划创建影响', exact: true }).click()
    await page.getByRole('button', { name: '确认创建审阅计划', exact: true }).click()
    const created = await createResponse
    assert.equal(created.status(), 200)
    const createdBody = created.request().postDataJSON()
    assert.deepEqual(Object.keys(createdBody).sort(), ['component', 'schema', 'source', 'targets'])
    assert.equal(createdBody.source, 'explicit_admin_inventory_manifest')
    assert.deepEqual(createdBody.component, { kind: 'bare_host', version: '0.1.0', sha256: '1c9dc260a2d689602a6e133b9017561d9b69c30136834e08f51aaa05de3542c5', source: 'local_package_candidate' })
    assert.equal(createdBody.targets.filter(host => host.selected).length, 2)
    const emittedPlan = (await created.json()).plan
    const id = emittedPlan.id
    const digest = emittedPlan.plan_digest
    assert.match(id, /^[a-z0-9_-]+$/)
    assert.match(digest, /^[a-f0-9]{64}$/)
    assert.equal(await page.locator(`[data-plan-id="${id}"]`).getAttribute('data-plan-digest'), digest)
    const compatible = emittedPlan.targets.find(host => host.host_key === 'fixture-darwin').id
    const linux = emittedPlan.targets.find(host => host.host_key === 'fixture-linux').id
    const unselected = emittedPlan.targets.find(host => host.host_key === 'fixture-unselected').id
    await target(linux).waitFor()
    assert.equal(await target(linux).getAttribute('data-status'), 'incompatible')
    assert.equal(await target(linux).getByRole('button').count(), 0)
    assert.equal(await target(unselected).getAttribute('data-status'), 'not_selected')
    assert.equal(await target(compatible).getAttribute('data-status'), 'pending_approval')
    await target(compatible).getByRole('button', { name: '审阅此目标的 apply', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    assert.match(await page.locator('.confirm-modal').innerText(), /只为此目标绑定当前计划的快照/)
    const approval = await submitWithResponse(`/api/v1/install-plans/${id}/approve`, '确认审阅此目标')
    assert.deepEqual(approval, { target_id: compatible, reviewed_plan_digest: digest })
    const current = await read(`/api/v1/install-plans/${id}`)
    const approved = readTarget(current.plan, compatible)
    assert.equal(approved.status, 'approved')
    assert.equal(approved.current_version, '0.0.0')
    assert.ok(approved.current_operation_id)
    await status(compatible, 'approved')
    assert.match(await target(compatible).innerText(), /已审阅（仅计划）/)
    assert.doesNotMatch(await target(compatible).innerText(), /已激活|已安装|已注册|已授权/)
    const applyId = approved.current_operation_id

    await target(compatible).locator('select').selectOption('health_failed')
    await target(compatible).getByRole('button', { name: '审阅这份合成报告', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    assert.match(await page.locator('.confirm-modal').innerText(), /不是主机遥测、真实安装结果或独立外部验证/)
    const failureReport = await submitWithResponse(`/api/v1/install-plans/${id}/observe`, '确认记录合成观察')
    assert.deepEqual(failureReport, { target_id: compatible, operation: 'apply', outcome: 'health_failed' })
    const failed = readTarget((await read(`/api/v1/install-plans/${id}`)).plan, compatible)
    assert.equal(failed.status, 'health_failed')
    assert.equal(failed.current_version, '0.0.0')
    assert.deepEqual(failed.observations.at(-1), { operation_id: applyId, operation: 'apply', outcome: 'health_failed', reported_at: failed.observations.at(-1).reported_at, report_kind: 'manual_synthetic_inventory_report', simulated: true })
    await status(compatible, 'health_failed')
    await target(compatible).getByRole('button', { name: '审阅回滚此合成 apply', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    assert.match(await page.locator('.confirm-modal').innerText(), /不会在真实主机上回滚/)
    const rollback = await submitWithResponse(`/api/v1/install-plans/${id}/rollback-approve`, '确认审阅回滚')
    assert.deepEqual(rollback, { target_id: compatible, operation_id: applyId })
    const rollbackApproved = readTarget((await read(`/api/v1/install-plans/${id}`)).plan, compatible)
    assert.equal(rollbackApproved.status, 'rollback_approved')
    assert.ok(rollbackApproved.current_operation_id)
    assert.notEqual(rollbackApproved.current_operation_id, applyId)
    assert.equal(rollbackApproved.rollback_parent_operation_id, applyId)
    const rollbackId = rollbackApproved.current_operation_id
    await status(compatible, 'rollback_approved')
    await target(compatible).locator('select').selectOption('healthy')
    await target(compatible).getByRole('button', { name: '审阅这份合成报告', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    const rollbackObservation = await submitWithResponse(`/api/v1/install-plans/${id}/observe`, '确认记录合成观察')
    assert.deepEqual(rollbackObservation, { target_id: compatible, operation: 'rollback', outcome: 'healthy' })
    const rolledBack = readTarget((await read(`/api/v1/install-plans/${id}`)).plan, compatible)
    assert.equal(rolledBack.status, 'rolled_back_observed')
    assert.equal(rolledBack.current_version, '0.0.0')
    assert.equal(rolledBack.observations.length, 2)
    assert.equal(rolledBack.observations.at(-1).operation_id, rollbackId)
    assert.equal(rolledBack.observations.at(-1).operation, 'rollback')
    assert.equal(rolledBack.rollback_parent_operation_id, applyId)
    await status(compatible, 'rolled_back_observed')
    output.apply = { plan_id: id, previous_operation_id: applyId, rollback_operation_id: rollbackId, previous_version: '0.0.0', current_version: '0.0.0', observations: rolledBack.observations }

    const unknownCreate = await request('/api/v1/install-plans', {
      schema: 'loom.install-plan.v1', source: 'explicit_admin_inventory_manifest',
      component: createdBody.component,
      targets: [{ host_key: 'fixture-unknown', os: 'darwin', arch: 'arm64', baseline_version: '0.0.0', requested_version: '0.1.0', selected: true }],
    })
    const unknownPlanId = unknownCreate.plan.id
    const unknownTargetId = unknownCreate.plan.targets[0].id
    await request(`/api/v1/install-plans/${unknownPlanId}/approve`, { target_id: unknownTargetId, reviewed_plan_digest: unknownCreate.plan.plan_digest })
    await page.locator('.install-plans-view').getByRole('button', { name: '刷新', exact: true }).click()
    const unknownCard = target(unknownTargetId)
    await unknownCard.waitFor()
    await unknownCard.locator('select').selectOption('connection_lost')
    await unknownCard.getByRole('button', { name: '审阅这份合成报告', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    assert.match(await page.locator('.confirm-modal').innerText(), /需具名对账，不能自动再次执行/)
    const unknownRequest = await submitWithResponse(`/api/v1/install-plans/${unknownPlanId}/observe`, '确认记录合成观察')
    assert.deepEqual(unknownRequest, { target_id: unknownTargetId, operation: 'apply', outcome: 'connection_lost' })
    const originalUnknown = await read(`/api/v1/install-plans/${unknownPlanId}`)
    assert.equal(readTarget(originalUnknown.plan, unknownTargetId).status, 'unknown')
    await status(unknownTargetId, 'unknown')
    assert.match(await unknownCard.innerText(), /未知—需具名取证对账/)
    assert.equal(await unknownCard.getByRole('button').count(), 0)
    const duplicate = await request(`/api/v1/install-plans/${unknownPlanId}/observe`, unknownRequest)
    assert.equal(duplicate.duplicate, true)
    assert.deepEqual(duplicate.plan, originalUnknown.plan)
    await assert.rejects(request(`/api/v1/install-plans/${unknownPlanId}/observe`, { ...unknownRequest, outcome: 'healthy' }), /400/)
    assert.deepEqual((await read(`/api/v1/install-plans/${unknownPlanId}`)).plan, originalUnknown.plan)
    const validAudit = (await read('/api/v1/audit/verify')).valid
    assert.equal(validAudit, true)
    output.unknown = { terminal: true, no_retry_controls: true, duplicate_read_only: true, cannot_reclassify_healthy: true }
    await capture(screenshotPaths.desktop)
    const after = await Promise.all([read('/api/v1/tickets'), read('/api/v1/grants'), read('/api/v1/nodes')])
    assert.deepEqual(after, [beforeTickets, beforeGrants, beforeNodes])
    output.no_task_grant_or_node_changes = after.map((rows, index) => ({ ticket_grant_node: ['tickets', 'grants', 'nodes'][index], unchanged: true }))
    await page.reload()
    await page.locator('.connection-banner').waitFor({ state: 'hidden' })
    await page.locator(`[data-plan-id="${id}"]`).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => document.documentElement.scrollWidth <= 390)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true)
    await target(unknownTargetId).scrollIntoViewIfNeeded()
    assert.match(await target(unknownTargetId).innerText(), /未知—需具名取证对账/)
    assert.equal(await unknownCard.getByRole('button').count(), 0)
    await capture(screenshotPaths.narrow)
    await page.locator('.mobile-tabs').waitFor()
    await page.getByRole('navigation', { name: '移动端工作空间' }).getByRole('button', { name: '更多', exact: true }).click()
    assert.equal(await page.getByRole('navigation', { name: '更多工作空间' }).getByRole('button', { name: '部署', exact: true }).count(), 1)
    assert.equal(await page.locator('#client-token').count(), 0)
    output.viewport = { width: 390, no_horizontal_overflow: true, mobile_navigation_accessible: true }
    output.recovery = { same_persisted_plans_after_page_reload: true, previous_rollback_observations_count: 2, unknown_still_no_retry: true, service_restart_proven_separately: 'node tests/install/plan.mjs' }
    assert.deepEqual(errors, [], `Browser errors: ${errors.join(' | ')}`)
    await writeFile(evidencePath, JSON.stringify({ ...output, screenshots: screenshotPaths, result: 'PASS' }, null, 2), { mode: 0o600 })
    console.log(`INSTALL_PLANS_BROWSER_PASS ${evidencePath}`)
    return output
  } catch (error) {
    failure = error
    if (page) {
      const diagnostic = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 5000), page_width: document.documentElement.scrollWidth,
        targets: [...document.querySelectorAll('[data-target-id]')].map(node => ({ id: node.getAttribute('data-target-id'), status: node.getAttribute('data-status'), text: node.textContent.slice(0, 1200) })),
      })).catch(() => null)
      await writeFile(debugPath, JSON.stringify({ error: redact(failure.stack || failure), logs: errors.map(redact), diagnostic }, null, 2), { mode: 0o600 })
      await page.screenshot({ path: join(root, 'install-plans-failure.png'), fullPage: true }).catch(() => {})
    }
  } finally {
    await context?.close().catch(error => { failure ||= error })
    await preview?.close().catch(error => { failure ||= error })
    for (const name of ['install-plans-browser-profile', '.install-plans-vite-cache']) {
      await rm(join(root, name), { recursive: true, force: true }).catch(error => { failure ||= error })
    }
  }
  if (failure) {
    const message = redact(failure.stack || failure)
    await writeFile(evidencePath, JSON.stringify({ result: 'FAIL', error: message, screenshots: screenshotPaths }, null, 2), { mode: 0o600 })
    throw new Error(`INSTALL_PLANS_BROWSER_FAIL ${message}`, { cause: failure })
  }
}
