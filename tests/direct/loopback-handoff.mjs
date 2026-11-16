#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../../packages/node-client/src/runner.js'
import { DirectArtifactExecutor, LoopbackArtifactOfferServer, loadOfferSource, signDirectOffer, sourceOfferQuestion, validateDirectEndpoint } from '../../packages/node-client/src/direct.js'
import { sha256 } from '../../packages/node-client/src/util.js'
import { envelope } from '../../packages/node-client/src/validation.js'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'

const checks = [], ownedPeers = []
let server, nodeA, nodeB, admin
const SAFE_LIMIT = () => 1_048_577
const secret = () => server?.clientToken
function safe(value) { return String(value).replaceAll(secret() || '\0', '[redacted-test-token]') }
async function check(name, fn) {
  const evidence = await fn()
  checks.push({ name, status: 'PASS', evidence })
  console.log(`PASS direct: ${name}`)
  return evidence
}
async function run(node, expected) {
  const value = await node.pollAndRun()
  if (value.status !== expected) throw new Error(`runner expected ${expected}, actually ${JSON.stringify(value)}; completions=${JSON.stringify(node.state.data.completions)}`)
  const first = await node.client.dispatchOutbox(), second = await node.client.dispatchOutbox()
  assert.ok(![...first, ...second].some((item) => item.status === 'deferred'), JSON.stringify([...first, ...second]))
  return value
}
function recordFor(node, ticket, kind = 'artifact') {
  return node.state.data.deliveries.find((entry) => entry.kind === kind && entry.body.ticket_id === ticket)
}
function rehome(node) {
  node.http = new LoomHttpClient({ baseUrl: server.baseUrl })
  node.client.http = node.http
  node.options.baseUrl = server.baseUrl
}
const requestOffer = (node, offer) => sourceOfferQuestion({ node, http: node.http, offer })

try {
  // This fixture creates a temporary test-owned isolated Root; no system Profile is loaded.
  // Create a per-run root via the existing fixture; all writes stay in temporary test-owned directories.
  const { testingRoot } = await import('../../scripts/fixtures/rust-server.mjs')
  const baseRoot = await testingRoot()
  const rootA = join(baseRoot, 'a'), rootB = join(baseRoot, 'b')
  await mkdir(join(rootA, 'docs'), { recursive: true, mode: 0o700 })
  await mkdir(join(rootB, 'docs'), { recursive: true, mode: 0o700 })
  await writeFile(join(rootA, 'docs/input.txt'), '  Node A direct loopback source.\nThe bytes must be verified by B.  ', { mode: 0o600 })
  server = await startRustConcierge({ root: baseRoot })
  admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const project = (await admin.post('/api/v1/projects', { name: 'Direct offer logical project', root: rootA, mode: 'read_write' })).project
  const makeNode = async (role, workerId, roots) => LocalNodeRunner.create({ baseUrl: server.baseUrl,
    stateDir: join(baseRoot, `${role}-state`), artifactDir: join(baseRoot, `${role}-artifacts`),
    projectRoots: { [project.id]: roots }, enrollmentCode: (await admin.post('/api/v1/enrollment-codes', {})).code,
    registration: { workerId, harnessKind: 'direct-loopback-fixture', profileId: `direct-${role}` } })
  nodeA = await makeNode('a', 'worker-a', rootA)
  nodeB = await makeNode('b', 'worker-b', rootB)
  const bindingA = (await admin.post('/api/v1/project-bindings', { project_id: project.id, node_id: nodeA.nodeId, worker_id: 'worker-a', root_scope: rootA })).id
  const bindingB = (await admin.post('/api/v1/project-bindings', { project_id: project.id, node_id: nodeB.nodeId, worker_id: 'worker-b', root_scope: rootB })).id
  const readGrant = (await admin.post('/api/v1/grants', { project_id: project.id, node_id: nodeA.nodeId, worker_id: 'worker-a', project_binding_id: bindingA, operations: ['read'] })).grant
  const writeGrant = (await admin.post('/api/v1/grants', { project_id: project.id, node_id: nodeB.nodeId, worker_id: 'worker-b', project_binding_id: bindingB, operations: ['write'] })).grant
  await check('two actual Ed25519 Nodes and independent current ProjectBindings/Grants', async () => {
    assert.notDeepEqual(nodeA.identity.public.public_key, nodeB.identity.public.public_key)
    assert.notEqual(nodeA.nodeId, nodeB.nodeId)
    assert.notEqual(nodeA.installationId, nodeB.installationId)
    assert.notEqual(bindingA, bindingB); assert.notEqual(readGrant.id, writeGrant.id)
    assert.deepEqual(readGrant.operations, ['read']); assert.deepEqual(writeGrant.operations, ['write'])
    assert.equal(nodeA.options.projectRoots[project.id], rootA)
    assert.equal(nodeB.options.projectRoots[project.id], rootB)
    return { nodes: 2, independent_ed25519_keys: true, read_write_grants_scoped: true }
  })

  const bindDirectExecutor = () => {
    nodeB.executor = new DirectArtifactExecutor({ baseOptions: { artifactDir: nodeB.options.artifactDir, projectRoots: nodeB.options.projectRoots },
      currentOffer: async ({ ticketId, artifactId }) => {
        const issued = await nodeB.http.post('/api/v1/nodes/direct-offers', { ...envelope(nodeB, randomUUID()), ticket_id: ticketId, artifact_id: artifactId }, { token: nodeB.identity.token }).then((raw) => raw.direct_offer, (error) => { throw new Error(`ISSUE FAILED ${error.message}`, { cause: error }) })
        const peer = ownedPeers.at(-1)
        return { direct_offer: issued, identity: nodeB.identity, endpoint: peer?.endpoint }
      } })
  }
  const startPeerFor = (offer) => {
    const peer = new LoopbackArtifactOfferServer({ identity: nodeA.identity, offer, bytes: sourceBytesForCurrent,
      root: nodeA.options.artifactDir, nonceFile: join(baseRoot, 'a-state', 'direct-peer-used.json'),
      sourceGrantCurrent: async () => {
        const response = await requestOffer(nodeA, offer).catch((error) => {
          if (error.status === 403 && error.code === 'direct_offer_source_denied') return null
          throw error
        })
        if (!response.direct_offer) throw Object.assign(new Error('No active SourceGrant proof'), { code: 'source_grant_denied' })
        return response.direct_offer
      } })
    return peer
  }

  // Conventional parent pipeline relation is immutable; no body Grant can choose a new parent.
  const definition = (id, path = 'docs/destination.txt') => ({ schema: 'loom.document-pipeline.v1', version: 1, pipeline_id: id, project_id: project.id,
    read: { stage_id: 'source', kind: 'read_summary', grant_id: readGrant.id, relative_path: 'docs/input.txt', output_id: 'source-summary', depends_on: [], worker_id: 'worker-a' },
    edit: { stage_id: 'overwrite', kind: 'edit_file', grant_id: writeGrant.id, relative_path: path, output_id: 'destination', depends_on: ['source'], worker_id: 'worker-b', transform: 'trim', direct: true } })
  let pipelineId = randomUUID()
  await admin.post('/api/v1/pipelines', definition(pipelineId))
  const parent = await run(nodeA, 'succeeded')
  const sourceTask = (await admin.get(`/api/v1/pipelines/${pipelineId}`)).pipeline.stages[0].ticket_id
  const sourceRecord = recordFor(nodeA, sourceTask)
  const sourceReference = {
    type: 'artifact_ref', artifact_id: sourceRecord.body.artifact_id, ticket_id: sourceTask,
    origin_node_id: nodeA.nodeId, sha256: sourceRecord.body.metadata.sha256,
    location: `loom://artifact/${sourceRecord.body.artifact_id}`, parents: [],
  }
  let sourceBytesForCurrent = null
  await check('A real successful Task produced immutable UUID, SHA, origin and source Ticket', async () => {
    const response = await admin.get(`/api/v1/tickets/${sourceTask}`)
    assert.equal(response.status, 'succeeded'); assert.equal(response.artifacts.length, 1)
    assert.equal(response.artifacts[0].origin_node_id, nodeA.nodeId)
    assert.deepEqual(response.artifacts[0].lineage, [])
    sourceBytesForCurrent = recordFor(nodeA, sourceTask).body.bytes_base64
    sourceBytesForCurrent = Buffer.from(sourceBytesForCurrent, 'base64')
    assert.equal(sha256(sourceBytesForCurrent), sourceReference.sha256)
    const loaded = await loadOfferSource({ assignment: { ...nodeA.state.data.assignments[parent.assignmentId],
      artifact_input: { direct_offer: true, artifact_ref: sourceReference } }, nodeId: nodeA.nodeId,
      artifactDir: nodeA.options.artifactDir, root: nodeA.options.artifactDir })
    assert.deepEqual(loaded.bytes, sourceBytesForCurrent)
    return { artifact_id: sourceReference.artifact_id, source_ticket_id: sourceTask, origin_node_id: nodeA.nodeId, sha256: sourceReference.sha256, size_bytes: sourceBytesForCurrent.length }
  })
  await check('pipeline direct Assignment contains scope/reference only, never center source bytes', async () => {
    const child = await nodeB.client.poll({ waitSeconds: 0 })
    assert.equal(child.ticket_id, (await admin.get(`/api/v1/pipelines/${pipelineId}`)).pipeline.stages[1].ticket_id)
    assert.ok(child, 'B got a real Assignment through the ordinary pipeline')
    assert.equal(child.artifact_input.direct_offer, true)
    assert.equal(child.artifact_input.transform, 'trim')
    assert.equal(child.artifact_input.bytes_base64, undefined)
    assert.equal(child.content, null)
    assert.deepEqual(child.artifact_input.artifact_ref, sourceReference)
    return { source_bytes_in_assignment: false, artifact_ref_preserved: true, transform: 'trim', child_ticket_id: child.ticket_id }
  })

  const childTicket = (await admin.get(`/api/v1/pipelines/${pipelineId}`)).pipeline.stages[1].ticket_id
  const firstIssue = await nodeB.http.post('/api/v1/nodes/direct-offers', {
    ...envelope(nodeB, randomUUID()), ticket_id: childTicket, artifact_id: sourceReference.artifact_id,
  }, { token: nodeB.identity.token })
  assert.ok(firstIssue.direct_offer)
  assert.equal(firstIssue.artifact_bytes_included, false)
  assert.equal(firstIssue.direct_offer.bytes_base64, undefined)

  await check('one-off signed challenge has trusted origin/recipient keys, bounded lease and nonce', async () => {
    const offer = firstIssue.direct_offer
    assert.equal(offer.origin_node_id, nodeA.nodeId)
    assert.equal(offer.recipient_node_id, nodeB.nodeId)
    assert.equal(offer.recipient_installation_id, nodeB.installationId)
    assert.equal(offer.recipient_worker_id, 'worker-b')
    assert.equal(offer.lease_epoch, 1); assert.equal(offer.artifact_id, sourceReference.artifact_id)
    assert.ok(Date.parse(offer.expires_at) > Date.now() && Date.parse(offer.expires_at) <= Date.now() + 60001)
    assert.equal(Buffer.from(offer.nonce, 'hex').length, 32)
    assert.equal(offer.recipient_public_key, nodeB.identity.public.public_key)
    assert.equal(offer.source_public_key, nodeA.identity.public.public_key)
    assert.equal(sha256(Buffer.from(offer.recipient_public_key, 'base64url')), nodeB.nodeId)
    return { schema: offer.schema, nonce_bytes: 32, challenge_binding: 'ticket/assignment/lease/artifact/recipient/origin', source_bytes_in_offer: false }
  })

  await check('center restart preserves the original IDs, scope and nonce', async () => {
    await server.stop()
    server = await startRustConcierge({ root: join(baseRoot), env: { ...process.env, LOOM_CLIENT_TOKEN: server.clientToken } })
    admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
    rehome(nodeA); rehome(nodeB)
    const repoll = await nodeB.http.post('/api/v1/nodes/direct-offers', {
      ...envelope(nodeB, randomUUID()), ticket_id: childTicket, artifact_id: sourceReference.artifact_id,
    }, { token: nodeB.identity.token })
    assert.equal(repoll.direct_offer.offer_id, firstIssue.direct_offer.offer_id)
    assert.equal(repoll.direct_offer.nonce, firstIssue.direct_offer.nonce)
    assert.equal(repoll.direct_offer.artifact_sha256, sourceReference.sha256)
    return { same_offer_id: true, same_nonce: true, source_bytes_from_coordinator: false }
  })
  const peer = startPeerFor(firstIssue.direct_offer)
  ownedPeers.push(peer)
  peer.endpoint = await peer.start()
  bindDirectExecutor()
  const direct = async (request) => globalThis.fetch(`${peer.endpoint}/api/v1/direct/artifacts/${sourceReference.artifact_id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request),
  })
  const request = (change = {}) => ({ schema: 'loom.direct-offer.v1', offer_id: firstIssue.direct_offer.offer_id,
    nonce: firstIssue.direct_offer.nonce, artifact_id: sourceReference.artifact_id,
    origin_node_id: firstIssue.direct_offer.origin_node_id, source_ticket_id: firstIssue.direct_offer.source_ticket_id,
    recipient_node_id: firstIssue.direct_offer.recipient_node_id, recipient_installation_id: firstIssue.direct_offer.recipient_installation_id,
    recipient_worker_id: firstIssue.direct_offer.recipient_worker_id, ticket_id: firstIssue.direct_offer.ticket_id,
    assignment_id: firstIssue.direct_offer.assignment_id, lease_id: firstIssue.direct_offer.lease_id,
    lease_epoch: firstIssue.direct_offer.lease_epoch,
    signature: signDirectOffer(nodeB.identity, firstIssue.direct_offer), ...change })
  await check('wrong recipient and B-key mismatch/signature fail before any direct byte stream', async () => {
    const wrong = await direct(request({ recipient_node_id: nodeA.nodeId }))
    assert.equal(wrong.status, 403)
    const bad = await direct(request({ signature: signDirectOffer(nodeA.identity, firstIssue.direct_offer) }))
    assert.equal(bad.status, 403)
    assert.equal((await bad.json()).error.code, 'recipient_signature_invalid')
    assert.equal(peer.requests.length, 0)
    assert.throws(() => validateDirectEndpoint('http://example.invalid'), /loopback|127\.0\.0\.1/)
    return { wrong_recipient_http: wrong.status, wrong_signature_code: 'recipient_signature_invalid', foreign_keys_not_trusted: true }
  })
  await check('oversize source stream is stopped before ordinary Executor writes', async () => {
    const assignment = await nodeB.client.poll({ waitSeconds: 0 })
    const bounded = new DirectArtifactExecutor({ baseOptions: { artifactDir: nodeB.options.artifactDir, projectRoots: nodeB.options.projectRoots },
      currentOffer: async () => ({ direct_offer: firstIssue.direct_offer, identity: nodeB.identity, endpoint: peer.endpoint }),
      fetch: async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(SAFE_LIMIT())); controller.close()
      } }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '210', 'x-content-type-options': 'nosniff' } }) })
    await assert.rejects(() => bounded.execute(assignment, assignment.grant),
      (error) => error.code === 'source_response_limit')
    await assert.rejects(() => readFile(join(rootB, 'docs/destination.txt')), (error) => error.code === 'ENOENT')
    return { response_code: 502, exceeded_artifact_bytes_rejected: true, destination_file_absent_before_success: true }
  })
  await check('real socket B receives only from A, verifies bytes and writes under B Grant with parent reference', async () => {
    await run(nodeB, 'succeeded')
    const target = join(rootB, 'docs/destination.txt')
    const content = await readFile(target, 'utf8')
    assert.equal(content, sourceBytesForCurrent.toString('utf8').trim(), 'B applies existing trim to direct Artifact bytes, not a different raw A file')
    const task = await admin.get(`/api/v1/tickets/${childTicket}`)
    if (task.status !== 'succeeded' || task.artifacts.length !== 1) throw new Error(`B was not fully delivered (${nodeB.state.outbox.length} queued): ${JSON.stringify(task)}; queue=${JSON.stringify(nodeB.state.outbox)}`)
    const output = task.artifacts[0]
    assert.equal(output.origin_node_id, nodeB.nodeId)
    assert.equal(output.size_bytes, Buffer.byteLength(JSON.stringify({ path: 'docs/destination.txt', kind: 'edit_file', operation: 'replaced_project_file', target_hash: sha256(content) })))
    assert.equal(output.lineage[0].artifact_id, sourceReference.artifact_id)
    assert.equal(output.lineage[0].sha256, sourceReference.sha256)
    assert.equal(output.lineage[0].origin_node_id, nodeA.nodeId)
    assert.equal(output.lineage[0].source_ticket_id, sourceTask)
    assert.equal(output.lineage[0].component_sha256, output.sha256)
    assert.deepEqual(recordFor(nodeB, childTicket).body.metadata.parents, [sourceReference.artifact_id])
    assert.equal(peer.requests.length, 1)
    assert.equal(peer.requests[0].artifact_id, sourceReference.artifact_id)
    assert.equal(peer.requests[0].recipient_node_id, nodeB.nodeId)
    assert.equal(await readFile(join(rootA, 'docs/input.txt'), 'utf8'), '  Node A direct loopback source.\nThe bytes must be verified by B.  ')
    return { destination_file_sha256: sha256(content), source_sha256: sourceReference.sha256,
      output_artifact_id: output.id, derivation: 'existing trim', network_bytes: sourceReference.sha256 && sourceBytesForCurrent.length,
      actual_node_a_offers: peer.requests.length, parent_ticket_id: sourceTask, parent_origin_node_id: nodeA.nodeId }
  })
  await check('replay is one-use and exact completed poll has no second FileEffect', async () => {
    const response = await direct(request())
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'offer_nonce_consumed')
    const before = await stat(join(rootB, 'docs/destination.txt'))
    await run(nodeB, 'idle'); await run(nodeB, 'idle')
    const after = await stat(join(rootB, 'docs/destination.txt'))
    assert.equal(before.ino, after.ino)
    assert.equal((await admin.get(`/api/v1/tickets/${childTicket}`)).assignments.length, 1)
    assert.equal(peer.requests.length, 1)
    const consumed = JSON.parse(await readFile(peer.nonceFile, 'utf8'))
    assert.ok(consumed.includes(firstIssue.direct_offer.nonce), 'A durably consumes a nonce before serving bytes')
    return { duplicate_offer_code: 'offer_nonce_consumed', nonce_persisted_in_private_state: true, destination_inodes_equal: true, second_file_effect: false }
  })
  await check('expired challenge is rejected without ever producing another direct byte response', async () => {
    const originalNow = peer.now
    peer.now = () => Date.now() + 120000
    const response = await direct(request())
    assert.equal(response.status, 410); assert.equal((await response.json()).error.code, 'offer_expired')
    peer.now = originalNow
    return { expired_code: 'offer_expired' }
  })
  await check('cancel intent before the peer response blocks the direct byte fetch too', async () => {
    const nextId = randomUUID()
    await admin.post('/api/v1/pipelines', definition(nextId, 'docs/cancelled.txt'))
    await run(nodeA, 'succeeded')
    const pending = await nodeB.client.poll({ waitSeconds: 0 })
    assert.equal(pending.artifact_input.direct_offer, true)
    const issued = await nodeB.http.post('/api/v1/nodes/direct-offers', { ...envelope(nodeB, randomUUID()),
      ticket_id: pending.ticket_id, artifact_id: pending.artifact_input.artifact_ref.artifact_id }, { token: nodeB.identity.token })
    const stoppedPeer = startPeerFor(issued.direct_offer)
    ownedPeers.push(stoppedPeer)
    stoppedPeer.endpoint = await stoppedPeer.start()
    const cancelled = await admin.post(`/api/v1/tickets/${pending.ticket_id}/cancel`, {})
    assert.equal(cancelled.status, 'cancel_requested')
    const body = { schema: 'loom.direct-offer.v1', offer_id: issued.direct_offer.offer_id, nonce: issued.direct_offer.nonce,
      artifact_id: issued.direct_offer.artifact_id, origin_node_id: issued.direct_offer.origin_node_id,
      source_ticket_id: issued.direct_offer.source_ticket_id, recipient_node_id: nodeB.nodeId,
      recipient_installation_id: nodeB.installationId, recipient_worker_id: 'worker-b', ticket_id: pending.ticket_id,
      assignment_id: pending.id, lease_id: pending.lease_id, lease_epoch: pending.lease_epoch,
      signature: signDirectOffer(nodeB.identity, issued.direct_offer) }
    const response = await fetch(`${stoppedPeer.endpoint}/api/v1/direct/artifacts/${issued.direct_offer.artifact_id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'source_grant_denied')
    assert.equal(stoppedPeer.requests.length, 0)
    const unused = JSON.parse(await readFile(stoppedPeer.nonceFile, 'utf8'))
    assert.equal(unused.includes(issued.direct_offer.nonce), false)
    await assert.rejects(() => readFile(join(rootB, 'docs/cancelled.txt')), (error) => error.code === 'ENOENT')
    return { stop_intent_not_ack_or_success: true, source_bytes_rejected_before_effect: true }
  })
  await check('revoked source Grant blocks a separate unconsumed offer and its next file effect', async () => {
    const nextId = randomUUID()
    await admin.post('/api/v1/pipelines', definition(nextId, 'docs/revoked.txt'))
    await run(nodeA, 'succeeded')
    const pending = await nodeB.client.poll({ waitSeconds: 0 })
    assert.equal(pending.artifact_input.direct_offer, true)
    const issued = await nodeB.http.post('/api/v1/nodes/direct-offers', { ...envelope(nodeB, randomUUID()),
      ticket_id: pending.ticket_id, artifact_id: pending.artifact_input.artifact_ref.artifact_id }, { token: nodeB.identity.token })
    const revokedPeer = startPeerFor(issued.direct_offer)
    ownedPeers.push(revokedPeer)
    revokedPeer.endpoint = await revokedPeer.start()
    await admin.post(`/api/v1/grants/${readGrant.id}/revoke`, {})
    const body = { schema: 'loom.direct-offer.v1', offer_id: issued.direct_offer.offer_id, nonce: issued.direct_offer.nonce,
      artifact_id: issued.direct_offer.artifact_id, origin_node_id: issued.direct_offer.origin_node_id,
      source_ticket_id: issued.direct_offer.source_ticket_id, recipient_node_id: nodeB.nodeId,
      recipient_installation_id: nodeB.installationId, recipient_worker_id: 'worker-b',
      ticket_id: pending.ticket_id, assignment_id: pending.id, lease_id: pending.lease_id, lease_epoch: pending.lease_epoch,
      signature: signDirectOffer(nodeB.identity, issued.direct_offer) }
    const response = await fetch(`${revokedPeer.endpoint}/api/v1/direct/artifacts/${issued.direct_offer.artifact_id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'source_grant_denied')
    assert.equal(revokedPeer.requests.length, 0)
    await assert.rejects(() => requestOffer(nodeA, issued.direct_offer),
      (error) => error.status === 403 && error.code === 'direct_offer_source_denied')
    await assert.rejects(() => readFile(join(rootB, 'docs/revoked.txt')), (error) => error.code === 'ENOENT')
    return { revoked_source_offer_http: 403, no_unconsumed_file_effect: true, consumed_nonce_is_not_authority: true }
  })
  await check('source peer cannot swap bytes under an old immutable SHA or use a destination project root', async () => {
    assert.throws(() => new LoopbackArtifactOfferServer({ identity: nodeA.identity,
      offer: firstIssue.direct_offer, bytes: Buffer.from('different source bytes'), root: nodeA.options.artifactDir,
      nonceFile: join(baseRoot, 'a-state', 'tamper-must-not-be-used.json'), sourceGrantCurrent: () => false }),
      /Source object hash and content differ/)
    assert.throws(() => validateDirectEndpoint('https://127.0.0.1'), /http loopback/)
    assert.throws(() => validateDirectEndpoint('http://user:secret@127.0.0.1:8788'), /bare operator-owned/)
    return { old_sha_alias_denied: true, new_file_effect: false, tls_or_credentials_in_http_endpoint_not_used: true }
  })
  await check('explicit source HTTP server shutdown cannot be hidden by fallback fetch', async () => {
    await peer.stop()
    assert.equal(peer.closed, true)
    await assert.rejects(() => globalThis.fetch(`${peer.endpoint}/api/v1/direct/artifacts/${sourceReference.artifact_id}`, {
      method: 'POST', signal: AbortSignal.timeout(1000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()),
    }))
    return { source_socket_stopped: true, alternate_source_or_center_bytes: false }
  })
  const report = { schema: 'loom.direct-loopback.actual-execution.v1', overall: 'PASS', source: sourceReference,
    network_bytes: sourceBytesForCurrent.length, recipient: nodeB.nodeId, nonce_single_use: true, checks,
    limits: ['One physical host, no second machine or remote/TLS guarantee', 'No DSH/current Profile/model/LLM calls', 'No large-file/decompressor/public peer support'] }
  const evidencePath = join(baseRoot, 'direct-loopback-result.json')
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ...report, evidence_path: evidencePath }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ schema: 'loom.direct-loopback.actual-execution.v1', overall: 'FAIL', error: safe(error.stack || error), checks }, null, 2))
  process.exitCode = 1
} finally {
  for (const peer of ownedPeers) await peer.stop().catch(() => {})
  if (server) await server.stop().catch(() => {})
}
