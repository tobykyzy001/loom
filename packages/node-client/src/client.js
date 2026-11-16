import { LoomHttpClient } from './http.js'
import { id, canonical, sha256 } from './util.js'
import { envelope, nonNegative, validateStatus } from './validation.js'

export class LoomNodeClient {
  constructor({ http, identity, state }) {
    if (!(http instanceof LoomHttpClient) || !identity || !state) throw new TypeError('http, identity and durable state are required')
    this.http = http; this.identity = identity; this.state = state
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
  async report({ ticketId, assignmentId, leaseEpoch, state: requestedState, summary, evidence = [], artifacts = [], artifactIds = [], effects = [], signal }) {
    if (!['running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(requestedState)) throw new TypeError('Invalid report state')
    const artifact_ids = artifactIds.concat(artifacts.map((artifact) => typeof artifact === 'string' ? artifact : artifact.artifact_id))
    if (!artifact_ids.every((artifact) => typeof artifact === 'string' && artifact.length > 0)) {
      throw new TypeError('Report artifact references must be explicit non-empty string IDs')
    }
    const body = { ...envelope(this, id()), ticket_id: ticketId, assignment_id: assignmentId, lease_epoch: leaseEpoch,
      requested_state: requestedState, summary, evidence, artifacts, effects,
      artifact_ids, cancel_acknowledged: requestedState === 'cancelled' }
    if (leaseEpoch === undefined) delete body.lease_epoch
    const digest = this.logicalDigest(body)
// Persist the exact signed node identity and centered report association.
    return this.state.enqueue('report', body, { digest })
  }
  async artifact({ ticketId, artifactId, assignmentId, leaseEpoch, metadata, bytes, signal }) {
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const sha256 = (await import('node:crypto')).createHash('sha256').update(content).digest('hex')
    const body = { ...envelope(this, id()), ticket_id: ticketId, artifact_id: artifactId, assignment_id: assignmentId,
      ...(leaseEpoch === undefined ? {} : { lease_epoch: leaseEpoch }),
      metadata: { ...metadata, size_bytes: content.length, sha256 }, bytes_base64: content.toString('base64') }
    return this.state.enqueue('artifact', body, { digest: this.logicalDigest(body) })
  }
  logicalDigest(body) {
    const { request_id, ...rest } = body
    return sha256(canonical({ logical_fields: rest }))
  }
  async acknowledge({ ticketId, assignmentId, leaseEpoch, accepted, reason = '', cancellation = false }) {
    const body = { ...envelope(this, id()), ticket_id: ticketId, assignment_id: assignmentId,
      ...(leaseEpoch === undefined ? {} : { lease_epoch: leaseEpoch }), accepted: Boolean(accepted),
      reason, cancellation: Boolean(cancellation) }
    const response = await this.http.post('/api/v1/nodes/acknowledge', body, { token: this.identity.token })
    return { request: body, response }
  }
  async dispatchOutbox({ signal } = {}) {
    const results = []
    for (const item of this.state.outbox) {
      if (signal?.aborted || Date.parse(item.next_attempt_at) > Date.now()) continue
      const route = { event: '/api/v1/nodes/events', report: '/api/v1/nodes/reports', artifact: '/api/v1/nodes/artifacts' }[item.kind]
      try {
        const response = await this.http.post(route, item.body, { token: this.identity.token, signal })
        await this.state.mutate((data) => {
          data.outbox = data.outbox.filter((other) => !(other.kind === item.kind && other.digest === item.digest))
          data.deliveries ||= []
          data.deliveries.push({ kind: item.kind, body: item.body, digest: item.digest, delivered_at: new Date().toISOString() })
          if (data.deliveries.length > 500) data.deliveries.splice(0, data.deliveries.length - 500)
        })
        results.push({ status: item.kind === 'report' ? 'replay_delivered' : 'delivered', kind: item.kind, requestId: item.body.request_id, response })
      } catch (error) {
        await this.state.mutate((data) => {
          const current = data.outbox.find((other) => other.kind === item.kind && other.digest === item.digest)
          if (!current) return
          current.attempts += 1
          current.last_error = error.message
          if ([401, 403, 409, 410, 422].includes(error.status)) current.next_attempt_at = new Date(864e13).toISOString()
          else current.next_attempt_at = new Date(Date.now() + Math.min(60_000, 1000 * (2 ** Math.min(current.attempts, 6)))).toISOString()
        })
        results.push({ status: 'deferred', kind: item.kind, requestId: item.body.request_id, error: error.message })
      }
    }
    return results
  }
}
