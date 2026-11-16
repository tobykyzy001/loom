import { realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'

const MAX_BYTES = 1_048_576
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_FIELDS = ['type', 'artifact_id', 'ticket_id', 'origin_node_id', 'sha256', 'location', 'parents']
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function need(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }) }
function boundedString(value, code, limit = 160) {
  const valid = typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value)
  need(valid, code)
  return value
}

/** Current Assignment/Lease and source are independently verified by the center.
 * This is a read-only exact-descendant proof, not admin credentials or a new grant.
 * The same-host AddSession relationship is then passed to the real DSH API.
 */
export async function verifiedDelegation({ assignment, runner, config }) {
  need(config.delegation_tools === 'scoped_fixture', 'delegation_capability_disabled')
  const input = assignment.artifact_input
  need(input && typeof input === 'object' && !Array.isArray(input)
    && ['artifact_ref', 'bytes_base64'].every((key) => Object.hasOwn(input, key))
    && Object.keys(input).length === 2, 'source_input_required')
  const reference = input.artifact_ref
  need(reference?.type === 'artifact_ref' && UUID.test(reference.artifact_id), 'source_artifact_id_invalid')
  boundedString(reference.ticket_id, 'source_ticket_required')
  need(reference.origin_node_id === runner.identity.nodeId, 'source_origin_mismatch')
  need(/^[a-f0-9]{64}$/.test(reference.sha256), 'source_sha256_invalid')
  need(reference.location === `loom://artifact/${reference.artifact_id}`, 'source_location_not_controlled')
  need(Array.isArray(reference.parents) && reference.parents.length === 0, 'source_parent_mismatch')
  need(JSON.stringify(Object.keys(reference).sort()) === JSON.stringify([...REF_FIELDS].sort()), 'source_ref_fields_invalid')
  const offeredBytes = Buffer.from(typeof input.bytes_base64 === 'string' ? input.bytes_base64 : '', 'base64')
  need(offeredBytes.length > 0 && offeredBytes.length <= MAX_BYTES
    && offeredBytes.toString('base64') === input.bytes_base64
    && hash(offeredBytes) === reference.sha256, 'source_input_bytes_invalid')
  const body = {
    protocol: 'loom.node.v1', node_id: runner.identity.nodeId, installation_id: runner.identity.installationId,
    request_id: randomUUID(), ticket_id: assignment.ticket_id, assignment_id: assignment.id,
    lease_epoch: assignment.lease_epoch, source_ref: reference,
  }
  let proof
  try {
    proof = await runner.client.http.post('/api/v1/nodes/assignments/source', body, { token: runner.identity.token })
  } catch (error) {
    const wrapped = Object.assign(new Error('Exact current Assignment source could not be verified'), { code: error.code || 'source_verification_failed' })
    throw wrapped
  }
  const actual = proof?.artifact_input
  need(actual?.artifact_ref && JSON.stringify(actual.artifact_ref) === JSON.stringify(reference), 'source_assignment_proof_mismatch')
  need(typeof actual.bytes_base64 === 'string' && actual.bytes_base64.length > 0 && actual.bytes_base64.length <= 1_500_000, 'source_bytes_encoding_invalid')
  const bytes = Buffer.from(actual.bytes_base64, 'base64')
  need(bytes.length > 0 && bytes.length <= MAX_BYTES, 'source_bytes_limit')
  need(bytes.toString('base64') === actual.bytes_base64, 'source_bytes_not_canonical')
  need(hash(bytes) === reference.sha256, 'source_bytes_hash_mismatch')
  const parent = proof.parent_session_ref
  need(parent && parent.harness === 'dsh' && parent.protocol === 'dsh-session-log' && UUID.test(parent.session_id), 'parent_session_ref_missing')
  need(parent.ticket_id === reference.ticket_id, 'parent_session_ticket_mismatch')
  const parentRef = { harness: 'dsh', session_id: parent.session_id, protocol: parent.protocol,
    host_api: boundedString(parent.host_api, 'parent_host_api_invalid', 64),
    // A newly created Agent can legitimately publish an empty session at seq 0.
    observed_seq: Number.isSafeInteger(parent.observed_seq) && parent.observed_seq >= 0 ? parent.observed_seq : 0 }
  const expectedRoot = await realpath(config.delegation_project_root || '')
  const actualRoot = await realpath(assignment.grant?.project_root || '')
  need(expectedRoot === actualRoot, 'delegation_root_mismatch')
  return {
    ref: { type: 'artifact_ref', artifact_id: reference.artifact_id, ticket_id: reference.ticket_id,
      origin_node_id: reference.origin_node_id, sha256: reference.sha256, location: reference.location, parents: [] },
    parent_session: parentRef,
    bytes,
    root: actualRoot,
  }
}
