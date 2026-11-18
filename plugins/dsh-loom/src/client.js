import { LoomHttpClient } from './http.js'
import { id, canonical, sha256 } from './util.js'
import { envelope, nonNegative, validateStatus } from './validation.js'

const ACK_ROUTE = '/api/v1/nodes/acknowledge'
const ACK_DENIED = new Set([400, 401, 403, 409, 410, 422])

function validAcknowledgement(response) {
  return response !== null && typeof response === 'object' && !Array.isArray(response)
    && response.accepted === true
    && typeof response.acknowledged_at === 'string' && response.acknowledged_at.length > 0
    && Number.isFinite(Date.parse(response.acknowledged_at))
    && (!('duplicate' in response) || typeof response.duplicate === 'boolean')
}

export class LoomNodeClient {
  constructor({ http, identity, state }) {
    if (!(http instanceof LoomHttpClient) || !identity || !state) throw new TypeError('http, identity and durable state are required')
    this.http = http; this.identity = identity; this.state = state
    this.acknowledgementInflight = new Map()
  }
  get nodeId() { return this.identity.nodeId }
  get installationId() { return this.identity.data.installation_id }
  async enroll({ enrollmentCode, capabilities, workerId = 'local-fixture-worker', harnessKind = 'local-fixture', profileId = 'isolated', signal } = {}) {
    const challenge = await this.http.post('/api/v1/nodes/challenge', this.identity.public, { signal, noAuth: true })
    const body = { ...this.identity.public, enrollment_code: enrollmentCode, nonce: challenge.nonce,
      signed_challenge: this.identity.sign(challenge.nonce), request_id: id(), capabilities, worker_id: workerId,
      harness_kind: harnessKind, profile_id: profileId }
    const response = await this.http.post('/api/v1/nodes/register', body,
      { ...(this.identity.token ? { token: this.identity.token } : { noAuth: true }), signal })
    await this.identity.setToken(response)
    return response
  }
  async heartbeat({ status = 'online', capabilities, workers = [], inventory, signal } = {}) {
    return this.http.post('/api/v1/nodes/heartbeat', { ...envelope(this, id()), status: validateStatus(status),
      capabilities, workers, ...(inventory ? { inventory } : {}), timestamp: new Date().toISOString() }, { token: this.identity.token, signal })
  }
  async poll({ lastAssignmentId = null, waitSeconds = 1, signal } = {}) {
    nonNegative(waitSeconds, 'waitSeconds', 60)
    const response = await this.http.post('/api/v1/nodes/assignments/poll', { ...envelope(this, id()),
      last_assignment_id: lastAssignmentId, wait_seconds: waitSeconds }, { token: this.identity.token, signal,
      timeoutMs: Math.max(this.http.timeoutMs, waitSeconds * 1000 + 10_000) })
    if (response !== null && (typeof response !== 'object' || !('assignment' in response))) {
      throw new Error('Poll response must contain an assignment property (including null)')
    }
    return response.assignment
  }
  async event({ ticketId, assignmentId, leaseEpoch, sessionRef, kind = 'progress', summary, signal }) {
    const body = { ...envelope(this, id()), ...(ticketId ? { ticket_id: ticketId } : {}),
      ...(assignmentId ? { assignment_id: assignmentId } : {}), ...(leaseEpoch === undefined ? {} : { lease_epoch: leaseEpoch }),
      ...(sessionRef ? { session_ref: sessionRef } : {}), kind, content: summary, activity: summary }
    return this.state.enqueue('event', body, { digest: this.logicalDigest(body) })
  }
  async report({ ticketId, assignmentId, leaseEpoch, state: requestedState, summary,
    evidence = [], artifacts = [], artifactIds = [], effects = [], cancelAcknowledged = false, signal }) {
    if (!['running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(requestedState)) throw new TypeError('Invalid report state')
    const ids = [...artifactIds, ...artifacts.map((entry) => typeof entry === 'string' ? entry : entry?.artifact_id).filter(Boolean)]
    const artifact_ids = [...new Set(ids)]
    if (!artifact_ids.every((entry) => typeof entry === 'string' && entry.length > 0)) {
      throw new TypeError('Every artifact reference needs a stable non-empty UUID string')
    }
    const body = { ...envelope(this, id()), ticket_id: ticketId, assignment_id: assignmentId, lease_epoch: leaseEpoch,
      requested_state: requestedState, summary, evidence, artifact_ids, effects,
      ...(cancelAcknowledged ? { cancel_acknowledged: true } : {}) }
    if (leaseEpoch === undefined) delete body.lease_epoch
    const digest = this.logicalDigest(body)
    // An identical immutable receipt keeps its identity across a durable reopen.
    // Changed results/effects yield a different digest and cannot borrow this receipt.
    body.request_id = digest
    return this.state.enqueue('report', body, { digest })
  }
  async artifact({ ticketId, artifactId, assignmentId, leaseEpoch, metadata, bytes, signal }) {
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const sha256 = (await import('node:crypto')).createHash('sha256').update(content).digest('hex')
    const body = { ...envelope(this, id()), ticket_id: ticketId, artifact_id: artifactId, assignment_id: assignmentId,
      ...(leaseEpoch === undefined ? {} : { lease_epoch: leaseEpoch }),
      metadata: { ...metadata, size_bytes: content.length, sha256 }, bytes_base64: content.toString('base64') }
    const digest = this.logicalDigest(body)
    // Identical immutable bytes/metadata map to the same receipt, never a new upload ID.
    body.request_id = digest
    return this.state.enqueue('artifact', body, { digest })
  }
  logicalDigest(body) {
    const { request_id, ...rest } = body
    return sha256(canonical({ logical_fields: rest }))
  }
  async acknowledge({ ticketId, assignmentId, leaseEpoch, accepted, reason = '', cancelRequested = false, cancellation = false, signal }) {
    const stop = Boolean(cancelRequested || cancellation)
    const body = { ...envelope(this, id()), ticket_id: ticketId, assignment_id: assignmentId,
      ...(leaseEpoch === undefined ? {} : { lease_epoch: leaseEpoch }), accepted: Boolean(accepted),
      reason, cancel_requested: stop, cancellation: stop }
    // Preserve the pre-existing stop/cancel protocol exactly. In particular,
    // revocable stop qualification can require a persisted original ACK timestamp;
    // marking-cancelling only fields must never be replayed as ordinary admission.
    if (stop) {
      const response = await this.http.post(ACK_ROUTE, body, { token: this.identity.token, signal })
      return { request: body, response }
    }
    const digest = this.logicalDigest(body)
    const delivered = this.state.data.deliveries?.find((item) => item.kind === 'ack' && item.digest === digest)
    if (delivered && canonical({ ...delivered.body, request_id: body.request_id }) === canonical(body)
      && typeof delivered.body.request_id === 'string' && delivered.body.request_id.length > 0
      && validAcknowledgement(delivered.response)) {
      return { request: structuredClone(delivered.body), response: { ...structuredClone(delivered.response), duplicate: true } }
    }
    const item = await this.state.enqueue('ack', body, { digest })
    const current = this.state.data.outbox.find((other) => other.kind === 'ack' && other.digest === digest)
    if (current && current.body.request_id !== body.request_id) body.request_id = current.body.request_id
    try {
      return await this.postAcknowledgement(item, { signal })
    } catch (error) {
      if (ACK_DENIED.has(error?.status) || (error?.status >= 200 && error.status < 500)) throw error
      // A network loss/unknown server outcome may already have committed the original
      // admission. The durable intent is not itself a receipt or new execution authority.
      return { request: structuredClone(item.body), response: null, acknowledgement_pending: true }
    }
  }
  deliveredAcknowledgement(item) {
    return this.state.data.deliveries?.find((other) => other.kind === 'ack' && other.digest === item.digest)
  }
  postAcknowledgement(item, { signal } = {}) {
    const key = `ack:${item.digest}`
    if (this.acknowledgementInflight.has(key)) return this.acknowledgementInflight.get(key)
    // Start the request before sharing this promise so synchronous token rejection
    // cannot create a false shared receipt or skip the real authorization check.
    const transport = this.http.post(ACK_ROUTE, item.body, { token: this.identity.token, signal })
    const operation = (async () => {
      try {
        const response = await transport
        if (!validAcknowledgement(response)) {
          const error = new Error('Invalid node acknowledgement receipt')
          error.code = 'invalid_acknowledgement_receipt'; error.status = 502
          throw error
        }
        const delivered = this.deliveredAcknowledgement(item)
        const sameRequest = delivered && canonical(delivered.body) === canonical(item.body)
          && validAcknowledgement(delivered.response)
        const receipt = sameRequest ? { ...structuredClone(delivered.response), duplicate: true }
          : structuredClone(response)
        await this.recordDelivery(item, structuredClone(response))
        return { request: structuredClone(item.body), response: receipt }
      } finally {
        if (this.acknowledgementInflight.get(key) === operation) this.acknowledgementInflight.delete(key)
      }
    })()
    this.acknowledgementInflight.set(key, operation)
    return operation
  }
  async authorizeCredential({ ticketId, assignmentId, leaseEpoch, snapshot }) {
    const body = { ...envelope({ protocol: 'loom.node.v1', node_id: this.nodeId, installation_id: this.installationId }, id()),
      ticket_id: ticketId, assignment_id: assignmentId, lease_epoch: leaseEpoch,
      authorization_snapshot: sha256(canonical(snapshot)) }
    return this.http.post('/api/v1/nodes/credential-authorize', body, { token: this.identity.token })
  }
  async recordDelivery(item, response) {
    await this.state.mutate((data) => {
      data.outbox = data.outbox.filter((other) => !(other.kind === item.kind && other.digest === item.digest))
      const next = { kind: item.kind, body: structuredClone(item.body), digest: item.digest, delivered_at: new Date().toISOString() }
      if (item.kind === 'ack') next.response = structuredClone(response)
      data.deliveries ||= []
      const previous = data.deliveries.findIndex((other) => other.kind === item.kind && other.digest === item.digest)
      if (previous >= 0) data.deliveries[previous] = next
      else data.deliveries.push(next)
      if (data.deliveries.length > 500) data.deliveries.splice(0, data.deliveries.length - 500)
    })
  }
  sameAcknowledgementWork(ack, item) {
    return typeof item.body?.assignment_id === 'string' && item.body.assignment_id.length > 0
      && ack.body?.assignment_id === item.body.assignment_id
      && ack.body?.ticket_id === item.body?.ticket_id
      && ack.body?.lease_epoch === item.body?.lease_epoch
  }
  acknowledgementFor(item) {
    if (!['artifact', 'report'].includes(item.kind)) return null
    return this.state.data.outbox.find(other => other.kind === 'ack' && this.sameAcknowledgementWork(other, item)) || null
  }
  async defer(item, error, { signal } = {}) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error
    await this.state.mutate((data) => {
      const current = data.outbox.find((other) => other.kind === item.kind && other.digest === item.digest)
      if (!current) return
      current.attempts += 1
      current.last_error = error.message
      if ([401, 403, 409, 410, 422].includes(error.status)) current.next_attempt_at = new Date(864e13).toISOString()
      else current.next_attempt_at = new Date(Date.now() + Math.min(60_000, 1000 * (2 ** Math.min(current.attempts, 6)))).toISOString()
    })
    return { status: 'deferred', kind: item.kind, requestId: item.body?.request_id, error: error.message }
  }
  async dispatchOutbox({ signal } = {}) {
    const results = []
    const visited = new Set()
    for (;;) {
      if (signal?.aborted) break
      const candidates = this.state.outbox.filter(item => !visited.has(`${item.kind}:${item.digest}`)
        && Date.parse(item.next_attempt_at) <= Date.now())
      let selected = candidates[0]
      const dependent = candidates.find(item => this.acknowledgementFor(item))
      if (dependent) {
        const ack = this.acknowledgementFor(dependent)
        selected = candidates.find(item => item.kind === 'ack' && item.digest === ack.digest)
          || candidates.find(item => !this.acknowledgementFor(item)) || null
        if (selected && this.acknowledgementFor(selected)) selected = null
      }
      if (!selected) break
      const item = selected
      const key = `${item.kind}:${item.digest}`
      visited.add(key)
      const route = { event: '/api/v1/nodes/events', report: '/api/v1/nodes/reports', artifact: '/api/v1/nodes/artifacts' }[item.kind]
      try {
        if (item.kind === 'ack') {
          const receipt = await this.postAcknowledgement(item, { signal })
          results.push({ status: 'delivered', kind: item.kind, requestId: item.body.request_id, response: receipt.response })
        } else {
          const response = await this.http.post(route, item.body, { token: this.identity.token, signal })
          await this.recordDelivery(item)
          results.push({ status: item.kind === 'report' ? 'replay_delivered' : 'delivered', kind: item.kind, requestId: item.body.request_id, response })
        }
      } catch (error) {
        results.push(await this.defer(item, error, { signal }))
      }
    }
    return results
  }
}
