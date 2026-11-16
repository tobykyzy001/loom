import { createServer } from 'node:http'
import { createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { sha256, canonical, writeJsonAtomic } from '../../packages/node-client/src/util.js'

/** Synthetic, process-local protocol fixture. No claim this is the Rust server. */
export class SyntheticCoordinator {
  constructor({ root, clientToken = 'synthetic-coordinator-token', nodeToken = 'synthetic-node-token' }) {
    this.root = root; this.clientToken = clientToken; this.nodeToken = nodeToken
    this.nodes = new Map(); this.challenges = new Map(); this.enrollmentCodes = new Map()
    this.projects = new Map(); this.grants = new Map(); this.tickets = new Map(); this.assignments = new Map()
    this.outbox = new Map(); this.reports = new Map(); this.artifacts = new Map(); this.events = []; this.acks = []
  }
  async listen() {
    this.server = createServer((request, response) => void this.handle(request, response).catch((error) => {
      this.reply(response, error.status || 500, { error: { code: 'fixture_error', message: error.message } })
    }))
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    this.baseUrl = `http://127.0.0.1:${this.server.address().port}`
    return this.baseUrl
  }
  async close() { if (this.server) await new Promise((resolve) => this.server.close(resolve)) }
  async prepareProject(name) {
    const root = await mkdtemp(join(this.root, 'project-'))
    await writeFile(join(root, 'input.txt'), 'Synthetic input for deterministic fixture testing.\nNo model is involved.\n')
    const id = randomUUID(); const project = { id, name, mode: 'read_write', root }
    this.projects.set(id, project); return project
  }
  unused(bytes, limit) { if (bytes > limit) throw Object.assign(new Error('Request body too large'), { status: 413 }) }
  async handle(req, res) {
    const chunks = []; let length = 0
    for await (const chunk of req) { length += chunk.length; this.unused(length, 2_100_000); chunks.push(chunk) }
    const url = new URL(req.url, this.baseUrl || 'http://localhost')
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    let result, status = 200
    const publicRoute = url.pathname === '/api/v1/health' || url.pathname === '/api/v1/nodes/challenge' || url.pathname === '/api/v1/nodes/register'
    let identity = null
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
    if (!publicRoute) {
      if (bearer === this.clientToken) identity = { client: true }
      else {
        const node = [...this.nodes.values()].find((node) => node.token === bearer && !node.revoked)
        if (!node) throw Object.assign(new Error('Invalid or revoked credentials'), { status: 401 })
        identity = Object.assign(node, { node: true })
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/health') result = { ok: true, service: 'synthetic-loom-fixture', model_calls: 0 }
    else if (req.method === 'POST' && url.pathname === '/api/v1/nodes/challenge') {
      this.validatePublic(body)
      const nonce = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
      const id = randomUUID(); this.challenges.set(id, { ...body, nonce })
      result = { challenge_id: id, nonce, expires_at: new Date(Date.now() + 60000).toISOString() }
    } else if (req.method === 'POST' && url.pathname === '/api/v1/nodes/register') result = this.register(body, identity)
    else if (req.method === 'POST' && url.pathname === '/api/v1/enrollment-codes') {
      this.requireClient(identity); const code = randomUUID(); this.enrollmentCodes.set(sha256(code), Date.now() + 60000); result = { code, enrollment_code: code }
    } else if (req.method === 'POST' && url.pathname === '/api/v1/projects') {
      this.requireClient(identity); const id = randomUUID(); const root = await mkdtemp(join(this.root, 'project-'))
      await writeFile(join(root, 'input.txt'), 'Synthetic input for deterministic fixture testing.\n')
      const project = { id, name: body.name, mode: body.mode, root }; this.projects.set(id, project)
      result = { ...project, root: undefined }
    } else if (req.method === 'POST' && url.pathname === '/api/v1/grants') { this.requireClient(identity); result = this.makeGrant(body) }
    else if (req.method === 'POST' && url.pathname.endsWith('/revoke')) {
      this.requireClient(identity); const id = url.pathname.split('/').at(-2)
      const grant = this.grants.get(id); if (!grant) throw Object.assign(new Error('No such Grant'), { status: 404 })
      grant.revoked_at ||= new Date().toISOString(); grant.version += 1; result = grant
    } else if (req.method === 'POST' && url.pathname === '/api/v1/tickets') { this.requireClient(identity); result = this.makeTicket(body) }
    else if (req.method === 'POST' && url.pathname.endsWith('/cancel')) {
      this.requireClient(identity); const id = url.pathname.split('/').at(-2); const ticket = this.tickets.get(id)
      if (!ticket) throw Object.assign(new Error('No such ticket'), { status: 404 })
      ticket.cancel_requested = true; ticket.status = 'cancelled'
      for (const a of this.assignments.values()) if (a.ticket_id === id) result = { ...a, cancel_requested: true }
      result = result || ticket
    } else if (req.method === 'POST' && url.pathname === '/api/v1/nodes/heartbeat') {
      this.requireNode(body, identity); identity.heartbeat = body.status; result = { accepted: true, heartbeat_received_at: new Date().toISOString() }
    } else if (req.method === 'POST' && url.pathname === '/api/v1/nodes/assignments/poll') { this.requireNode(body, identity); result = this.poll(identity, body) }
    else if (req.method === 'POST' && url.pathname === '/api/v1/nodes/reports') result = this.report(body, identity)
    else if (req.method === 'POST' && url.pathname === '/api/v1/nodes/artifacts') result = this.artifact(body, identity)
    else if (req.method === 'POST' && url.pathname === '/api/v1/nodes/events') {
      this.requireNode(body, identity); this.events.push(body); result = { accepted: true }
    } else if (req.method === 'POST' && url.pathname === '/api/v1/nodes/acknowledge') {
      this.requireNode(body, identity); this.acks.push(body); result = { accepted: true }
    } else if (req.method === 'GET' && url.pathname === '/api/v1/tickets') { this.requireClient(identity); result = { tickets: [...this.tickets.values()] } }
    else if (req.method === 'GET' && /^\/api\/v1\/tickets\/[^/]+$/.test(url.pathname)) {
      this.requireClient(identity); result = this.tickets.get(url.pathname.split('/').at(-1)); if (!result) throw Object.assign(new Error('Not found'), { status: 404 })
    } else if (req.method === 'GET' && url.pathname.includes('/artifacts/')) {
      this.requireClient(identity); const stored = this.artifacts.get(url.pathname.split('/').at(-1)); if (!stored) throw Object.assign(new Error('Not found'), { status: 404 }); result = stored
    } else throw Object.assign(new Error('Unknown synthetic route'), { status: 404 })
    this.reply(res, status, result)
  }
  reply(res, status, data) { const bytes = Buffer.from(JSON.stringify(data)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length }); res.end(bytes) }
  requireClient(identity) { if (!identity?.client) throw Object.assign(new Error('Coordinator requires its own client token'), { status: 401 }) }
  validatePublic(body) {
    if (body.protocol !== 'loom.node.v1' || !/^[a-f0-9]{64}$/.test(body.node_id || '') || sha256(Buffer.from(body.public_key, 'base64url')) !== body.node_id || !body.installation_id) {
      throw Object.assign(new Error('Invalid node identity'), { status: 400 })
    }
  }
  register(body, identity) {
    this.validatePublic(body)
    const existing = this.nodes.get(body.node_id)
    if (existing?.revoked) throw Object.assign(new Error('Node revoked'), { status: 403 })
    if (!existing && !this.enrollmentCodes.delete(sha256(body.enrollment_code || ''))) throw Object.assign(new Error('Enrollment code is invalid or reused'), { status: 401 })
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(body.public_key, 'base64url')]), format: 'der', type: 'spki' })
    if (!verify(null, Buffer.from(body.nonce, 'utf8'), publicKey, Buffer.from(body.signed_challenge, 'base64url'))) throw Object.assign(new Error('Invalid proof of possession'), { status: 401 })
    if (!existing) this.nodes.set(body.node_id, { ...body, token: this.nodeToken + '-' + randomUUID() })
    const node = this.nodes.get(body.node_id); return { ...body, token: node.token, node_token: node.token, node_id: body.node_id }
  }
  requireNode(body, identity) {
    if (!identity || identity.client || identity.node_id !== body.node_id || identity.installation_id !== body.installation_id || body.protocol !== 'loom.node.v1') throw Object.assign(new Error('Node identity mismatch / revoked token'), { status: 403 })
  }
  makeGrant(body) {
    const project = this.projects.get(body.project_id); if (!project) throw Object.assign(new Error('No such project'), { status: 404 })
    const grant = { id: randomUUID(), version: 1, project_id: body.project_id, project_root: project.root,
      operations: body.operations || ['read_summary', 'edit_file'], expires_at: null, revoked_at: null }
    grant.digest = sha256(canonical(grant)); this.grants.set(grant.id, grant); return grant
  }
  makeTicket(body) {
    const ticket = { id: randomUUID(), project_id: body.project_id, objective: body.objective, status: 'pending', cancel_requested: false }
    this.tickets.set(ticket.id, ticket); return ticket
  }
  async handleClient() {}
  async dispatchTicket(ticketId, nodeId, details = {}) {
    const ticket = this.tickets.get(ticketId); const grant = [...this.grants.values()].find((item) => item.project_id === ticket.project_id)
    if (!grant || grant.revoked_at) throw Object.assign(new Error('No active Grant'), { status: 409 })
    const assignment = { id: randomUUID(), ticket_id: ticketId, node_id: nodeId, installation_id: this.nodes.get(nodeId).installation_id,
      worker_id: 'local-fixture-worker', lease_id: randomUUID(), lease_epoch: 1, lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      attempt: 1, grant_version: grant.version, grant_digest: grant.digest, grant, kind: details.kind, relative_path: details.relative_path,
      content: details.content, project_id: ticket.project_id }
    this.assignments.set(assignment.id, assignment); this.outbox.set(nodeId, assignment); ticket.status = 'running'; return assignment
  }
  poll(identity) {
    const active = this.outbox.get(identity.node_id)
    if (active) return { assignment: active }
    for (const assignment of this.assignments.values()) if (assignment.node_id === identity.node_id && this.tickets.get(assignment.ticket_id)?.cancel_requested) return { assignment: { ...assignment, cancel_requested: true } }
    return { assignment: null }
  }
  report(body, identity) {
    this.requireNode(body, identity)
    const assignment = this.assignments.get(body.assignment_id)
    if (!assignment || assignment.ticket_id !== body.ticket_id || assignment.lease_epoch !== body.lease_epoch) throw Object.assign(new Error('Invalid assignment or lease'), { status: 409 })
    const grant = [...this.grants.values()].find((item) => item.digest === assignment.grant_digest)
    if (grant.revoked_at || grant.version > assignment.grant_version) throw Object.assign(new Error('Revoked or superseded Grant fences report'), { status: 409 })
    const digest = sha256(canonical(body)); const previous = this.reports.get(body.assignment_id)
    if (previous) {
      if (previous.digest !== digest) throw Object.assign(new Error('Idempotent callback has different content'), { status: 409 })
      return { accepted: true, duplicate: true }
    }
    this.reports.set(body.assignment_id, { ...body, digest }); const ticket = this.tickets.get(body.ticket_id)
    ticket.reports ||= []; ticket.reports.push(body)
    if (!ticket.cancel_requested) ticket.status = body.requested_state === 'unknown' ? 'reconciling' : body.requested_state
    this.outbox.delete(identity.node_id); return { accepted: true, duplicate: false }
  }
  artifact(body, identity) {
    this.requireNode(body, identity)
    const assignment = this.assignments.get(body.assignment_id)
    if (!assignment || assignment.ticket_id !== body.ticket_id || body.metadata.size_bytes !== Buffer.from(body.bytes_base64, 'base64').length
      || body.metadata.sha256 !== sha256(Buffer.from(body.bytes_base64, 'base64'))) throw Object.assign(new Error('Artifact is unknown or bytes/hash mismatch'), { status: 422 })
    this.artifacts.set(body.artifact_id, { ...body, artifact_id: body.artifact_id, location: `synthetic-host://artifact/${body.artifact_id}` })
    const ticket = this.tickets.get(body.ticket_id); ticket.artifacts ||= []
    if (!ticket.artifacts.some((other) => other.artifact_id === body.artifact_id)) ticket.artifacts.push(this.artifacts.get(body.artifact_id))
    return { accepted: true }
  }
  async handleClient() {}
}
