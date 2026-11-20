export type Page = 'conversation' | 'activity' | 'devices' | 'projects' | 'plans' | 'memories' | 'skills' | 'access' | 'help'
export type ProjectMode = 'read_only' | 'read_write'
export type TicketKind = 'read_summary' | 'edit_file' | 'model_text'
export type TicketStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'reconciling'
export type ExtendedTicketStatus = TicketStatus | 'cancel_requested'

export type TicketReadableStatus = TicketStatus | 'unknown'

export interface ProjectInventory {
  form: 'working_tree' | 'documents' | 'generated_workspace' | string
  git_available?: boolean
  revision?: string | null
  dirty?: boolean | null
  canonical_remote?: string | null
  canonical_remote_status?: 'public' | 'unsupported_or_redacted' | string | null
  redacted_remote?: boolean
  needs_review?: boolean
  source?: string
  probed_at?: string
  credential_lookup_performed?: boolean
  credential_available?: string | null
  credential_location?: 'host_credential_store' | 'node_credential_broker' | 'none' | string | null
}

export interface Project {
  id: string
  name: string
  mode: ProjectMode
  root?: string
  created_at?: string
  inventory?: ProjectInventory
}

export type GrantOperation = 'read_summary' | 'edit_file' | 'read_write'
export interface ProjectBindingInput {
  project_id: string
  node_id: string
  worker_id: string
  root_scope: string
  /** Only needed when this Node has multiple usable Installation records. */
  installation_id?: string
}

export interface Assignment {
  id: string
  ticket_id: string
  node_id: string
  worker_id: string
  attempt: number
  lease_id?: string
  lease_epoch?: number
  lease_expires_at?: string
  grant_digest?: string
}

export interface Effect {
  effect_id: string
  input_digest?: string
  status: 'recorded' | 'unknown' | 'confirmed' | 'needs_person'
  evidence?: string | Record<string, unknown>
}

export interface ArtifactRef {
  artifact_id: string
  ticket_id: string
  origin_node_id: string
  id?: string
  assignment_id?: string
  name?: string
  type?: string
  version?: number
  location?: string
  parents?: Array<Record<string, string>>
  code_evidence?: unknown
  media_type?: string
  size_bytes?: number
  sha256?: string
  lineage?: Array<Record<string, string>>
}

export interface Report {
  id?: string
  assignment_id?: string
  lease_id?: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  state?: string
  summary: string
  evidence?: string | Record<string, unknown>
  artifacts?: ArtifactRef[]
  effects?: Effect[]
  created_at?: string
}

export interface DelegationEvidence {
  type?: string
  artifact_id: string
  ticket_id: string
  origin_node_id?: string
  sha256?: string
  location?: string
  parents?: unknown[]
  session?: { session_id: string; harness?: string }
  source_verified: true
  validated_by: 'current_assignment_and_pipeline_relation'
}
export interface Message {
  kind?: string
  session_ref?: string | { session_id?: string; delegated_from?: DelegationEvidence }
  id: string
  content: string
  sender?: string
  sender_id?: string
  sender_kind?: string
  role?: string
  ticket_id?: string
  assignment_id?: string
  created_at?: string
  segment?: 'conversation' | 'activity' | 'collaboration'
  visible?: boolean
}

export interface Ticket {
  id: string
  project_id: string
  objective: string
  status: TicketStatus | (string & {})
  attempt: number
  kind?: TicketKind
  relative_path?: string
  assignments?: Assignment[]
  reports?: Report[]
  artifacts?: ArtifactRef[]
  effects?: Effect[]
  messages?: Message[]
  created_at: string
  updated_at: string
  cancel_requested?: boolean
  grant_digest?: string
  approval?: ApprovalRequest | null
  model_observation?: ModelObservation | null
}

export interface ModelObservation {
  schema: 'loom.model-observation.v1'
  artifact_id: string
  ticket_id: string
  assignment_id: string
  origin_node_id: string
  provider: string
  model: string
  input_modalities: string[]
  source: 'host_reported'
  execution_observed: boolean
  output_observed: boolean
  not_live_llm: boolean | null
  observed_at: string
  recorded_at: string
  grant_id: string
  operation: 'invoke_text'
  grant_current: boolean
  session_id?: string
}

export interface SkillCandidate {
  id: string
  kind: 'skill' | 'memory' | 'route' | string
  scope: string
  status: 'pending' | 'accepted' | 'rejected' | 'later' | string
  content: string
  source_refs: string
  version: number
}

export interface ReplaySample {
  path: string
  line_count: number
  lines: string[]
  digest: string
}

export type ReplayStatus = 'awaiting_execution' | 'verified' | 'sample_mismatch' | 'failed' | 'reconciling' | (string & {})
export interface SkillReplay {
  schema: 'loom.skill-replay.v1' | string
  candidate_id: string
  source_ticket_id: string
  source_artifact_id: string
  replay_ticket_id: string
  replay_artifact_id: string | null
  expected_sha256: string
  expected_sample: { path?: string; line_count?: number; lines?: string[] }
  sample: ReplaySample
  status: ReplayStatus
  verified_at?: string | null
  reason?: string | null
  grant_revocation_denied_at?: string | null
  current_project_valid: boolean
  authority_created: false
  runtime: 'bounded_exact_deterministic_read_summary_only' | string
  grant_id: string
}

export interface SkillProof {
  id: string
  candidate_id: string
  scope: string
  kind: 'skill' | string
  source_ticket_id: string
  source_artifact_id: string
  replay_ticket_id: string
  replay_artifact_id: string
  grant_id: string
  definition_json: string
  proof_json: string
}

export interface SkillProofJson {
  schema: 'loom.skill.v1'
  bounded_operation: 'read_summary'
  replay_verified: boolean
  source_ticket_id: string
  source_artifact_id: string
  replay_ticket_id: string
  replay_artifact_id: string
  sha256: string
  sample: ReplaySample
  grant_id: string
  standing_grant: boolean
  activation: boolean
}

export interface SkillWorkspaceData {
  candidates: SkillCandidate[]
  skill_replays: SkillReplay[]
  skills: SkillProof[]
  policy?: string
}

export interface ApprovalRequest {
  id?: string
  summary?: string
  operation?: string
  reason?: string
}

export interface ArtifactContent {
  metadata: ArtifactRef
  content: string
  encoding?: 'utf8' | 'base64'
  truncated?: boolean
}

export interface Bootstrap {
  protocol_version?: string
  version?: string
  api?: string
  client_api?: string
  node_protocol?: string
  identity?: { principal?: string; device_role?: string; name?: string }
  principal?: { id: string; name?: string; display_name?: string }
  tickets?: Ticket[]
  default_ticket_id?: string | null
  ticket_id?: string | null
  default_ticket?: Ticket | null
  node?: Partial<LoomNode> | null
}

export interface ResourceFact {
  resource: string
  value?: string | number | boolean | null
  confidence?: 'available' | 'missing' | 'unknown' | 'incompatible' | 'denied' | 'offline' | 'busy' | 'error' | 'stale' | string
  source?: 'user_declared' | 'host_reported' | 'controller_probed' | 'unverified' | string
  observed_at?: string | null
  freshness?: 'fresh' | 'stale' | 'unknown' | string
}

export interface NodeInventory {
  schema?: 'loom.inventory.v1' | string
  identity?: { node_id?: string; installation_id?: string }
  freshness?: 'fresh' | 'stale' | 'unknown' | string
  presence?: 'installed' | 'never_installed' | 'revoked' | string
  reachability?: 'online' | 'busy' | 'degraded' | 'offline' | 'stale' | 'revoked' | 'not_installed' | 'unknown' | string
  health?: 'available' | 'busy' | 'degraded' | 'offline' | 'missing' | 'revoked' | 'error' | string
  facts?: ResourceFact[]
  issues?: Array<{ resource?: string; code?: string; confidence?: ResourceFact['confidence'] }>
  project_roots?: Record<string, string>
  /** Public controller inspection of an already-declared Node root, null when unavailable. */
  canonical_project_roots?: Record<string, string | null>
  hardware_probe?: HardwareProbeSnapshot
  permission_boundary?: string
}

export interface HardwareProbeSnapshot {
  schema: 'loom.local-hardware-probe.v1' | string
  inspector?: string | null
  observed_at: string
  source: 'controller_probed'
  permission_granted: false
}

export interface PlacementWait {
  code: string
  source: string
  resource: string
  confidence: string
}
export interface PlacementDecision {
  schema: 'loom.inventory.v1' | string
  selected: { node_id: string; installation_id: string; worker_id: string; project_binding_id: string; root_scope: string } | null
  waiting: PlacementWait[]
  explanation: string
  existing_grant_matching_passed: boolean
  permission_boundary: string
}

export interface LoomNode {
  id: string
  node_id?: string
  installation_id?: string
  name?: string
  status?: 'online' | 'busy' | 'degraded' | 'offline' | string
  online?: boolean
  freshness?: 'fresh' | 'stale_offline' | 'stale_or_offline' | string
  last_heartbeat?: string
  last_seen_at?: string
  capabilities?: Array<string | Record<string, unknown>>
  revoked_at?: string | null
  trusted?: boolean
  platform?: string
  inventory?: NodeInventory
}

export interface Grant {
  id: string
  version?: number
  digest?: string
  project_id: string
  ticket_id?: string
  node_id?: string
  installation_id?: string
  worker_id?: string
  project_binding_id?: string
  operations: string[]
  status?: 'active' | 'revoked' | string
  revoked_at?: string | null
  created_at?: string
}

export interface Memory {
  id: string
  project_id?: string | null
  content: string
  scope: 'user' | 'global' | 'project' | string
  created_at?: string
  updated_at?: string
}

export interface Preferences {
  expanded: boolean
  sender_filter?: string | null
}

export interface AuditEntry {
  id?: string
  action?: string
  kind?: string
  actor?: string
  created_at?: string
  summary?: string
  details?: Record<string, unknown>
}

export interface ModelFinding { state: string; provider?: string; model?: string; observed_at?: string }
export interface CatalogModel {
  id: string
  node_id: string
  installation_id: string
  worker_id: string
  provider: string
  model: string
  catalogued: true
  prepared_call_observed: true
  generation_observed: false
  input_modalities: ['text']
  context_window?: number
  source: 'host_reported'
  observed_at: string
  resource_state: 'adapter_observed' | 'unavailable' | string
  activated: false
  allowed: false
  executable: false
  controller_matches: true
  read_source: 'authenticated_node_heartbeat'
  freshness: 'fresh' | 'stale'
}
export interface ModelCatalogObservation {
  schema: 'loom.model-inventory.v1'
  revision: number
  models: CatalogModel[]
  findings: ModelFinding[]
  resource_facts?: Array<Record<string, unknown>>
  policy: ModelInventoryPolicy
  confidence: string
  node_id: string
  installation_id: string
  worker_id: string
  read_source: 'authenticated_node_heartbeat'
  lookup_source: string
  controller_matches: boolean
  permission_granted: false
}
export interface ModelInventoryPolicy {
  schema: string
  views?: string
  supported_operations?: string[]
  install_support?: string
  activation_support?: string
  download_support?: string
  install: false
  download: false
  activation: false
  generation: false
  remote_delivery?: false
  billing_effects?: false
  universal_provider_registry?: false
  not_supported?: string[]
}
export interface ModelInventoryData {
  schema: 'loom.model-inventory.v1'
  revision: number
  models: CatalogModel[]
  observations: ModelCatalogObservation[]
  policy: ModelInventoryPolicy
  policy_code: 'observed_only_not_activation'
}

export type InstallTargetStatus = 'pending_approval' | 'approved' | 'healthy_observed' | 'health_failed' | 'rollback_approved' | 'rolled_back_observed' | 'unknown' | 'not_selected' | 'incompatible'
export type InstallOutcome = 'healthy' | 'health_failed' | 'connection_lost'
export interface InstallTarget {
  id: string
  host_key: string
  os: string
  arch: string
  baseline_version: string
  requested_version: string
  selected: boolean
  status: InstallTargetStatus
  current_version: string
  current_operation_id?: string | null
  approved_at?: string | null
  rollback_parent_operation_id?: string | null
  observations?: Array<{
    operation_id: string
    operation: 'apply' | 'rollback'
    outcome: InstallOutcome
    reported_at: string
    report_kind: 'manual_synthetic_inventory_report'
    simulated: true
  }>
}
export interface InstallComponent {
  kind: 'bare_host' | string
  version: string
  sha256: string
  source: 'local_package_candidate' | string
  source_manifest_sha256?: string
}
export interface InstallPlan {
  id: string
  schema: 'loom.install-plan.v1' | string
  version: number
  plan_digest: string
  proof_kind: 'synthetic_plan_only' | string
  source: string
  component: InstallComponent
  authorization_revision: string
  host_execution: false
  created_at: string
  updated_at: string
  targets: InstallTarget[]
}
export interface InstallPlanPolicy {
  simulation_only: boolean
  fixture_reporting: boolean
  remote_execution: boolean
  proof_kind: 'synthetic_plan_only' | string
}
export interface InstallPlanData { plan: InstallPlan; policy: InstallPlanPolicy }
export type InstallPlanAction = 'approve' | 'rollback' | 'observe'
export interface InstallObservationRequest {
  target_id: string
  operation: 'apply' | 'rollback'
  outcome: InstallOutcome
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}

export interface ClientRoutes { // Structural request/response types, not a server-generated schema.
  projects: {
    list: { path: '/projects'; response: Project[] }
    create: { path: '/projects'; body: { name: string; root: string; mode: ProjectMode }; response: Project }
  }
  tickets: {
    list: { path: '/tickets'; response: Ticket[] }
    create: { path: '/tickets'; body: NewTicket; response: Ticket }
    get: { path: `/tickets/${string}`; response: Ticket }
  }
}

export interface NewTicket {
  project_id: string
  objective: string
  kind: TicketKind
  relative_path?: string
  content?: string
}

export interface SourceInstance {
  id: string
  source_key: string
  kind: 'web'
  label?: string | null
  owner_key?: string
  definition_digest?: string
  last_sequence?: number
  created_at?: string
  updated_at?: string
}
export interface SourceRegistration {
  source: SourceInstance
  duplicate: boolean
  task_created: false
  permission_granted: false
}
export interface SourceInstanceInput {
  schema: 'loom.source-instance.v1'
  source_key: string
  kind: 'web'
  label: string
}
export interface SourceEvent {
  id: string
  source_id: string
  /** Internal association key, never substituted for the exact client thread. */
  thread_id: string
  client_thread_id: string
  external_event_id: string
  kind: 'user_message'
  content: string
  payload_digest?: string
  /** Unverified historical intake relation, not authority for new work. */
  ticket_id?: string | null
  task_ticket_id?: string | null
  task_digest?: string | null
  creation_kind?: string | null
  task_spec?: SourceWorkSpec | null
  /** Raw immutable evidence for audit display only; never a substitute for parsed full server validation. */
  task_spec_raw?: string
  legacy_reference?: 'unverified_intake_reference' | null
  occurred_at?: string | null
  received_at?: string
  source_sequence: number
  thread_sequence: number
  duplicate?: boolean
  task_created?: false
  permission_granted?: false
  delivery_stage?: 'recorded'
}
export interface SourceWorkSpec {
  schema: 'loom.source-work-spec.v1'
  source_event_id: string
  event_request_digest: string
  ticket_id: string
  digest: string
  project_id: string
  kind: 'read_summary'
  objective: string
  relative_path: string
  content?: string | null
  grant_id: string
  grant_digest: string
  grant_version: number
  project_binding_id: string
  binding_digest: string
  root_scope: string
  node_id: string
  installation_id: string
  worker_id: string
  created_at: string
}
export interface SourceThread {
  schema?: 'loom.source-page.v1'
  source_id: string
  client_thread_id: string
  thread_id?: string
  events: SourceEvent[]
  has_more: boolean
  next_cursor: string | null
  permission_granted?: false
  /** Bound cursor continuation is supported by the workspace, never global thread merging. */
  cursor?: string
  limit?: number
}
export interface SourceWorkDraft {
  /** Client-only validated immutable event and exact thread scope, never serialized as new authority. */
  source_event?: SourceEvent
  source_event_id: string
  objective: string
  kind: 'read_summary'
  relative_path: string
  project_id: string
  grant_id: string
  node_id: string
  worker_id: string
  /** Client-only context; sourceWorkBodyFrom deliberately does not send these to /tickets. */
  source_scope?: { source_id: string; client_thread_id: string }
  /** A client-only preparation/confirmation fence, never serialized as new authority. */
  authority_snapshot?: {
    grant_version: number
    grant_digest: string
    project_binding_id: string
    installation_id: string
  }
}
export interface SourceTicketReceipt {
  ticket: Ticket
  source_event_id: string
  task_digest: string
  duplicate: boolean
  task_created: boolean
  linked_existing_authorized_ticket: boolean
  /** Applied to the existing workspace Ticket list without erasing a just-created Ticket. */
  rejectLegacyTicketAsAuthority?: true
}
