export type Page = 'conversation' | 'activity' | 'devices' | 'projects' | 'memories' | 'access' | 'help'
export type ProjectMode = 'read_only' | 'read_write'
export type TicketKind = 'read_summary' | 'edit_file'
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

export interface Project {
  id: string
  name: string
  mode: ProjectMode
  root?: string
  created_at?: string
}

export type GrantOperation = 'read_summary' | 'edit_file' | 'read_write'
export interface ProjectBindingInput {
  project_id: string
  node_id: string
  worker_id: string
  root_scope: string
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
  type?: string
  version?: number
  location?: string
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

export interface Message {
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
}

export interface Grant {
  id: string
  version?: number
  project_id: string
  ticket_id?: string
  node_id?: string
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
