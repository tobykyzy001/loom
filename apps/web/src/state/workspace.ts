import { reactive, toRefs } from 'vue'
import { ApiError, LoomClient } from '../api/client'
import { auditFrom, artifactFrom, defaultTicketId, grantsFrom, memoriesFrom, nodesFrom, preferencesFrom, projectFrom, projectsFrom, ticketFrom, ticketResponseFrom, ticketsFrom } from '../api/parsing'
import type { ArtifactContent, ArtifactRef, AuditEntry, Bootstrap, Grant, GrantOperation, InstallObservationRequest, InstallTarget, InstallPlan, InstallPlanData, InstallPlanPolicy, LoomNode, Memory, NewTicket, Page, Preferences, Project, ProjectBindingInput, ProjectMode, SkillCandidate, SkillWorkspaceData, Ticket } from '../api/types'
import { PAGE_KEY, TICKET_KEY, TOKEN_KEY, cachedExpanded, localRead, localWrite } from '../lib/storage'
import { SkillActions, type SkillWorkspaceReference } from '../lib/skillActions'
import { InstallPlanActions, type InstallPlanRefresh } from '../lib/installPlan'
export interface WorkspaceState {
  page: Page
  installPlans: InstallPlan[]
  installPlanPolicy: InstallPlanPolicy | null
  expanded: boolean
  selectedTicketId: string | null
  ticket: Ticket | null
  bootstrap: Bootstrap | null
  projects: Project[]
  tickets: Ticket[]
  nodes: LoomNode[]
  memories: Memory[]
  grants: Grant[]
  audit: AuditEntry[]
  artifacts: Record<string, ArtifactContent>
  preferences: Preferences
  skillData: SkillWorkspaceData | null
  connected: boolean | null
  busy: Record<string, boolean>
  errors: Record<string, string>
}

const pages: Page[] = ['conversation', 'activity', 'devices', 'projects', 'plans', 'memories', 'skills', 'access', 'help']
const savedPage = localRead(PAGE_KEY) as Page
const state = reactive<WorkspaceState>({
  page: pages.includes(savedPage) ? savedPage : 'conversation',
  expanded: cachedExpanded(),
  selectedTicketId: localRead(TICKET_KEY),
  ticket: null, bootstrap: null, projects: [], tickets: [], nodes: [], memories: [], grants: [], audit: [], artifacts: {}, skillData: null,
  installPlans: [], installPlanPolicy: null,
  preferences: { expanded: cachedExpanded(), sender_filter: null }, connected: null, busy: {}, errors: {},
})
const client = new LoomClient({ token: () => localRead(TOKEN_KEY) ?? '' })
const skillActions = new SkillActions(client)
const installActions = new InstallPlanActions(client)
let detailVersion = 0
let refreshInFlight: Promise<void> | null = null
let poll: ReturnType<typeof setInterval> | undefined

async function run<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
  if (state.busy[key]) return undefined
  state.busy[key] = true
  state.errors[key] = ''
  try {
    const result = await action()
    state.connected = true
    return result
  } catch (error) {
    state.errors[key] = error instanceof Error ? error.message : '操作未完成，请稍后重试。'
    if (error instanceof ApiError) {
      if (error.status === 0) state.connected = false
      // HTTP 401 is expired credentials, not a reachable/online worker status.
    }
    return undefined
  } finally { state.busy[key] = false }
}

export async function loadAudit(id: string) {
  const result = await run('audit', async () => auditFrom(await client.get<unknown>(`/audit?ticket_id=${encodeURIComponent(id)}`)))
  if (result) state.audit = result
  return result !== undefined
}

async function fetchPreferences(ticketId?: string) {
  const suffix = ticketId ? `?ticket_id=${encodeURIComponent(ticketId)}` : ''
  const value = await client.get<unknown>(`/preferences${suffix}`)
  state.preferences = preferencesFrom(value)
  state.expanded = state.preferences.expanded
  localWrite(`loom.preferences:${ticketId ?? 'global'}`, String(state.expanded))
}

async function readPreferences(ticketId?: string) {
  state.expanded = cachedExpanded(ticketId)
  state.preferences = { expanded: state.expanded, sender_filter: null }
  state.errors.preferences = ''
  try { await fetchPreferences(ticketId) } catch {
    // A cached display preference may be used, but never masks Ticket status.
    state.errors.preferences = '显示偏好暂不可用，正在使用本地显示设置。'
  }
}

export async function loadTicket(id: string) {
  const version = ++detailVersion
  const value = await client.get<unknown>(`/tickets/${encodeURIComponent(id)}`)
  if (version !== detailVersion) return
  state.ticket = ticketFrom(value)
  state.selectedTicketId = id
  localWrite(TICKET_KEY, id)
  await readPreferences(id)
  state.errors.detail = ''
}

export async function selectTicket(id: string, page: Page = 'conversation') {
  if (state.busy.detail) return
  localWrite(TICKET_KEY, id)
  state.selectedTicketId = id
  state.ticket = null
  state.errors.detail = ''
  state.artifacts = {}
  navigate(page)
  await run('detail', async () => {
    await loadTicket(id)
    try {
      const value = await client.get<unknown>(`/audit?ticket_id=${encodeURIComponent(id)}`)
      state.audit = auditFrom(value)
      state.errors.audit = ''
    } catch { state.audit = []; state.errors.audit = '此任务的审计暂不可用，不能据此认定没有审计记录。' }
  })
}

export async function refreshWorkspace() {
  await run('workspace', async () => {
    const value = await client.get<unknown>('/bootstrap')
    state.bootstrap = (value ?? {}) as Bootstrap
    const [projects, tickets, nodes, memories, grants] = await Promise.all([
      client.get<unknown>('/projects'), client.get<unknown>('/tickets'), client.get<unknown>('/nodes'),
      client.get<unknown>('/memories'), client.get<unknown>('/grants'),
    ])
    state.projects = projectsFrom(projects)
    state.tickets = ticketsFrom(tickets)
    state.nodes = nodesFrom(nodes)
    state.memories = memoriesFrom(memories)
    state.grants = grantsFrom(grants)
    const preferred = state.selectedTicketId ?? defaultTicketId(state.bootstrap)
    const id = preferred && state.tickets.some(ticket => ticket.id === preferred) ? preferred : null
    if (id) {
      await loadTicket(id)
      try {
        const value = await client.get<unknown>(`/audit?ticket_id=${encodeURIComponent(id)}`)
        state.audit = auditFrom(value)
        state.errors.audit = ''
      } catch { state.audit = []; state.errors.audit = '此任务的审计暂不可用，不能据此认定没有审计记录。' }
    } else {
      detailVersion++
      localWrite(TICKET_KEY, null)
      state.selectedTicketId = null
      state.ticket = null
      state.audit = []
      await readPreferences()
    }
  })
}

export function refresh() {
  if (!refreshInFlight) refreshInFlight = refreshWorkspace().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

export function startPolling() {
  stopPolling()
  poll = setInterval(() => {
    const id = state.selectedTicketId
    const status = state.ticket?.status
    if (document.visibilityState === 'visible' && state.page === 'conversation' && id && status && ['pending', 'running', 'waiting_approval', 'cancel_requested', 'reconciling'].includes(status)) {
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
   localWrite(TICKET_KEY, null)
  state.selectedTicketId = null
  state.ticket = null
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

export async function cancelTicket(id: string) {
  const result = await run('ticket-write', () => client.post<unknown>(`/tickets/${encodeURIComponent(id)}/cancel`))
  if (result === undefined) return false
  await selectTicket(id)
  return true
}

export async function retryTicket(id: string) {
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
  const previous = { ...state.preferences }
  state.expanded = expanded
  state.preferences = { ...state.preferences, expanded, sender_filter: senderFilter || null }
  localWrite(`loom.preferences:${ticketId ?? 'global'}`, String(expanded))
  const suffix = ticketId ? `?ticket_id=${encodeURIComponent(ticketId)}` : ''
  const result = await run('preferences', () => client.put<unknown>(`/preferences${suffix}`, { expanded, sender_filter: senderFilter || null }))
  if (result === undefined) {
    state.preferences = previous
    state.expanded = previous.expanded
    localWrite(`loom.preferences:${ticketId ?? 'global'}`, String(previous.expanded))
    return false
  }
  return true
}

export async function saveMemory(input: { id?: string; project_id?: string | null; scope: string; content: string }) {
  const result = await run('memory-write', () => input.id
    ? client.patch<unknown>(`/memories/${encodeURIComponent(input.id!)}`, { content: input.content, project_id: input.project_id, scope: input.scope })
    : client.post<unknown>('/memories', input))
  if (result === undefined) return false
  await loadResources()
  return true
}
export async function deleteMemory(id: string) {
  const result = await run('memory-write', () => client.delete<unknown>(`/memories/${encodeURIComponent(id)}`))
  if (result === undefined) return false
  await loadResources()
  return true
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
  await loadResources()
  return true
}

export async function createEnrollmentCode() { return run('enrollment', () => client.post<unknown>('/enrollment-codes', {})) }
export async function loadResources() {
  const result = await run('resources', async () => {
    const [nodes, memories, grants] = await Promise.all([client.get<unknown>('/nodes'), client.get<unknown>('/memories'), client.get<unknown>('/grants')])
    state.nodes = nodesFrom(nodes); state.memories = memoriesFrom(memories); state.grants = grantsFrom(grants)
  })
  return result !== undefined
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

export function useWorkspace() { return { state, ...toRefs(state) } }
