/** Real parent/child DSH source-integrity and production browser checks. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { redact } from './environment.mjs'
import { chromium } from '../browser/node_modules/playwright-core/index.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Takes a still-live ownerFixture and borrowed real server, returning its
 * owned new center/client. This is not universal multi-host orchestration. */
export async function validateDelegationProduction({ root, server, admin, host, initialClientToken, parent, child, parentSessionId, childSessionId, node, secrets = [] }) {
  const checks = [], browser = []
  let context, preview
  const childTicketUrl = `/api/v1/tickets/${child.id}`
  const parentTicketUrl = `/api/v1/tickets/${parent.id}`
  const original = await admin.get(childTicketUrl)
  const beforeRoot = await admin.get('/api/v1/projects')
  const origin = server.baseUrl
  const clientToken = initialClientToken || server.clientToken
  const identity = JSON.parse(await readFile(join(root, 'node-state', 'identity.json'), 'utf8'))
  const childId = child.assignments[0].id
  const parentArtifact = await admin.get(`${parentTicketUrl}/artifacts/${parent.artifacts[0].id}`)
  const parentArtifactId = parentArtifact.artifact.id
  const sourceRef = { type: 'artifact_ref', artifact_id: parentArtifactId, ticket_id: parent.id,
    origin_node_id: node.id, sha256: parentArtifact.artifact.sha256, location: `loom://artifact/${parentArtifactId}`, parents: [] }
  const transport = new LoomHttpClient({ baseUrl: origin })
  const nodeBody = goal => ({
    protocol: 'loom.node.v1', node_id: identity.node_id, installation_id: identity.installation_id,
    request_id: randomUUID(), ticket_id: child.id, assignment_id: childId, lease_epoch: child.assignments[0].lease_epoch,
    source_ref: { ...sourceRef, ...goal }
  })
  const nodePost = body => transport.post('/api/v1/nodes/assignments/source', body, { token: identity.token })
  const deny = async (body, label) => {
    let error
    try { await nodePost(body) } catch (cause) { error = cause }
    assert.ok(error, `Expected ${label} to be rejected by the real controller`)
    assert.ok(error.status >= 400 && error.status < 500, `${label} must deny before child SDK reading: ${error.status}`)
    assert.equal(typeof error.code, 'string')
    assert.ok(error.message.includes('parent_session_ref') || error.message.includes('immutable size/digest') || /No such file|not found/i.test(error.message), `${label} must fail at actual source bytes and Session proof, not a weak caller-shape check: ${error.message}`)
    assert.deepEqual((await admin.get(childTicketUrl)).messages.length, original.messages.length,
      `${label} must not create a visible correlated message`)
    checks.push({ name: label, status: 'PASS', status_code: error.status })
  }
  try {
    await assert.doesNotReject(() => nodePost({ ...nodeBody({}), parent_session_ref: {
      harness: 'dsh', session_id: parentSessionId, protocol: 'dsh-session-log'
    } }), 'Exact current source should first prove the negative cases reachable')
    const wrongSession = randomUUID()
    await deny({ ...nodeBody({}), parent_session_ref: {
        harness: 'dsh', session_id: wrongSession, protocol: 'dsh-session-log'
      }
    }, 'matching_artifact_with_forged_parent_session')

    const exactPath = join(server.dataDir, 'artifacts', `${parentArtifactId}.artifact`)
    const withheld = `${exactPath}.withheld`
    const savedBytes = await readFile(exactPath)
    assert.equal(hash(savedBytes), parentArtifact.artifact.sha256)
    let restored = false
    try {
      await rename(exactPath, withheld)
      await deny(nodeBody({}), 'the_same_authenticated_assignment_with_withheld_parent_bytes')
    } finally {
      await rename(withheld, exactPath)
      restored = true
    }
    assert.equal(restored, true)
    assert.deepEqual(await readFile(exactPath), savedBytes, 'Returning the intact owned source must not rewrite its bytes or Grant')
    await access(exactPath)
    assert.doesNotMatch((await admin.get(childTicketUrl)).messages.map(row => row.session_ref ?? '').join(','), new RegExp(wrongSession))
    const output = await readFile(join(root, 'project', 'docs', 'delegated.html'))
    const freshOfficialDigest = hash(output)
    const knownEffects = [...child.effects]
    assert.equal(freshOfficialDigest, child.artifacts[0].sha256)
    checks.push({ name: 'restored_original_artifact_remains_immutable_and_effects_unchanged', status: 'PASS' })

    const appRoot = resolve('apps/web')
    process.env.LOOM_TEST_CONCIERGE_URL = origin
    const { preview: startPreview } = await import(pathToFileURL(join(appRoot, 'node_modules/vite/dist/node/index.js')).href)
    preview = await startPreview({ root: appRoot, configFile: resolve('tests/browser/vite.config.mjs'), logLevel: 'error', cacheDir: join(root, 'vite-cache'),
      preview: { host: '127.0.0.1', port: 0, strictPort: true }, build: { outDir: join(appRoot, 'dist') },
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/api': { target: origin, changeOrigin: true } } } })
    const appOrigin = `http://127.0.0.1:${preview.httpServer.address().port}`
    context = await chromium.launchPersistentContext(join(root, 'edge-delegation-ui'), {
      executablePath: process.env.LOOM_BROWSER_EXECUTABLE || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true,
      viewport: { width: 1280, height: 1000 }, timeout: 30_000,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--no-proxy-server'],
      env: { PATH: process.env.PATH, TMPDIR: root },
    })
    const page = context.pages()[0]
    page.setDefaultTimeout(20_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (![appOrigin, origin].includes(url.origin)) throw new Error('Browser escaped isolated test Concierge')
    })
    const screenshot = async name => {
      await page.screenshot({ path: join(root, `${name}.png`), fullPage: true })
      await access(join(root, `${name}.png`)); browser.push({ name, width: await page.evaluate(() => innerWidth) })
    }
    await page.goto(appOrigin, { waitUntil: 'domcontentloaded' }); await page.locator('.loom-app').waitFor()
    await page.getByRole('button', { name: '个人工作空间与连接设置', exact: true }).click()
    await page.locator('#client-token').fill(clientToken)
    await page.getByRole('button', { name: '保存并重新连接', exact: true }).click()
    await page.locator('#connection-dialog').waitFor({ state: 'hidden' })
    await page.locator('.ticket-id').filter({ hasText: child.id }).waitFor()
    await page.getByRole('tab', { name: '协作', exact: true }).click()
    assert.equal(await page.locator('.delegation-source').count(), 0, 'Default collapsed process must not fabricate parent lineage display')
    const pref = page.waitForResponse(response => new URL(response.url()).pathname.includes('/preferences')
      && ['PUT', 'POST'].includes(response.request().method()) && response.status() === 200)

    await page.locator('label.switch-label').filter({ hasText: '展开过程消息' }).click()
    await page.getByRole('checkbox', { name: '展开过程消息', exact: true }).waitFor({ state: 'attached' })
    await pref
    const relation = page.locator('.delegation-source')
    await relation.waitFor()
    const text = await relation.innerText()
    for (const expected of [parent.id, parentArtifactId, parentSessionId, childSessionId]) assert.ok(text.includes(expected))
    assert.notEqual(parentSessionId, childSessionId)
    await screenshot('delegation-collaboration')
    await page.locator('.artifact-card').click()
    const childViewer = page.locator('.artifact-content')
    await childViewer.waitFor({ state: 'visible' })
    const childText = await childViewer.innerText()
    assert.equal(Buffer.from(childText, 'utf8').toString('base64'), output.toString('base64'))
    const parentButton = page.getByRole('button', { name: `打开已核验的父任务 ${parent.id}`, exact: true })
    await parentButton.click()
    await page.locator('.ticket-id').filter({ hasText: parent.id }).waitFor()
    const freshText = await page.locator('.ticket-detail').innerText()
    assert.ok(freshText.includes('ORBITAL-731'))
    assert.ok(!(await page.locator('.delegation-source').count()), 'Parent cannot masquerade as its own child source')
    await page.locator('.artifact-card').click()
    assert.ok((await page.locator('.artifact-viewer').innerText()).includes(parentSessionId) === false, 'Ordinary parent artifact contains its real summary, not fabricated child Session')

    // The source Ticket/report read is an independent view: child lineage is
    // not replaced by the globally latest Ticket or administrative token.
    assert.equal((await admin.get(parentTicketUrl)).artifacts.length, 1)
    await page.getByRole('button', { name: '新的任务', exact: true }).click()
    await page.locator('.ticket-item').filter({ hasText: child.id.slice(0, 6) }).click()
    await page.getByRole('tab', { name: '协作', exact: true }).click()
    assert.ok((await relation.innerText()).includes(parentArtifactId)
      && (await relation.innerText()).includes(childSessionId))
    assert.deepEqual(errors, [])
    await page.setViewportSize({ width: 390, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
    await screenshot('delegation-narrow')
    checks.push({ name: 'production_collaboration_parent_navigation_roundtrip_and_narrow', status: 'PASS', responsive_widths: [1280, 390], no_mobile_claim: true })

    const originalToken = server.clientToken, originalDataDir = server.dataDir
    const originalParent = await admin.get(parentTicketUrl), latestChild = await admin.get(childTicketUrl)
    const beforeRequests = readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'request').length
    await server.stop()
    server = await startRustConcierge({ root: join(root, 'rust'), env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: originalToken }, dataDir: originalDataDir, baseUrl: origin })
    admin = new LoomHttpClient({ baseUrl: origin, clientToken: originalToken })
    const reopenedChild = await admin.get(childTicketUrl)
    assert.deepEqual({ assignments: reopenedChild.assignments, reports: reopenedChild.reports, effects: reopenedChild.effects, artifacts: reopenedChild.artifacts, messages: reopenedChild.messages },
      { assignments: latestChild.assignments, reports: latestChild.reports, effects: latestChild.effects, artifacts: latestChild.artifacts, messages: latestChild.messages })
    assert.deepEqual(await admin.get(parentTicketUrl), originalParent)
    assert.deepEqual(await admin.get('/api/v1/projects'), beforeRoot)
    assert.deepEqual(host.sessionEvents(childSessionId, ['tool/call', 'tool/result']), [], 'No replay of ordinary terminal child work while reopening completed records')
    assert.equal(hash(output), freshOfficialDigest)
    const afterRequests = readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'request').length
    assert.equal(afterRequests, beforeRequests, 'A center restart must not create a second provider/model request')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.ticket-id').filter({ hasText: child.id }).waitFor()
    await page.getByRole('tab', { name: '协作', exact: true }).click()
    assert.ok((await page.locator('.delegation-source').innerText()).includes(parentArtifactId))
    assert.deepEqual(errors, [])
    checks.push({ name: 'same_center_port_state_session_reopen_preserves_lineage_without_replay', status: 'PASS', child_effects: knownEffects.length, provider_requests_after_reopen: beforeRequests.length })
    return { server, admin, checks, browser, root }
  } catch (error) {
    if (context?.pages().length) {
      const page = context.pages()[0]
      await page.screenshot({ path: join(root, 'delegation-ui-failure.png'), fullPage: true }).catch(() => {})
      if (error?.stack) console.error(redact(error.stack, [...secrets, clientToken, identity.token]))
    }
    throw error
  } finally {
    if (context) await context.close().catch(() => {})
    if (preview?.httpServer) await new Promise(ok => preview.httpServer.close(() => ok())).catch(() => {})
  }
}
