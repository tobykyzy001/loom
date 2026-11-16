import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fixtureRoot, installBundles, isolatedEnv, installation, command, redact, sleep } from './environment.mjs'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
// Existing real SDK and Rust fixture processes are owned by this script.

const root = await fixtureRoot(process.env.LOOM_DELEGATION_ROOT)
const checks = []
let server, admin, host, stopped = false
const secrets = []
const log = async (name, evidence) => { checks.push({ name, status: 'PASS', evidence }); console.log('PASS DSH delegation: ' + name) }
const facts = { real_sdk_pair: 'NOT RUN', source_and_lease_fencing: 'NOT RUN', effect_and_immutable_lineage: 'NOT RUN', live_llm: 'NOT RUN', second_physical_host: 'NOT RUN', active_desktop_profile: 'NOT TOUCHED' }
try {
  assert.equal(process.env.DSH_PROFILE, 'desktop', 'Only runtime facts are read. Only the fixture Profile is mutated.')
  const { executable, cli } = installation()
  server = await startRustConcierge({ root: join(root, 'rust') })
  secrets.push(server.clientToken)
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const projectRoot = join(root, 'project')
  await mkdir(join(projectRoot, 'docs'), { recursive: true })
  const originalInput = Buffer.from('ORBITAL-731\nBounded parent observation, not personal project content.\n')
  await writeFile(join(projectRoot, 'docs', 'input.txt'), originalInput, { mode: 0o600 })
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  const project = await admin.post('/api/v1/projects', { name: 'Parent and child Agent validation', root: projectRoot, mode: 'read_write' })
  const projectId = project.project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  secrets.push(enrollment.code)
  const env = isolatedEnv(root, {
    LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl,
    LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code,
    LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [projectId]: projectRoot }),
    LOOM_FIXTURE_DELEGATION_TOOLS: 'scoped_fixture',
  })
  await installBundles({ env, root, cli, executable, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom')] })
  host = new FixtureHost(root, env, secrets)
  await host.writePatch()
  const composed = await command(executable, [cli, '--profile', 'loom-local-fixture', '--patch', join(root, 'patch', 'fixture.yml'), '--dump-config'], { cwd: join(root, 'project'), env })
  assert.match(composed.stdout, /loom-local-node/)
  assert.match(composed.stdout, /loom-fixture-stub-provider/)
  assert.doesNotMatch(composed.stdout, new RegExp(enrollment.code))
  await writeFile(join(root, 'private', 'composed-runtime-config.txt'), composed.stdout, { mode: 0o600 })
  await host.start()
  const node = await wait(admin, '/api/v1/nodes', (body) => body.nodes.find((item) => item.status === 'online'
    && item.inventory?.project_roots?.[projectId] === projectRoot && item.workers?.some((entry) => entry.worker_id === 'default')))
  const binding = await admin.post('/api/v1/project-bindings', { project_id: projectId, node_id: node.id, worker_id: 'default', root_scope: projectRoot })
  const makeGrant = async (operations) => (await admin.post('/api/v1/grants', { project_id: projectId, node_id: node.id, worker_id: 'default', operations })).grant
  const readGrant = await makeGrant(['read'])
  const writeGrant = await makeGrant(['write'])
  assert.notEqual(readGrant.id, writeGrant.id)
  const pipelineId = randomUUID()
  const definition = {
    schema: 'loom.document-pipeline.v1', version: 1, pipeline_id: pipelineId,
    name: 'Parent should read ORBITAL-731 and delegate its summary to child', project_id: projectId,
    read: { stage_id: 'parent', kind: 'read_summary', grant_id: readGrant.id, relative_path: 'docs/input.txt', output_id: 'parent-summary', depends_on: [] },
    edit: { stage_id: 'child', kind: 'edit_file', grant_id: writeGrant.id, relative_path: 'docs/delegated.html', output_id: 'child-document', depends_on: ['parent'], transform: 'collapse_whitespace' },
  }
  await admin.post('/api/v1/pipelines', definition)
  const parent = await ticketUntil(admin, (await admin.get(`/api/v1/pipelines/${pipelineId}`)).pipeline.stages[0].ticket_id, 'succeeded')
  assert.equal(parent.reports.length, 1); assert.equal(parent.artifacts.length, 1)
  const parentMap = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json')))
  const parentSessionId = parentMap.assignments.find((entry) => entry.assignment_id === parent.assignments[0].id)?.session_id
  assert.ok(parentSessionId)
  await host.waitFor(() => host.sessionEvents(parentSessionId, ['turn/end']).length > 0, 30_000, 'parent actual turn/end')
  await log('real parent Agent produces immutable source and its own Session', { ticket_id: parent.id, artifact_id: parent.artifacts[0].id, session_id: parentSessionId, boundary: 'zero-network fixture' })
  const advanced = await admin.post(`/api/v1/pipelines/${pipelineId}/run`, {})
  const childTicketId = advanced.pipeline.stages.at(-1).ticket_id
  assert.ok(childTicketId)
  const child = await ticketUntil(admin, childTicketId, 'succeeded')
  const childMapsBeforeStop = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json')))
  const liveChildSessionId = childMapsBeforeStop.assignments.find((entry) => entry.assignment_id === child.assignments[0].id)?.session_id
  assert.ok(liveChildSessionId)
  const committedCall = host.sessionEvents(liveChildSessionId, ['tool/call']).find((entry) => entry.event.data.name === 'loom_fixture_delegate_write')
  assert.ok(committedCall, 'Observed real SDK call must use the scoped delegated tool')
  assert.equal(host.sessionEvents(liveChildSessionId, ['tool/call']).filter((entry) => entry.event.data.name === 'loom_fixture_delegate_write').length, 1, 'One real child Assignment yields exactly one scoped tool call before restart')
  const committedResult = host.sessionEvents(liveChildSessionId, ['tool/result']).find((entry) => entry.event.data.message.toolCallId === committedCall.event.data.callId)
  assert.equal(committedResult.event.data.message.isError, false)
  console.log('STEP first actual child completed; preserve its evidence before recovery checks')
  await host.stop(); host = null
  const identityFile = join(root, 'node-state', 'identity.json')
  const identity = JSON.parse(await readFile(identityFile, 'utf8'))
  const parentArtifact = await admin.get(`/api/v1/tickets/${parent.id}/artifacts/${parent.artifacts[0].id}`)
  const sourceRef = { type: 'artifact_ref', artifact_id: parentArtifact.artifact.id, ticket_id: parent.id,
    origin_node_id: node.id, sha256: parentArtifact.artifact.sha256, location: `loom://artifact/${parentArtifact.artifact.id}`, parents: [] }
  const childId = (await admin.get(`/api/v1/tickets/${childTicketId}`)).assignments[0].id
  const sourceBody = (goal) => ({
    protocol: 'loom.node.v1', node_id: identity.node_id, installation_id: identity.installation_id,
    request_id: randomUUID(), ticket_id: childTicketId, assignment_id: childId, lease_epoch: 1,
    source_ref: { ...sourceRef, ...goal },
  })
  const nodeTransport = new LoomHttpClient({ baseUrl: server.baseUrl })
  console.log('FENCE pre-existing file status', { exists: await readFile(join(projectRoot, 'docs', 'delegated.html')).then(() => true).catch(() => false), childTicketId })
  const accepted = await nodeTransport.post('/api/v1/nodes/assignments/source', sourceBody({}), { token: identity.token })
  assert.ok(accepted.artifact_input.bytes_base64.length > 0)
  assert.equal(Buffer.from((await admin.get(`/api/v1/tickets/${parent.id}/artifacts/${parent.artifacts[0].id}`)).content, 'utf8').toString('base64'), accepted.artifact_input.bytes_base64)
  assert.equal(createHash('sha256').update(Buffer.from(accepted.artifact_input.bytes_base64, 'base64')).digest('hex'), parentArtifact.artifact.sha256)
  assert.equal(accepted.parent_session_ref.session_id, parentSessionId)
  const priorOutput = await readFile(join(projectRoot, 'docs', 'delegated.html')).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  const previousBytes = priorOutput?.toString('base64') ?? null
  for (const [name, change] of [
    ['wrong hash', { sha256: '0'.repeat(64) }],
    ['foreign origin', { origin_node_id: '1'.repeat(64) }],
    ['unassigned source', { artifact_id: randomUUID() }],
    ['wrong source ticket', { ticket_id: childTicketId }],
  ]) {
    let denied = false
    let observed
    try { observed = await nodeTransport.post('/api/v1/nodes/assignments/source', sourceBody(change), { token: identity.token }) } catch (error) { denied = true; observed = { status: error.status, code: error.code } }
    console.log('FENCE CANDIDATE', name, JSON.stringify(observed))
    assert.ok(denied, `FENCE ${name} unexpectedly accepted: ${JSON.stringify(observed)}`)
    const afterDenial = await readFile(join(projectRoot, 'docs', 'delegated.html')).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    assert.equal(afterDenial?.toString('base64') ?? null, previousBytes, `Denied ${name} must not change the existing output file`)
  }
  await assert.rejects(() => nodeTransport.post('/api/v1/nodes/assignments/source', { ...sourceBody({}), lease_epoch: 99 }, { token: identity.token }), /403|400|Loom HTTP/)
  await assert.rejects(() => nodeTransport.post('/api/v1/nodes/assignments/source', sourceBody({}), { token: server.clientToken }))
  await log('source SHA, parent SessionRef and child Lease fenced before any file effect', { wrong_hash_denied: true, foreign_origin_denied: true, unknown_artifact_denied: true, bad_source_ticket_denied: true, admin_token_refused: true, source_proof_server_selected: true })
  facts.source_and_lease_fencing = 'PASS'
  console.log('STEP resume host for the independently verified child')
  env.LOOM_FIXTURE_ENROLLMENT_CODE = ''
  host = await new FixtureHost(root, env, secrets).start()
  await host.writePatch()
  await admin.post(`/api/v1/pipelines/${pipelineId}/run`, {})
  const maps = JSON.parse(await readFile(join(root, 'node-state', 'dsh-session-map.json')))
  const childSessionId = maps.assignments.find((entry) => entry.assignment_id === child.assignments[0].id)?.session_id
  assert.ok(childSessionId)
  assert.notEqual(childSessionId, parentSessionId)
  assert.equal(childSessionId, liveChildSessionId)
  const childInfo = persistedSessionHeader(root, childSessionId)
  assert.equal(childInfo.parentSession, parentSessionId)
  assert.equal(childInfo.origin, 'subagent')
  const call = committedCall
  assert.ok(call, 'The real child Agent must invoke the scoped source-bound tool')
  const result = committedResult
  assert.equal(result.event.data.message.isError, false)
  const output = await readFile(join(projectRoot, 'docs', 'delegated.html'))
  const outputHash = createHash('sha256').update(output).digest('hex')
  assert.match(output.toString('utf8'), /Verified delegated Agent/)
  assert.equal(child.effects.length, 1); assert.equal(child.artifacts.length, 1)
  assert.equal(child.artifacts[0].lineage[0].artifact_id, parent.artifacts[0].id)
  assert.equal(child.artifacts[0].lineage[0].sha256, parentArtifact.artifact.sha256)
  assert.equal(child.artifacts[0].lineage[0].source_ticket_id, parent.id)
  const download = await admin.get(`/api/v1/tickets/${childTicketId}/artifacts/${child.artifacts[0].id}`)
  assert.equal(Buffer.from(download.content).toString('base64'), output.toString('base64'))
  assert.equal(createHash('sha256').update(download.content).digest('hex'), outputHash)
  const message = await admin.get(`/api/v1/messages?ticket_id=${childTicketId}`)
  const event = message.messages.find((item) => item.kind === 'session_link')
  const childRef = typeof event.session_ref === 'string' ? JSON.parse(event.session_ref) : event.session_ref
  assert.equal(childRef.session_id, childSessionId)
  assert.equal(childRef.delegated_from.artifact_id, parent.artifacts[0].id)
  assert.equal(childRef.delegated_from.ticket_id, parent.id)
  assert.equal(childRef.delegated_from.session.session_id, parentSessionId)
  assert.equal(childRef.delegated_from.source_verified, true)
  assert.equal(childRef.delegated_from.validated_by, 'current_assignment_and_pipeline_relation')
  const beforeForgery = (await admin.get(`/api/v1/tickets/${childTicketId}`)).messages.length
  const forgedRef = { type: 'artifact_ref', ...sourceRef, sha256: '0'.repeat(64),
    session: { session_id: parentSessionId }, source_verified: true }
  await assert.rejects(() => nodeTransport.post('/api/v1/nodes/events', {
    protocol: 'loom.node.v1', node_id: identity.node_id, installation_id: identity.installation_id, request_id: randomUUID(),
    ticket_id: childTicketId, assignment_id: childId, lease_epoch: child.assignments[0].lease_epoch,
    kind: 'session_link', content: 'Attempted source substitution',
    session_ref: { harness: 'dsh', session_id: childSessionId, protocol: 'dsh-session-log', host_api: '0.2.2-rc.3', observed_seq: 0, delegated_from: forgedRef },
  }, { token: identity.token }), (error) => Number(error.status) >= 400 && Number(error.status) < 500)
  assert.equal((await admin.get(`/api/v1/tickets/${childTicketId}`)).messages.length, beforeForgery, 'A forged source relation must never persist a delegation Session link')
  await sleep(1800)
  const executions = readFileSync(join(root, 'private', 'fixture-control.jsonl'), 'utf8').split('\n').filter((line) => line.includes('loom_fixture_delegate_write'))
  const derivedTicket = await admin.get(`/api/v1/tickets/${childTicketId}`)
  assert.equal(derivedTicket.effects.length, 1)
  assert.equal(derivedTicket.artifacts.length, 1)
  assert.equal(readFileSync(identityFile, 'utf8').includes(parentSessionId), false)
  const recoveredBytes = await readFile(join(projectRoot, 'docs', 'delegated.html'))
  assert.equal(recoveredBytes.toString('base64'), previousBytes, 'Restart must not replace the actual child output')
  const finalGraph = await admin.get(`/api/v1/pipelines/${pipelineId}`)
  assert.equal(finalGraph.pipeline.status, 'succeeded')
  await log('distinct parent/child actual Dsh Sessions, public tool result and sourced HTML', {
    parent_ticket: parent.id, child_ticket: childTicketId, parent_session: parentSessionId,
    child_session: childSessionId, parent_artifact: parent.artifacts[0].id, child_artifact: child.artifacts[0].id,
    child_file_sha256: outputHash, count_tool_result: result.event.data.message.id, call_id: call.event.data.callId,
    exactly_one_file_effect: child.effects.length === 1, actual_session_parent: childInfo,
    simple_tool_calls: executions.length, immutable_lineage: true,
  })
  facts.real_sdk_pair = 'PASS'; facts.effect_and_immutable_lineage = 'PASS'
  stopped = true
  console.log(JSON.stringify({ overall: 'PASS', facts, checks, root, limits: 'One DSH Profile on one computer, bounded synthetic Tool/Stub. Not a live model, arbitrary Graph, second physical host or general Harness certification.' }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', facts, root, error: redact(error.stack, secrets), host_diagnostics: redact(host?.diagnostics() || 'No host launched', secrets), checks }, null, 2))
  process.exitCode = 1
} finally {
  if (host) await host.stop().catch(() => {})
  if (server) await server.stop().catch(() => {})
}
function persistedSessionHeader(root, sessionId) {
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        const found = walk(path)
        if (found) return found
      } else if (entry.name === 'session.v4.jsonl') {
        const first = readFileSync(path, 'utf8').split('\n', 1)[0]
        const header = JSON.parse(first)
        if (header?.type === 'session' && header.id === sessionId) return { header, path }
      }
    }
  }
  const found = walk(join(root, 'dsh-test-state', 'sessions'))
  assert.ok(found?.header)
  return { ...found.header, session_log_proof: found.path }
}
async function ticketUntil(admin, id, expected) {
  const deadline = Date.now() + 35_000
  let last
  while (Date.now() < deadline) {
    last = await admin.get(`/api/v1/tickets/${id}`)
    if (last.status === expected) return last
    if (['failed', 'cancelled', 'reconciling'].includes(last.status)) throw new Error(JSON.stringify({ status: last.status, assignments: last.assignments, reports: last.reports, effects: last.effects, artifacts: last.artifacts }))
    await sleep(200)
  }
  throw new Error(JSON.stringify({ timed_out: id, expected, last: last ? { status: last.status, reports: last.reports, assignments: last.assignments, messages: last.messages } : null }))
}
async function wait(admin, route, test) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const value = await admin.get(route)
    const chosen = test(value)
    if (chosen) return chosen
    await sleep(200)
  }
  throw new Error('Expected runtime evidence did not arrive')
}
