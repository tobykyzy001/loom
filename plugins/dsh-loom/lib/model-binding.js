import { canonical } from '../src/util.js'

const BINDING_FIELDS = Object.freeze([
  'schema', 'model_id', 'placement_id', 'placement_sha256',
  'source_artifact_id', 'source_ticket_id', 'source_assignment_digest',
  'placement_grant_id', 'placement_grant_digest',
  'node_id', 'project_id', 'worker_id', 'installation_id',
])
const REQUEST_FIELDS = Object.freeze(['schema', 'objective', 'provider', 'model', 'model_binding'])
const HEX_256 = /^[a-f0-9]{64}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,253}$/
const PERSISTED_GRANT_FIELDS = Object.freeze([
  'id', 'project_id', 'node_id', 'worker_id', 'installation_id', 'operations',
  'version', 'revoked_at', 'digest', 'created_at', 'project_binding_id', 'expires_at',
])

function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${name} must be a bounded identifier`)
  return value
}
function proof(value, name) {
  if (typeof value !== 'string' || !HEX_256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 proof`)
  return value
}
function exactFields(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const keys = Object.keys(value).sort()
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error(`${name} must contain exactly its required fields`)
  }
}
function scope(grant, assignment, binding, operation) {
  for (const key of ['node_id', 'project_id', 'worker_id', 'installation_id']) {
    if (grant[key] !== binding[key] || assignment[key] !== binding[key]) throw new Error(`Model binding ${key} does not match current authority`)
  }
  // Missing state is not proof of being current. In particular, do not treat
  // active:true, a kind label, or the absence of revoked_at as authorization.
  if (!Object.hasOwn(grant, 'revoked_at') || grant.revoked_at !== null) throw new Error(`${operation} Grant is not explicitly current`)
  if (!Number.isSafeInteger(grant.version) || grant.version <= 0) throw new Error(`${operation} Grant version is invalid`)
  if (!Array.isArray(grant.operations) || !grant.operations.includes(operation)) throw new Error(`The current ${operation} Grant is required`)
  proof(grant.digest, `${operation} grant.digest`)
  if (grant.expires_at !== undefined && (!Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now())) {
    throw new Error(`${operation} Grant is expired or has invalid expiry`)
  }
  if (operation === 'place_model' && grant.digest !== binding.placement_grant_digest) {
    throw new Error('Placement Grant digest differs from the immutable binding')
  }
}

function persistedGrant(grant) {
  return Object.fromEntries(PERSISTED_GRANT_FIELDS.filter((key) => Object.hasOwn(grant || {}, key)).map((key) => [key, grant[key]]))
}

/** Parse only the center-supplied immutable text request; no config/provider fallback. */
export function loadTextRequest(assignment) {
  if (typeof assignment?.content !== 'string' || assignment.content.length === 0 || assignment.content.length > 32_768) {
    throw new Error('model_text requires its bounded immutable content request')
  }
  let request
  try { request = JSON.parse(assignment.content) } catch { throw new Error('model_text content must be JSON') }
  exactFields(request, REQUEST_FIELDS, 'model_text content')
  if (request.schema !== 'loom.model-text.v1') throw new Error('Unsupported model_text content schema')
  if (typeof request.objective !== 'string' || request.objective.length === 0 || request.objective.length > 16_000
    || request.objective !== assignment.objective) throw new Error('model_text objective is absent, unbounded, or differs from the Assignment')
  if (request.provider !== 'loom-stub' || request.model !== 'loom-stub-v1'
    || assignment.provider !== request.provider || assignment.model !== request.model) {
    throw new Error('model_text must select the exact scoped fixture provider/model')
  }
  // poll may expose the already parsed binding. Both forms must be byte-for-byte
  // equivalent as JSON values, never competing sources of model authority.
  if (assignment.model_binding !== undefined && canonical(assignment.model_binding) !== canonical(request.model_binding)) {
    throw new Error('Conflicting immutable model bindings')
  }
  return Object.freeze({ provider: request.provider, model: request.model, modelBinding: request.model_binding })
}

/** Local integrity fence only. This neither refreshes authority nor invokes a model SDK. */
export async function validateModelBinding(assignment, identity) {
  if (assignment?.kind !== 'model_text') throw new Error('Model binding applies only to model_text')
  const request = loadTextRequest(assignment)
  const binding = request.modelBinding
  exactFields(binding, BINDING_FIELDS, 'model_binding')
  if (binding.schema !== 'loom.model-binding.v1') throw new Error('Unsupported model binding schema')
  for (const key of ['model_id', 'placement_id', 'source_artifact_id', 'source_ticket_id',
    'placement_grant_id', 'node_id', 'project_id', 'worker_id', 'installation_id']) identifier(binding[key], `model_binding.${key}`)
  proof(binding.placement_sha256, 'model_binding.placement_sha256')
  proof(binding.source_assignment_digest, 'model_binding.source_assignment_digest')
  proof(binding.placement_grant_digest, 'model_binding.placement_grant_digest')
  if (!identity || binding.node_id !== identity.node_id || binding.installation_id !== identity.installation_id
    || assignment.node_id !== identity.node_id || assignment.installation_id !== identity.installation_id) {
    throw new Error('Model binding is not for this enrolled installation')
  }
  if (binding.worker_id === 'auto' || binding.worker_id !== assignment.worker_id) throw new Error('Model binding requires the actual assigned Worker')
  if (!Array.isArray(assignment.grants) || assignment.grants.length < 2) throw new Error('Both center-issued Grants are required')
  if (binding.placement_grant_id === assignment.grant?.id) throw new Error('Invocation and placement Grants must be separate')
  const placements = assignment.grants.filter((grant) => grant?.id === binding.placement_grant_id)
  if (placements.length !== 1) throw new Error('The exact current placement Grant is absent or ambiguous')
  scope(placements[0], assignment, binding, 'place_model')
  if (!Array.isArray(assignment.grant?.operations) || assignment.grant.operations.length !== 1
    || assignment.grant.operations[0] !== 'invoke_text') throw new Error('model_text requires a dedicated invoke_text Grant')
  scope(assignment.grant, assignment, binding, 'invoke_text')
  if (assignment.grant_digest !== assignment.grant.digest) throw new Error('Invocation Grant digest differs from the Assignment')
  // assignment.grant also carries the poll-derived project_root. Only the
  // persisted Grant facts are comparable with the unmodified record in grants.
  // Equality of common fields alone could hide a substituted permission.
  if (assignment.grant.project_root !== undefined
    && (typeof assignment.resource?.root_scope !== 'string'
      || assignment.grant.project_root !== assignment.resource.root_scope)) {
    throw new Error('Invocation ProjectRoot does not match the current center resource')
  }
  if (assignment.grants.filter((grant) => grant?.id === assignment.grant.id).length !== 1
    || canonical(persistedGrant(assignment.grants.find((grant) => grant?.id === assignment.grant.id)))
      !== canonical(persistedGrant(assignment.grant))) {
    throw new Error('The center Grants list does not contain the exact invocation Grant')
  }
  return Object.freeze({
    model_id: binding.model_id,
    placement_id: binding.placement_id,
    placement_sha256: binding.placement_sha256,
    source_artifact_id: binding.source_artifact_id,
    source_ticket_id: binding.source_ticket_id,
    source_assignment_digest: binding.source_assignment_digest,
    placement_grant_id: binding.placement_grant_id,
    placement_grant_digest: binding.placement_grant_digest,
    provider: request.provider,
    model: request.model,
  })
}

export function modelBindingSnapshot(assignment) {
  const request = loadTextRequest(assignment)
  return canonical({ binding: request.modelBinding, provider: request.provider, model: request.model,
    grant_digest: assignment.grant_digest, lease_epoch: assignment.lease_epoch })
}
