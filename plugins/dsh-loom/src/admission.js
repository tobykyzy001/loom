import { canonical, sha256 } from './util.js'

/** Same-ID durable facts only. A changed grant requires a separately authorized Assignment.
 * Undefined new history is fine; malformed old fencing evidence must never be a wildcard. */
export function admissionFence(previous, assignment) {
  if (previous === undefined) return null
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return 'invalid_previous_assignment'
  if (!Number.isSafeInteger(previous.lease_epoch) || !Number.isSafeInteger(assignment.lease_epoch)) return 'invalid_stored_lease_epoch'
  if (assignment.lease_epoch < previous.lease_epoch) return 'stale_lease_epoch'
  const expected = previous.grant_digest || previous.grant?.grant_digest || previous.grant?.digest
  const received = assignment.grant_digest || assignment.grant?.grant_digest || assignment.grant?.digest
  if (typeof expected !== 'string' || !expected || expected !== received) return 'stale_grant_digest'
  return null
}

export function cancellationFence(previous, assignment, active = undefined) {
  if (previous === undefined) return 'missing_previous_assignment'
  // A live immutable snapshot is checked before any independently altered durable frame.
  // It must never be reconstructed from a diverged later cancellation payload.
  if (active !== undefined) {
    const { grant: _activeGrant, ...admittedActive } = active
    const { grant: _previousGrant, ...admittedPrevious } = previous
    if (!sameAuthorizedAssignment(admittedActive, admittedPrevious)) return 'active_assignment_mismatch'
  }
  const stale = admissionFence(previous, assignment)
  if (stale) return stale
  // Current Grant fields are not immutable work. A matching admitted frame can be
  // stopped after revocation, but divergent task input still cannot produce a stop.
  const { cancel_requested: _previousCancel, grant: _previousGrant, ...admitted } = previous
  const { cancel_requested: _receivedCancel, grant: _receivedGrant, ...received } = assignment
  if (!sameAuthorizedAssignment(admitted, received)) return 'cancellation_assignment_mismatch'
  return null
}

// Epoch and grant fencing cannot make same-ID altered paths, inputs or tickets a duplicate.
// grant_id is a local validation result; cancellation is a transient request flag.
export function sameAuthorizedAssignment(previous, assignment) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)
    || !assignment || typeof assignment !== 'object' || Array.isArray(assignment)) return false
  // Expiry is current Lease timing, not immutable work input. Cancellation can shorten it to stop
  // redelivery; ordinary execution still must pass validateAssignment's current-time check.
  const view = value => {
    // These fields are the controller's current presentation/authorization view, not task input.
    const { cancel_requested: _cancel, grant_id: _derived, lease_expires_at: _expiry,
      purpose: _purpose, status: _status, resource: _resource, operation: _operation,
      grants: _grants, grant_operations: _grantOperations, grant_status: _grantStatus,
      protocol: _protocol, ...frame } = value
    if (frame.grant && typeof frame.grant === 'object' && !Array.isArray(frame.grant)) {
      // Current Grant status also changes between polls without changing the work issued.
      const { revoked_at: _revoked, expires_at: _grantExpiry, ...grant } = frame.grant
      frame.grant = grant
    }
    return frame
  }
  const expected = view(previous)
  const received = view(assignment)
  // Compare the same JSON representation that NodeState durably commits. Omitted optional
  // fields and transient non-JSON JS gaps do not manufacture a different assignment.
  const persisted = value => {
    const frame = JSON.parse(JSON.stringify(value))
    // validateAssignment may establish the version from the verified Grant before
    // credential reauthorization writes this same fact onto the Assignment header.
    if (frame.grant_version === undefined && frame.grant?.version !== undefined) frame.grant_version = frame.grant.version
    return canonical(frame)
  }
  return persisted(expected) === persisted(received)
}

export function rejectionFingerprint(assignment) {
  return sha256(canonical({
    assignment_id: assignment.id,
    lease_epoch: assignment.lease_epoch,
    grant_digest: assignment.grant_digest || assignment.grant?.grant_digest || assignment.grant?.digest,
  }))
}

/** Context for local rejection dedup only. It is not a Grant or a terminal task receipt.
 * Current grant status and Lease expiry views do not become immutable work by being included.
 */
export function rejectionInputDigest(assignment) {
  return sha256(canonical({
    assignment_id: assignment.id, ticket_id: assignment.ticket_id,
    node_id: assignment.node_id, installation_id: assignment.installation_id,
    worker_id: assignment.worker_id, project_id: assignment.project_id,
    kind: assignment.kind, relative_path: assignment.relative_path, content: assignment.content,
    objective: assignment.objective,
    lease_epoch: assignment.lease_epoch,
    grant_id: assignment.grant_id || assignment.grant?.id,
    grant_version: assignment.grant_version ?? assignment.grant?.version,
    grant_digest: assignment.grant_digest || assignment.grant?.grant_digest || assignment.grant?.digest,
    project_root: assignment.grant?.project_root || assignment.grant?.root,
  }))
}

export function optionalNodeAckError(error) {
  return Number.isInteger(error?.status) && [401, 403, 409, 410, 422].includes(error.status)
    ? { outcome: 'quarantined', status: error.status, code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'http_error' }
    : { outcome: 'pending' }
}
