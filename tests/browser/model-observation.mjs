import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const OBJECTIVE = 'Use one bounded text operation for a synthetic flow.'
const appRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url))

/** Read-only verification of a *running* real model_fixture controller.
 * This helper never creates/reports a model task and never stops the caller's host.
 * The Task must already contain an actual completed DSH Stub stream; invoke_text has
 * already been revoked. `root` is the parent test's owned temporary directory.
 */
export async function verifyModelObservationBrowser({ server, taskId, root }) {
  assert.ok(server?.baseUrl && server.clientToken && taskId && root, 'An actual completed controller, Task ID, token and temporary fixture root are required')
  assert.ok(isAbsolute(root) && resolve(root) !== '/' && resolve(root) !== process.env.HOME, 'root must be an explicit owned temporary directory')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const base = new URL(server.baseUrl)
  assert.equal(base.protocol, 'http:')
  assert.equal(base.hostname, '127.0.0.1')
  assert.ok(base.port && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash)
  const executable = process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(executable)), true, `NOT RUN: no installed browser at ${executable}`)
  assert.ok(!(await import('node:fs/promises').then(({ stat }) => stat(executable))).isDirectory())
  const desktop = join(root, 'model-observation-desktop.png')
  const narrow = join(root, 'model-observation-narrow.png')
  const output = join(root, 'model-observation-ui.json')
  const redact = (value) => String(value)
    .replaceAll(server.clientToken, '[fixture-token-redacted]')
    .replaceAll(root, '<fixture-root>').slice(0, 5000)
  const logs = []
  let preview, context, page, failure
  try {
    let client
    const get = server.admin?.get
      ? (route) => server.admin.get(route)
      : async (route) => {
        client ||= new (await import('../../packages/node-client/src/http.js')).LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 15000 })
        return client.get(route)
      }
    const task = await get(`/api/v1/tickets/${encodeURIComponent(taskId)}`)
    const observation = task.model_observation
    assert.equal(task.id, taskId)
    assert.equal(task.objective, OBJECTIVE)
    assert.equal(task.status, 'succeeded')
    assert.equal(observation?.schema, 'loom.model-observation.v1')
    assert.equal(observation.ticket_id, taskId)
    assert.equal(observation.provider, 'loom-stub')
    assert.equal(observation.model, 'loom-stub-v1')
    assert.equal(observation.source, 'host_reported')
    assert.equal(observation.grant_current, false, 'invoke_text must already be revoked: not current callable permission')
    assert.equal(observation.not_live_llm, true)
    assert.equal(observation.execution_observed, true)
    assert.equal(observation.output_observed, true)
    assert.equal(observation.operation, 'invoke_text')
    assert.ok(observation.session_id)
    assert.equal(observation.grant_id?.length > 0, true)
    assert.deepEqual(observation.input_modalities, ['text'])
    assert.equal(observation.artifact_sha256?.length, 64)
    assert.ok(observation.artifact_id)
    const related = task.artifacts?.find((artifact) => {
      const id = artifact.artifact_id ?? artifact.id
      if (artifact.artifact_id && artifact.id && artifact.id !== artifact.artifact_id) return false
      return id === observation.artifact_id
    })
    assert.ok(related, 'The immutable database id/artifact_id projection must identify exactly the observed Artifact')
    assert.equal(related.ticket_id, taskId)
    assert.equal(related.sha256, observation.artifact_sha256)
    const downloaded = await get(`/api/v1/tickets/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(observation.artifact_id)}`)
    assert.equal(downloaded.artifact?.id, observation.artifact_id)
    assert.equal(downloaded.artifact?.ticket_id, taskId)
    const expected = JSON.parse(downloaded.content)
    assert.equal(expected.schema, 'loom.model-text-result.v1')
    assert.equal(expected.source, 'dsh_llm_stream')
    assert.ok(expected.text?.trim(), 'The actual DSH stream must have non-empty text')
    assert.equal(createHash('sha256').update(downloaded.content).digest('hex'), downloaded.artifact.sha256)
    assert.equal(downloaded.artifact.sha256, observation.artifact_sha256)
    assert.equal(related.sha256, downloaded.artifact.sha256)

    const { createServer } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
    // Vite config already registers @vitejs/plugin-vue. Re-registering its
    // compiler transforms the same .vue into JS and then tries an empty SFC.
    const { chromium } = await import('playwright-core')
    preview = await createServer({
      root: appRoot,
      configFile: join(appRoot, 'vite.config.ts'),
      logLevel: 'silent',
      cacheDir: join(root, '.model-browser-vite-cache'),
      server: {
        host: '127.0.0.1', port: 0, strictPort: true,
        hmr: false,        // Do not open the existing application or DSH GUI: only this loopback proxy.
        https: false,
        proxy: { '/api': { target: server.baseUrl, changeOrigin: true } },
        fs: { allow: [appRoot] },
      },
    })
    await preview.listen()
    const selectedAddress = preview.httpServer.address()
    assert.ok(selectedAddress && selectedAddress.address === '127.0.0.1' && selectedAddress.port > 0)
    const appOrigin = `http://127.0.0.1:${selectedAddress.port}`
    context = await chromium.launchPersistentContext(join(root, 'model-observation-browser-profile'), {
      executablePath: executable,
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--disable-default-apps', '--disable-background-networking', '--disable-component-update',
        '--metrics-recording-only', '--no-service-autorun', '--no-proxy-server',
        '--disable-features=msImplicitSignin,msEdgeSignin,msHubApps'],
      env: { PATH: process.env.PATH, TMPDIR: root },
      timeout: 30000,
    })
    assert.equal(context.pages().length, 1)
    page = context.pages()[0]
    assert.equal(page.url(), 'about:blank', 'A completely new browser session is required')
    page.setDefaultTimeout(20000)
    page.setDefaultNavigationTimeout(30000)
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.protocol !== 'http:' || ![appOrigin, server.baseUrl].includes(url.origin)) {
        logs.push(`BLOCKED_EXTERNAL_REQUEST ${url.protocol}//${url.hostname}:${url.port}${url.pathname}`)
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    page.on('pageerror', (error) => logs.push(`PAGE_ERROR ${error.message}`))
    // The first load intentionally has no token and yields one bootstrap 401.
    // Never ignore a later 401 or one actually carrying the fixture credential.
    let bootstrapUnauthorized = 0
    page.on('response', (response) => {
      if (response.status() >= 400) {
        const url = URL.parse(response.url())
        const authorized = Object.hasOwn(response.request().headers(), 'authorization')
        if (response.status() === 401 && url?.pathname === '/api/v1/bootstrap' && !authorized && !bootstrapUnauthorized) {
          bootstrapUnauthorized += 1
          return
        }
        logs.push(`HTTP_RESPONSE ${response.status()} ${url?.pathname ?? response.url()}`)
      }
    })
    page.on('requestfailed', (request) => {
      logs.push(`REQUEST_FAILED ${request.url().slice(0, 500)} ${request.failure()?.errorText ?? ''}`)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') logs.push(`CONSOLE_ERROR ${message.text().slice(0, 2000)}`)
    })
    await page.goto(appOrigin, { waitUntil: 'domcontentloaded' })
    await page.locator('.loom-app').waitFor()
    await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
    assert.equal(await page.locator('#client-token').getAttribute('type'), 'password')
    await page.locator('#client-token').fill(server.clientToken)
    await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
    const row = page.locator('.ticket-item').filter({ hasText: OBJECTIVE })
    // Bootstrap may already have selected the most recent real Ticket, which
    // intentionally hides the list in favor of its Detail, just as a user would.
    await page.waitForFunction(({ id, objective }) => document.querySelector('.ticket-id')?.textContent === `Ticket / ${id}`
      || [...document.querySelectorAll('.ticket-item')].some((entry) => entry.textContent.includes(objective)), { id: taskId, objective: OBJECTIVE })
    const alreadySelected = await page.locator('.ticket-id').textContent().catch(() => '')
    if (alreadySelected !== `Ticket / ${taskId}`) {
      assert.equal(await row.count(), 1, 'Only the actual SDK-created Ticket may be opened')
      await row.click()
    }
    await page.waitForFunction((id) => document.querySelector('.ticket-id')?.textContent === `Ticket / ${id}`, taskId)
    const section = page.locator('section[aria-labelledby="model-observation-heading"]')
    await section.waitFor()
    const text = await section.innerText()
    assert.match(text, /loom-stub \/ loom-stub-v1/)
    assert.match(text, /宿主报告/)
    assert.match(text, /已关联模型调用报告；已关联文本输出/)
    assert.match(text, /零网络确定性 Stub；不是实际 LLM，无 Live LLM 调用。/)
    assert.match(text, /关联 Grant 已撤销，不能用于新调用。/)
    assert.match(text, /invoke_text/)
    assert.ok(text.includes(observation.grant_id))
    assert.ok(text.includes(observation.session_id))
    assert.ok(text.includes(observation.artifact_id))
    assert.ok(text.includes(observation.artifact_sha256))
    assert.ok(text.includes(`关联 Ticket ${taskId}`))
    assert.doesNotMatch(text, /关联 Grant 记录当前未撤销/)
    assert.equal(await section.getByRole('button', { name: '查看关联产物', exact: true }).count(), 1)
    await assertCredentialsAbsent(page, server.clientToken)
    await section.scrollIntoViewIfNeeded()
    await page.screenshot({ path: desktop, fullPage: true })

    const fetched = page.waitForResponse((response) => response.url().includes(encodeURIComponent(observation.artifact_id)))
    await section.getByRole('button', { name: '查看关联产物', exact: true }).click()
    assert.equal((await fetched).status(), 200, 'Real local Artifact must be fetched, not inferred from labels')
    const contentText = await page.locator('.artifact-content').innerText()
    assert.ok(contentText.trim())
    const rendered = JSON.parse(contentText)
    assert.deepEqual(rendered, expected)
    assert.equal(rendered.source, 'dsh_llm_stream')
    assert.deepEqual(rendered.text, expected.text)

    await section.scrollIntoViewIfNeeded()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(() => document.documentElement.scrollWidth <= 390)
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      page_width: document.documentElement.scrollWidth,
      observation_visible: !!document.querySelector('section[aria-labelledby="model-observation-heading"]')?.getBoundingClientRect().width,
      source_visible: document.body.innerText.includes('宿主报告'),
      artifact_visible: !!document.querySelector('.artifact-content')?.getBoundingClientRect().height,
    }))
    assert.deepEqual(viewport, { width: 390, page_width: 390, observation_visible: true, source_visible: true, artifact_visible: true })
    assert.ok((await section.innerText()).includes(observation.artifact_sha256), 'SHA must wrap at narrow viewport without being dropped')
    await assertCredentialsAbsent(page, server.clientToken)
    await page.screenshot({ path: narrow, fullPage: true })
    const unexpected = logs.filter((message) => !/401 \(Unauthorized\)/.test(message))
    assert.deepEqual(unexpected, [], `Browser runtime or ModelObservation binding error: ${unexpected.join(' | ')}`)
    assert.ok(!logs.some((message) => message.includes(server.clientToken)))
  } catch (error) {
    failure = error
    if (page) {
      await page.screenshot({ path: join(root, 'model-observation-failure.png'), fullPage: true }).catch(() => {})
      try {
        const diagnostics = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 5000),
          app: !!document.querySelector('.loom-app'), loading: !!document.querySelector('.workspace-loading'),
          error: document.querySelector('.connection-banner')?.textContent || null,
          storage: Object.keys(localStorage).filter((key) => !key.toLowerCase().includes('token')),
          viewport: innerWidth,
          page_width: document.documentElement.scrollWidth,
          overflowing: [...document.querySelectorAll('*')].map((element) => ({ tag: element.tagName, klass: typeof element.className === 'string' ? element.className : '', width: element.getBoundingClientRect().width, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, client: element.clientWidth, scroll: element.scrollWidth }))
            .filter((entry) => entry.right > innerWidth + 1 || entry.scroll > entry.client + 1).slice(0, 30) }))
        await writeFile(join(root, 'model-observation-diagnostic.json'), redact(JSON.stringify(diagnostics, null, 2)), { mode: 0o600 })
      } catch { /* do not replace the real original failure */ }
    }
  } finally {
    await context?.close().catch((error) => { failure ||= error })
    if (context) await rm(join(root, 'model-observation-browser-profile'), { recursive: true, force: true })
    await preview?.close().catch((error) => { failure ||= error })
    await rm(join(root, '.model-browser-vite-cache'), { recursive: true, force: true }).catch(() => {})
    const screenshot_paths = { desktop, narrow }
    if (failure) {
      await writeFile(output, JSON.stringify({ actual_dsh_model_observation: false, error: redact(failure.stack || failure), logs: logs.map(redact) }, null, 2), { mode: 0o600 })
      const message = redact(failure.stack || failure.message || failure)
      console.error(`BROWSER_MODEL_OBSERVATION_FAIL ${message}`)
      throw new Error(message, { cause: failure })
    }
    const summary = {
      actual_dsh_model_observation: true,
      grant_revoked_history_visible: true,
      related_artifact_verified: true,
      no_live_llm: true,
      narrow_viewport_no_overflow: true,
      screenshot_paths,
    }
    await writeFile(output, JSON.stringify(summary, null, 2), { mode: 0o600 })
    console.log(`BROWSER_MODEL_OBSERVATION_PASS screenshots=${desktop},${narrow}`)
    return summary
  }
}
async function assertCredentialsAbsent(page, token) {
  const body = await page.locator('body').innerText()
  assert.equal(await page.locator('#client-token, .enrollment-code').count(), 0, 'Do not save credential or enrollment fields')
  assert.ok(!body.includes(token), 'Token appeared in screenshot DOM; refusing capture')
}

// No model process is launched by this optional direct invocation. The parent
// fixture must supply an already-run real controller and Task ID to this test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = process.env.LOOM_MODEL_OBSERVATION_SERVER ? JSON.parse(process.env.LOOM_MODEL_OBSERVATION_SERVER) : null
  const taskId = process.env.LOOM_MODEL_OBSERVATION_TASK_ID
  const root = process.env.LOOM_MODEL_OBSERVATION_TEMP_ROOT
  if (!server || !taskId || !root) {
    console.error('BROWSER_MODEL_OBSERVATION_NOT_RUN: pass a real already-completed, revoked controller using verifyModelObservationBrowser({server, taskId, root}). No model or Task was fabricated.')
    process.exitCode = 1
  } else {
    await verifyModelObservationBrowser({ root, taskId, server })
  }
}
