/** Public CredentialKey strings, with the exact scope segment invariant. */import { canonical, sha256 } from '../src/util.js'
import { stableArtifactId as stableUUID } from './ids.js'
import { validateCredentialAssignment } from '../src/validation.js'

export const CREDENTIAL_OWNER = 'loom-local-node'
export const CREDENTIAL_REFERENCE_SCHEMA = 'loom.credential-reference.v1'
export const CREDENTIAL_RESULT_SCHEMA = 'loom.credential-reference-result.v1'
const RECORD_KEY = /^refid-[a-z0-9][a-z0-9-]{0,111}$/
const REFERENCE_ID = /^cref_[a-z0-9][a-z0-9-]{0,63}$/

export class CredentialError extends Error {
  constructor(code, message, state = 'unknown') {
    super(message)
    this.code = code
    this.state = state
  }
}

/** Load only the shipped public helper, never a guessed private Host property. */
export async function loadCredentialKey() {
  // The key shape derives from the public SDK CredentialKey grammar, rather
  // than importing an ambient package hidden by the bundle's dependency tree.
  // Enforce the exact scope every time; an arbitrary Host-namespace key is not a
  // secret lookup permission nor a fallback to a global package installation.
  return (owner, recordKey) => {
    const segment = /^[a-z][a-z0-9-]*$/
    if (!segment.test(owner) || !segment.test(recordKey)) {
      throw new CredentialError('credential_wrong_scope', 'Credential reference is outside the public DSH record namespace', 'failed')
    }
    return `${owner}/${recordKey}`
  }
}

export function isCredentialRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.configured === 'boolean'
    && (value.writable === null || typeof value.writable === 'boolean')
}

/** Only metadata crosses this adapter; no read/resolve/list/modify API exists here. */
export class HostCredentialBroker {
  constructor(credentials, keyFn) {
    this.credentials = credentials
    this.keyFn = keyFn
  }
  get available() {
    return this.credentials !== null && typeof this.credentials === 'object'
      && typeof this.credentials.describeRecord === 'function'
      && typeof this.credentials.deleteRecord === 'function' && typeof this.keyFn === 'function'
  }
  key(recordKey) {
    if (!this.available || typeof recordKey !== 'string' || !RECORD_KEY.test(recordKey)) {
      throw new CredentialError('credential_unavailable', 'Host credential broker unavailable or record mismatch', 'failed')
    }
    try { return this.keyFn(CREDENTIAL_OWNER, recordKey) } catch {
      throw new CredentialError('credential_wrong_scope', 'Credential reference is outside the owned record namespace', 'failed')
    }
  }
  async describe(key) {
    let value
    try { value = await this.credentials.describeRecord(key) } catch {
      throw new CredentialError('credential_unavailable', 'Host credential broker unavailable or record mismatch')
    }
    if (!isCredentialRecord(value)) throw new CredentialError('credential_unavailable', 'Host credential broker returned invalid public metadata')
    return { configured: value.configured === true, writable: typeof value.writable === 'boolean' ? value.writable : null,
      ...(value.configured === true && typeof value.kind === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.kind)
        ? { kind: value.kind } : {}) }
  }
  async execute(assignment, identity, { authorizeDelete } = {}) {
    const { action, reference } = validateCredentialAssignment(assignment, assignment.grant, identity)
    const key = this.key(reference.record_key)
    const inputDigest = sha256(canonical({ asset_action: action, binding_id: reference.binding_id,
      ref_recordkey: reference.record_key, ...reference.scope }))
    const result = (metadata) => metadataResult({ assignment, reference, action, inputDigest, ...metadata })
    const before = await this.describe(key)
    if (action === 'inspect') return result({ state: before.configured ? 'present' : 'missing', ...before, effects: [] })
    if (!before.configured) throw new CredentialError('credential_missing', 'Credential reference is not configured; nothing was revoked', 'failed')
    if (typeof authorizeDelete !== 'function') throw new CredentialError('credential_wrong_scope', 'Destruction requires fresh controller authorization at the Host side-effect boundary', 'failed')
    // Recheck the persisted Grant/Binding/proof after metadata lookup, before
    // the destructive public call. Replaying this decision is never an effect.
    await authorizeDelete()
    try { await this.credentials.deleteRecord(key) } catch {
      return result({ state: 'unknown', configured: true, kind: before.kind, writable: before.writable,
        effect_status: 'unknown', summary: 'Credential deletion outcome is unknown; reconciliation is required' })
    }
    let after
    try { after = await this.describe(key) } catch {
      return result({ state: 'unknown', configured: true, kind: before.kind, writable: before.writable,
        effect_status: 'unknown', summary: 'Credential deletion was requested but its outcome could not be verified' })
    }
    if (after.configured) return result({ state: 'unknown', ...after,
      effect_status: 'unknown', summary: 'Credential remains configured after deletion; reconciliation is required' })
    return result({ state: 'revoked', ...after, effect_status: 'confirmed', summary: 'Credential reference revoked without exposing its value' })
  }
}

export function credentialSnapshot(assignment) {
  const { action, reference } = validateCredentialAssignment(assignment, assignment.grant, undefined, { scopeOnly: true })
  return canonical({ action, reference, grant_credential_ref: assignment.grant_credential_ref,
    credential_revoke_expected: assignment.credential_revoke_expected ?? null,
    grant_digest: assignment.grant_digest, grant_version: assignment.grant.version, lease_epoch: assignment.lease_epoch })
}

function metadataResult({ assignment, reference, action, state, configured, writable = null, kind,
  inputDigest, effects, effect_status, summary }) {
  const digest = sha256(canonical({ assignment_id: assignment.id, reference_id: reference.reference_id,
    binding_id: reference.binding_id, action, state }))
  const artifact_id = stableUUID(`${digest}:loom-credential-reference-result:v1`)
  const bytes = Buffer.from(JSON.stringify({ schema: CREDENTIAL_RESULT_SCHEMA, record_id: reference.id,
    record_subject: { reference_id: reference.reference_id, binding_id: reference.binding_id,
      grant_credential_ref: assignment.grant_credential_ref }, record_key: reference.record_key, action, state, configured,
    writable, kind: typeof kind === 'string' ? kind : null, credential_owner: CREDENTIAL_OWNER,
    source: 'host_dsh_credentials', configured_state: configured ? 'present_metadata' : 'missing',
    value_exposed: false, grant_created: false, permission_granted: false, matching_scope_only: true }, null, 2) + '\n')
  const artifact = { artifact_id, bytes, metadata: { name: `credential-ref-${artifact_id}.json`,
    media_type: 'application/json', size_bytes: bytes.length, sha256: sha256(bytes), origin_node_id: assignment.node_id } }
  const effect = action === 'revoke' ? [{ effect_id: stableUUID(`${inputDigest}:credential-revoke:v1:${assignment.id}`),
    status: effect_status, input_digest: inputDigest, artifacts: [artifact_id],
    evidence: { asset_action: 'revoke', record_id: reference.id, reference_id: reference.reference_id,
      binding_id: reference.binding_id, grant_version: assignment.grant.version, grant_digest: assignment.grant.digest,
      input_sha256: inputDigest, value_exposed: false } }] : []
  return { state: state === 'unknown' ? 'unknown' : 'succeeded',
    summary: summary || 'Credential reference observed without exposing value', artifact,
    effects: effects || effect }
}
