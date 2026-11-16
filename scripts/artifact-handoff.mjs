#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LoomHttpClient } from '../packages/node-client/src/http.js'
import { LocalNodeRunner } from '../packages/node-client/src/runner.js'
import { ControlledFileExecutor } from '../packages/node-client/src/executor.js'
import { sha256 } from '../packages/node-client/src/util.js'
import { assertLoopback, startRustConcierge, testingRoot } from './fixtures/rust-server.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = resolve(process.env.LOOM_HANDOFF_OUTPUT || join(repository, 'tests/handoff/artifact-handoff-result.json'))
const PLATFORM = process.platform === 'darwin' ? 'macOS' : process.platform
const OFFLINE_WAIT_MS = 68000

function generatedSourceShape(source) {
  return {
    type: 'artifact_ref', artifact_id: source.artifact_id, ticket_id: source.ticket_id,
    origin_node_id: source.origin_node_id, sha256: source.sha256,
    location: source.location, parents: source.parents,
  }
}

/** Only the ordinary edit_file executor is extended, with a verified artifact ID, not arbitrary metadata. */
class ReferencedArtifactExecutor {
  constructor(options, source) {
    this.base = new ControlledFileExecutor(options)
    this.parentId = source.artifact_id
    const { bytes, ticket_id: ticketId, ...rest } = source
    this.source = { ...rest, ticket_id: ticketId }
    assert.equal(source.sha256, sha256(source.bytes ?? bytes), 'Verified constructor input SHA mismatch')
    this.sourceBytes = bytes
    assert.deepEqual(generatedSourceShape(this.source), this.source, 'artifact_ref must be bounded typed provenance without payload bytes')
  }

  async execute(assignment, grant) {
    assert.equal(assignment.kind, 'edit_file')
    const generated = JSON.parse(assignment.content)
    assert.equal(generated.schema, 'loom.artifact_handoff.generated_payload.v1', 'Invalid generated_schema for handoff')
    assert.equal(generated.source_artifact.artifact_id, this.parentId, 'Invalid generated_source_artifact_id')
    assert.equal(generated.source_artifact.sha256, sha256(this.sourceBytes), 'Invalid generated_source_sha256')
    assert.equal(generated.source_artifact.origin_node_id, this.source.origin_node_id, 'Invalid generated_source_origin')
    assert.deepEqual(generated.source_artifact, {
      artifact_id: this.source.artifact_id, ticket_id: this.source.ticket_id,
      origin_node_id: this.source.origin_node_id, location: this.source.location,
      sha256: this.source.sha256, parents: this.source.parents,
    })
    const inputSummary = JSON.parse(this.sourceBytes.toString('utf8'))
    assert.deepEqual(generated.derived_summary, { path: inputSummary.path, lines: inputSummary.lines })
    assert.equal(generated.operator_effect, 'edit_file')
    assert.equal(generated.conversion, 'deterministic-verified-artifact-summary')
    const result = await this.base.execute(assignment, grant)
    assert.equal(result.state, 'succeeded')
    const producedReceipt = JSON.parse(Buffer.from(result.artifact.bytes).toString('utf8'))
    assert.deepEqual(producedReceipt, {
      path: assignment.relative_path, kind: 'edit_file', operation: 'replaced_project_file',
      target_hash: sha256(assignment.content),
    })
    // The scoped conversion may enrich its NEW receipt, never rewrite the base receipt or another Artifact.
    assert.equal(await readFile(join(grant.project_root, assignment.relative_path), 'utf8'), assignment.content)
    const bytes = Buffer.from(JSON.stringify({
      ...producedReceipt, generated_payload: generated,
      verified_source: {
        schema: inputSummary.schema, sha256: this.source.sha256,
        parents: this.source.parents, bytes_base64: this.sourceBytes.toString('base64'),
      },
    }, null, 2))
    const metadata = {
      ...result.artifact.metadata, parents: [this.parentId], artifact_ref: this.source,
      size_bytes: bytes.length, sha256: sha256(bytes),
    }
    // No caller metadata, secret bag, caller digest, effect input_digest, origin or Artifact ID override.
    return { ...result, artifact: { ...result.artifact, metadata, bytes } }
  }
}

async function runArtifactHandoff({ env = process.env, output = console } = {}) {
  const secrets = [env.LOOM_CLIENT_TOKEN]
  const checks = []
  let evidence
  let server
  let nodeA
  let nodeB
  const startedAt = new Date().toISOString()
  const redact = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, '[REDACTED_TEST_CREDENTIAL]'), text).slice(0, 10000)
  }
  const check = async (name, fn) => {
    try {
      const fact = await fn()
      checks.push({ name, status: 'PASS', evidence: fact })
      output.log(`PASS handoff: ${name}`)
      return fact
    } catch (error) {
      checks.push({ name, status: 'FAIL', error: redact(error?.stack || error) })
      throw new Error(`${name}: ${redact(error?.message || error)}`)
    }
  }
  const failed = (error) => ({
    schema: 'loom.artifact_handoff.evidence.v1',
    overall: 'FAIL', started_at: startedAt, finished_at: new Date().toISOString(),
    error: redact(error?.stack || error), checks,
  })

  try {
    server = env.LOOM_BASE_URL ? {
      baseUrl: assertLoopback(env.LOOM_BASE_URL).origin,
      clientToken: env.LOOM_CLIENT_TOKEN || '', external: true, stop: async () => {},
    } : await startRustConcierge({ env })
    assert.ok(server.clientToken, 'LOOM_CLIENT_TOKEN is required for the fixture center; no profile credential is read')
    secrets.push(server.clientToken)
    const root = server.dataDir ? join(server.dataDir, '..') : await testingRoot()
    const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, maxResponseBytes: 12 * 1024 * 1024 })
    const projectRoot = async (name) => {
      const directory = join(root, name)
      await mkdir(directory, { mode: 0o700 })
      return realpath(directory)
    }
    const assignment = (ticket) => {
      assert.equal(ticket.assignments?.length, 1)
      return ticket.assignments[0].id
    }
    const run = async (node) => {
      const execution = await node.pollAndRun()
      assert.equal(execution.status, 'succeeded', JSON.stringify(execution))
      const first = await node.client.dispatchOutbox()
      const second = await node.client.dispatchOutbox()
      assert.ok(![...first, ...second].some((entry) => entry.status === 'deferred'), JSON.stringify([...first, ...second]))
      assert.equal(node.state.outbox.length, 0, JSON.stringify(node.state.outbox.map((item) => ({ kind: item.kind, last_error: item.last_error }))))
      const delivered = node.state.data.deliveries.find((entry) => entry.kind === 'report' && entry.body.assignment_id === execution.assignmentId)
      assert.ok(delivered?.body.request_id, 'Successful execution requires a durably delivered Report request ID')
      return { ...execution, requestId: delivered.body.request_id }
    }
    const download = async (ticketId, id) => {
      const response = await admin.get(`/api/v1/tickets/${ticketId}/artifacts/${id}`)
      assert.equal(response.artifact.sha256, sha256(response.content))
      assert.equal(response.artifact.size_bytes, Buffer.byteLength(response.content))
      return response
    }
    const immutableReplay = async (node, ticketId) => {
      const original = await admin.get(`/api/v1/tickets/${ticketId}`)
      const delivery = node.state.data.deliveries.find((entry) => entry.kind === 'artifact' && entry.body.ticket_id === ticketId)
      assert.ok(delivery)
      assert.equal((await node.http.post('/api/v1/nodes/artifacts', delivery.body, { token: node.identity.token })).duplicate, true)
      assert.equal(delivery.body.request_id, node.state.data.deliveries.find((entry) => entry.kind === 'artifact' && entry.body.ticket_id === ticketId).body.request_id)
      assert.equal(await readFile(join(root, 'concierge', 'artifacts', `${delivery.body.artifact_id}.artifact`), 'utf8'), delivery.body.bytes_base64 ? Buffer.from(delivery.body.bytes_base64, 'base64').toString('utf8') : null)
      const mutation = structuredClone(delivery.body)
      mutation.request_id = crypto.randomUUID()
      mutation.metadata.sha256 = '0'.repeat(64)
      await assert.rejects(() => node.http.post('/api/v1/nodes/artifacts', mutation, { token: node.identity.token }),
        (error) => error.status === 400)
      const tamper = structuredClone(delivery.body)
      const changedBytes = Buffer.from('Immutable artifact replacement must be rejected.')
      tamper.request_id = crypto.randomUUID()
      tamper.bytes_base64 = changedBytes.toString('base64')
      tamper.metadata.sha256 = sha256(changedBytes)
      tamper.metadata.size_bytes = changedBytes.length
      await assert.rejects(() => node.http.post('/api/v1/nodes/artifacts', tamper, { token: node.identity.token }),
        (error) => error.status === 409 && error.code === 'artifact_conflict')
      const hadParents = delivery.body.metadata.parents?.length > 0
      if (hadParents) {
        const lineageTamper = structuredClone(delivery.body)
        lineageTamper.request_id = crypto.randomUUID()
        lineageTamper.metadata.parents = []
        lineageTamper.metadata.artifact_ref = undefined
        await assert.rejects(() => node.http.post('/api/v1/nodes/artifacts', lineageTamper, { token: node.identity.token }),
          (error) => error.status === 409 && error.code === 'artifact_conflict')
      }
      assert.deepEqual(await admin.get(`/api/v1/tickets/${ticketId}`), original)
      return { same_request_id_replayed: delivery.body.request_id, forged_sha256_rejected: true, changed_bytes_rejected: true, changed_parents_rejected: hadParents, bytes_unchanged: true }
    }

    await check('real Rust center is the only authority', async () => {
      const health = await admin.get('/api/v1/health')
      assert.equal(health.status, 'ok')
      assert.equal(health.protocol, 'loom.node.v1')
      assert.equal(server.external, false, 'This benchmark owns a newly launched foreground child, not another server')
      return { server: 'rust-concierge', api: health.api, foreground_child: true, base_url: server.baseUrl }
    })
    const rootA = await projectRoot('root-a')
    const rootB = await projectRoot('root-b')
    assert.notEqual(rootA, rootB)
    const sourceText = 'Node A observed: alpha, beta, gamma.\nThis is deterministic input, not a model response.\n'
    await writeFile(join(rootA, 'input.txt'), sourceText, { mode: 0o600, flag: 'wx' })
    // node-state and node-artifacts are private siblings of, never inside, either Project root.
    let aOffline = false
    const aRequests = []
    const node = (label, projectRoots, enrollmentCode, workerId) => new LocalNodeRunner({
      baseUrl: server.baseUrl,
      stateDir: join(root, `${label}-state`), artifactDir: join(root, `${label}-artifacts`),
      projectRoots, enrollmentCode,
      registration: { workerId, harnessKind: 'deterministic-local-http-handoff', profileId: `${label}-isolated-logical-worker` },
      ...(label === 'node-a' ? { fetch: async (...args) => {
        if (aOffline) throw new Error('Node A transport is stopped; offline mean no HTTP request is sent')
        aRequests.push(String(args[0]))
        return globalThis.fetch(...args)
      } } : {}),
    })
    await check('two POST /projects create independent read_write Project IDs and roots', async () => {
      const a = await admin.post('/api/v1/projects', { name: 'Isolated handoff source A', root: rootA, mode: 'read_write' })
      const b = await admin.post('/api/v1/projects', { name: 'Isolated handoff destination B', root: rootB, mode: 'read_write' })
      evidence = { project_a: a.project.id, project_b: b.project.id }
      assert.notEqual(a.project.id, b.project.id)
      assert.equal(a.project.mode, 'read_write')
      assert.equal(b.project.mode, 'read_write')
      return { project_ids_distinct: true, modes: ['read_write', 'read_write'], roots_independent: true }
    })
    await check('distinct Ed25519 identities, installation credentials and heartbeat mappings', async () => {
      const [enrollA, enrollB] = await Promise.all([
        admin.post('/api/v1/enrollment-codes', {}), admin.post('/api/v1/enrollment-codes', {}),
      ])
      nodeA = node('node-a', { [evidence.project_a]: rootA }, enrollA.code, 'worker-a')
      nodeB = node('node-b', { [evidence.project_b]: rootB }, enrollB.code, 'worker-b')
      await nodeA.start({ enrollmentCode: enrollA.code })
      await nodeB.start({ enrollmentCode: enrollB.code })
      secrets.push(nodeA.identity.token, nodeB.identity.token, enrollA.code, enrollB.code)
      assert.notEqual(nodeA.nodeId, nodeB.nodeId)
      assert.notEqual(nodeA.identity.data.public_key, nodeB.identity.data.public_key)
      assert.notEqual(nodeA.identity.data.private_key_pkcs8, nodeB.identity.data.private_key_pkcs8)
      assert.notEqual(nodeA.identity.token, nodeB.identity.token)
      assert.notEqual(nodeA.installationId, nodeB.installationId)
      for (const label of ['node-a-state', 'node-a-artifacts', 'node-b-state', 'node-b-artifacts']) {
        for (const parent of [rootA, rootB]) {
          const candidate = join(root, label)
          assert.ok(candidate !== parent && !candidate.startsWith(parent + '/') && !parent.startsWith(candidate + '/'))
        }
      }
      const nodes = (await admin.get('/api/v1/nodes')).nodes
      const registeredA = nodes.find((entry) => entry.id === nodeA.nodeId)
      const registeredB = nodes.find((entry) => entry.id === nodeB.nodeId)
      assert.deepEqual(registeredA.inventory.project_roots, { [evidence.project_a]: rootA })
      assert.deepEqual(registeredB.inventory.project_roots, { [evidence.project_b]: rootB })
      assert.equal(registeredA.workers[0].worker_id, 'worker-a')
      assert.equal(registeredB.workers[0].worker_id, 'worker-b')
      return { distinct_ed25519_keys: true, distinct_tokens: true, distinct_installations: true, roots_scoped_to_own_project: true, worker_ids: ['worker-a', 'worker-b'] }
    })
    // A real envelope with B's bearer cannot pretend to be A. The public helper is intentionally not a freeform auth override.
    await check('one node credential cannot become the other node identity', async () => {
      const before = aRequests.length
      await assert.rejects(() => nodeA.http.post('/api/v1/nodes/heartbeat', {
        protocol: 'loom.node.v1', node_id: nodeA.nodeId, installation_id: nodeA.installationId,
        request_id: crypto.randomUUID(), status: 'online', workers: [], inventory: {},
      }, { token: nodeB.identity.token }), (error) => error.status === 401)
      assert.equal(aRequests.length, before + 1)
      return { cross_node_bearer_rejected: 401 }
    })
    await check('admin approves exact bindings; read-only A and write-only B grants cannot exchange roots', async () => {
      const bindingA = await admin.post('/api/v1/project-bindings', {
        project_id: evidence.project_a, node_id: nodeA.nodeId, worker_id: 'worker-a', root_scope: rootA,
      })
      const bindingB = await admin.post('/api/v1/project-bindings', {
        project_id: evidence.project_b, node_id: nodeB.nodeId, worker_id: 'worker-b', root_scope: rootB,
      })
      await assert.rejects(() => admin.post('/api/v1/project-bindings', {
        project_id: evidence.project_a, node_id: nodeA.nodeId, worker_id: 'worker-a', root_scope: rootB,
      }), (error) => error.status === 403 && error.code === 'binding_not_declared_by_host')
      const grantA = await admin.post('/api/v1/grants', {
        project_id: evidence.project_a, node_id: nodeA.nodeId, worker_id: 'worker-a', project_binding_id: bindingA.id, operations: ['read'],
      })
      const grantB = await admin.post('/api/v1/grants', {
        project_id: evidence.project_b, node_id: nodeB.nodeId, worker_id: 'worker-b', project_binding_id: bindingB.id, operations: ['write'],
      })
      evidence.grant_a = grantA.grant.id
      evidence.grant_b = grantB.grant.id
      assert.notEqual(grantA.grant.digest, grantB.grant.digest)
      await assert.rejects(() => admin.post('/api/v1/tickets', {
        project_id: evidence.project_a, grant_id: grantA.grant.id, node_id: nodeA.nodeId, worker_id: 'worker-a',
        objective: 'Read Grant cannot write root A', kind: 'edit_file', relative_path: 'forbidden.json', content: '{}',
      }), (error) => error.status === 403 && error.code === 'operation_scope')
      await assert.rejects(() => admin.post('/api/v1/tickets', {
        project_id: evidence.project_b, grant_id: grantB.grant.id, node_id: nodeB.nodeId, worker_id: 'worker-b',
        objective: 'Write Grant cannot read root B', kind: 'read_summary', relative_path: 'missing.txt',
      }), (error) => error.status === 403 && error.code === 'operation_scope')
      return { approved_bindings: 2, read_only_grant: true, write_only_grant: true, foreign_root_rejected: true, out_of_scope_operations_rejected: true }
    })
    let readTicket, writeTicket
    let source
    await check('A executes actual read_summary and exports input-derived immutable Artifact', async () => {
      readTicket = await admin.post('/api/v1/tickets', {
        project_id: evidence.project_a, grant_id: evidence.grant_a, node_id: nodeA.nodeId, worker_id: 'worker-a',
        objective: 'Read the actual A input for a later controlled Artifact handoff', kind: 'read_summary', relative_path: 'input.txt',
      })
      const execution = await run(nodeA)
      assert.ok(execution.requestId)
      assert.equal(execution.assignmentId, readTicket.assignments[0].id)
      const detail = await admin.get(`/api/v1/tickets/${readTicket.id}`)
      assert.equal(detail.status, 'succeeded')
      assert.equal(detail.assignments.length, 1)
      assert.equal(detail.reports.length, 1)
      assert.equal(detail.artifacts.length, 1)
      assert.equal(detail.artifacts[0].origin_node_id, nodeA.nodeId)
      assert.deepEqual(detail.artifacts[0].lineage, [])
      source = await download(readTicket.id, detail.artifacts[0].id)
      const summary = JSON.parse(source.content)
      assert.deepEqual(summary.lines, sourceText.trim().split('\n'))
      assert.equal(summary.path, 'input.txt')
      evidence.source_artifact = {
        artifact_id: source.artifact.id, ticket_id: readTicket.id,
        origin_node_id: source.artifact.origin_node_id, sha256: source.artifact.sha256,
        size_bytes: source.artifact.size_bytes, parents: source.artifact.lineage,
        report_request_id: nodeA.state.data.deliveries.find((entry) => entry.kind === 'report' && entry.body.ticket_id === readTicket.id).body.request_id,
      }
      return evidence.source_artifact
    })
    const originalSource = await admin.get(`/api/v1/tickets/${readTicket.id}`)
    const replayA = await check('A accepts exact Artifact replay but rejects mutated lineage before revocation', () => immutableReplay(nodeA, readTicket.id))
    await check('A really stops heartbeat and polling; fresh center presence is stale offline', async () => {
      nodeA.stopped = true
      aOffline = true
      const count = aRequests.length
      // The deterministic runner has no hidden background loop. Stop its driver and block all subsequent transport.
      const deadline = Date.now() + OFFLINE_WAIT_MS
      let registered
      while (Date.now() < deadline) {
        registered = (await admin.get('/api/v1/nodes')).nodes.find((entry) => entry.id === nodeA.nodeId)
        if (registered.online === false && registered.freshness === 'stale_offline') break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      assert.ok(registered, 'Node A must still be listed')
      assert.equal(registered.online, false, 'A stale cutoff is required; the driver must not merely print offline')
      assert.equal(registered.freshness, 'stale_offline')
      assert.equal(aRequests.length, count, 'No hidden A network request is allowed during the offline interval')
      const stillBlocked = await nodeA.http.post('/api/v1/nodes/heartbeat', {}, { token: nodeA.identity.token }).then(() => false, (error) => /transport is stopped/.test(error.message))
      assert.equal(stillBlocked, true)
      assert.equal(aRequests.length, count)
      evidence.offline = { actual_poll_and_heartbeat_stopped: true, stale_cutoff_seconds: 60, last_heartbeat: registered.last_heartbeat, stale_observed_at: new Date().toISOString(), node_id: nodeA.nodeId }
      return evidence.offline
    })
    await admin.post(`/api/v1/grants/${evidence.grant_a}/revoke`, {})
    await check('offline and revoked A retains history; terminal work cannot be polled or assigned again', async () => {
      const detail = await admin.get(`/api/v1/tickets/${readTicket.id}`)
      assert.equal(detail.status, 'succeeded')
      assert.deepEqual(detail.reports, originalSource.reports)
      assert.deepEqual(detail.artifacts, originalSource.artifacts)
      assert.equal((await download(readTicket.id, source.artifact.id)).content, source.content)
      assert.equal((await nodeB.pollAndRun()).status, 'idle')
      const after = await admin.post(`/api/v1/tickets/${readTicket.id}/retry`, {})
      assert.equal(after.assignments.length, 1)
      assert.equal(after.id, readTicket.id)
      await assert.rejects(() => nodeB.http.post('/api/v1/nodes/reports', {
        protocol: 'loom.node.v1', node_id: nodeB.nodeId, installation_id: nodeB.installationId,
        request_id: crypto.randomUUID(), ticket_id: readTicket.id, assignment_id: assignment(readTicket), lease_epoch: 1,
        requested_state: 'succeeded', summary: 'Cross-node Report injection must fail.', artifact_ids: [source.artifact.id], effects: [],
      }, { token: nodeB.identity.token }), (error) => error.status === 403 && error.code === 'assignment_owner')
      await assert.rejects(() => admin.post('/api/v1/tickets', {
        project_id: evidence.project_a, grant_id: evidence.grant_a, node_id: nodeA.nodeId, worker_id: 'worker-a',
        objective: 'Revoked Grant cannot create another read', kind: 'read_summary', relative_path: 'input.txt',
      }), (error) => error.status === 403 && error.code === 'grant_scope')
      assert.equal((await download(readTicket.id, source.artifact.id)).content, source.content)
      return { historical_reports_preserved: true, original_artifact_readable_and_verified: true, additional_assignments: 0, b_received_a_work: false, cross_node_report_rejected: 403, revoked_new_ticket_rejected: 403 }
    })
    let generatedPayload
    await check('verified A bytes produce the specified B edit_file JSON through the existing operator DTO', async () => {
      const fresh = await download(readTicket.id, source.artifact.id)
      const summary = JSON.parse(fresh.content)
      generatedPayload = {
        schema: 'loom.artifact_handoff.generated_payload.v1',
        source_artifact: {
          artifact_id: fresh.artifact.id, ticket_id: fresh.artifact.ticket_id,
          origin_node_id: fresh.artifact.origin_node_id, location: fresh.artifact.location,
          sha256: fresh.artifact.sha256, parents: fresh.artifact.lineage,
        },
        derived_summary: { path: summary.path, lines: summary.lines },
        operator_effect: 'edit_file', conversion: 'deterministic-verified-artifact-summary', no_model: true,
      }
      return { input_sha256_verified: fresh.artifact.sha256, source_artifact_id: fresh.artifact.id, ticket_b_will_use_existing_kind: 'edit_file', direct_host_transport: 'NOT IMPLEMENTED' }
    })
    await check('B writes only root B and emits an Artifact with actual A parents', async () => {
      await nodeB.client.heartbeat({
        capabilities: nodeB.capabilities, workers: [{ worker_id: 'worker-b' }],
        inventory: { project_roots: { [evidence.project_b]: rootB }, source: 'explicit_local_node_configuration' },
      })
      const onlineB = (await admin.get('/api/v1/nodes')).nodes.find((entry) => entry.id === nodeB.nodeId)
      assert.equal(onlineB.online, true)
      assert.equal(onlineB.freshness, 'fresh')
      writeTicket = await admin.post('/api/v1/tickets', {
        project_id: evidence.project_b, grant_id: evidence.grant_b, node_id: nodeB.nodeId, worker_id: 'worker-b',
        objective: 'Convert verified A Artifact to deterministic generated_payload JSON; no LLM', kind: 'edit_file',
        relative_path: 'handoff/generated_payload.json', content: JSON.stringify(generatedPayload, null, 2),
      })
      const fresh = await download(readTicket.id, source.artifact.id)
      assert.equal(fresh.content, source.content)
      nodeB.executor = new ReferencedArtifactExecutor({ artifactDir: join(root, 'node-b-artifacts'), projectRoots: { [evidence.project_b]: rootB } }, {
        artifact_id: fresh.artifact.id, sha256: fresh.artifact.sha256, origin_node_id: fresh.artifact.origin_node_id,
        parents: fresh.artifact.lineage, location: fresh.artifact.location, ticket_id: readTicket.id, type: 'artifact_ref', bytes: Buffer.from(fresh.content),
      })
      const bogusSource = {
        artifact_id: fresh.artifact.id, sha256: '0'.repeat(64), origin_node_id: fresh.artifact.origin_node_id,
        parents: [], location: fresh.artifact.location, ticket_id: readTicket.id,
        type: 'artifact_ref', bytes: Buffer.from(fresh.content),
      }
      const bad = () => new ReferencedArtifactExecutor({ artifactDir: join(root, 'unused-artifacts'), projectRoots: {} }, bogusSource)
      let rejected = false
      try {
        await bad().execute({ kind: 'edit_file', content: JSON.stringify(generatedPayload) }, {})
      } catch (error) {
        assert.equal(error.code, 'ERR_ASSERTION', JSON.stringify({ name: error.name, code: error.code, message: error.message }))
        assert.ok(error.message.includes(bogusSource.sha256) && error.message.includes(fresh.artifact.sha256), error.message)
        rejected = true
      }
      assert.equal(rejected, true, 'Forged source digest was accepted')
      const execution = await run(nodeB)
      assert.ok(execution.requestId)
      assert.equal(execution.assignmentId, writeTicket.assignments[0].id)
      const effectFile = await readFile(join(rootB, 'handoff/generated_payload.json'), 'utf8')
      assert.deepEqual(JSON.parse(effectFile), generatedPayload)
      assert.equal(sha256(effectFile), sha256(writeTicket.content))
      const beforeA = await readFile(join(rootA, 'input.txt'), 'utf8')
      assert.equal(beforeA, sourceText)
      assert.deepEqual(await readdir(rootA), ['input.txt'])
      const detail = await admin.get(`/api/v1/tickets/${writeTicket.id}`)
      assert.equal(detail.status, 'succeeded')
      assert.equal(detail.assignments.length, 1)
      assert.equal(detail.reports.length, 1)
      assert.equal(detail.effects.length, 1)
      assert.equal(detail.effects[0].status, 'confirmed')
      assert.equal(detail.artifacts.length, 1)
      const artifact = detail.artifacts[0]
      assert.equal(artifact.origin_node_id, nodeB.nodeId)
      assert.notEqual(artifact.origin_node_id, source.artifact.origin_node_id)
      assert.ok(Array.isArray(artifact.lineage), JSON.stringify(artifact))
      assert.equal(artifact.lineage.length, 1, JSON.stringify(artifact.lineage))
      const verifiedParent = artifact.lineage[0]
      assert.equal(verifiedParent.type, 'artifact_ref', JSON.stringify(artifact.lineage))
      assert.equal(verifiedParent.artifact_id, source.artifact.id)
      assert.equal(verifiedParent.origin_node_id, source.artifact.origin_node_id)
      assert.equal(verifiedParent.sha256, source.artifact.sha256)
      assert.equal(verifiedParent.component_sha256, artifact.sha256)
      assert.equal(verifiedParent.source_location, source.artifact.location)
      assert.equal(verifiedParent.source_ticket_id, readTicket.id)
      assert.deepEqual(verifiedParent.parents, source.artifact.lineage)
      assert.equal(verifiedParent.artifact_ref.artifact_id, source.artifact.id)
      assert.equal(verifiedParent.artifact_ref.sha256, source.artifact.sha256)
      assert.equal(verifiedParent.artifact_ref.origin_node_id, source.artifact.origin_node_id)
      // The canonical center reference has authoritative ID/SHA/origin; parents are a sibling field copied from that same immutable record.
      assert.deepEqual(verifiedParent.parents, source.artifact.lineage, JSON.stringify(verifiedParent))
      // The referenced immutable Artifact retains its own Ticket and parents in the independently fetched source record.
      assert.deepEqual(source.artifact.lineage, [])
      assert.deepEqual(originalSource.reports, (await admin.get(`/api/v1/tickets/${readTicket.id}`)).reports)
      const bDownload = await download(writeTicket.id, artifact.id)
      assert.equal(JSON.parse(bDownload.content).target_hash, sha256(writeTicket.content))
      assert.equal(JSON.parse(bDownload.content).target_hash, sha256(effectFile))
      assert.equal(JSON.parse(bDownload.content).path, 'handoff/generated_payload.json')
      assert.equal(JSON.parse(bDownload.content).operation, 'replaced_project_file')
      assert.deepEqual(JSON.parse(bDownload.content).generated_payload, generatedPayload)
      assert.deepEqual(JSON.parse(bDownload.content).verified_source, {
        schema: 'loom.synthetic_summary.v1', sha256: source.artifact.sha256, parents: [],
        bytes_base64: Buffer.from(source.content).toString('base64'),
      })
      assert.deepEqual(nodeB.state.data.assignments[assignment(writeTicket)].grant.operations, ['write'])
      assert.equal(nodeB.options.projectRoots[evidence.project_a], undefined)
      const bDelivery = nodeB.state.data.deliveries.find((entry) => entry.kind === 'artifact' && entry.body.ticket_id === writeTicket.id).body
      assert.deepEqual(bDelivery.metadata.parents, [source.artifact.id])
      assert.equal(bDelivery.metadata.artifact_ref.ticket_id, readTicket.id)
      assert.equal(bDelivery.metadata.artifact_ref.origin_node_id, nodeA.nodeId)
      assert.deepEqual(bDelivery.metadata.artifact_ref.parents, [])
      evidence.destination_artifact = {
        artifact_id: artifact.id, ticket_id: writeTicket.id, origin_node_id: artifact.origin_node_id,
        sha256: artifact.sha256, size_bytes: artifact.size_bytes, parents: artifact.lineage,
        submitted_provenance: { parents: bDelivery.metadata.parents, artifact_ref: bDelivery.metadata.artifact_ref },
        effect_id: detail.effects[0].id,
        report_request_id: nodeB.state.data.deliveries.find((entry) => entry.kind === 'report' && entry.body.ticket_id === writeTicket.id).body.request_id,
      }
      return evidence.destination_artifact
    })
    await check('B tamper cannot write root A, spoof Artifact SHA or replay completed work', async () => {
      assert.equal((await nodeB.pollAndRun()).status, 'idle')
      assert.equal((await nodeB.pollAndRun()).status, 'idle')
      assert.equal((await admin.get(`/api/v1/tickets/${writeTicket.id}`)).assignments.length, 1)
      await assert.rejects(() => nodeB.assertApprovedRoot(nodeB.state.data.assignments[assignment(writeTicket)], {
        ...nodeB.state.data.assignments[assignment(writeTicket)].grant, project_id: evidence.project_a, project_root: rootA,
      }), /does not match/)
      await assert.rejects(() => nodeB.executor.execute({ ...nodeB.state.data.assignments[assignment(writeTicket)], project_id: evidence.project_a },
        { ...nodeB.state.data.assignments[assignment(writeTicket)].grant, project_id: evidence.project_a, project_root: rootA }), /no exact local root/)
      await assert.rejects(() => nodeB.executor.execute({ ...nodeB.state.data.assignments[assignment(writeTicket)], content: '{"schema":"wrong"}' },
        nodeB.state.data.assignments[assignment(writeTicket)].grant), (error) => error.code === 'ERR_ASSERTION'
        && error.actual === 'wrong' && error.expected === 'loom.artifact_handoff.generated_payload.v1')
      return { completed_assignment_not_repeated: true, worker_b_root_a_effect_denied_before_write: true, missing_verified_parent_rejected: true }
    })
    const replayB = await check('B bytes and lineage survive immutable replay and mutation attempts', () => immutableReplay(nodeB, writeTicket.id))
    await check('bounded center transport and evidence do not leak credentials', async () => {
      assert.equal((await admin.get('/api/v1/audit/verify')).valid, true)
      const smallDownload = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, maxResponseBytes: 16 })
      await assert.rejects(() => smallDownload.get(`/api/v1/tickets/${writeTicket.id}/artifacts/${evidence.destination_artifact.artifact_id}`), /exceeds configured limit/)
      for (const node of [nodeA, nodeB]) assert.equal((await stat(node.options.stateDir)).isDirectory(), true)
      const serialized = JSON.stringify({ checks, evidence })
      for (const secret of secrets.filter(Boolean)) assert.equal(serialized.includes(secret), false)
      assert.ok(!/[rR]aw[_ -]?[tT]oken|inputSecret|private_key/.test(serialized), 'Evidence must not contain secret/private-key fields')
      return { audit_chain_valid: true, inline_artifact_limit_bytes: 8388608, http_body_limit_bytes: 16777216, direct_host_transport: 'NOT IMPLEMENTED', evidence_credentials_redacted: true }
    })
    return {
      schema: 'loom.artifact_handoff.evidence.v1', overall: 'PASS', started_at: startedAt, finished_at: new Date().toISOString(),
      scope: `Same single ${PLATFORM} host; two isolated logical Nodes, Installation identities, Ed25519 keys, state, artifact stores, Project roots, Workers and Grants. No physical second machine.`,
      physical_cross_machine: 'NOT TESTED', real_second_machine: false,
      milestone_scope: 'Supplemental to M0/M1; broader M2 and geo-distributed validation remain unfinished.',
      dsh_profile_or_host: 'NOT TOUCHED', live_llm: 'NOT RUN', model_calls: 0,
      transport: 'Real loopback HTTP through a foreground Rust Concierge; not a SyntheticCoordinator.',
      direct_host_transport: 'NOT IMPLEMENTED', inline_artifact_limit_bytes: 8388608,
      forge_protection: { a: replayA, b: replayB },
      projects: { a: evidence.project_a, b: evidence.project_b, roots: 'isolated temporary directories (paths intentionally omitted from evidence)' },
      node_a: { node_id: nodeA.nodeId, installation_id: nodeA.installationId, worker_id: 'worker-a', grant_id: evidence.grant_a, revocation: 'REVOKED AFTER READ' },
      node_b: { node_id: nodeB.nodeId, installation_id: nodeB.installationId, worker_id: 'worker-b', grant_id: evidence.grant_b, revocation: 'ACTIVE' },
      offline: evidence.offline, source_artifact: evidence.source_artifact, destination_artifact: evidence.destination_artifact,
      generated_payload: generatedPayload, checks,
    }
  } catch (error) {
    return failed(error)
  } finally { if (server) await server.stop() }
}

// A startup/shutdown failure is still FAIL, not an absent or fabricated PASS report.
let result
try {
  result = await runArtifactHandoff()
} catch (error) {
  result = { schema: 'loom.artifact_handoff.evidence.v1', overall: 'FAIL', error: error?.stack || String(error) }
} finally {
  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
}
console.log(JSON.stringify({ overall: result.overall, output: OUTPUT, error: result.error, checks: result.checks?.map(({ name, status }) => ({ name, status })) }, null, 2))
// Keep every failed result for a precise diagnosis; never remove it or relabel it as skipped.
if (result.overall !== 'PASS') {
  console.error(`Artifact handoff FAIL; inspect ${OUTPUT}`)
  process.exitCode = 1
}
