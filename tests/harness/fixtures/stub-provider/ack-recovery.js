import { appendFileSync } from 'node:fs'
import { CoordinatorLoop } from '@loom/dsh-loom/lib/coordinator.js'

const installed = Symbol.for('loom.fixture.ack-response-loss.coordinator.v1')

/** Test-only fetch boundary at the coordinator's actual shared transport.
 * `_hold_` drops the first valid HTTP 200 ACK and withholds later replay. `_replay_`
 * observes actual outbound reconciliation, without constructing Agents or records.
 */
export function installAckResponseLoss({ control_path: controlPath }) {
  const mode = process.env.LOOM_FIXTURE_ACK_RESPONSE_LOSS
  if (!['hold', 'replay'].includes(mode) || CoordinatorLoop.prototype[installed]) return
  CoordinatorLoop.prototype[installed] = mode
  const start = CoordinatorLoop.prototype.start
  const dispose = CoordinatorLoop.prototype.dispose
  const record = value => appendFileSync(controlPath, JSON.stringify({ ...value, fixture: 'ack-response-loss' }) + '\n', { mode: 0o600 })

  CoordinatorLoop.prototype.start = function () {
    const client = this.client
    const http = client?.http
    if (!http || typeof http.fetch !== 'function' || typeof client.nodeId !== 'string') {
      throw new Error('ACK response-loss fixture requires the actual shared Node transport')
    }
    const previousFetch = http.fetch
    let discarded = false
    let attempts = 0
    this._ackResponseLossRestore = () => { http.fetch = previousFetch }
    http.fetch = async (url, options) => {
      const path = new URL(url).pathname
      const body = options.body ? JSON.parse(options.body) : null
      if (path === '/api/v1/nodes/acknowledge' && discarded && mode === 'hold') {
        throw new Error('Fixture: hold ACK transport replay until the real DSH host restarts')
      }
      const response = await previousFetch(url, options)
      if (path !== '/api/v1/nodes/acknowledge') return response
      const assignment = client.state.data.assignments?.[body?.assignment_id]
      if (body?.node_id !== client.nodeId || body?.cancel_requested === true || assignment?.kind !== 'edit_file') return response
      const receipt = await response.clone().json()
      record({ type: 'ack-http-attempt', phase: mode, count: ++attempts,
        assignment_id: body.assignment_id, request_id: body.request_id })
      if (mode === 'hold' && !discarded && response.status === 200 && receipt.accepted === true
        && typeof receipt.acknowledged_at === 'string' && receipt.acknowledged_at) {
        discarded = true
        record({ type: 'ack-http-200-discarded', ticket_id: body.ticket_id,
          assignment_id: body.assignment_id, request_id: body.request_id,
          acknowledged_at: receipt.acknowledged_at })
        throw new Error('Fixture: discard an actual successful ACK response before the client can observe it')
      }
      if (response.status === 200 && receipt.accepted === true) {
        record({ type: 'ack-http-replay-accepted', ticket_id: body.ticket_id,
          assignment_id: body.assignment_id, request_id: body.request_id,
          acknowledged_at: receipt.acknowledged_at, duplicate: receipt.duplicate === true })
      }
      return response
    }
    return start.call(this)
  }
  CoordinatorLoop.prototype.dispose = async function () {
    try { return await dispose.call(this) } finally { this._ackResponseLossRestore?.() }
  }
}
