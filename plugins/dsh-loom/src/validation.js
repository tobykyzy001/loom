import { assertIdentifier, assertObject, assertString, sha256 } from './util.js'
const states = new Set(['online', 'busy', 'degraded'])
export const CAPABILITIES = Object.freeze(['read_summary', 'edit_file', 'model_descriptor'])
const operations = new Set(CAPABILITIES)
const credentialActions = Object.freeze({ inspect: 'credential_inspect', revoke: 'credential_revoke' })
// DSH allows lowercase ASCII lowercase alphanumeric / hyphen ids. Rust derives
// a 24-hex-byte namespace suffix; the initial fixture documents the same rule.
const credentialKeyPattern = /^refid-[a-z0-9][a-z0-9-]{0,111}$/
function credentialError(code, message) {
  const error = new Error(message); error.code = code; return error
}
/** A controller-bound record name, not an arbitrary Host credential namespace. */
export function validateCredentialAssignment(assignment, grant, identity, options = {}) {
  const reference = assignment?.credential_ref
  try {
    if (assignment?.kind !== 'credential_ref' || !credentialActions[assignment.credential_action]) {
      throw credentialError('credential_wrong_scope', 'Credential reference action is not supported')
    }
    const expectedOperation = credentialActions[assignment.credential_action]
    if (!Array.isArray(grant?.operations) || grant.operations.length !== 1 || grant.operations[0] !== expectedOperation) {
      throw credentialError('credential_wrong_scope', `The exact ${expectedOperation} Grant is required`)
    }
    if (!Object.hasOwn(grant, 'revoked_at') || grant.revoked_at !== null) {
      throw credentialError('credential_wrong_scope', 'The credential Grant is not explicitly current')
    }
    for (const key of ['node_id', 'installation_id', 'worker_id', 'project_id']) assertIdentifier(grant[key], `grant.${key}`)
    if (!options.scopeOnly && (!identity || assignment.node_id !== identity.node_id || assignment.installation_id !== identity.installation_id)) {
      throw credentialError('credential_wrong_scope', 'Credential reference is not for this enrolled installation')
    }
    // Generic checks validate the center-issued digest, Lease and current scope.
    try {
      if (options.scopeOnly) validateAssignment(assignment, grant, { node_id: assignment.node_id, installation_id: assignment.installation_id })
      else validateAssignment(assignment, grant, identity)
    } catch (error) {
      throw credentialError('credential_wrong_scope', `Credential assignment boundary failed: ${error.message}`)
    }
    // No implicit filesystem root or Provider Agent Session is created here.
    try { assertObject(reference, 'assignment.credential_ref') } catch (error) { throw credentialError('credential_wrong_scope', error.message) }
    if (reference.schema !== 'loom.credential-reference.v1' || reference.owner !== 'loom-local-node'
      || typeof reference.reference_id !== 'string' || !/^cref_[a-z0-9][a-z0-9-]{0,63}$/.test(reference.reference_id)
      || typeof reference.id !== 'string' || reference.id.length < 1 || reference.id.length > 254
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,253}$/.test(reference.id)
      || typeof reference.record_key !== 'string' || !credentialKeyPattern.test(reference.record_key)) {
          throw credentialError('credential_wrong_scope', 'Credential reference is malformed or outside the owned namespace')
    }
    if (typeof reference.binding_id !== 'string' || reference.binding_id.length < 1 || reference.binding_id.length > 160
      || reference.binding_id.includes('*') || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(reference.binding_id)) {
      throw credentialError('credential_wrong_scope', 'Credential binding is not a bounded exact identifier')
    }
    assertObject(reference.scope, 'credential_ref.scope')
    if (Object.keys(reference.scope).length !== 4) throw credentialError('credential_wrong_scope', 'Credential reference scope is incomplete')
    // This is one resource Reference, not the serialized four-scope Grant DTO.
    // Exact installation scope is also independently enforced below and in
    // validateAssignment; do not let failed nested bindings masquerade as {id}.
    if (reference.binding_digest !== undefined && !/^[a-f0-9]{64}$/.test(reference.binding_digest)) {
      throw credentialError('credential_wrong_scope', 'Credential binding digest is not immutable SHA-256')
    }
    if (reference.action !== assignment.credential_action || reference.value_exposed !== false
      || reference.expect_present !== (assignment.credential_action === 'revoke')) {
      throw credentialError('credential_wrong_scope', 'Credential action metadata does not match this exact reference')
    }
    for (const key of ['node_id', 'worker_id', 'installation_id', 'project_id']) {
      assertIdentifier(reference.scope[key], `credential_ref.scope.${key}`)
      if (reference.scope[key] !== grant[key] || reference.scope[key] !== assignment[key]) {
        throw credentialError('credential_wrong_scope', 'Credential reference scope differs from current authority')
      }
    }
    const meta = assignment.grant_credential_ref
    assertObject(meta, 'assignment.grant_credential_ref')
    if (meta.id !== reference.id || meta.name_scope !== 'source' || meta.record_key !== reference.record_key
      || meta.binding_id !== reference.binding_id || canonicalScope(meta.scope) !== canonicalScope(reference.scope)) {
      throw credentialError('credential_wrong_scope', 'Grant credential binding differs from the source reference')
    }
    if (assignment.credential_action === 'revoke') {
      validateRevocationProof(assignment, reference)
    }
    return { action: assignment.credential_action, reference }
  } catch (error) {
    if (process.env.LOOM_DEBUG_CREDENTIAL_SCOPE === '1') {
      const scope = (value) => value ? {
        node_id: value?.node_id, installation_id: value?.installation_id,
        worker_id: value?.worker_id, project_id: value?.project_id,
      } : null
      process.stderr.write(`CREDENTIAL_SCOPE_MISMATCH code=${error.code || 'none'} message=${String(error.message)}\n`)
      process.stderr.write(`CREDENTIAL_SCOPE_FACTS ${JSON.stringify({ management: error.message,
        grant: scope(grant), reference: scope(reference?.scope), identity: scope(identity),
        reference_id: reference?.reference_id, owner: reference?.owner,
        reference_binding: reference?.binding_id, grant_credential_ref: assignment?.grant_credential_ref,
        assignment: scope(assignment), action: assignment?.credential_action,
        grant_operations: grant?.operations,
          revocation_expected: assignment?.credential_revoke_expected,
        inspection_proof: reference?.inspection_proof })}\n`)
    }
    if (Object.hasOwn(error, 'code')) throw error
    throw credentialError('credential_wrong_scope', 'Credential reference, scope, or current Grant is invalid')
  }
}
function validateRevocationProof(assignment, reference) {
  const expected = assignment.credential_revoke_expected
    , proof = reference.inspection_proof
  if (expected?.expect_present !== true || proof?.state !== 'present'
    || proof?.source !== 'host_dsh_credentials' || proof?.verified_current_binding !== true
    || typeof expected.source_ticket_id !== 'string' || expected.source_ticket_id !== proof.source_ticket_id
    || typeof expected.source_artifact_id !== 'string' || expected.source_artifact_id !== proof.source_artifact_id
    || !/^[a-f0-9]{64}$/.test(expected.source_sha256) || expected.source_sha256 !== proof.copy_sha256
    || expected.source_reference_id !== proof.present_proof?.reference_id
    || proof.present_proof?.schema !== 'loom.credential-reference.v1'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,253}$/.test(proof.present_proof?.id || '')
    || proof.present_proof?.binding_digest !== reference.binding_digest
    || proof.present_proof?.expect_present !== false
    || proof.present_proof?.owner !== 'loom-local-node'
    || proof.present_proof?.scope?.node_id !== reference.scope?.node_id
    || proof.present_proof?.action !== 'inspect'
    || proof.present_proof?.record_key !== reference.record_key
    || proof.present_proof?.owner !== reference.owner
    || proof.present_proof?.binding_id !== reference.binding_id
    || canonicalScope(proof.present_proof?.scope) !== canonicalScope(reference.scope)
    || canonicalScope(expected.scope) !== canonicalScope(reference.scope)
    || reference.expect_present !== true) {
    throw credentialError('credential_wrong_scope', 'Revocation requires a byte-proof-present inspection for this exact reference and current binding')
  }
}
function canonicalScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  return ['installation_id', 'node_id', 'project_id', 'worker_id'].map((key) => `${key}:${value[key]}`).join('|')
}
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
  if (!operations.has(assignment.kind) && !['model_text', 'model_descriptor', 'credential_ref'].includes(assignment.kind)) throw new Error('Unsupported assignment kind')
  const allowed = Array.isArray(grant.operations) ? grant.operations : (Array.isArray(grant.capabilities) ? grant.capabilities : [])
  const permission = assignment.kind === 'edit_file' ? 'write' : assignment.kind === 'model_text' ? 'invoke_text' : 'read'
  if (assignment.kind !== 'credential_ref' && !allowed.includes(assignment.kind) && !allowed.includes(permission)) throw new Error('Grant does not authorize assignment kind')
  if (assignment.project_id && grant.project_id && grant.project_id !== assignment.project_id) throw new Error('Grant project mismatch')
  if (assignment.kind === 'credential_ref') {
    if (!identity.installation_id || assignment.installation_id !== identity.installation_id) throw new Error('Credential work requires the exact enrolled Installation')
    // A credential reference is non-file work. It never inherits a ProjectRoot,
    // generic read permission, provider invocation, or an Agent Session.
  } else if (assignment.kind === 'model_text') {
    if (assignment.worker_id !== grant.worker_id || !identity.installation_id
      || assignment.installation_id !== identity.installation_id) throw new Error('Text invocation requires the exact enrolled Worker/Installation')
    // Text-only work has no file path or implicit ProjectRoot authority. The
    // separately validated placement binding, not project_root, scopes it.
  } else if (['read_summary', 'edit_file', 'model_descriptor'].includes(assignment.kind)) {
    if (typeof grant.project_root !== 'string' || !grant.project_root) throw new Error('File work requires the exact current ProjectBinding root')
    if (typeof assignment.relative_path !== 'string' || !assignment.relative_path) throw new Error('File work requires an explicit relative path')
  }
  if (grant.expires_at && Date.parse(grant.expires_at) <= now) throw new Error('Grant is expired')
  return { ...assignment, grant_id: gid, ... (!assignment.grant_digest ? { grant_digest: expected } : {}) }
}
export function envelope(identity, requestId) {
  const source = identity.identity || identity
  return { protocol: 'loom.node.v1', node_id: source.node_id || source.data?.node_id,
    installation_id: source.installation_id || source.data?.installation_id, request_id: requestId }
}
export function nonNegative(value, name, max = 3600) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`${name} must be an integer from 0 to ${max}`)
  return value
}
export function validateStatus(status) { if (!states.has(status)) throw new TypeError('Invalid node status'); return status }
export function artifactDigest(artifact) { return sha256(canonical({ ...artifact, content_base64: undefined })) }
