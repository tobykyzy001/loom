import { assertIdentifier, assertObject, assertString, sha256 } from './util.js'
const states = new Set(['online', 'busy', 'degraded'])
export const CAPABILITIES = Object.freeze([
  Object.freeze({ ticket_kind: 'model_descriptor', permission: 'read' }),
  Object.freeze({ ticket_kind: 'read_summary', permission: 'read' }),
  Object.freeze({ ticket_kind: 'edit_file', permission: 'write' }),
])
const operations = new Set(['read_summary', 'edit_file', 'model_descriptor'])
/** Local fence validates the exact issued project/operation; it does not invent a grant from capability alone. */
export function validateAssignment(assignment, grant, identity, { now = Date.now() } = {}) {
  assertObject(assignment, 'assignment')
  for (const key of ['id', 'ticket_id', 'node_id', 'lease_id']) assertIdentifier(assignment[key], `assignment.${key}`)
  for (const key of ['lease_epoch', 'attempt']) {
    if (!Number.isSafeInteger(assignment[key]) || assignment[key] < 0) throw new Error(`assignment.${key} must be a non-negative integer`)
  }
  if (assignment.node_id !== identity.node_id) throw new Error('Assignment belongs to a different node')
  if (identity.installation_id && assignment.installation_id && assignment.installation_id !== identity.installation_id) {
    throw new Error('Assignment installation does not match this installation')
  }
  if (!Number.isFinite(Date.parse(assignment.lease_expires_at)) || Date.parse(assignment.lease_expires_at) <= now) {
    throw new Error('Assignment lease expired or has invalid expiry')
  }
  assertObject(grant, 'grant')
  assertIdentifier(grant.id, 'grant.id')
  if (!Number.isSafeInteger(grant.version) || grant.version <= 0) throw new Error('Grant version is invalid')
  if (grant.revoked_at) throw new Error('Grant is revoked')
  if (assignment.grant_version !== undefined && assignment.grant_version !== grant.version) throw new Error('Assignment does not match Grant version')
  const gid = grant.grant_id || grant.id
  const expected = assignment.grant_digest || grant.grant_digest || grant.digest
  const suppliedDigest = grant.grant_digest || grant.digest
  if (typeof expected !== 'string' || typeof suppliedDigest !== 'string' || expected !== suppliedDigest) {
    throw new Error('No verifiable center-issued Grant digest')
  }
  if (!operations.has(assignment.kind)) throw new Error('Unsupported assignment kind')
  if (assignment.kind === 'model_descriptor' && assignment.relative_path !== 'model.json') {
    throw new Error('model_descriptor requires an explicit model.json read target')
  }
  const allowed = Array.isArray(grant.operations) ? grant.operations : (Array.isArray(grant.capabilities) ? grant.capabilities : [])
  const permission = assignment.kind === 'edit_file' ? 'write' : 'read'
  if (!allowed.includes(assignment.kind) && !allowed.includes(permission)) throw new Error('Grant does not authorize assignment kind')
  if (assignment.project_id && grant.project_id && grant.project_id !== assignment.project_id) throw new Error('Grant project mismatch')
  if (typeof grant.project_root !== 'string' || !grant.project_root.startsWith('/')) throw new Error('Exact approved local project mapping is missing for this deterministic file executor')
  if (grant.node_id && grant.node_id !== 'auto' && grant.node_id !== assignment.node_id) throw new Error('Grant belongs to another node')
  if (grant.installation_id && grant.installation_id !== '*' && grant.installation_id !== identity.installation_id) throw new Error('Grant belongs to a different installation')
  if (grant.worker_id && grant.worker_id !== assignment.worker_id) throw new Error('Grant worker scope mismatch')
  if (grant.revoked_at) throw new Error('Grant is revoked')
  if (grant.expires_at && Date.parse(grant.expires_at) <= now) throw new Error('Grant is expired')
  return { ...assignment, grant_id: gid, ... (!assignment.grant_digest ? { grant_digest: expected } : {}) }
}
export function envelope(identity, requestId) {
  const source = identity.identity || identity
  const nodeId = identity.nodeId || source.node_id || source.nodeId || source.data?.node_id
  const installationId = identity.installationId || source.installation_id || source.installationId || source.data?.installation_id
  if (typeof nodeId !== 'string' || !/^[a-f0-9]{64}$/.test(nodeId) || typeof installationId !== 'string' || !installationId) {
    throw new TypeError('Node envelope requires an enrolled persistent node identity')
  }
  return { protocol: 'loom.node.v1', node_id: nodeId, installation_id: installationId, request_id: requestId }
}
export function nonNegative(value, name, max = 3600) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`${name} must be an integer from 0 to ${max}`)
  return value
}
export function validateStatus(status) { if (!states.has(status)) throw new TypeError('Invalid node status'); return status }
export function artifactDigest(artifact) { return sha256(canonical({ ...artifact, content_base64: undefined })) }
