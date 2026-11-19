import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { installation, isolatedEnv, fixtureRoot, installBundles, command, redact, sleep, PROFILE } from './environment.mjs'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { DatabaseSync } from 'node:sqlite'

export async function runRealLifecycle({ output = process.env.LOOM_TEST_OUTPUT ? resolve(process.env.LOOM_TEST_OUTPUT) : undefined, root: requestedRoot } = {}) {
  const root = await fixtureRoot(requestedRoot)
  const checks = []
  const facts = { real_dsh: 'NOT RUN', install: 'NOT RUN', register: 'NOT RUN', task: 'NOT RUN', programming_write: 'NOT RUN', traversal_failure: 'NOT RUN', cancellation: 'NOT RUN', resume: 'NOT RUN', live_llm: 'NOT RUN (zero network Stub)' }
  const log = async (name, evidence) => { checks.push({ name, status: 'PASS', evidence }); console.log(`PASS real DSH: ${name}`) }
  const failure = (error) => {
    const text = redact(error.stack || error.message || error, secrets)
    console.error(text)
    checks.push({ name: 'failure', status: 'FAIL', evidence: text.slice(0, 4000) })
  }
  let host, server, admin
  const secrets = []
  let env
  let settled = false
  let sessionId = ''
  try {
    await writeFile(join(root, 'project', 'input.txt'), 'ORBITAL-731\nSynthetic appointed test project; no real user files.\n', { mode: 0o600 })
    await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
    await mkdir(join(root, 'rust'), { mode: 0o700 })
    const { executable, cli } = installation()
    server = await startRustConcierge({ root: join(root, 'rust'), env: { ...isolatedEnv(root), PATH: process.env.PATH } })
    secrets.push(server.clientToken)
    admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20_000 })
    const health = await admin.get('/api/v1/health')
    assert.equal(health.status, 'ok')
    const projectRoot = join(root, 'project')
    const project = await admin.post('/api/v1/projects', { name: 'Loom deterministic DSH synthetic project', root: projectRoot, mode: 'read_write' })
    const projectId = project.project.id
    const enrollment = await admin.post('/api/v1/enrollment-codes', {})
    secrets.push(enrollment.code)
    env = isolatedEnv(root, { LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl, LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code,
      LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [projectId]: projectRoot }) })
    const installed = await installBundles({ env, root, cli, executable, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
    assert.ok(installed.dependencies.includes('@loom/dsh-loom'))
    facts.install = 'PASS'
    await log('real dsh plugin CLI installs only inside owned temporary Profile', { argv: ['dsh', 'plugin', '--profile', PROFILE, 'add', 'file:<owned-shallow-copy>', '--ignore-scripts', '--store-dir', '<fixture>/pnpm-store'], dependencies: installed.dependencies, dsh_home_mode: installed.root_mode })
    env = { ...env, LOOM_FIXTURE_AGENT_SESSION_ID: '' }
    host = new FixtureHost(root, env, secrets)
    await host.writePatch()
    await command(executable, [cli, '--profile', PROFILE, '--patch', join(root, 'patch', 'fixture.yml'), '--dump-config'], { cwd: join(root, 'project'), env }).then((result) => writeFile(join(root, 'private', 'composed-runtime-config.txt'), result.stdout, { mode: 0o600 }))
    const composed = await readFile(join(root, 'private', 'composed-runtime-config.txt'), 'utf8')
    assert.match(composed, /# == @loom\/dsh-loom/)
    assert.match(composed, /# == @loom\/dsh-fixture-stub-provider/)
    assert.doesNotMatch(composed, new RegExp(enrollment.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await host.start()
    await waitForRegistration(admin, projectId, projectRoot)
    const nodes = await admin.get('/api/v1/nodes')
    const initialNodes = nodes.nodes
    console.log('REAL_REGISTRATION_SNAPSHOT', JSON.stringify(initialNodes.map((entry) => ({ id: entry.id, status: entry.status, workers: entry.workers?.map((worker) => ({ worker_id: worker.worker_id, profile_id: worker.profile_id, harness_kind: worker.harness_kind })), project_roots: entry.inventory?.project_roots }))))
    const node = initialNodes.find((entry) => entry.status === 'online' && entry.inventory?.project_roots?.[projectId] === projectRoot)
    assert.ok(initialNodes.length > 0 && initialNodes.some((entry) => entry.status === 'online' && entry.workers?.some((worker) => worker.worker_id === 'default')), 'Actual dsh-host Node must be registered with default Worker')
    assert.ok(node?.inventory?.project_roots?.[projectId] === projectRoot, 'Registration inventory must contain the approved synthetic root mapping')
    facts.register = 'PASS'; facts.real_dsh = 'PASS'
    await log('real Host activate + outbound Node registration / root inventory persists', { node_id: node.id, worker_id: node.workers[0].worker_id, harness_kind: node.inventory.harness_kind, session_ref: 'derived by Host provider logging; no synthetic Session record', credential_persistence_restart_without_new_enrollment: true })
    const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: projectRoot })
    const grantResponse = await admin.post('/api/v1/grants', { project_id: projectId, node_id: node.id, worker_id: 'default', operations: ['read', 'write'] })
    const grantId = grantResponse.grant.id
    const createTicket = (objective, kind = 'read_summary', relativePath = 'input.txt') => admin.post('/api/v1/tickets', { project_id: projectId, node_id: node.id, grant_id: grantId, worker_id: 'default', objective, kind, relative_path: relativePath })
    const followup = await createTicket(`LOOM_FIXTURE_READ ${randomUUID()} Please call the controlled inspect tool for project ORBITAL-731.`)
    await host.waitFor(() => readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8').then((value) => JSON.parse(value).assignments.length > 0, () => false), 45_000, 'real own DSH Agent Session creation')
    const mapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
    sessionId = mapping.assignments.find((entry) => entry.assignment_id === followup.assignments[0].id)?.session_id
    assert.ok(sessionId, 'Actual SessionRef must map the real Assignment ID')
    const realSessionRef = controlRead(root).find((entry) => entry.session_id && entry.session_id === sessionId)
    if (!realSessionRef) await host.waitFor(() => controlRead(root).some((entry) => entry.session_id === sessionId), 45_000, 'actual provider-bound Session header')
    const completed = await waitTicket(admin, followup.id, ['succeeded', 'failed', 'cancelled', 'reconciling'], 60_000)
    assert.equal(completed.status, 'succeeded', JSON.stringify({ reports: completed.reports, status: completed.status }))
    assert.equal(completed.reports.length, 1)
    assert.equal(completed.artifacts.length, 1)
    assert.equal(host.sessionEvents(sessionId, ['tool/call']).length, 1)
    assert.equal(host.sessionEvents(sessionId, ['tool/result']).length, 1)
    assert.ok(host.sessionEvents(sessionId, ['turn/end']).at(-1).event.data.reason.kind === 'completed')
    const artifact = await admin.get(`/api/v1/tickets/${followup.id}/artifacts/${completed.artifacts[0].id}`)
    const assistant = JSON.parse(artifact.content)
    assert.equal(assistant.schema, 'loom.read-evidence.v1')
    assert.equal(assistant.source.schema, 'loom.read-source.v1')
    assert.equal(assistant.source.path, 'input.txt')
    assert.equal(assistant.source.size_bytes, await readFile(join(projectRoot, 'input.txt')).then(data => data.length))
    assert.equal(assistant.source.bytes, createHash('sha256').update(await readFile(join(projectRoot, 'input.txt'))).digest('hex'))
    assert.equal(assistant.read_observed, true)
    assert.equal(assistant.raw_artifact_published, false)
    assert.equal(assistant.proof.name, 'loom_fixture_inspect')
    assert.equal(assistant.proof.call_id, 'loom-fixture-controlled-read')
    assert.equal(assistant.proof.session.session_id, sessionId)
    assert.equal(assistant.text, undefined, 'The public read proof must not copy the assistant narration or original file')
    const publicReadProjection = JSON.parse(JSON.stringify(artifact.artifact)).read_evidence
    assert.equal(publicReadProjection.schema, 'loom.read-provenance.v1')
    assert.equal(publicReadProjection.path, 'input.txt')
    assert.equal(publicReadProjection.sha256, assistant.source.bytes)
    assert.equal(publicReadProjection.call_id, assistant.proof.call_id)
    assert.equal(publicReadProjection.call_seq, assistant.proof.call_seq)
    assert.equal(publicReadProjection.result_seq, assistant.proof.result_seq)
    assert.equal(publicReadProjection.raw_artifact_published, false)
    const stateStat = await stat(join(root, 'node-state', 'identity.json'))
    assert.equal(stateStat.mode & 0o777, 0o600)
    assert.equal((await stat(join(root, 'node-state', 'dsh-session-map.json'))).mode & 0o777, 0o600)
    facts.task = 'PASS'
    await log('actual Loom Ticket to real DSH Agent followup + controlled tool + immutable artifact', { ticket_id: followup.id, assignment_id: completed.assignments[0].id, session_id: sessionId, host_tool_calls: 1, final_reason: 'completed', report_state: 'succeeded', artifact_id: artifact.artifact.id, source: 'DSH committed assistant/message', effect_kind: 'none (read-only inspect tool)', project_binding_id: binding.id })
    const programming = await createTicket('Create a small semantic HTML page with the specified fixture title "Loom verifier portal". LOOM_FIXTURE_FILE_WRITE', 'edit_file', 'demo.html')
    const writeCompleted = await waitTicket(admin, programming.id, ['succeeded', 'failed', 'reconciling', 'cancelled'], 60_000)
    assert.equal(writeCompleted.status, 'succeeded', JSON.stringify({ reports: writeCompleted.reports, status: writeCompleted.status }))
    const writeMapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
    const writeSessionId = writeMapping.assignments.find((entry) => entry.assignment_id === programming.assignments[0].id)?.session_id
    assert.ok(writeSessionId, 'Programming Assignment requires its own actual DSH SessionRef')
    const writeCall = host.sessionEvents(writeSessionId, ['tool/call']).find((entry) => entry.event.data?.name === 'loom_fixture_write')
    assert.ok(writeCall?.event.data.callId, 'The public DSH Agent must actually declare the bounded file-write tool call')
    const writeArguments = JSON.parse(writeCall.event.data.arguments)
    assert.equal(writeArguments.path, 'demo.html')
    assert.equal(writeArguments.title, 'Loom verifier portal')
    const writeResult = host.sessionEvents(writeSessionId, ['tool/result']).find((entry) => entry.event.data?.message?.toolCallId === writeCall.event.data.callId)
    assert.ok(writeResult?.event.data.message, 'Actual public bounded write ToolResult is required')
    assert.equal(writeResult.event.data.message.isError, false)
    const file = join(projectRoot, 'demo.html')
    const fileBytes = await readFile(file)
    const contentHash = createHash('sha256').update(fileBytes).digest('hex')
    assert.equal(writeResult.event.data.message.content[0].text, JSON.stringify({ created: true, path: 'demo.html', sha256: contentHash, size_bytes: fileBytes.length, title: 'Loom verifier portal' }))
    assert.match(fileBytes.toString('utf8'), /<title>Loom verifier portal<\/title>/)
    assert.match(fileBytes.toString('utf8'), /<main><h1>Loom verifier portal<\/h1>/)
    assert.equal(writeCompleted.effects.length, 1)
    assert.equal(writeCompleted.effects[0].status, 'confirmed')
    assert.equal(writeCompleted.effects[0].assignment_id, programming.assignments[0].id)
    assert.deepEqual(writeCompleted.effects[0].artifacts, writeCompleted.artifacts.map((entry) => entry.id))
    assert.match(JSON.stringify(writeCompleted.effects[0].evidence), /loom_fixture_write/)
    const htmlArtifact = await admin.get(`/api/v1/tickets/${programming.id}/artifacts/${writeCompleted.artifacts[0].id}`)
    assert.equal(htmlArtifact.artifact.sha256, contentHash)
    assert.equal(htmlArtifact.artifact.media_type, 'text/html')
    assert.deepEqual(Buffer.from(htmlArtifact.content), fileBytes)
    await sleep(2200)
    const repeatedWrites = controlRead(root).filter((entry) => entry.type === 'tool-execute' && entry.name === 'loom_fixture_write')
    assert.equal(repeatedWrites.length, 1, 'Settled Assignment must not invoke a second file-writing tool')
    assert.deepEqual((await admin.get(`/api/v1/tickets/${programming.id}`)).effects.length, 1)
    const immutableReport = await admin.get(`/api/v1/tickets/${programming.id}`, {})
    assert.equal(immutableReport.reports.length, 1)
    assert.equal(immutableReport.artifacts.length, 1)
    facts.programming_write = 'PASS'
    await log('bounded DSH semantic HTML task creates actual file with ToolResult-centered Effect lineage', { ticket_id: programming.id, assignment_id: programming.assignments[0].id, session_id: writeSessionId, tool: 'loom_fixture_write', call_id: writeCall.event.data.callId, tool_result_id: writeResult.event.data.message.id, effect_id: writeCompleted.effects[0].id, artifact_id: writeCompleted.artifacts[0].id, sha256: contentHash, size_bytes: fileBytes.length, repeated_tool_executions: 0 })
    const traversal = await createTicket('LOOM_FIXTURE_TRAVERSAL The tool must reject a path outside the exact project root')
    const traversalDetail = await waitTicket(admin, traversal.id, ['failed', 'succeeded', 'cancelled', 'reconciling'], 45_000)
    assert.equal(traversalDetail.status, 'failed', JSON.stringify({ reports: traversalDetail.reports, status: traversalDetail.status }))
    await host.waitFor(() => readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8').then((value) => JSON.parse(value).assignments.some((entry) => entry.assignment_id === traversal.assignments[0].id), () => false), 20_000, 'actual traversal SessionRef mapping')
    const traversalMapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
    const traversalSessionId = traversalMapping.assignments.find((entry) => entry.assignment_id === traversal.assignments[0].id)?.session_id
    assert.ok(traversalSessionId, 'Traversal must have its own actual SessionRef, never borrow the successful write Session')
    const invalidResult = host.sessionEvents(traversalSessionId, ['tool/result']).find((entry) => entry.event.data.message?.toolCallId === 'loom-fixture-invalid-write')
    assert.ok(invalidResult, 'The traversal attempt must enter the public DSH tool dispatcher and produce a real failed result')
    assert.equal(invalidResult.event.data.message.isError, true)
    assert.match(invalidResult.event.data.message.content.map((block) => block.text || '').join('\n'), /limited to demo.html/)
    await assert.rejects(() => access(join(root, 'escape.html')), (error) => error.code === 'ENOENT')
    assert.equal((await readFile(file)).toString('base64'), fileBytes.toString('base64'), 'Traversal must never modify the previously proven output')
    facts.traversal_failure = 'PASS'
    await log('public tool traversal refusal leaves no out-of-root output', { ticket_id: traversal.id, report_state: 'failed', tool_result_error: true, no_file_effect: true, output_untouched_sha256: contentHash })
    const cancellation = await createTicket('LOOM_FIXTURE_CANCEL hold until DSH demonstrably aborts this turn')
    await host.waitFor(() => controlRead(root).some((entry) => entry.type === 'hold'), 30_000, 'Stub hold')
    assert.equal((await admin.post(`/api/v1/tickets/${cancellation.id}/cancel`, {})).status, 'cancel_requested')
    const cancelMapping = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8'))
    const cancelSessionId = cancelMapping.assignments.find((entry) => entry.assignment_id === cancellation.assignments[0].id)?.session_id
    assert.ok(cancelSessionId && cancelSessionId !== sessionId, 'Cancellation must bind its own actual DSH Session')
    const cancelled = await waitTicket(admin, cancellation.id, ['cancelled', 'failed', 'succeeded', 'reconciling'], 45_000)
    assert.equal(cancelled.status, 'cancelled', JSON.stringify({ reports: cancelled.reports, status: cancelled.status }))
    assert.equal(cancelled.reports.at(-1).state, 'cancelled')
    assert.ok([1, true].includes(cancelled.reports.at(-1).cancel_acknowledged))
    assert.equal(cancelled.artifacts.length, 0)
    await host.waitFor(() => host.sessionEvents(cancelSessionId, ['turn/end']).some((entry) => entry.event.data?.reason?.kind === 'aborted'), 15_000, 'actual user-cause aborted DSH Session event')
    assert.equal(host.sessionEvents(cancelSessionId, ['turn/end']).at(-1).event.data.reason.kind, 'aborted')
    // The terminal DSH event above is the observed cancellation source; no extra Session events are synthesized.
    // The separate Node acknowledgement must also have used the centre's cancel_requested gate.
    const receiptDb = new DatabaseSync(join(server.dataDir, 'loom.sqlite3'), { readOnly: true })
    try {
      const row = receiptDb.prepare('SELECT id,acknowledged_at,last_report_at,lease_epoch FROM assignments WHERE id=? AND ticket_id=?')
        .get(cancellation.assignments[0].id, cancellation.id)
      assert.ok(row?.acknowledged_at, `The Node stop acknowledgement must reach the actual controller, not only a mocked client`)
      assert.ok(row.last_report_at, 'A cancelled final Report remains distinct from a cancellation delivery acknowledgement')
      assert.equal(row.lease_epoch, cancellation.assignments[0].lease_epoch)
    } finally { receiptDb.close() }
    facts.cancellation = 'PASS'
    await log('actual Loom cancel -> Host agent.cancel + durable aborted turn + cancel_acknowledged', { ticket_id: cancellation.id, session_id: cancelSessionId, terminal_kind: 'aborted', cancel_acknowledged: true, artifacts: 0 })
    await host.stop(); host = null
    const retained = await readFile(join(root, 'node-state', 'dsh-session-map.json'), 'utf8')
    assert.match(retained, new RegExp(sessionId))
    assert.doesNotMatch(retained, /token|private_key/)
    assert.match(fsEvents(root, sessionId).join('\n'), /assistant\/message/)
    env.LOOM_FIXTURE_ENROLLMENT_CODE = ''
    env.LOOM_FIXTURE_AGENT_SESSION_ID = sessionId
    host = await new FixtureHost(root, env, secrets).start()
    await host.raw('session/resume', { sessionId })
    const resumed = await createTicket('LOOM_FIXTURE_RESUME verify actual persisted Session history')
    const resumedDone = await waitTicket(admin, resumed.id, ['succeeded', 'failed', 'reconciling', 'cancelled'], 60_000)
    assert.equal(resumedDone.status, 'succeeded')
    const resumedArtifact = await admin.get(`/api/v1/tickets/${resumed.id}/artifacts/${resumedDone.artifacts[0].id}`)
    const resumedProof = JSON.parse(resumedArtifact.content)
    const resumedSessionRef = JSON.parse(resumedDone.reports.at(-1).evidence)[0]
    assert.equal(resumedSessionRef.session_id, sessionId)
    assert.equal(resumedProof.source, 'dsh-assistant-messages')
    assert.equal(resumedProof.assignment_id, resumed.assignments[0].id)
    assert.match(resumedProof.text, /resumed Session reused loom_fixture_inspect.*ORBITAL-731/)
    assert.equal(host.sessionEvents(sessionId, ['turn/end']).at(-1).event.data.reason.kind, 'completed')
    facts.resume = 'PASS'
    await log('owned Session persisted across Host restart and resumed for new actual followup', { session_id: sessionId, restart_completed: true, actual_history_provider_seen: true, no_synthetic_session_event: true })
    settled = true
    return { schema: 'loom.dsh.real_harness.v1', overall: 'PASS', facts, checks, public_apis: publicApis(), root, session_id: sessionId }
  } catch (error) {
    failure(error)
    return { schema: 'loom.dsh.real_harness.v1', overall: 'FAIL', facts, checks, root, diagnostics: host?.diagnostics().slice(-4000) || '', public_apis: publicApis() }
  } finally {
    if (host) await host.stop().catch(() => {})
    if (server) await server.stop().catch(() => {})
    if (output) await writeFile(output, JSON.stringify({ schema: 'loom.dsh.real_harness.v1', overall: settled ? 'PASS' : 'FAIL', facts, checks, root, public_apis: publicApis(), diagnostics: host?.diagnostics().slice(-4000) || '' }, null, 2), { mode: 0o600 })
  }
}
function controlRead(root) {
  try { return readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] }
}
function fsEvents(root, sessionId) {
  // Read only the explicit synthetic DSH root, and only names event types, never secret fields or unrelated logs.
  const files = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === 'session.v4.jsonl') files.push(path)
    }
  }
  visit(join(root, 'dsh-test-state', 'sessions'))
  return files.filter((path) => readFileSync(path, 'utf8').includes(sessionId)).flatMap((path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).type || JSON.parse(line).event?.type || ''))
}
async function waitForRegistration(admin, projectId, root) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const nodes = await admin.get('/api/v1/nodes')
    if (nodes.nodes.some((entry) => entry.status === 'online' && entry.inventory?.project_roots?.[projectId] === root)) return nodes
    await sleep(200)
  }
  const final = await admin.get('/api/v1/nodes')
  throw new Error(`The real outbound Node did not deliver bounded inventory: ${JSON.stringify(final)}`)
}
async function waitTicket(admin, ticket, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const detail = await admin.get(`/api/v1/tickets/${ticket}`); if (statuses.includes(detail.status)) return detail; await sleep(150) }
  throw new Error(`Ticket ${ticket} did not reach ${statuses}`)
}
function publicApis() {
  return [
    'dsh --profile loom-local-fixture --from-default-profile sdk-minimal --dump-config (one-time owned initialization)',
    'dsh plugin --profile loom-local-fixture add file:<fixture> --ignore-scripts --store-dir <fixture>',
    'dsh --profile loom-local-fixture --patch <owned-patch>',
    'ctx.llm.registerAdapter([provider], LlmAdapter)',
    'ctx.tools.register(ToolDefinition)',
    'export const inject=["agents","sessionPersistence"]',
    'ctx.agents.create({sessionId,meta:{cwd},agentOptions:{provider,model}})',
    'ctx.agents.resume({resumeSessionId})',
    'ctx.agents.get(sessionId)',
    'agent.followup({id,role:"user",content,source:{kind:"loom"}}) (identified, frozen public UserMessage)',
    'agent.cancel({kind:"user"})',
    'ctx.on("session/event",(session,event)) ordinary assistant/message + turn/end',
    'SDK initialize/session/prompt/session/wait/session/resume/shutdown',
  ]
}
if (process.argv[1]?.endsWith('real-lifecycle.mjs')) {
  const result = await runRealLifecycle()
  console.log(JSON.stringify({ ...result, checks: undefined }, null, 2))
  if (result.overall !== 'PASS') process.exitCode = 1
}
