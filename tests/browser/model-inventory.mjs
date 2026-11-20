import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** Real model inventory projection browser review.
 * `observer` posts a bounded explicit source heartbeat fixture to the running
 * isolated controller. It never launches an SDK call or worker execution.
 */
export async function verifyModelInventoryBrowser({ server, observer = {}, root }) {
  assert.ok(server?.baseUrl?.startsWith('http://127.0.0.1:') && server?.clientToken && root && typeof observer.heartbeat === 'function', 'A running local synthetic controller, token and bounded heartbeat producer are required')
  assert.ok(isAbsolute(root) && resolve(root) !== '/' && resolve(root) !== process.env.HOME, 'root must be a test-owned output directory')
  if (observer.offline_worker) assert.equal(typeof observer.offline_worker, 'function')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const { chromium } = await import('playwright-core')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const { createServer } = await import(pathToFileURL(join(fileURLToPath(new URL('../../apps/web/node_modules/vite/dist/node/index.js', import.meta.url))), 'index.js').href)
  const appRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url))
  const { createServer: reservePort } = await import('node:net')
  const bay = reservePort()
  await new Promise(resolve => bay.listen(0, '127.0.0.1', resolve))
  const port = bay.address().port
  await new Promise(resolve => bay.close(resolve))
  const source = await observer.heartbeat()
  assert.ok(source?.catalog?.models?.length === 1 && source.observation?.findings?.length > 0)
  const expected = await observer.refresh()
  const model = expected.models[0]
  assert.equal(model.provider, 'loom-stub')
  assert.equal(model.model, 'loom-stub-v1')
  assert.equal(model.generation_observed, false)
  assert.equal(model.prepared_call_observed, true)
  assert.equal(model.catalogued, true)
  assert.equal(model.resource_state, 'adapter_observed')
  for (const key of ['allowed', 'executable', 'activated']) assert.equal(model[key], false)
  assert.equal(model.input_modalities.length, 1)
  assert.equal(model.input_modalities[0], 'text')
  assert.equal(model.context_window, 131072)
  assert.equal(model.read_source, 'authenticated_node_heartbeat')
  assert.equal(model.source, 'host_reported')
  assert.equal(expected.policy.install, false)
  assert.equal(expected.policy.download, false)
  assert.equal(expected.policy.activation, false)
  assert.equal(expected.policy.generation, false)
  const report = {
    result: 'NOT RUN', schema: 'loom.model-inventory-browser.v1',
    node_id: model.node_id, worker_id: model.worker_id,
    source: source.observation, controller_model: model, screenshot_paths: {},
  }

  const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  const logs = []
  let preview, context, failure
  try {
    preview = await createServer({
      root: appRoot, configFile: pathToFileURL(join(appRoot, 'vite.config.ts')).pathname,
      cacheDir: join(root, '.inventory-browser-vite-cache'), logLevel: 'silent',
      server: {
        host: '127.0.0.1', port, strictPort: true, hmr: false, fs: { allow: [appRoot] },
        proxy: { '/api': { target: server.baseUrl, changeOrigin: true } },
      },
    })
    await preview.listen()
    const address = preview.httpServer.address()
    assert.ok(address?.address === '127.0.0.1' && address.port)
    const appOrigin = `http://127.0.0.1:${address.port}`
    context = await chromium.launchPersistentContext(join(root, 'inventory-browser-profile'), {
      executablePath: executable, headless: true, viewport: { width: 1280, height: 960 },
      args: ['--no-first-run', '--no-default-browser-check', '--no-default-search', '--disable-sync', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server', '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'xdg'), TMPDIR: root }, timeout: 30000,
    })
    const page = context.pages()[0]
    assert.equal(context.pages().length, 1)
    assert.equal(page.url(), 'about:blank')
    page.setDefaultNavigationTimeout(30000)
    page.setDefaultTimeout(20000)
    const urls = [appOrigin, server.baseUrl]
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !urls.includes(url.origin)) {
        logs.push(`BLOCKED ${url.protocol}//${url.hostname}:${url.port}`)
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    page.on('pageerror', error => logs.push(`PAGE ${error.message}`))
    page.on('requestfailed', request => logs.push(`FAILED ${request.url()}`))
    let initial401 = 0, console401 = 0
    page.on('response', response => {
      if (response.status() < 400) return
      const path = new URL(response.url()).pathname
      if (response.status() === 401 && path === '/api/v1/bootstrap' && !response.request().headers().authorization && initial401 === 0) {
        initial401++
        return
      }
      logs.push(`HTTP_${response.status()} ${path}`)
    })
    page.on('console', message => {
      if (message.type() === 'error' && message.location().url.includes('/api/v1/bootstrap') && message.text().includes('401') && console401 === 0) { console401++; return }
      if (['error', 'warning'].includes(message.type())) logs.push(`CONSOLE_${message.type()} ${message.text().slice(0, 1200)}`)
    })
    const authorizedCollections = []
    page.on('request', request => {
      if (new URL(request.url()).pathname.includes('/model-inventory')) authorizedCollections.push({ method: request.method(), url: new URL(request.url()).pathname, auth: !!request.headers().authorization })
    })
    await page.goto(appOrigin, { waitUntil: 'domcontentloaded' })
    await page.locator('.loom-app').waitFor()
    await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
    await page.locator('#client-token').fill(server.clientToken)
    await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
    await page.locator('.main-nav').getByRole('button', { name: '设备', exact: true }).click()
    await page.locator('.model-inventory-section').waitFor()
    await page.locator(`[data-model-id="${model.id}"]`).waitFor()
    const modelRow = page.locator(`[data-model-id="${model.id}"]`)
    assert.equal(await modelRow.getAttribute('data-node-id'), model.node_id)
    assert.equal(await modelRow.getAttribute('data-worker-id'), model.worker_id)
    const text = await modelRow.innerText()
    assert.match(text, /loom-stub \/ loom-stub-v1/)
    assert.ok(text.includes(model.node_id) && text.includes(model.worker_id))
    assert.match(text, /主机上报 · 已认证心跳/)
    assert.match(text, /131,072 tokens 的声明窗口/)
    assert.match(text, /已观察文本适配器（未激活）/)
    assert.doesNotMatch(text, /模型已激活|已经激活|已安装模型|已授权运行|下载模型|运行模型/)
    const observation = page.locator(`[data-workspace-node-id="${model.node_id}"]`)
    const observationText = await observation.innerText()
    assert.ok(observationText.includes('permission_granted: false'))
    assert.ok(observationText.includes(source.observation.findings[0].observed_at) || observationText.length > 100)
    assert.ok(authorizedCollections.some(row => row.method === 'GET' && row.url === '/api/v1/model-inventory' && row.auth))
    assert.equal(authorizedCollections.filter(row => row.method === 'GET').length, 1, 'Do not silently prepare or fetch models on load or unrelated visits')
    assert.equal(authorizedCollections.some(row => row.method !== 'GET'), false)
    const manual = page.getByRole('button', { name: '刷新资源观察', exact: true })
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/v1/model-inventory') && response.request().method() === 'GET'), manual.click()])
    assert.equal(authorizedCollections.filter(row => row.method === 'GET').length, 2)
    assert.equal(authorizedCollections.filter(row => row.method !== 'GET').length, 0)
    const sourceText = await page.locator('.model-inventory-section').innerText()
    assert.match(sourceText, /模型目录观察不等于执行 Grant。不提供下载或激活。/)
    assert.match(sourceText, /不提供下载或激活/)
    report.screenshot_paths.desktop = join(root, 'model-inventory-desktop.png')
    await page.screenshot({ path: report.screenshot_paths.desktop, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await modelRow.scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.documentElement.scrollWidth <= 390, undefined, { timeout: 800 })
    report.narrow_overflow = await page.evaluate(modelId => ({
      width: innerWidth,
      document_width: document.documentElement.scrollWidth,
      model_visible: !!document.querySelector(`[data-model-id="${modelId}"]`)?.getBoundingClientRect().width,
      has_worker: document.body.innerText.includes('default'),
    }), model.id)
    assert.equal(report.narrow_overflow.width, 390)
    assert.ok(report.narrow_overflow.document_width <= 390)
    assert.equal(report.narrow_overflow.model_visible, true)
    assert.equal(report.narrow_overflow.has_worker, true)
    report.screenshot_paths.narrow = join(root, 'model-inventory-narrow.png')
    await page.screenshot({ path: report.screenshot_paths.narrow, fullPage: true })
    assert.equal(await page.locator('#client-token, .enrollment-code').count(), 0)
    assert.equal((await page.locator('body').innerText()).includes(server.clientToken), false)
    assert.equal(await page.locator('.model-inventory-section').getByRole('button').count(), 1, 'Only the explicit resource-read refresh belongs to model inventory')
    assert.equal(await modelRow.getByRole('button').count(), 0)
    if (observer.offline_worker) {
      const offline = await observer.offline_worker()
      assert.equal(offline.confidence, 'worker_offline')
      assert.equal(offline.models[0].resource_state, 'unavailable')
      assert.equal(offline.models[0].freshness, 'stale')
      assert.equal(offline.models[0].observed_at, model.observed_at, 'Do not invent a fresh catalog lookup merely to establish Worker offline')
      assert.ok(offline.findings.some(finding => finding.state === 'worker_offline'))
      const before = authorizedCollections.length
      const reading = page.waitForResponse(response => response.url().endsWith('/api/v1/model-inventory') && response.request().method() === 'GET' && response.status() === 200)
      await manual.click()
      await reading
      assert.ok(authorizedCollections.length > before, 'An ordinary resource refresh must re-read the current Worker fact')
      const offlineSection = await page.locator('.model-inventory-section').innerText()
      assert.match(offlineSection, /Worker 离线 · 保留历史记录/)
      assert.match(offlineSection, /此 Worker 已离线 · 仅存历史观察/)
      assert.doesNotMatch(offlineSection, /目录状态不明确/)
      const offlineRow = await modelRow.innerText()
      assert.match(offlineRow, /仅历史观察 · 当前不可用/)
      assert.match(offlineRow, /不可用（保留历史证据）/)
      assert.match(offlineRow, /上次已知（陈旧）/)
      for (const control of ['激活模型', '下载模型', '运行模型', '已授权运行']) assert.equal(offlineRow.includes(control), false)
      assert.equal(await modelRow.getByRole('button').count(), 0, 'An offline Worker may not acquire an invocation control')
      assert.equal(await page.locator('.model-inventory-section').getByRole('button').count(), 1, 'The only remaining action is an explicit read')
      report.worker_offline_history = true
      report.screenshot_paths.worker_offline_desktop = join(root, 'model-inventory-worker-offline-desktop.png')
      await page.screenshot({ path: report.screenshot_paths.worker_offline_desktop, fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      await modelRow.scrollIntoViewIfNeeded()
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, undefined, { timeout: 800 })
      report.screenshot_paths.worker_offline_narrow = join(root, 'model-inventory-worker-offline-narrow.png')
      await page.screenshot({ path: report.screenshot_paths.worker_offline_narrow, fullPage: true })
    }
    report.read_only_controller_and_ui = authorizedCollections.every(row => row.method === 'GET' && row.auth)
    report.browser_errors = logs
    assert.deepEqual(logs, [], `Unexpected browser requests/errors: ${logs.join(' | ')}`)
    report.result = 'PASS'
    await writeFile(join(root, 'model-inventory-result.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(`MODEL_INVENTORY_BROWSER_PASS result=${join(root, 'model-inventory-result.json')} desktop=${report.screenshot_paths.desktop} narrow=${report.screenshot_paths.narrow}`)
    return report
  } catch (error) {
    failure = error
    const diagnostic = context ? await context.pages()[0].evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 5000), viewport: innerWidth, document_width: document.documentElement.scrollWidth, has_model: !!document.querySelector('.catalog-row'),
      overflow: [...document.querySelectorAll('*')].map(element => ({ tag: element.tagName, class: element.className || element.getAttribute('class'), text: element.textContent?.slice(0, 160), width: element.getBoundingClientRect().width, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, scroll: element.scrollWidth, client: element.clientWidth })).filter(item => item.right > innerWidth + 1 || item.scroll > item.client + 1).slice(0, 36),
    })).catch(() => null) : null
    await writeFile(join(root, 'model-inventory-browser-debug.json'), JSON.stringify({ error: String(error.stack || error).replaceAll(server.clientToken, '[redacted]'), logs, diagnostic }, null, 2), { mode: 0o600 })
  } finally {
    await context?.close().catch(() => {})
    await preview?.close().catch(() => {})
    await Promise.all([
      rm(join(root, 'inventory-browser-profile'), { recursive: true, force: true }),
      rm(join(root, '.inventory-browser-vite-cache'), { recursive: true, force: true }),
    ]).catch(() => {})
  }
  if (failure) throw new Error(`MODEL_INVENTORY_BROWSER_FAIL ${String(failure.stack || failure).replaceAll(server.clientToken, '[redacted]')}`, { cause: failure })
}
