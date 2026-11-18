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

/** A queued acknowledgement is evidence of intent only, never permission or remote delivery. */
export class LoomNodeClient {
  constructor({ http, identity, state }) {
    if (!(http instanceof LoomHttpClient) || !identity || !state) throw new TypeError('http, identity and durable state are required')
    this.http = http; this.identity = identity; this.state = state
    this.acknowledgementInflight = new Map()
  }
  get nodeId() { return this.identity.nodeId }
  get installationId() { return this.identity.data.installation_id }
  async enroll({ enrollmentCode, capabilities, workerId = 'default', harnessKind = 'local-fixture', profileId = 'isolated', signal } = {}) {
    const challenge = await this.http.post('/api/v1/nodes/challenge', this.identity.public, { signal, noAuth: true })
    const body = { ...this.identity.public, enrollment_code: enrollmentCode, nonce: challenge.nonce,
      signed_challenge: this.identity.sign(challenge.nonce), request_id: id(), capabilities, worker_id: workerId,
      harness_kind: harnessKind, profile_id: profileId }
    const response = await this.http.post('/api/v1/nodes/register', body,
      { ...(this.identity.token ? { token: this.identity.token } : { noAuth: true }), signal })
    await this.identity.setToken(response)
    return response
  }
  async heartbeat({ status = 'online', capabilities, workers = [], inventory = {}, signal } = {}) {
    return this.http.post('/api/v1/nodes/heartbeat', { ...envelope(this, id()), status: validateStatus(status),
      capabilities, workers, inventory, timestamp: new Date().toISOString() }, { token: this.identity.token, signal })
  }
  async poll({ lastAssignmentId = null, waitSeconds = 1, signal } = {}) {
    nonNegative(waitSeconds, 'waitSeconds', 60)
    const response = await this.http.post('/api/v1/nodes/assignments/poll', { ...envelope(this, id()),
      last_assignment_id: lastAssignmentId, wait_seconds: waitSeconds }, { token: this.identity.token, signal,
      timeoutMs: Math.max(this.http.timeoutMs, waitSeconds * 1000 + 10_000) })
    if (response === null || (response && typeof response === 'object' && !Array.isArray(response) && Object.keys(response).length === 0)) return null
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
  async report({ ticketId, assignmentId, leaseEpoch, state: requestedState, summary, evidence = [], artifacts = [], artifactIds = [], effects = [], cancelAcknowledged = false, signal }) {
    if (!['running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(requestedState)) throw new TypeError('Invalid report state')
    const artifact_ids = artifactIds.concat(artifacts.map((artifact) => typeof artifact === 'string' ? artifact : artifact.artifact_id))
    if (!artifact_ids.every((artifact) => typeof artifact === 'string' && artifact.length > 0)) {
      throw new TypeError('Report artifact references must be explicit non-empty string IDs')
    }
    const body = { ...envelope(this, id()), ticket_id: ticketId, assignment_id: assignmentId, lease_epoch: leaseEpoch,
      requested_state: requestedState, summary, evidence, artifacts, effects,
      artifact_ids, cancel_acknowledged: requestedState === 'cancelled' || cancelAcknowledged === true }
    if (leaseEpoch === undefined) delete body.lease_epoch
    const digest = this.logicalDigest(body)
    // The receipt identity of the same immutable report survives reopen and replay.
    // Never mint an unrelated random request ID for an identical immutable result.
    body.request_id = digest
    // Persist the exact signed node identity and centered report association.
    return this.state.enqueue('report', body, { digest })
  }
  async artifact({ ticketId, artifactId, assignmentId, leaseEpoch, metadata, bytes, signal }) {
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const sha256 = (await import('node:crypto')).createHash('sha256').update(content).digest('hex')
    const body = { ...envelope(this, id()), ticket_id: ticketId, artifact_id: artifactId, assignment_id: assignmentId,
      ...(leaseEpoch === undefined ? {} : { lease_epoch: leaseEpoch }),
      metadata: { ...metadata, size_bytes: content.length, sha256 }, bytes_base64: content.toString('base64') }
    const digest = this.logicalDigest(body)
    // An immutable upload and its receipt identity must survive a durable replay.
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
    const digest = this.logicalDigest(body)
    const delivered = this.state.data.deliveries?.find((item) => item.kind === 'ack' && item.digest === digest)
    if (delivered) {
      // Only an intact durable response can save another authenticated network attempt.
      // A delivery row by itself is not a central receipt.
      if (canonical({ ...delivered.body, request_id: body.request_id }) === canonical(body)
        && typeof delivered.body.request_id === 'string' && delivered.body.request_id.length > 0
        && validAcknowledgement(delivered.response)) {
        return { request: structuredClone(delivered.body),
          response: { ...structuredClone(delivered.response), duplicate: true } }
      }
    }
    const item = await this.state.enqueue('ack', body, { digest })
    // Leave a newer per-process request stable while callers await an existing HTTP attempt.
    // JSON disk state remains the durable representation of this exact immutable body.
    const current = this.state.data.outbox.find((other) => other.kind === 'ack' && other.digest === digest)
    if (current && current.body.request_id !== body.request_id) body.request_id = current.body.request_id
    try {
      return await this.postAcknowledgement(item, { signal })
    } catch (error) {
      if (ACK_DENIED.has(error?.status) || (error?.status >= 200 && error.status < 500)) throw error
      // An abort/timeout/network failure can occur after a remote commit. Keep the exact
      // request for reconciliation, but do not turn that unknown outcome into acceptance.
      return { request: structuredClone(item.body), response: null, acknowledgement_pending: true }
    }
  }
  deliveredAcknowledgement(item) {
    return this.state.data.deliveries?.find((other) => other.kind === 'ack' && other.digest === item.digest)
  }
  postAcknowledgement(item, { signal } = {}) {
    const key = `${item.kind}:${item.digest}`
    if (this.acknowledgementInflight.has(key)) return this.acknowledgementInflight.get(key)
    // Start the authenticated HTTP operation before sharing its Promise: even if a node
    // token is rejected synchronously, concurrent callers must not manufacture a false receipt.
    const transport = this.http.post(ACK_ROUTE, item.body, { token: this.identity.token, signal })
    const operation = (async () => {
      try {
        const response = await transport
        if (!validAcknowledgement(response)) {
          const error = new Error('Invalid node acknowledgement receipt')
          error.code = 'invalid_acknowledgement_receipt'
          error.status = 502
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
      const existing = data.deliveries.findIndex((other) => other.kind === item.kind && other.digest === item.digest)
      if (existing >= 0) data.deliveries[existing] = next
      else data.deliveries.push(next)
      if (data.deliveries.length > 500) data.deliveries.splice(0, data.deliveries.length - 500)
    })
  }
  sameAcknowledgementWork(ack, item) {
    return typeof item.body?.assignment_id === 'string' && item.body.assignment_id.length > 0
      && ack.body?.assignment_id === item.body.assignment_id
      && ['ticket_id', 'lease_epoch'].every(field => ack.body?.[field] === item.body?.[field])
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
      const earliest = candidates[0]
      let selected = earliest
      // Only an ACK needed by a queued Artifact/Report is promoted ahead of its own
      // dependency. No central receipt is inferred from this local ordering decision.
      const dependent = candidates.find(item => this.acknowledgementFor(item))
      if (dependent) {
        const ack = this.acknowledgementFor(dependent)
        selected = candidates.find(item => item.kind === 'ack' && item.digest === ack.digest)
          || candidates.find(item => !this.acknowledgementFor(item)) || null
        // A fenced ACK must not hold unrelated work. Preserve same-assignment ordering.
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
