import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
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
    const reviewRequests = []
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (![origin, server.baseUrl].includes(url.origin) || url.protocol !== 'http:') {
        logs.push(`blocked external ${url.origin}`); return route.abort('blockedbyclient')
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
      if (response.status() >= 400 && !(response.status() === 401 && url.pathname === '/api/v1/bootstrap')) logs.push(`${response.status()}: ${url.pathname}`)
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
    const save = article.getByRole('button', { name: '审阅后保存', exact: true })
    assert.equal(await save.isDisabled(), false)
    await save.click()
    const dialog = page.locator('.confirm-modal')
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /不生成 Skill，不创建 Grant|不会自动执行/)
    await dialog.getByRole('button', { name: '确认保存这条偏好', exact: true }).click()
    await page.locator('.memory-item').filter({ hasText: 'Concise reports with citations' }).last().waitFor()
    assert.deepEqual(reviewRequests[0], { decision: 'accept' }, 'No custom Skill code or authority may be added by the browser')
    await page.waitForTimeout(250)
    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('accepted')
    const accepted = page.locator('.candidate-card').filter({ hasText: 'Concise reports with citations' }).first()
    await accepted.waitFor()
    const withdraw = accepted.getByRole('button', { name: '撤回保存的偏好', exact: true })
    assert.equal(await withdraw.isDisabled(), false, 'The actual joined derived memory id must make withdrawal available')
    const beforeScreenshots = await page.locator('body').innerText()
    assert.ok(!beforeScreenshots.includes(server.clientToken))
    await page.screenshot({ path: join(root, 'memory-accepted-desktop.png'), fullPage: true })
    await withdraw.click()
    await dialog.getByRole('button', { name: '确认撤回保存偏好', exact: true }).click()
    await page.waitForTimeout(350)
    assert.deepEqual(reviewRequests[1], { decision: 'undo' })
    await page.getByRole('combobox', { name: '审核候选项过滤', exact: true }).selectOption('pending')
    await page.locator('.candidate-card').filter({ hasText: 'Concise reports with citations' }).waitFor()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.loom-app').waitFor()
    const reloaded = page.locator('.candidate-card').filter({ hasText: 'Concise reports with citations' }).first()
    await reloaded.waitFor()
    assert.match(await reloaded.innerText(), /pending/)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'Narrow viewport must remain readable after direct-page reload')
    const body = await page.locator('body').innerText()
    assert.ok(!body.includes(server.clientToken))
    await page.screenshot({ path: join(root, 'memory-pending-narrow.png'), fullPage: true })
    assert.deepEqual(logs, [], `Unexpected browser error: ${logs.join('\n')}`)
    return { actual_ui_candidate_accept: true, actual_ui_withdraw: true, isolated_edge: true, no_grant_or_ticket_created: true, narrow_no_overflow: true,
      screenshots: ['memory-accepted-desktop.png', 'memory-pending-narrow.png'], status_restored_to_pending: true }
  } finally {
    if (page && !page.isClosed()) await page.evaluate(() => localStorage.clear()).catch(() => {})
    if (context) await context.close().catch(() => {})
    await rm(join(root, 'memory-browser-profile'), { recursive: true, force: true })
    await app.close()
  }
}
