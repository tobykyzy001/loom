import { reactive, toRefs } from 'vue'
import { ApiError, LoomClient } from '../api/client'
import { acceptSourceTicketReceipt, auditFrom, artifactFrom, defaultTicketId, grantsFrom, memoriesFrom, nodesFrom, preferencesFrom, projectFrom, projectsFrom, sourceEventFrom, sourceReceiptFrom, sourceRegistrationFrom, sourceThreadFrom, rejectSourceSpecMismatch, sourceWorkBodyFrom, ticketFrom, ticketResponseFrom, ticketsFrom } from '../api/parsing'
import type { ArtifactContent, ArtifactRef, AuditEntry, Bootstrap, Grant, GrantOperation, InstallObservationRequest, InstallTarget, InstallPlan, InstallPlanData, InstallPlanPolicy, ModelInventoryData, LoomNode, Memory, NewTicket, Page, Preferences, Project, ProjectBindingInput, ProjectMode, SkillCandidate, SkillWorkspaceData, SourceEvent, SourceInstance, SourceInstanceInput, SourceThread, SourceTicketReceipt, SourceWorkDraft, Ticket } from '../api/types'
import { PAGE_KEY, TICKET_KEY, TOKEN_KEY, cachedExpanded, localRead, localWrite } from '../lib/storage'
import { safeRelativePath } from '../lib/format'
import { SkillActions, type SkillWorkspaceReference } from '../lib/skillActions'
import { InstallPlanActions, type InstallPlanRefresh } from '../lib/installPlan'
import { modelReadError, parseModelInventory } from '../lib/modelInventory'
import { canRetryTicket } from '../lib/retryControl'
export interface WorkspaceState {
  page: Page
  installPlans: InstallPlan[]
  installPlanPolicy: InstallPlanPolicy | null
  modelInventory: ModelInventoryData | null
  expanded: boolean
  selectedTicketId: string | null
  ticket: Ticket | null
  bootstrap: Bootstrap | null
  projects: Project[]
  tickets: Ticket[]
  nodes: LoomNode[]
  memories: Memory[]
  candidateMemories: unknown
  grants: Grant[]
  audit: AuditEntry[]
  artifacts: Record<string, ArtifactContent>
  preferences: Preferences
  skillData: SkillWorkspaceData | null
  connected: boolean | null
  credentialState: 'unknown' | 'checking' | 'valid' | 'required'
  busy: Record<string, boolean>
  errors: Record<string, string>
  /** A newly accepted Source-linked Ticket, independent from a legacy intake ticket_id. */
  sourceTicketToOpen: string | null
  sourceTicketReceipt: SourceTicketReceipt | null
}

const pages: Page[] = ['conversation', 'activity', 'devices', 'projects', 'plans', 'memories', 'skills', 'access', 'help']
const savedPage = localRead(PAGE_KEY) as Page
const state = reactive<WorkspaceState>({
  page: pages.includes(savedPage) ? savedPage : 'conversation',
  expanded: cachedExpanded(),
  selectedTicketId: localRead(TICKET_KEY),
  ticket: null, bootstrap: null, projects: [], tickets: [], nodes: [], memories: [], candidateMemories: null, grants: [], audit: [], artifacts: {}, skillData: null,
  installPlans: [], installPlanPolicy: null, modelInventory: null,
  preferences: { expanded: cachedExpanded(), sender_filter: null }, connected: null, credentialState: 'unknown', busy: {}, errors: {}, sourceTicketToOpen: null, sourceTicketReceipt: null,
})
let credentialEpoch = 0
let credentialCandidate: string | null = null
let authentication: Promise<boolean> | null = null
const client = new LoomClient({
  token: () => credentialCandidate ?? localRead(TOKEN_KEY) ?? '',
  credentialEpoch: () => credentialEpoch,
})
const skillActions = new SkillActions(client)
const installActions = new InstallPlanActions(client)
let detailVersion = 0
let runDetailVersion = 0
let sourceIdentityEpoch = 0
const retainedSourceIds = new Map<string, string>()
const rememberedSourceThreads = new Map<string, { source_id: string; client_thread_id: string }>()
const recordRequests = new Map<string, string>()
// Only bounded opaque IDs are retained locally; raw user text and tokens never enter storage.
let refreshInFlight: Promise<void> | null = null
function rethrowCredentialFailure(error: unknown): void {
  if (error instanceof ApiError && (error.status === 401 || error.code === 'credential_epoch_changed')) throw error
}
let poll: ReturnType<typeof setInterval> | undefined

const writesNeedingCredentials = new Set(['project', 'composer', 'source-write', 'ticket-write', 'grant-write', 'memory-write', 'binding-write', 'skill-write', 'plan-write', 'enrollment'])
function preferenceScope(ticketId?: string) { return ticketId ? `ticket:${ticketId}` : 'global' }
function preferenceWriteKey(ticketId?: string) { return ticketId ? `preferences:ticket:${ticketId}` : 'preferences:global' }
function preferenceReadKey(ticketId?: string) { return `${preferenceWriteKey(ticketId)}:read` }
function preferenceCacheKey(ticketId?: string) { return `loom.preferences:${ticketId ?? 'global'}` }
function writeNeedsCredentials(key: string): boolean {
  // A preference read must still run against the authenticated server even when
  // a candidate token is being checked. It only becomes a rejection after the
  // actual 401, rather than blocking that read as though it were a write.
  if (key.startsWith('preferences:') && key.endsWith(':read')) return false
  return writesNeedingCredentials.has(key) || key === 'preferences:global' || key.startsWith('preferences:ticket:')
}

async function run<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
  if (state.busy[key]) return undefined
  const busyKey = key.startsWith('detail:') ? 'detail' : key
  if (writeNeedsCredentials(key) && state.credentialState !== 'valid') {
    state.errors[busyKey] = '请先完成连接认证，再发起这个操作。旧任务未被取消，新的执行也未被创建。'
    return undefined
  }
  const epoch = credentialEpoch
  // Existing run preserves accepted write responses while rejecting stale reads.
  state.busy[key] = true
  state.busy[busyKey] = true
  state.errors[key] = ''
  try {
    const result = await action()
    if (epoch !== credentialEpoch) return result
    if (result !== false && state.credentialState !== 'required') {
      if (key === 'workspace') state.errors.workspace = ''
      state.connected = true
      if (!authentication || key === 'workspace') state.credentialState = 'valid'
    }
    return result
  } catch (error) {
    if (epoch !== credentialEpoch || (error instanceof ApiError && error.code === 'credential_epoch_changed')) {
      if (writeNeedsCredentials(key)) state.errors[key] = '凭据已变化。若服务端曾接受写入，只能使用相同的 Source event 与完整冻结参数明确重放；不能改绑或假定执行状态。'
      return undefined
    }
    state.errors[key] = error instanceof Error ? error.message : '操作未完成，请稍后重试。'
    if (error instanceof ApiError) {
      if (error.status === 0) {
        state.connected = false
        state.credentialState = 'unknown'
      }
      if (error.status === 401) {
        // Protected data is not verified merely because it is cached locally.
        state.credentialState = 'required'
        state.connected = null
        state.errors[key] = '客户端凭据已失效。请更新连接设置；已加载的任务仅是先前快照，不能当作最新状态。'
      }
    }
    return undefined
  } finally {
    state.busy[key] = false
    if (busyKey === key || !Object.entries(state.busy).some(([name, busy]) => name.startsWith('detail:') && busy)) state.busy[busyKey] = false
  }
}

export async function loadAudit(id: string) {
  const version = detailVersion
  const result = await run('audit', async () => client.get<unknown>(`/audit?ticket_id=${encodeURIComponent(id)}`))
  if (result === undefined) return false
  if (version !== detailVersion || state.selectedTicketId !== id || state.ticket?.id !== id) return false
  state.audit = auditFrom(result)
  return true
}

// `state.expanded` is only the global default. `state.preferences` is the
// effective view for the selected Ticket (or the global view when none is selected).
let globalPreferenceVersion = 0
const ticketPreferenceVersions = new Map<string, number>()
interface AcceptedPreference extends Preferences { has_override: boolean }
const acceptedPreferences = new Map<string, AcceptedPreference>()
const preferenceReads = new Map<string, Promise<void>>()
const preferenceWrites = new Map<string, PreferenceWrite>()
interface PreferenceWrite {
  promise: Promise<boolean>
  previous: Preferences
}
function acceptedPreference(scope: string): AcceptedPreference {
  const existing = acceptedPreferences.get(scope)
  if (existing?.has_override || scope === 'global') {
    return existing ? { ...existing } : { expanded: state.expanded, sender_filter: null, has_override: false }
  }
  // An effective no-row view must follow the current default. Its old bool is
  // only an inherited display snapshot, never a user's per-Ticket override.
  return { expanded: state.expanded, sender_filter: existing?.sender_filter ?? null, has_override: false }
}
function commitPreference(scope: string, value: Preferences, hasOverride: boolean) {
  acceptedPreferences.set(scope, { ...value, has_override: hasOverride })
  const ticketId = scope.startsWith('ticket:') ? scope.slice('ticket:'.length) : undefined
  // Only an actual explicit override can be cached as a task-specific choice.
  // A default effective value is not manufactured into a task override/permission.
  if (ticketId) localWrite(preferenceCacheKey(ticketId), hasOverride ? String(value.expanded) : null)
  else localWrite(preferenceCacheKey(), String(value.expanded))
}
function ticketPreferenceIsCurrent(ticketId: string): boolean {
  return state.selectedTicketId === ticketId && state.ticket?.id === ticketId
}
function installPreferenceRead(scope: string, action: () => Promise<void>): Promise<void> {
  const previous = preferenceReads.get(scope) ?? Promise.resolve()
  const current = previous.then(action, action)
  preferenceReads.set(scope, current)
  const cleanup = () => { if (preferenceReads.get(scope) === current) preferenceReads.delete(scope) }
  void current.then(cleanup, cleanup)
  return current
}
export async function readPreferences(ticketId?: string, readVersion?: number): Promise<void> {
  const scope = preferenceScope(ticketId)
  let version = readVersion
  if (ticketId) {
    if (version === undefined || !ticketPreferenceVersions.has(ticketId)) version = (ticketPreferenceVersions.get(ticketId) ?? 0) + 1
    if (version > (ticketPreferenceVersions.get(ticketId) ?? 0)) ticketPreferenceVersions.set(ticketId, version)
  } else version ??= ++globalPreferenceVersion
  // Queue only same-scope retries. The ordinary credential/run path handles
  // real direct 401 responses and preserves per-scope read errors independently.
  return installPreferenceRead(scope, () => run(preferenceReadKey(ticketId), () => fetchPreferences(version!, ticketId)))
}

function preferencePayload(ticketId: string | undefined, raw: unknown): { data: Preferences; hasOverride: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Preference response must be an object')
  const payload = raw as Record<string, unknown>
  if (typeof payload.has_override !== 'boolean') throw new TypeError('Preference response must identify the real per-Ticket override')
  if (ticketId) {
    if (payload.scope !== 'ticket' || payload.ticket_id !== ticketId) {
      throw new TypeError('Preference response does not belong to the selected Ticket')
    }
  } else if (payload.scope !== 'global' || payload.ticket_id !== null) {
    throw new TypeError('Global preference response must carry its own scope identity')
  }
  // Never translate an inherited effective bool into an implicit Ticket override.
  // Only an actual row/tested global default can map into has_override truthiness.
  return { data: preferencesFrom(raw), hasOverride: ticketId ? payload.has_override as boolean : false }
}

async function fetchPreferences(version: number, ticketId?: string) {
  const scope = preferenceScope(ticketId)
  const key = preferenceReadKey(ticketId)
  const currentVersion = ticketId ? ticketPreferenceVersions.get(ticketId) : globalPreferenceVersion
  if (version !== currentVersion) return
  // Outer run() owns this read key's busy lifecycle; do not lock it here twice.
  if (!ticketId) {
    const fallback = acceptedPreference(scope)
    state.expanded = fallback.expanded
    if (!state.selectedTicketId) state.preferences = fallback
  } else if (ticketPreferenceIsCurrent(ticketId)) state.preferences = acceptedPreference(scope)
  try {
    const suffix = ticketId ? `?ticket_id=${encodeURIComponent(ticketId)}` : ''
    const { data: value, hasOverride } = preferencePayload(ticketId,
      await client.get<unknown>(`/preferences${suffix}`))
    const currentVersion = ticketId ? ticketPreferenceVersions.get(ticketId) : globalPreferenceVersion
    // An older read in the same Ticket must not replace a newer response.
    // A current non-selected Ticket may update only its own verified cache,
    // never the selected Ticket or another scope below.
    if (version !== currentVersion) return
    // An actual explicit PUT in the same scope wins over this older GET snapshot.
    if (!state.busy[preferenceWriteKey(ticketId)]) {
      commitPreference(scope, value, hasOverride)
      if (ticketId) {
        if (ticketPreferenceIsCurrent(ticketId)) state.preferences = { ...value }
      } else {
        state.expanded = value.expanded
        state.preferences = state.selectedTicketId
          ? acceptedPreference(preferenceScope(state.selectedTicketId))
          : { ...value }
      }
    }
  } catch (error) {
    // Real 401/credential epoch errors go through common authentication handling;
    // non-credential errors such as 403 or malformed identity remain scoped degrade.
    rethrowCredentialFailure(error)
    const currentVersion = ticketId ? ticketPreferenceVersions.get(ticketId) : globalPreferenceVersion
    if (version === currentVersion && (!ticketId || ticketPreferenceIsCurrent(ticketId))) {
      const detail = error instanceof Error ? error.message : String(error)
      state.errors[key] = `显示偏好暂不可用，保留当前显示快照，不把它保存为该任务或全局的同步选择。${detail}`
    }
  }
}

export async function loadTicket(id: string) {
  const version = ++detailVersion
  const preferenceVersion = (ticketPreferenceVersions.get(id) ?? 0) + 1
  ticketPreferenceVersions.set(id, preferenceVersion)
  const value = await client.get<unknown>(`/tickets/${encodeURIComponent(id)}`)
  if (version !== detailVersion) return
  const ticket = ticketFrom(value)
  if (ticket.id !== id || state.selectedTicketId && state.selectedTicketId !== id) return
  state.ticket = ticket
  state.selectedTicketId = id
  localWrite(TICKET_KEY, id)
  await readPreferences(id, preferenceVersion)
  if (version === detailVersion && ticketPreferenceIsCurrent(id)) state.errors.detail = ''
}

export async function selectTicket(id: string, page: Page = 'conversation') {
  if (state.busy[`detail:${id}`]) return
  detailVersion++
  localWrite(TICKET_KEY, id)
  state.selectedTicketId = id
  state.ticket = null
  // Before the server verifies a Ticket override, this view merely inherits the
  // global default. Never treat a prior effective GET or fallback as a user choice.
  state.preferences = acceptedPreference(preferenceScope(id))
  state.errors.detail = ''
  state.artifacts = {}
  navigate(page)
  const version = ++runDetailVersion
  await run(`detail:${id}`, async () => {
    await loadTicket(id)
    if (version !== runDetailVersion || state.selectedTicketId !== id) return
    try {
      const value = await client.get<unknown>(`/audit?ticket_id=${encodeURIComponent(id)}`)
      if (version !== runDetailVersion || state.selectedTicketId !== id || state.ticket?.id !== id) return
      state.audit = auditFrom(value)
      state.errors.audit = ''
    } catch (error) {
      rethrowCredentialFailure(error)
      if (version !== runDetailVersion || state.selectedTicketId !== id || state.ticket?.id !== id) return
      state.audit = []; state.errors.audit = '此任务的审计暂不可用，不能据此认定没有审计记录。'
    }
  })
}

export async function refreshWorkspace() {
  await run('workspace', async () => {
    const value = await client.get<unknown>('/bootstrap')
    state.bootstrap = (value ?? {}) as Bootstrap
    const loadMemorySources = state.page === 'memories'
    const [projects, tickets, nodes, memories, grants, candidates] = await Promise.all([
      client.get<unknown>('/projects'), client.get<unknown>('/tickets'), client.get<unknown>('/nodes'),
      client.get<unknown>('/memories'), client.get<unknown>('/grants'),
      loadMemorySources ? client.get<unknown>('/candidates') : Promise.resolve(undefined),
    ])
    state.projects = projectsFrom(projects)
    state.tickets = ticketsFrom(tickets)
    state.nodes = nodesFrom(nodes)
    state.memories = memoriesFrom(memories)
    state.grants = grantsFrom(grants)
    if (loadMemorySources) state.candidateMemories = candidates
    const preferred = state.selectedTicketId ?? defaultTicketId(state.bootstrap)
    const id = preferred && state.tickets.some(ticket => ticket.id === preferred) ? preferred : null
    if (id) {
      await loadTicket(id)
      if (state.credentialState === 'required') throw new ApiError(401, 'unauthorized', state.errors[preferenceReadKey(id)] || '客户端凭据已失效。', '/preferences')
      const auditVersion = detailVersion
      try {
        const value = await client.get<unknown>(`/audit?ticket_id=${encodeURIComponent(id)}`)
        if (auditVersion !== detailVersion || state.selectedTicketId !== id || state.ticket?.id !== id || state.ticket?.id !== id) return
        state.audit = auditFrom(value)
        state.errors.audit = ''
      } catch (error) {
        rethrowCredentialFailure(error)
        if (auditVersion !== detailVersion || state.selectedTicketId !== id || state.ticket?.id !== id || state.ticket?.id !== id) return
        state.audit = []; state.errors.audit = '此任务的审计暂不可用，不能据此认定没有审计记录。'
      }
    } else {
      detailVersion++
      localWrite(TICKET_KEY, null)
      state.selectedTicketId = null
      state.ticket = null
      state.audit = []
      await readPreferences()
      if (state.credentialState === 'required') throw new ApiError(401, 'unauthorized', state.errors[preferenceReadKey()] || '客户端凭据已失效。', '/preferences')
    }
  })
}

export function refresh() {
  if (!refreshInFlight) refreshInFlight = refreshWorkspace().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

/** Validate a candidate using actual protected reads before committing it to local storage.
 * After the previous read settles, the candidate must pass actual protected reads before saving.
 * Verified write receipts remain controller facts even if credentials change while refreshing them.
 */
function credentialIsValid(): boolean { return state.credentialState === 'valid' }

export function reconnect(token: string): Promise<boolean> {
  if (authentication) return authentication
  authentication = (async () => {
    const candidate = token.trim()
    credentialEpoch++
    sourceIdentityEpoch++
    retainedSourceIds.clear()
    rememberedSourceThreads.clear()
    recordRequests.clear()
    state.sourceTicketToOpen = null
    state.sourceTicketReceipt = null
    credentialCandidate = candidate
    state.credentialState = 'checking'
    state.connected = null
    if (refreshInFlight) await refreshInFlight
    try {
      await refresh()
      if (!credentialIsValid()) return false
      localWrite(TOKEN_KEY, candidate || null)
      state.errors.workspace = ''
      return true
    } finally {
      credentialCandidate = null
      credentialEpoch++
    }
  })().finally(() => { authentication = null })
  return authentication
}

export function startPolling() {
  stopPolling()
  poll = setInterval(() => {
    const id = state.selectedTicketId
    const status = state.ticket?.status
    if (state.credentialState !== 'required' && document.visibilityState === 'visible' && state.page === 'conversation' && id && state.ticket?.id === id && status && ['pending', 'running', 'waiting_approval', 'cancel_requested', 'reconciling'].includes(status)) {
      void run('background', async () => {
        await loadTicket(id)
        const index = state.tickets.findIndex(ticket => ticket.id === id)
        if (index >= 0 && state.ticket) state.tickets[index] = state.ticket
      })
    }
  }, 12_000)
}
export function stopPolling() { if (poll) clearInterval(poll); poll = undefined }
export function navigate(page: Page) {
   state.page = page
  localWrite(PAGE_KEY, page)
}
export function startNewTicket() {
  detailVersion++
  runDetailVersion++
  localWrite(TICKET_KEY, null)
  state.selectedTicketId = null
  state.ticket = null
  // New Tickets have no row until an explicit PUT, so only show the global default.
  state.preferences = { ...acceptedPreference('global'), expanded: state.expanded }
  void readPreferences()
  navigate('conversation')
}

export async function createProject(input: { name: string; root: string; mode: ProjectMode }) {
  const result = await run('project', () => client.post<unknown>('/projects', input))
  if (result === undefined) return false
  const project = projectFrom(result)
  if (project) state.projects = [...state.projects, project]
  await refresh()
  startNewTicket()
  return true
}

export async function createTicket(input: NewTicket) {
  const body: NewTicket = {
    project_id: input.project_id, objective: input.objective.trim(), kind: input.kind,
    ...(input.relative_path ? { relative_path: input.relative_path.trim() } : {}),
    ...(input.kind === 'edit_file' ? { content: input.content } : {}),
  }
  const result = await run('composer', () => client.post<unknown>('/tickets', body))
  if (result === undefined) return false
  const ticket = ticketResponseFrom(result)
  if (ticket) {
    state.tickets = [ticket, ...state.tickets.filter(item => item.id !== ticket.id)]
    await selectTicket(ticket.id)
  } else await refresh()
  return true
}

function opaqueSourceId(value: string): string {
  if (!value || value.length > 160 || !/^[\w.:-]+$/u.test(value)) throw new Error('Source/thread/event ID 必须是非空、长度不超过 160 的受限 opaque ID。')
  return value
}
function sourceUUID(): string {
  const id = globalThis.crypto?.randomUUID?.()
  if (!id) throw new Error('浏览器无法生成 Source event 幂等 ID，尚未发送消息或 Ticket。')
  return `web-${id}`
}
export function sourceOperationError(): string {
  const write = state.errors['source-write']
  const read = state.errors['source-read']
  if (write && read && write !== read) return `${write} ${read}`
  return write || read || 'Source 操作未完成；没有创建 Ticket 或新 Grant。'
}

export async function registerSource(input: { source_key: string; kind: 'web'; label: string }): Promise<SourceInstance | null> {
  const epoch = sourceIdentityEpoch
  const result = await run('source-write', async () => {
    if (input.kind !== 'web' || !input.label.trim() || input.label.length > 160 || [...input.label].some(character => character < ' ' || character === '\u007f')) throw new Error('仅支持有明确 label 的 web Source。')
    const body: SourceInstanceInput = { schema: 'loom.source-instance.v1', source_key: opaqueSourceId(input.source_key), kind: 'web', label: input.label }
    const registration = sourceRegistrationFrom(await client.post<unknown>('/sources', body))
    if (registration.task_created || registration.permission_granted) throw new Error('Source 注册不能创建 Ticket 或授权。')
    retainedSourceIds.set(input.source_key, registration.source.id)
    return registration.source
  })
  return result !== undefined && epoch === sourceIdentityEpoch ? result : null
}
export async function ensureWebSource(sourceKey: string, label = 'User-authorized web messages'): Promise<SourceInstance | null> {
  return findWebSource(sourceKey, label)
}
export function rememberSourceThread(sourceId: string, threadId: string, eventId: string) {
  rememberedSourceThreads.set(opaqueSourceId(eventId), { source_id: opaqueSourceId(sourceId), client_thread_id: opaqueSourceId(threadId) })
}

export async function findWebSource(sourceKey: string, label = 'User-authorized web messages'): Promise<SourceInstance | null> {
  const key = opaqueSourceId(sourceKey)
  const epoch = sourceIdentityEpoch
  const result = await run('source-read', async () => {
    const cached = retainedSourceIds.get(key)
    if (cached) return { id: cached, source_key: key, kind: 'web' as const, label }
    let cursor: string | null = null
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ limit: '100' })
      if (cursor) { query.delete('limit'); query.set('source_cursor', cursor) }
      const value = sourceObjectForSource(await client.get<unknown>(`/sources?${query}`))
      const sources = value.sources
      if (!Array.isArray(sources)) throw new Error('Source 列表格式无效，未进行跨 Source 推断。')
      const found = sources.map(sourceRegistrationSummary).find(source => source.source_key === key && source.kind === 'web')
      if (found) { retainedSourceIds.set(key, found.id); return found }
      if (value.has_more !== true) return null
      const nextCursor: unknown = value.next_cursor
      cursor = typeof nextCursor === 'string' ? nextCursor : null
      if (typeof cursor !== 'string') throw new Error('Source 列表 cursor 无效。')
    }
    throw new Error('Source 列表超过有界页数，未继续全局读取。')
  })
  return result !== undefined && epoch === sourceIdentityEpoch ? result : null
}
function sourceObjectForSource(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source 响应不是对象。')
  return value as Record<string, unknown>
}
function sourceRegistrationSummary(source: unknown): SourceInstance {
  const value = sourceObjectForSource(source)
  if (typeof value.id !== 'string' || typeof value.source_key !== 'string' || value.kind !== 'web') throw new Error('Source 列表包含无效的 SourceInstance。')
  return { ...value, id: value.id, source_key: value.source_key, kind: 'web' } as SourceInstance
}

export async function recordSourceMessage(input: { source_id: string; thread_id: string; content: string }): Promise<SourceEvent | null> {
  const source = opaqueSourceId(input.source_id)
  const thread = opaqueSourceId(input.thread_id)
  const requestKey = `${source}\u0000${thread}\u0000${input.content}`
  /**
   * Idempotence is stable for this unsent/queued logical message. It is not retained
   * after settlement and is never a localStorage key or a reusable authority token.
   */
  const eventId = recordRequests.get(requestKey) ?? sourceUUID()
  const epoch = sourceIdentityEpoch
  recordRequests.set(requestKey, eventId)
  const result = await run('source-write', () => client.post<unknown>('/source-events', {
    schema: 'loom.source-event.v1', source_id: source, thread_id: thread,
    event_id: eventId, kind: 'user_message', content: input.content,
  }))
  recordRequests.delete(requestKey)
  if (result === undefined || epoch !== sourceIdentityEpoch) return null
  const event = sourceReceiptFrom(result)
  if (event.source_id !== source || event.client_thread_id !== thread) throw new Error('Source 接收回包不属于所选 Source/client thread，已拒绝。')
  rememberSourceThread(source, thread, event.id)
  return event
}

export async function loadSourceThread(sourceId: string, threadId: string, limit = 50, eventIds: string[] = []): Promise<SourceThread | null> {
  const source = opaqueSourceId(sourceId)
  const thread = opaqueSourceId(threadId)
  const pageSize = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : (() => { throw new Error('Source 单 thread 页大小必须在 1 到 200 之间。') })()
  const epoch = sourceIdentityEpoch
  const result = await run('source-read', () => {
    return client.get<unknown>(`/source-events?source_id=${encodeURIComponent(source)}&thread_id=${encodeURIComponent(thread)}&limit=${pageSize}`)
  })
  if (result === undefined) return null
  if (epoch !== sourceIdentityEpoch) throw new Error('凭据已变化，旧 Source 读取未用于新工作区。')
  const page = sourceThreadFrom(result, { source_id: source, client_thread_id: thread })
  for (const event of page.events) rememberSourceThread(source, thread, event.id)
  for (const eventId of eventIds) rememberSourceThread(source, thread, eventId)
  return page
}
export async function continueSourceThread(cursor: string, limit = 50, expected?: { source_id: string; client_thread_id: string }): Promise<SourceThread | null> {
  if (state.credentialState !== 'valid') {
    state.errors['source-read'] = '请重新认证后再读取 Source cursor。'
    return null
  }
  const id = opaqueSourceId(cursor)
  const pageSize = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : (() => { throw new Error('Source 单 thread 页大小必须在 1 到 200 之间。') })()
  const epoch = sourceIdentityEpoch
  if (!expected) {
    state.errors['source-read'] = '未知 cursor 不在本面板已核实的 Source/thread 内，不能猜测其范围。'
    return null
  }
  const result = await run('source-read', () => client.get<unknown>(`/source-events?cursor=${encodeURIComponent(id)}&limit=${pageSize}`))
  if (result === undefined) return null
  if (epoch !== sourceIdentityEpoch) throw new Error('凭据已变化，cursor 对应的旧读取未用于新工作区。')
  const raw = sourceObjectForSource(result)
  const page = sourceThreadFrom(result, expected)
  if (raw.next_cursor && raw.next_cursor !== page.next_cursor) throw new Error('Source cursor 响应无效。')
  return page
}

export function createSourceWorkTransport(sourceKey: string, threadId: string, label = 'User-authorized web messages') {
  const source = opaqueSourceId(sourceKey)
  const thread = opaqueSourceId(threadId)
  // Only this exact Source/client thread is registered/read. Cross-thread IDs never share a cached source context.
  return {
    async registerAndRecord(input: { thread_id: string; content: string }) {
      if (input.thread_id !== thread) throw new Error('只能向绑定的 exact client thread 记录。')
      const registered = await registerSource({ source_key: source, kind: 'web', label })
      if (!registered) return null
      return recordSourceMessage({ source_id: registered.id, thread_id: thread, content: input.content })
    },
    async readThread(input: { thread_id: string }) {
      if (input.thread_id !== thread) throw new Error('只能读取绑定的 exact client thread。')
      const registered = await ensureWebSourceThread(source, label, thread)
      if (!registered) return null
      return loadSourceThread(registered.id, thread, 200)
    },
  }
}
async function ensureWebSourceThread(sourceKey: string, label: string, thread: string): Promise<SourceInstance | null> {
  let existing = await findWebSource(sourceKey, label)
  if (!existing) {
    if (state.errors['source-read']) return null
    const registered = await registerSource({ source_key: sourceKey, kind: 'web', label })
    if (!registered) return null
    existing = registered
  }
  // Registration alone doesn't prove readability: the transport next performs
  // the exact source_id + client_thread_id protected read; it must not be nested.
  return existing
}

export async function createTicketFromSource(draft: SourceWorkDraft, sourceContext?: { source_id: string; client_thread_id: string }): Promise<SourceTicketReceipt | null> {
  let body: SourceWorkDraft
  try { body = sourceWorkBodyFrom(draft) } catch (error) {
    state.errors['source-write'] = error instanceof Error ? error.message : 'Source 创建参数无效，未发送 Ticket。'
    return null
  }
  const exactScope = sourceContext ?? draft.source_scope
  if (exactScope) {
    if (typeof exactScope.source_id !== 'string' || typeof exactScope.client_thread_id !== 'string') {
      state.errors['source-write'] = 'Source 工作缺少精确的 Source/client thread 类型，未发送 Ticket。'
      return null
    }
    try { rememberSourceThread(exactScope.source_id, exactScope.client_thread_id, body.source_event_id) }
    catch (error) {
      state.errors['source-write'] = error instanceof Error ? error.message : 'Source thread 无效，未发送 Ticket。'
      return null
    }
  }
  // Do not silently normalize this explicit file path or turn an empty worker into default.
  if (!safeRelativePath(body.relative_path)) {
    state.errors['source-write'] = 'Source 任务必须显式指定项目内安全相对路径。'
    return null
  }
  const requestEpoch = credentialEpoch
  if (state.credentialState !== 'valid') {
    state.errors['source-write'] = '请先完成连接认证，再发起这个操作。旧任务未被取消，新的执行也未被创建。'
    return null
  }
  const result = await run('source-write', async () => {
    if (!rememberedSourceThreads.has(body.source_event_id)) throw new ApiError(409, 'source_context_required', '无法确定此 Source event 的精确 Source/client thread；未发送 Ticket。', '/tickets')
    if (draft.source_event) {
      const scope = rememberedSourceThreads.get(body.source_event_id)
      // This client-only evidence bypasses a repeated GET, not the response
      // parser. A forged/syntactic lookalike must not bypass Source validation.
      const event = sourceEventFrom(draft.source_event)
      if (!scope || event.id !== body.source_event_id
        || event.source_id !== scope.source_id || event.client_thread_id !== scope.client_thread_id) {
        throw new ApiError(409, 'source_context_required', '传入的 Source event 与已验证的 exact Source/client thread 不一致，未发送 Ticket。', '/tickets')
      }
    }
    const matchingThread = draft.source_event ?? await findRecordedSourceEvent(body.source_event_id)
    if (!matchingThread || matchingThread.content !== body.objective || matchingThread.kind !== 'user_message') throw new Error('Source event 不存在或原文不完全一致，不能创建新任务。')
    if (matchingThread.task_ticket_id) {
      rejectSourceSpecMismatch(matchingThread, body)
      if (matchingThread.creation_kind !== 'explicit_task_created_after_intake' || matchingThread.task_digest !== matchingThread.task_spec?.digest) throw new Error('Source 已绑定事件的 task_digest / creation_kind 不完整，禁止重放或改绑。')
    }
    const grant = await findCurrentSourceGrant(body)
    if (!grant) throw new Error('Grant/Project/Node/Worker 不符合同一精确 read 授权；未发送 Ticket。')
    // Pre-read authorization in the same unchanged operation scope; a revoked
    // current Grant fails before POST while the controller remains authoritative.
    const response = await client.post<unknown>('/tickets', body)
    const accepted = acceptSourceTicketReceipt(response)
    if (accepted.source_event_id !== body.source_event_id || accepted.ticket.objective !== body.objective || accepted.ticket.kind !== body.kind || accepted.ticket.project_id !== body.project_id || accepted.ticket.relative_path !== body.relative_path) throw new Error('回包 Ticket 与 requested Source objective/scope 不一致，未将其加入工作区。')
    const currentSpec = matchingThread.task_ticket_id ? matchingThread.task_spec : null
    if (currentSpec && (accepted.ticket.id !== currentSpec.ticket_id || accepted.task_digest !== currentSpec.digest || !accepted.duplicate || accepted.task_created || !accepted.linked_existing_authorized_ticket)) throw new Error('回包不是原 immutable spec 的精确 duplicate Ticket。')
    if (!currentSpec && (matchingThread.task_ticket_id || accepted.duplicate || !accepted.task_created || accepted.linked_existing_authorized_ticket)) throw new Error('未绑定 Source event 不能声称已有任务或重复。')
    for (const assignment of accepted.ticket.assignments ?? []) {
      if (assignment.ticket_id !== accepted.ticket.id || assignment.node_id !== body.node_id) throw new Error('回包 Assignment 与显式 Node/Ticket 不一致。')
    }
    return accepted
  })
  if (result === undefined) return null
  const receipt = result
  // An accepted response is a controller receipt, not a read snapshot. Do not discard it solely because credentials rotated.
  state.sourceTicketReceipt = receipt
  state.sourceTicketToOpen = receipt.ticket.id
  if (requestEpoch === credentialEpoch) {
    state.tickets = [receipt.ticket, ...state.tickets.filter(ticket => ticket.id !== receipt.ticket.id)]
    // Reconcile after run('source-write') settles. Never nest source-read here:
    // the receipt remains a fact even when this independent read later fails.
    await updateRecordedTask(receipt, body.source_event_id)
  } else if (state.errors['source-write'] === '') {
    state.errors['source-write'] = '已接收 Ticket 回包，但凭据随后改变；旧会话没有更新 Ticket 列表。请先验证连接，不把快照当最新状态。'
  }
  return receipt
}
async function findRecordedSourceEvent(id: string): Promise<SourceEvent | null> {
  const scope = rememberedSourceThreads.get(id)
  if (!scope) return null // Never globally guess or mix another Source/client thread.
  // Already inside source-write: use its single awaited read, then the same
  // source-write finally clears busy. Never clear busy in an inner nested run.
  const result = await client.get<unknown>(`/source-events?source_id=${encodeURIComponent(scope.source_id)}&thread_id=${encodeURIComponent(scope.client_thread_id)}&limit=200`)
  const page = sourceThreadFrom(result, scope)
  for (const event of page.events) rememberSourceThread(scope.source_id, scope.client_thread_id, event.id)
  rememberSourceThread(scope.source_id, scope.client_thread_id, id)
  return page.events.find(event => event.id === id) ?? null
}
async function findCurrentSourceGrant(body: SourceWorkDraft): Promise<Grant | null> {
  // Re-read the exact Grant, not a guessed replacement. Await this part of
  // source-write's own HTTP chain directly. The selector and controller also
  // check the root/binding/Node, without a nested cross-key busy operation.
  const grantValues = await client.get<unknown>('/grants')
  const value = grantsFrom(grantValues)
  const grant = value.find(candidate => candidate.id === body.grant_id)
  if (!grant || (grant.revoked_at !== null && grant.revoked_at !== undefined) || (grant.status !== undefined && grant.status !== 'active')
    || typeof grant.project_binding_id !== 'string' || !grant.project_binding_id
    || !Array.isArray(grant.operations) || !grant.operations.includes('read')) return null
  if (grant.project_id !== body.project_id || grant.node_id !== body.node_id || grant.node_id === 'auto'
    || typeof grant.worker_id !== 'string' || grant.worker_id !== body.worker_id) return null
  if (typeof grant.installation_id !== 'string' || !grant.installation_id) return null
  return { ...grant }
}
async function updateRecordedTask(receipt: SourceTicketReceipt, eventId: string): Promise<void> {
  const scope = rememberedSourceThreads.get(eventId)
  if (!scope) return
  const page = await loadSourceThread(scope.source_id, scope.client_thread_id, 200)
  if (!page) return // Preserve source-read authentication/scope errors; accepted receipt remains unchanged.
  const event = page.events.find(candidate => candidate.id === receipt.source_event_id)
  if (!event || event.task_ticket_id !== receipt.ticket.id) {
    state.errors['source-read'] = 'Ticket 已接受，但 Source 中尚未核实独立 task_ticket_id。legacy ticket_id 不是授权，运行中也不代表已完成。'
  }
}
export function consumeSourceTicketOpen(): string | null {
  const id = state.sourceTicketToOpen
  state.sourceTicketToOpen = null
  return id
}

export async function cancelTicket(id: string) {
  const result = await run('ticket-write', () => client.post<unknown>(`/tickets/${encodeURIComponent(id)}/cancel`))
  if (result === undefined) return false
  await selectTicket(id)
  return true
}

export async function retryTicket(id: string) {
  // Re-read the currently selected Ticket when the deferred confirmation runs.
  // Never turn an unsupported/stopped Ticket or another selection into a new Attempt.
  const current = state.selectedTicketId === id ? state.ticket : null
  if (!current || current.id !== id || !canRetryTicket(current)) {
    state.errors['ticket-write'] = '只有真正失败且没有停止意图的任务才能创建新尝试；未知结果请先核对已有副作用。'
    return false
  }
  const result = await run('ticket-write', () => client.post<unknown>(`/tickets/${encodeURIComponent(id)}/retry`))
  if (result === undefined) return false
  await selectTicket(id)
  return true
}

export async function decideApproval(id: string, decision: 'approve' | 'reject', reason: string) {
  const result = await run('ticket-write', () => client.post<unknown>(`/tickets/${encodeURIComponent(id)}/approval`, { approval_id: crypto.randomUUID(), decision, reason }))
  if (result === undefined) return false
  await selectTicket(id)
  return true
}

export async function loadArtifact(ticketId: string, artifact: ArtifactRef) {
  const result = await run(`artifact:${artifact.artifact_id}`, async () => {
    const value = await client.get<unknown>(`/tickets/${encodeURIComponent(ticketId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}`)
    return artifactFrom(value)
  })
  if (result) state.artifacts = { ...state.artifacts, [artifact.artifact_id]: result }
}

export async function updatePreferences(expanded: boolean, senderFilter: string, ticketId?: string) {
  const scope = preferenceScope(ticketId)
  const key = preferenceWriteKey(ticketId)
  // The per-scope writer starts from its own confirmed state snapshot.
  if (state.busy[key] || preferenceWrites.has(scope)) return false
  const previous = acceptedPreference(scope)
  const value: Preferences = { ...previous, expanded, sender_filter: senderFilter || null }
  if (ticketId) {
    if (state.selectedTicketId === ticketId) state.preferences = { ...value }
  } else {
    state.expanded = expanded
    state.preferences = state.selectedTicketId
      ? acceptedPreference(preferenceScope(state.selectedTicketId))
      : { ...value }
  }
  localWrite(preferenceCacheKey(ticketId), String(expanded))
  const suffix = ticketId ? `?ticket_id=${encodeURIComponent(ticketId)}` : ''
  // Capture the fixed request state. A later selection or an independent global PUT
  // must not change this operation's rollback target.
  let promise: Promise<boolean>
  promise = run(key, () => client.put<unknown>(`/preferences${suffix}`, { expanded, sender_filter: senderFilter || null }))
    .then(result => {
      // run reports a pending HTTP result or an undefined failed request.
      const write = preferenceWrites.get(scope)
      // Ignore the unrelated scope while completing a deferred request.
      state.busy[key] = false
      if (write?.promise !== promise) return result !== undefined
      preferenceWrites.delete(scope)
      if (result !== undefined) {
        // A completed explicit PUT is the user's override, not an inherited fallback.
        commitPreference(scope, value, ticketId !== undefined)
        if (!ticketId && state.selectedTicketId) state.preferences = acceptedPreference(preferenceScope(state.selectedTicketId))
        return true
      }
      // Roll back this exact scope and only its actual prior override (if any).
      acceptedPreferences.set(scope, previous)
      const cachedNow = cachedExpanded(ticketId)
      if (cachedNow === value.expanded) {
        if (ticketId && previous.has_override) localWrite(preferenceCacheKey(ticketId), String(previous.expanded))
        else if (ticketId) localWrite(preferenceCacheKey(ticketId), null)
        else localWrite(preferenceCacheKey(), String(previous.expanded))
      }
      if (!ticketId) {
        state.expanded = previous.expanded
        if (state.selectedTicketId) state.preferences = acceptedPreference(preferenceScope(state.selectedTicketId))
      }
      if (ticketId ? state.selectedTicketId === ticketId : !state.selectedTicketId) state.preferences = { ...previous }
      return false
    })
  preferenceWrites.set(scope, { previous, promise })
  return promise
}

async function applyMemoryChange(action: () => Promise<unknown>) {
  const refreshed = await run('memory-write', async () => {
    await action()
    const loaded = await loadResources()
    if (!loaded) {
      // Keep the confirmation/error visible; do not pretend stale state is verified.
      const detail = state.errors.resources || '资源暂时不可用'
      state.errors['memory-write'] = `服务端已接受这次操作，但最新状态尚未刷新：${detail}`
    }
    return loaded
  })
  return refreshed === true
}

export async function reviewMemoryCandidate(candidateId: string, decision: string) {
  return applyMemoryChange(() => client.patch<unknown>(`/candidates/${encodeURIComponent(candidateId)}`, { decision }))
}

export async function saveMemory(input: { id?: string; project_id?: string | null; scope: string; content: string }) {
  return applyMemoryChange(() => input.id
    ? client.patch<unknown>(`/memories/${encodeURIComponent(input.id!)}`, { content: input.content, project_id: input.project_id, scope: input.scope })
    : client.post<unknown>('/memories', input))
}
export async function deleteMemory(id: string) {
  return applyMemoryChange(() => client.delete<unknown>(`/memories/${encodeURIComponent(id)}`))
}
export async function createGrant(input: { project_id: string; operations: GrantOperation[]; ticket_id?: string; node_id?: string; worker_id?: string; project_binding_id?: string }) {
  const result = await run('grant-write', () => client.post<unknown>('/grants', input))
  if (result === undefined) return false
  await loadResources()
  return true
}
export async function createProjectBinding(input: ProjectBindingInput) {
  const result = await run('binding-write', () => client.post<unknown>('/project-bindings', input))
  if (result === undefined) return false
  await refresh()
  return true
}
export async function revokeGrant(id: string) {
  const result = await run('grant-write', () => client.post<unknown>(`/grants/${encodeURIComponent(id)}/revoke`))
  if (result === undefined) return false
  const receipt = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : null
  if (receipt?.revoked !== true || receipt.grant_id !== id) {
    state.errors['grant-write'] = '协调器未确认这个精确 Grant 的撤销；保留先前授权快照，不将其显示为撤销成功。'
    return false
  }
  const refreshed = await loadResources()
  if (!refreshed) {
    state.errors['grant-write'] = '中心已确认撤销，但最新授权列表未刷新；当前卡片只有先前快照，不意味着授权仍然有效。'
    return false
  }
  return true
}

export async function createEnrollmentCode() { return run('enrollment', () => client.post<unknown>('/enrollment-codes', {})) }
export async function loadResources() {
  const result = await run('resources', async () => {
    const [nodes, memories, grants, candidates] = await Promise.all([client.get<unknown>('/nodes'), client.get<unknown>('/memories'), client.get<unknown>('/grants'), client.get<unknown>('/candidates')])
    state.nodes = nodesFrom(nodes); state.memories = memoriesFrom(memories); state.grants = grantsFrom(grants); state.candidateMemories = candidates
    return true
  })
  return result === true
}

export async function loadSkillEvidence(reference = skillActions): Promise<boolean> {
  const result = await run('skills', () => reference.read())
  if (result === undefined) return false
  state.skillData = result.data
  state.tickets = result.tickets
  return true
}

export async function startSkillReplay(candidate: SkillCandidate, sourceTicketId: string, reference: SkillWorkspaceReference = skillActions): Promise<boolean> {
  const result = await run('skill-write', () => reference.replay(candidate, sourceTicketId))
  if (result === undefined) return false
  state.skillData = result.data
  state.tickets = result.tickets
  return true
}

export async function reviewSkill(candidate: SkillCandidate, decision: 'accept' | 'reject' | 'undo', reference: SkillWorkspaceReference = skillActions): Promise<boolean> {
  const result = await run('skill-write', () => reference.review(candidate, decision))
  if (result === undefined) return false
  state.skillData = result.data
  state.tickets = result.tickets
  return true
}

export async function loadInstallPlans(): Promise<boolean> {
  const result = await run('plans', () => installActions.list())
  return applyPlans(result)
}
function applyPlans(result?: InstallPlanRefresh): boolean {
  if (result === undefined) return false
  state.installPlans = result.plans
  state.installPlanPolicy = result.policy
  return true
}
export async function createInstallPlan(selected: string[]): Promise<boolean> {
  return applyPlans(await run('plan-write', () => installActions.create(selected)))
}
export async function approveInstallTarget(plan: InstallPlan, target: InstallTarget): Promise<boolean> {
  return applyPlans(await run('plan-write', () => installActions.approve(plan, target)))
}
export async function rollbackInstallTarget(plan: InstallPlan, target: InstallTarget): Promise<boolean> {
  return applyPlans(await run('plan-write', () => installActions.rollback(plan, target)))
}
export async function observeInstallTarget(plan: InstallPlan, target: InstallTarget, request: InstallObservationRequest): Promise<boolean> {
  const policy = state.installPlanPolicy
  if (!policy) {
    state.errors['plan-write'] = '尚未读取合成 Inventory 的边界策略，未记录观察。'
    return false
  }
  return applyPlans(await run('plan-write', () => installActions.observe(plan, target, request, policy)))
}

export async function loadModelInventory(): Promise<boolean> {
  const result = await run('models', async () => {
    try {
      const response = parseModelInventory(await client.get<unknown>('/model-inventory'))
      if (!response) throw new Error('模型目录的响应不符合已支持的只读观察协议，未加载目录。')
      state.modelInventory = response
      return true
    } catch (error) {
      throw new Error(modelReadError(error))
    }
  })
  return result !== undefined
}

export function useWorkspace() { return { state, ...toRefs(state) } }
