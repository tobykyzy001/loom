import { createPublicKey, sign as signKey, verify as verifyKey } from 'node:crypto'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { isIPv4, isIPv6 } from 'node:net'
import { canonical, sha256, readJson, writeJsonAtomic } from './util.js'
import { envelope } from './validation.js'
import { ControlledFileExecutor } from './executor.js'

export const DIRECT_SCHEMA = 'loom.direct-offer.v1'
export const DIRECT_BYTE_LIMIT = 1_048_576

const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a bounded object`)
  return value
}
const str = (value, name, length = 256) => {
  if (typeof value !== 'string' || !value.length || value.length > length) throw new Error(`${name} must be non-empty bounded text`)
  return value
}
const hash = (value, name) => { if (str(value, name) && !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256`) ; return value }
const nodeId = (value, name) => hash(value, name)
const uuid = (value, name) => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(str(value, name))) throw new Error(`${name} must be a UUID`); return value }
const reference = (value) => {
  const source = object(value, 'artifact_ref')
  const result = {
    ...source, type: 'artifact_ref', artifact_id: uuid(source.artifact_id, 'artifact_ref.artifact_id'),
    ticket_id: str(source.ticket_id, 'artifact_ref.ticket_id'), sha256: hash(source.sha256, 'artifact_ref.sha256'),
    origin_node_id: nodeId(source.origin_node_id, 'artifact_ref.origin_node_id'), location: str(source.location, 'artifact_ref.location'),
    parents: source.parents ?? [],
  }
  if (!Array.isArray(source.parents) || source.parents.length > 64 || result.location !== `loom://artifact/${result.artifact_id}`) throw new Error('Artifact lineage must use only bounded immutable references')
  return Object.freeze(result)
}
export function directChallenge(offer) {
  const input = object(offer, 'DirectOffer')
  if (input.schema !== DIRECT_SCHEMA || input.protocol !== 'loom.node.v1') throw new Error('DirectOffer protocol version is unsupported')
  // Every mutable recipient/stop/scope fact in this signed statement is validated before use.
  const fields = {
    schema: DIRECT_SCHEMA, protocol: 'loom.node.v1',
    offer_id: str(input.offer_id, 'DirectOffer.offer_id'), nonce: hash(input.nonce, 'DirectOffer.nonce'),
    artifact_ref: reference(input.artifact_ref), artifact_id: input.artifact_id, artifact_sha256: input.artifact_sha256,
    source_ticket_id: str(input.source_ticket_id, 'DirectOffer.source_ticket_id'), origin_node_id: nodeId(input.origin_node_id, 'DirectOffer.origin_node_id'),
    source_installation_id: str(input.source_installation_id, 'DirectOffer.source_installation_id'),
    source_worker_id: str(input.source_worker_id, 'DirectOffer.source_worker_id'),
    recipient_node_id: nodeId(input.recipient_node_id, 'DirectOffer.recipient_node_id'),
    recipient_installation_id: str(input.recipient_installation_id, 'DirectOffer.recipient_installation_id'),
    recipient_worker_id: str(input.recipient_worker_id, 'DirectOffer.recipient_worker_id'),
    ticket_id: str(input.ticket_id, 'DirectOffer.ticket_id'), assignment_id: str(input.assignment_id, 'DirectOffer.assignment_id'),
    lease_id: str(input.lease_id, 'DirectOffer.lease_id'), lease_epoch: input.lease_epoch, expires_at: input.expires_at,
    source_binding_id: str(input.source_binding_id, 'DirectOffer.source_binding_id'), destination_binding_id: str(input.destination_binding_id, 'DirectOffer.destination_binding_id'),
    source_grant_id: str(input.source_grant_id, 'DirectOffer.source_grant_id'), destination_grant_id: str(input.destination_grant_id, 'DirectOffer.destination_grant_id'),
    source_grant_version: input.source_grant_version, destination_grant_version: input.destination_grant_version,
    size_bytes: input.size_bytes, media_type: input.media_type, byte_limit: DIRECT_BYTE_LIMIT,
  }
  if (!Number.isSafeInteger(fields.lease_epoch) || fields.lease_epoch <= 0
    || !Number.isSafeInteger(fields.size_bytes) || fields.size_bytes <= 0 || fields.size_bytes > DIRECT_BYTE_LIMIT
    || !Number.isSafeInteger(fields.source_grant_version) || fields.source_grant_version <= 0
    || !Number.isSafeInteger(fields.destination_grant_version) || fields.destination_grant_version <= 0
    || fields.artifact_id !== fields.artifact_ref.artifact_id || fields.artifact_sha256 !== fields.artifact_ref.sha256
    || fields.origin_node_id === fields.recipient_node_id
    || str(fields.expires_at, 'DirectOffer.expires_at') && !Number.isFinite(Date.parse(fields.expires_at))) throw new Error('DirectOffer has inconsistent immutable Artifact or Lease fields')
  return canonical(fields)
}
export function signDirectOffer(identity, offer) {
  return signKey(null, Buffer.from(directChallenge(offer)), { key: Buffer.from(identity.data.private_key_pkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
    .toString('base64url')
}
const edKey = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64url')]), format: 'der', type: 'spki' })
const error = (status, code, message) => Object.assign(new Error(message), { status, code })
export function validateDirectEndpoint(authority) {
  const url = new URL(authority)
  if (url.protocol !== 'http:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Direct peer transport supports only a bare operator-owned http loopback authority')
  }
  try {
    const address = url.hostname.replace(/^\[|\]$/g, '')
    if (!((isIPv4(address) && address === '127.0.0.1') || (isIPv6(address) && address === '::1'))) throw new Error('Direct peer transport is explicitly loopback-only until a TLS design is proven')
    return url.origin
  } catch { /* non-IP forms below are refused rather than resolved or scanned */ }
  throw new Error('Direct peer endpoint must be a numeric 127.0.0.1 or ::1 loopback address (hostname resolution is not used)')
}

/** Direct fetch only calls this fresh handler, never coordinator/admin byte routes. */
export function sourceOfferQuestion({ node, http, offer }) {
  return http.post('/api/v1/nodes/direct-offers/scope', {
    ...envelope(node, randomUUID()), artifact_ref: offer.artifact_ref,
    artifact_id: offer.artifact_id, sha256: offer.artifact_sha256,
    source_ticket_id: offer.source_ticket_id, origin_node_id: offer.origin_node_id,
    nonce: offer.nonce, recipient_node_id: offer.recipient_node_id,
    recipient_installation_id: offer.recipient_installation_id, recipient_worker_id: offer.recipient_worker_id,
    ticket_id: offer.ticket_id, assignment_id: offer.assignment_id, lease_id: offer.lease_id,
  }, { token: node.identity.token })
}
export class LoopbackArtifactOfferServer {
  constructor({ identity, offer, bytes, root, sourceGrantCurrent, nonceFile, now = () => Date.now() }) {
    if (typeof sourceGrantCurrent !== 'function') throw new Error('A real current SourceGrant proof function is required, not a default always-true grant')
    this.identity = identity
    this.nonceFile = nonceFile
    directChallenge(offer)
    if (offer.media_type !== 'application/json' || offer.transport !== 'loopback-explicit-configuration') {
      throw new Error('Only loopback JSON proof artifacts can be offered by this experiment')
    }
    if (typeof offer.source_public_key !== 'string' || typeof offer.recipient_public_key !== 'string' || offer.recipient_node_id.length !== 64 || offer.source_public_key.length < 1 || offer.recipient_public_key.length < 1) throw new Error('Trusted public keys must come from coordinator issuance')
    if (sha256(Buffer.from(offer.recipient_public_key, 'base64url')) !== offer.recipient_node_id) throw new Error('Trusted recipient key does not match recipient identity')
    if (sha256(Buffer.from(offer.source_public_key, 'base64url')) !== identity.nodeId) throw new Error('Trusted source key is not this actual Node A')
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > DIRECT_BYTE_LIMIT || bytes.length !== offer.size_bytes
      || sha256(bytes) !== offer.artifact_sha256) throw new Error('Source object hash and content differ')
    this.offer = offer; this.bytes = bytes; this.used = new Set(); this.requests = []; this.now = now
    this.sourceGrantCurrent = sourceGrantCurrent
    if (!isAbsolute(root || '') || resolve(root) === sep || !isAbsolute(nonceFile)
      || resolve(nonceFile) === resolve(root)) throw new Error('An explicit private SourceArtifact/State root is required')
    this.root = root; this.closed = false; this.consumes = new Map()
  }
  async start() {
    const used = await readJson(this.nonceFile, [])
    if (!Array.isArray(used) || used.some((entry) => typeof entry !== 'string' || !/^[a-f0-9]{64}$/.test(entry))) throw new Error('Invalid persisted offer nonce ledger')
    this.used = new Set(used)
    this.server = createServer((req, res) => void this.handle(req, res).catch((err) => this.reply(res, err.status || 500, err.code || 'source_error')))
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${this.server.address().port}`
  }
  reply(res, status, code = null) {
    const body = code ? JSON.stringify({ error: { code, message: code } }) : this.bytes
    res.writeHead(status, { 'content-type': code ? 'application/json' : this.offer.media_type,
      'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' })
    res.end(body)
  }
  async handle(req, res) {
    if (this.closed) throw error(410, 'source_offline')
    const chunks = []; let length = 0
    for await (const chunk of req) { length += chunk.length; if (length > 16384 || chunks.length > 4) throw error(413, 'request_body_limit') ; chunks.push(chunk) }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const responseRequested = req.method === 'POST' && req.url === `/api/v1/direct/artifacts/${this.offer.artifact_id}`
    if (!responseRequested) throw error(404, 'not_found')
    if (body.schema !== DIRECT_SCHEMA || body.offer_id !== this.offer.offer_id || body.nonce !== this.offer.nonce) throw error(403, 'unknown_offer_nonce')
    if (body.recipient_node_id !== this.offer.recipient_node_id || body.recipient_installation_id !== this.offer.recipient_installation_id
      || body.recipient_worker_id !== this.offer.recipient_worker_id || body.ticket_id !== this.offer.ticket_id
      || body.assignment_id !== this.offer.assignment_id || body.lease_id !== this.offer.lease_id || body.lease_epoch !== this.offer.lease_epoch) throw error(403, 'wrong_recipient_or_lease')
    if (body.origin_node_id !== this.offer.origin_node_id || body.source_ticket_id !== this.offer.source_ticket_id) throw error(403, 'artifact_owner_mismatch')
    if (!Number.isSafeInteger(body.lease_epoch) || body.lease_epoch !== this.offer.lease_epoch) throw error(403, 'stale_lease')
    if (this.now() >= Date.parse(this.offer.expires_at)) throw error(410, 'offer_expired')
    if (this.used.has(body.nonce)) throw error(409, 'offer_nonce_consumed')
    const key = edKey(this.offer.recipient_public_key)
    if (!verifyKey(null, Buffer.from(directChallenge(this.offer)), key, Buffer.from(str(body.signature, 'DirectOffer.signature', 128), 'base64url'))) throw error(403, 'recipient_signature_invalid')
    const identityMatches = this.identity.nodeId === this.offer.origin_node_id && this.identity.installationId === this.offer.source_installation_id
    const currentScope = await this.sourceGrantCurrent(body).catch(() => null)
    if (!currentScope) throw error(403, 'source_grant_denied')
    if (this.consumes.has(body.nonce)) throw error(409, 'offer_nonce_consumed')
    const pending = (async () => {
      if (this.used.has(body.nonce)) throw error(409, 'offer_nonce_consumed')
      this.used.add(body.nonce)
      await writeJsonAtomic(this.nonceFile, [...this.used].slice(-32))
      this.requests.push({ artifact_id: body.artifact_id, offer_id: body.offer_id,
        recipient_node_id: body.recipient_node_id, signature_valid: identityMatches, nonce_consumed: true })
      return true
    })()
    this.consumes.set(body.nonce, pending)
    try { await pending; this.reply(res, 200) }
    catch (cause) { if (cause.status === 409) throw cause; throw error(503, 'source_nonce_persistence_failed') }
    finally { this.consumes.delete(body.nonce) }
  }
  async stop() { this.closed = true; if (this.server) await new Promise((resolve) => this.server.close(resolve)) }
}

/** Source is already controller-issued; local Source Grant remains the sole path permission. */
export async function loadOfferSource({ assignment, nodeId, artifactDir, root, maxBytes = DIRECT_BYTE_LIMIT }) {
  if (assignment.artifact_input?.direct_offer !== true) throw new Error('Only explicit direct pipeline Assignment is permitted to read a local peer artifact')
  const source = reference(assignment.artifact_input.artifact_ref)
  if (source.origin_node_id !== nodeId) throw new Error('Assignment Artifact origin does not match this producer Node')
  if (source.ticket_id === undefined) throw new Error('Source Artifact needs an immutable producer Ticket')
  const base = await realpath(artifactDir)
  if (!isAbsolute(root) || resolve(root) === sep || base !== await realpath(root)) throw new Error('Explicit artifact retention root required')
  const location = join(base, `${source.artifact_id}.bin`)
  if (location !== join(base, `${source.artifact_id}.bin`)) throw new Error('Unexpected artifact filename')
  const info = await lstat(location)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > maxBytes) throw new Error('Only one bounded ordinary local retained source Artifact may be offered')
  const bytes = await readFile(location)
  if (sha256(bytes) !== source.sha256) throw new Error('Retained source bytes hash differs from the immutable Artifact')
  return { source, bytes }
}

export function trimExact(text) { return text.trim() }

/** Verifies all scope before filename creation; ordinary Executor still owns root/path/write/Effect. */
export class DirectArtifactExecutor {
  constructor({ baseOptions, fetch = globalThis.fetch, now = () => Date.now(), currentOffer }) {
    this.base = new ControlledFileExecutor(baseOptions); this.fetch = fetch; this.now = now; this.currentOffer = currentOffer
  }
  async execute(assignment, grant) {
    if (assignment.kind !== 'edit_file' || assignment.artifact_input?.direct_offer !== true
      || assignment.artifact_input?.artifact_ref?.artifact_id === assignment.ticket_id || assignment.artifact_input?.transform !== 'trim') {
      throw new Error('Only one explicitly authorized direct trim handoff is supported')
    }
    if (grant.revoked_at || !grant.operations?.includes('write')) throw error(403, 'destination_grant_not_current')
    const issued = await this.currentOffer({ ticketId: assignment.ticket_id, artifactId: assignment.artifact_input.artifact_ref.artifact_id })
    const offer = object(issued.direct_offer, 'DirectOffer response')
    if (offer.ticket_id !== assignment.ticket_id || offer.assignment_id !== assignment.id || offer.lease_id !== assignment.lease_id
      || offer.lease_epoch !== assignment.lease_epoch || offer.recipient_node_id !== assignment.node_id
      || offer.recipient_installation_id !== assignment.installation_id || offer.recipient_worker_id !== assignment.worker_id) throw error(403, 'recipient_assignment_scope')
    const ref = reference(offer.artifact_ref)
    if (canonical(ref) !== canonical(reference(assignment.artifact_input.artifact_ref))
      || offer.artifact_id !== ref.artifact_id || offer.artifact_sha256 !== ref.sha256
      || offer.origin_node_id !== ref.origin_node_id || offer.source_ticket_id !== ref.ticket_id) throw error(403, 'parent_reference_mismatch')
    if (Date.parse(offer.expires_at) <= this.now()) throw error(410, 'offer_expired')
    if (typeof issued.endpoint !== 'string') throw new Error('DirectOffer has no fresh explicit endpoint; source is not locatable or is offline')
    const endpoint = validateDirectEndpoint(issued.endpoint)
    const signature = signDirectOffer(issued.identity, offer)
    const request = { schema: DIRECT_SCHEMA, offer_id: offer.offer_id, nonce: offer.nonce,
      artifact_id: offer.artifact_id, origin_node_id: offer.origin_node_id, source_ticket_id: offer.source_ticket_id,
      recipient_node_id: offer.recipient_node_id, recipient_installation_id: offer.recipient_installation_id,
      recipient_worker_id: offer.recipient_worker_id, ticket_id: offer.ticket_id, assignment_id: offer.assignment_id,
      lease_id: offer.lease_id, lease_epoch: offer.lease_epoch, signature }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('direct source offline/timeout')), 3000)
    let response
    try { response = await this.fetch(`${endpoint}/api/v1/direct/artifacts/${offer.artifact_id}`, { method: 'POST',
      signal: controller.signal, headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(request), redirect: 'error' })
    } catch (cause) { throw error(503, 'source_offline_no_borrow') }
    finally { clearTimeout(timer) }
    if (response.status === 403) throw error(403, 'direct_challenge_or_grant_denied')
    if (response.status === 410 || response.status === 409) throw error(423, 'offer_replayed_or_expired')
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json'
      || response.headers.get('x-content-type-options') !== 'nosniff' || response.headers.get('content-encoding')) throw error(502, 'invalid_direct_response')
    const length = Number(response.headers.get('content-length'))
    if (!Number.isSafeInteger(length) || length !== offer.size_bytes || length <= 0 || length > DIRECT_BYTE_LIMIT) throw error(502, 'source_size_mismatch')
    const chunks = []
    let received = 0
    if (!response.body) throw error(502, 'source_body_missing')
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > DIRECT_BYTE_LIMIT || received > length) {
        await response.body.cancel().catch(() => {})
        throw error(502, 'source_response_limit')
      }
      chunks.push(Buffer.from(chunk))
    }
    const bytes = Buffer.concat(chunks, received)
    if (received > DIRECT_BYTE_LIMIT || received !== length) throw error(502, 'source_response_limit')
    if (sha256(bytes) !== offer.artifact_sha256 || bytes.length !== offer.size_bytes) throw error(502, 'source_sha256_mismatch')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const content = trimExact(text)
    // Feed the *verified* bounded bytes to the normal existing controlled input path, not an arbitrary local file.
    const nextAssignment = { ...assignment, content,
      artifact_input: { artifact_ref: ref, bytes_base64: bytes.toString('base64') } }
    const result = await this.base.execute(nextAssignment, grant)
    result.artifact.metadata.parents = [ref.artifact_id]
    result.artifact.metadata.artifact_ref = ref
    result.summary = 'Direct source bytes verified by Ed25519-challenged loopback handoff and written under the existing B Grant.'
    return result
  }
}
