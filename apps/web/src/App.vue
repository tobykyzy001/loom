<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon, { type IconName } from './components/AppIcon.vue'
import TicketList from './components/TicketList.vue'
import TicketComposer from './components/TicketComposer.vue'
import ActivityPanel from './components/ActivityPanel.vue'
import ProjectDialog from './components/ProjectDialog.vue'
import ProjectBindingDialog from './components/ProjectBindingDialog.vue'
import ConnectionDialog from './components/ConnectionDialog.vue'
import ConfirmDialog, { type Confirmation } from './components/ConfirmDialog.vue'
import SourceWorkPanel, { eligibleSourceGrant } from './components/SourceWorkPanel.vue'
import EmptyState from './components/EmptyState.vue'
import TicketDetail from './views/TicketDetail.vue'
import ActivityView from './views/ActivityView.vue'
import DevicesView from './views/DevicesView.vue'
import ProjectsView from './views/ProjectsView.vue'
import { memoryCandidates, memoryText, type MemoryCandidate, type ReviewDecision } from './lib/memoryCandidate'
import { skillSourceRefs } from './lib/skillProof'
import { reviewMemoryCandidate } from './state/workspace'
import MemoriesView from './views/MemoriesView.vue'
import InstallPlansView from './views/InstallPlansView.vue'
import SkillsView from './views/SkillsView.vue'
import AccessView from './views/AccessView.vue'
import HelpView from './views/HelpView.vue'
import { useWorkspace, refresh, reconnect, navigate, readPreferences, startNewTicket, selectTicket, createTicket, createProject, updatePreferences, cancelTicket, retryTicket, decideApproval, loadArtifact, createEnrollmentCode, createGrant, createProjectBinding, revokeGrant, startPolling, stopPolling, saveMemory, deleteMemory, loadResources, loadSkillEvidence, startSkillReplay, reviewSkill, loadInstallPlans, createInstallPlan, approveInstallTarget, rollbackInstallTarget, observeInstallTarget, loadModelInventory, createSourceWorkTransport, createTicketFromSource, sourceOperationError } from './state/workspace'
import { heartbeatStale, nodeConnected } from './lib/format'
import { grantOperationsSummary } from './lib/permissions'
import { canRetryTicket } from './lib/retryControl'
import type { Grant, GrantOperation, NewTicket, Page, Project, ProjectBindingInput, ProjectMode, SkillCandidate, InstallOutcome, InstallPlan, InstallTarget, SourceWorkDraft, Ticket } from './api/types'

const { state, ticket, projects, tickets, nodes, bootstrap, expanded } = useWorkspace()
const showProjects = ref(false)
const showConnection = ref(false)
const bindingProject = ref<Project | null>(null)
const sourcePanelOpen = ref(false)
const sourceTransport = createSourceWorkTransport('browser-source', 'browser-thread')
const sourceSubmitting = ref(false)
const sourceFeedback = ref('')
const bindingNotice = ref('')

const showMore = ref(false)
const confirmation = ref<Confirmation | null>(null)
const pendingAction = ref<(() => Promise<boolean>) | null>(null)
const devicesView = ref<InstanceType<typeof DevicesView>>()
const confirmationBusy = computed(() => state.busy['ticket-write'] || state.busy['grant-write'] || state.busy.resources || state.busy['memory-write'] || state.busy['binding-write'] || state.busy['skill-write'] || sourceSubmitting.value)
const confirmationError = computed(() => state.errors['ticket-write'] || state.errors['grant-write'] || state.errors['memory-write'] || state.errors['binding-write'] || state.errors['skill-write'] || state.errors.confirm)
const greeting = computed(() => new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好')
const principalName = computed(() => bootstrap.value?.principal?.display_name ?? bootstrap.value?.principal?.name ?? bootstrap.value?.identity?.name ?? bootstrap.value?.identity?.principal ?? '个人工作空间')
const protocolName = computed(() => bootstrap.value?.client_api ?? bootstrap.value?.api ?? bootstrap.value?.protocol_version ?? bootstrap.value?.version ?? '协议版本未知')
const nodeStatus = computed(() => {
  if (state.credentialState === 'required') return '需要认证'
  if (state.connected === null) return '尚未验证连接'
  return !state.connected ? '未连接' : !nodes.value.length ? '未注册节点' : nodes.value.some(n => nodeConnected(n.status) && !heartbeatStale(n.last_heartbeat ?? n.last_seen_at)) ? '节点在线' : '节点离线'
})
const navItems: { page: Page; label: string; icon: IconName }[] = [
  { page: 'conversation', label: '对话', icon: 'conversation' }, { page: 'activity', label: '活动', icon: 'activity' },
  { page: 'devices', label: '设备', icon: 'devices' }, { page: 'projects', label: '项目', icon: 'projects' },
  { page: 'plans', label: '部署', icon: 'shield' },
  { page: 'memories', label: '记忆', icon: 'memories' }, { page: 'skills', label: '技能', icon: 'sparkle' }, { page: 'access', label: '权限', icon: 'access' },
]
const ticketOpen = computed(() => state.page === 'conversation' && !!state.selectedTicketId)
const preferenceError = computed(() => Object.entries(state.errors).filter(([key, message]) => key.startsWith('preferences:') && message).map(([, message]) => message).join(' '))
const sourceError = computed(() => sourceFeedback.value || sourceOperationError())

let confirmationVersion = 0
function ask(confirm: Confirmation, action: () => Promise<boolean>) {
  confirmationVersion++
  confirmation.value = confirm
  pendingAction.value = action
  state.errors.confirm = ''
}
async function confirm() {
  const action = pendingAction.value
  const version = confirmationVersion
  if (!action || confirmationBusy.value) return
  const succeeded = await action()
  if (version !== confirmationVersion) return
  if (succeeded) { confirmation.value = null; pendingAction.value = null; state.errors.confirm = '' }
}
function cancelConfirm() {
  if (confirmationBusy.value) return
  confirmationVersion++
  confirmation.value = null
  pendingAction.value = null
  state.errors.confirm = ''
}
function changePage(page: Page) {
  showMore.value = false
  navigate(page)
  if (page === 'devices') void loadModelInventory()
  if (['devices', 'access', 'memories'].includes(page)) void loadResources()
  if (page === 'projects') { void refresh(); void readPreferences() }
  if (page === 'skills') void loadSkillEvidence()
  if (page === 'plans') void loadInstallPlans()
}
function selectTask(id: string) { void selectTicket(id, 'conversation') }
function skillReplay(candidate: SkillCandidate, sourceTicketId: string) {
  ask({ title: '确认这次有限回放？', effect: '仅读取相同原始样本，不修改文件，创建一个新的普通 read_summary Ticket。不是运行任意代码，不创建 Grant，也不会由浏览器启动 Worker。', changes: [`原始任务：${sourceTicketId}`, '生成独立 Ticket 与（节点报告后）可能的 Artifact', '提交后回到此候选；需显式刷新以观察真实报告'], confirmLabel: '确认发起普通只读回放' }, () => startSkillReplay(candidate, sourceTicketId))
}
function skillReview(candidate: SkillCandidate, decision: 'accept' | 'reject' | 'undo') {
  const replay = state.skillData?.skill_replays.find(item => item.candidate_id === candidate.id)
  ask({
    title: decision === 'accept' ? '接受这项回放证据？' : decision === 'undo' ? '撤销已保存的审阅？' : '拒绝这个 Skill 候选？',
    effect: decision === 'accept' ? '保存原任务与真实新回放之间的只读证明。不会提供 Skill 运行、激活或后续执行权限。' : decision === 'undo' ? '移除保存的审阅结果，原任务、回放、Grant 和关联审计仍保留，不会删除历史事实。' : '只记录候选的审阅决定，不自动回放、不更改原任务、Memory 或 Grant。',
    changes: decision === 'accept' && replay ? [`原 Ticket：${replay.source_ticket_id}`, `回放 Ticket：${replay.replay_ticket_id}`, `SHA-256：${replay.expected_sha256}`] : [`Candidate：${candidate.id}`],
    danger: decision !== 'accept',
    confirmLabel: decision === 'accept' ? '确认保存证明' : decision === 'undo' ? '确认撤销审阅' : '确认拒绝候选',
  }, () => reviewSkill(candidate, decision))
}
function createPlan(ids: string[]) {
  ask({ title: '创建合成 Inventory 审阅计划？', effect: '只记录 Bare 0.1.0 候选包的审阅计划，不下载、不安装、不注册节点，也不会改变任何授权或真实主机。', changes: [`选中的 fixture：${ids.join('、')}`, '未选目标和不兼容目标分别保留自己的只读状态', '服务端将生成 ID 与不可变 plan_digest，之后再逐目标审阅。'], confirmLabel: '确认创建审阅计划' }, () => createInstallPlan(ids))
}
function approveTarget(plan: InstallPlan, target: InstallTarget) {
  ask({ title: '审阅此一个目标的 apply？', effect: '只为此目标绑定当前计划的快照。不是批准全部目标，也不使合成菜单变成执行授权。', changes: [`目标：${target.host_key} / ${target.id}`, `计划摘要：${plan.plan_digest}`, '签发仅计划用途的操作引用；需单独记录受控 fixture 观察。'], confirmLabel: '确认审阅此目标' }, () => approveInstallTarget(plan, target))
}
function rollbackTarget(plan: InstallPlan, target: InstallTarget) {
  ask({ title: '审阅此合成 apply 的回滚？', effect: '只记录对已有合成 apply 的回滚计划；不会在真实主机上回滚、不会改为已经回退的版本，也不撤销原观察记录。', changes: [`目标：${target.host_key} / ${target.id}`, `已知合成操作：${target.current_operation_id}`, '回滚仍需一次独立的合成观察。失联/未知操作不允许用于此操作。'], danger: true, confirmLabel: '确认审阅回滚' }, () => rollbackInstallTarget(plan, target))
}
function observeTarget(plan: InstallPlan, target: InstallTarget, operation: 'apply' | 'rollback', outcome: InstallOutcome) {
  ask({ title: '提交这条受控 fixture 观察？', effect: '这是一次由用户提供的 fixture 报告，仅服务端在合成模式开启时保存。不是主机遥测、真实安装结果或独立外部验证。', changes: [`目标：${target.host_key} / ${target.id}`, `操作：${operation}；报告：${outcome}`, outcome === 'connection_lost' ? '将保留 Unknown：需具名对账，不能自动再次执行或用另一结果重分类。' : '仅改变服务端此条合成计划的记录；不会安装或激活任何对象。'], danger: outcome !== 'healthy', confirmLabel: '确认记录合成观察' }, () => observeInstallTarget(plan, target, { target_id: target.id, operation, outcome }))
}
function openSourceWork() {
  sourceFeedback.value = ''
  sourcePanelOpen.value = true
}
function reviewSourceWork(draft: SourceWorkDraft) {
  const selected = state.grants.find(candidate => candidate.id === draft.grant_id)
  const grant = selected ? { ...selected, operations: [...selected.operations] } : undefined
  if (!eligibleSourceGrant(grant) || grant.project_id !== draft.project_id || grant.node_id !== draft.node_id || grant.worker_id !== draft.worker_id) {
    sourceFeedback.value = '所选 Grant/Node/Worker 不是同一可持续读取的精确授权，未创建 Ticket。'
    return
  }
  ask({
    title: '根据已保存消息创建只读摘要？',
    effect: '只使用下列已存在的文件读取授权；打开/记录消息本身没有创建任务。只有节点返回并送达 Report/Artifact 后，另行显示交付。',
    changes: [
      `Source event：${draft.source_event_id}`, `原文：${draft.objective}`,
      `Project：${draft.project_id}`, `显式文件：${draft.relative_path}`,
      `Grant / Binding：${grant.id} / ${grant.project_binding_id}`,
      `Node：${grant.node_id} / ${grant.installation_id ?? '由实体 Grant/Node 再次核验'}`,
      `Worker：${grant.worker_id}；kind=${draft.kind}`,
    ],
    confirmLabel: '确认创建只读摘要',
  }, async () => {
    if (sourceSubmitting.value) return false
    sourceSubmitting.value = true
    sourceFeedback.value = ''
    try {
      const result = await createTicketFromSource(draft)
      if (!result) {
        sourceFeedback.value = sourceOperationError()
        return false
      }
      return true
    } finally { sourceSubmitting.value = false }
  })
}
async function openSourceTicket(ticket: Ticket) {
  sourceFeedback.value = ''
  sourcePanelOpen.value = false
  await selectTicket(ticket.id)
}
function ticketCancel() {
  const id = ticket.value?.id
  if (!id) return
  ask({ title: '取消这项任务？', effect: '持久记录取消意图并禁止新执行。已经产生的副作用与对账证据会保留。', changes: ['取消意图与此 Ticket 关联', '未被节点响应前不标记为完成取消'], danger: true, confirmLabel: '确认取消任务' }, () => cancelTicket(id))
}
function ticketRetry() {
  const id = ticket.value?.id
  if (!id || !canRetryTicket(ticket.value)) return
  ask({ title: '创建一次明确的新尝试？', effect: '协调器创建新的 Attempt，系统不会由前端重放任何未知副作用。', changes: ['保留既有报告与证据', '重新核对匹配的 Grant 与 Lease'], confirmLabel: '创建新尝试' }, () => retryTicket(id))
}
function approval(decision: 'approve' | 'reject', reason: string) {
  const current = ticket.value
  if (!current) return
  ask({ title: decision === 'approve' ? '批准这次工作区操作？' : '拒绝这次工作区操作？', effect: decision === 'approve' ? '为当前 Ticket 作出一次性决定。原有项目 Grant 仍然生效，此操作不扩大长期授权。' : '拒绝本次请求，不增加执行权限。', changes: [reason, current.relative_path ? `目标：${current.relative_path}` : '仅限当前 Ticket'], danger: decision === 'reject', confirmLabel: decision === 'approve' ? '确认一次性批准' : '确认拒绝' }, () => decideApproval(current.id, decision, reason))
}
function grantCreate(value: { project_id: string; operations: GrantOperation[]; node_id?: string }) {
  ask({ title: '创建这个项目授权？', effect: '允许协调器在之前确认的精确节点绑定上匹配工作。这只是 Grant，不是执行中的 Lease，不会在前端自动执行任务。', changes: [`项目：${projects.value.find(p => p.id === value.project_id)?.name ?? value.project_id}`, `操作：${grantOperationsSummary(value.operations)}`, `节点：${value.node_id || '由协调器匹配合适的已有绑定'}`], confirmLabel: '确认创建 Grant' }, () => createGrant(value))
}
function bindProject(value: ProjectBindingInput) {
  const node = nodes.value.find(node => node.id === value.node_id)
  ask({ title: '确认这个精确的项目绑定？', effect: '仅确认项目 ID、所选 Node/Worker 与已注册根目录的对应关系，不授予读写权限。服务端会核对 host 的 inventory.project_roots 声明。', changes: [`项目：${bindingProject.value?.name ?? value.project_id}`, `项目根目录：${value.root_scope}`, `节点：${node?.name || value.node_id}（${value.node_id}）`, `Worker ID：${value.worker_id}`], confirmLabel: '确认绑定此位置' }, () => createProjectBinding(value)
    .then(succeeded => {
    if (succeeded) {
      bindingNotice.value = `已在节点 ${value.node_id} 为「${bindingProject.value?.name ?? value.project_id}」确认 Worker ${value.worker_id} 的资源绑定。下一步请单独创建 Grant；绑定本身不授予读写权限。`
      bindingProject.value = null
    }
    return succeeded
  }))
}
function revokeGrantWithConfirmation(grant: Grant) {
  ask({ title: '撤销这个项目授权？', effect: '拒绝此 Grant 下的新工作并围栏旧执行资格。已有审计、报告和待对账效果不会删除。', changes: [`项目：${projects.value.find(p => p.id === grant.project_id)?.name ?? grant.project_id}`, `操作：${grantOperationsSummary(grant.operations)}`], danger: true, confirmLabel: '确认撤销授权' }, () => revokeGrant(grant.id))
}
const memoryCandidateData = computed(() => memoryCandidates(state.candidateMemories))
function reviewCandidate(candidate: MemoryCandidate, decision: ReviewDecision) {
  const statusLabel = decision === 'accept' ? '接受后保存这条偏好？' : decision === 'never' ? '不再建议这个项目观察？' : decision === 'undo' && candidate.status === 'never' ? '允许重新审阅这项建议？' : decision === 'undo' ? '撤回由这条候选保存的偏好？' : decision === 'later' ? '稍后再审阅这项建议？' : '拒绝这项来源建议？'
  const sourceCount = skillSourceRefs(candidate.source_refs).length
  ask({
    title: statusLabel,
    effect: decision === 'accept' ? '明确保留一条来自项目观察的 Memory，不生成 Skill，不创建 Grant，不自动执行或学习任何历史会话。' : decision === 'undo' && candidate.status !== 'never' ? '仅撤回候选派生的 Memory，不伪造撤销历史 Ticket、Artifact 或执行权限。' : '只改变这个候选的审阅状态，不自动保存、执行、读取新秘密或生成授权。',
    changes: [`项目：${candidate.scope}`, sourceCount ? `真实来源 Ticket：${sourceCount} 个（可回查最早来源）` : '旧手工候选，未提供真实 Ticket 来源', memoryText(candidate) || '候选内容无效'],
    danger: decision !== 'accept',
    confirmLabel: decision === 'accept' ? '确认保存这条偏好' : decision === 'undo' && candidate.status === 'never' ? '确认恢复候选' : decision === 'undo' ? '确认撤回保存偏好' : decision === 'never' ? '确认不再建议' : decision === 'later' ? '确认稍后审阅' : '确认拒绝建议',
  }, () => reviewMemoryCandidate(candidate.id, decision))
}
function removeMemory(id: string) {
  ask({ title: '删除这条记忆？', effect: '只删除明确保存的偏好，不改变任务、审计或任何 Grant。', changes: ['该明细偏好不再存在于工作空间中。'], danger: true, confirmLabel: '删除这条记忆' }, () => deleteMemory(id))
}
async function enroll() {
  const result = await createEnrollmentCode()
  if (result) devicesView.value?.setEnrollment(result)
}
async function saveTicket(value: NewTicket) { await createTicket(value) }
async function saveProject(value: { name: string; root: string; mode: ProjectMode; confirm: boolean }) {
  if (await createProject({ name: value.name, root: value.root, mode: value.mode })) showProjects.value = false
}
async function onConnectionSaved(token: string) {
  if (await reconnect(token)) showConnection.value = false
}
function onVisibility() { if (document.visibilityState === 'visible') void refresh() }
onMounted(() => {
  void refresh()
  if (state.page === 'skills') void loadSkillEvidence()
  if (state.page === 'devices') void loadModelInventory()
  if (state.page === 'plans') void loadInstallPlans()
  startPolling()
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => { stopPolling(); document.removeEventListener('visibilitychange', onVisibility) })
</script>

<template>
  <div class="loom-app">
    <a class="skip-link" href="#workspace-content">跳到主要内容</a>
    <aside class="sidebar">
      <button class="brand-mark" aria-label="Loom 对话首页" @click="changePage('conversation')"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M10 6v20h13M10 16h10M17 6v20" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
      <span class="brand-name">loom<span>.</span></span>
      <nav class="main-nav" aria-label="工作空间"><button v-for="item in navItems" :key="item.page" class="nav-item" :class="{ active: state.page === item.page }" :aria-current="state.page === item.page ? 'page' : undefined" @click="changePage(item.page)"><AppIcon :name="item.icon" :size="20" /><span>{{ item.label }}</span></button></nav>
      <button class="nav-item help-nav" :class="{ active: state.page === 'help' }" @click="changePage('help')"><AppIcon name="help" :size="20" /><span>帮助</span></button>
      <button class="sidebar-avatar" aria-label="个人工作空间与连接设置" @click="showConnection = true">{{ principalName.slice(0, 1).toUpperCase() }}</button>
    </aside>
    <header class="workspace-header"><div class="workspace-heading"><h1>你的工作空间<span class="workspace-star">✧</span></h1><span class="workspace-subtitle">ALL YOUR WORK, ONE PLACE</span></div><div class="workspace-status"><span class="connection-pill" :class="{ offline: nodeStatus !== '节点在线' }"><span class="status-dot" :class="nodeStatus === '节点在线' ? 'active' : 'neutral'" />{{ nodeStatus }}</span><span class="protocol-muted">{{ protocolName }}</span><button class="identity-button" @click="showConnection = true"><span class="header-avatar">{{ principalName.slice(0, 1) }}</span><span>{{ principalName }}</span><AppIcon name="settings" :size="15" /></button></div></header>
    <div v-if="state.credentialState === 'required'" class="connection-banner auth-warning" role="alert"><AppIcon name="lock" :size="17" /><span><strong>需要更新客户端凭据。</strong>这里显示的任务和列表只是上次读取的数据，未验证为最新；不能凭此创建、授权、审批或重新执行。更新连接不会结束原处正在运行的Worker。</span><button class="button secondary small-button" @click="showConnection = true">更新凭据</button></div>
    <div v-else-if="state.errors.workspace" class="connection-banner" role="alert"><AppIcon name="warning" :size="17" /><span>{{ state.errors.workspace }}</span><button class="text-link" @click="void refresh()">重试</button><button class="button secondary small-button" @click="showConnection = true">连接设置</button></div>
    <main id="workspace-content" class="workspace-content" :class="{ 'has-selected-ticket': ticketOpen }" tabindex="-1">
      <div v-if="state.busy.workspace && !state.bootstrap" class="workspace-loading" role="status"><span class="logo-loader">l.</span><span class="spinner dark" /><p>正在连接你的工作空间…</p></div>
      <template v-else-if="state.page === 'conversation'">
        <section class="conversation-column" aria-label="任务对话">
          <div v-if="!ticketOpen" class="conversation-intro"><div class="greeting"><span class="greeting-symbol">✧</span><span>{{ greeting }}。</span></div><h1>把事情交给 Loom<span class="purple-period">。</span></h1><p class="intro-text">一个入口，调动你的计算网络。<br />不必追问每一步，结果与来路始终清晰。</p>
            <div v-if="!projects.length && !state.busy.workspace" class="first-project-callout"><AppIcon name="projects" :size="18" /><div><strong>先认识你的一个真实项目</strong><p>从已存在的目录开始，默认只读。不会用假数据填满这里。</p></div><button class="button secondary" @click="showProjects = true">添加项目<AppIcon name="arrow" :size="15" /></button></div>
            <TicketComposer v-if="projects.length" :projects="projects" :is-new="true" :busy="state.busy.composer" :error="state.errors.composer" @submit="saveTicket" @add-project="showProjects = true" />
            <div class="quiet-promise"><AppIcon name="shield" :size="14" />你的数据留在你的网络里，重要决定由你来做。</div>
          </div>
          <div v-if="ticketOpen && state.busy.detail" class="workspace-loading" role="status"><span class="spinner dark" /><p>正在读取任务与授权证据…</p></div>
          <EmptyState v-if="ticketOpen && !state.busy.detail && state.errors.detail" icon="warning" title="暂时无法读取这个任务" :description="state.errors.detail"><button class="button primary" @click="state.selectedTicketId && selectTask(state.selectedTicketId)">重新读取</button></EmptyState>
          <TicketDetail v-if="ticketOpen && ticket && !state.busy.detail" :ticket="ticket" :projects="projects" :artifacts="state.artifacts" :busy="state.busy['ticket-write']" :artifact-busy="Object.keys(state.busy).some(k => k.startsWith('artifact:') && state.busy[k])" :errors="state.errors" @cancel="ticketCancel" @retry="ticketRetry" @approve="approval" @artifact="artifact => ticket && void loadArtifact(ticket.id, artifact)" @close="startNewTicket" />
          <TicketList v-if="!ticketOpen" :tickets="tickets.slice(0, 20)" :projects="projects" :selected-id="state.selectedTicketId" @select="selectTask" />
        </section>
        <ActivityPanel :class="{ 'mobile-inline-activity': ticketOpen }" :ticket="ticketOpen ? ticket : null" :audit="state.audit" :expanded="ticketOpen ? state.preferences.expanded : expanded" :preferences="state.preferences" :preferences-busy="!!state.busy[state.selectedTicketId ? `preferences:ticket:${state.selectedTicketId}` : 'preferences:global']" :audit-error="state.errors.audit" @save="(value, sender) => { const id = state.selectedTicketId ?? undefined; void updatePreferences(value, sender, id) }" />
        <button v-if="!ticketOpen" class="button secondary source-open-button" @click="openSourceWork"><AppIcon name="conversation" :size="15" />打开受限 Source</button>
      </template>
      <InstallPlansView v-else-if="state.page === 'plans'" :plans="state.installPlans" :policy="state.installPlanPolicy" :loading="state.busy.plans" :busy="state.busy['plan-write']" :error="state.errors['plan-write']" :read-error="state.errors.plans" @create="createPlan" @approve="approveTarget" @rollback="rollbackTarget" @observe="observeTarget" @refresh="void loadInstallPlans()" />
      <ActivityView v-else-if="state.page === 'activity'" :tickets="tickets" :projects="projects" :audit="state.audit" @select="selectTask" />
      <template v-else-if="state.page === 'devices'">
        <DevicesView ref="devicesView" :nodes="nodes" :busy="state.busy.enrollment" :loading="state.busy.resources" :inventory="state.modelInventory" :inventory-loading="state.busy.models" :inventory-error="state.errors.models" @enroll="void enroll()" @refresh-inventory="void loadModelInventory()" />
        <p v-if="state.errors.enrollment" class="form-error" role="alert">{{ state.errors.enrollment }}</p>
      </template>
      <ProjectsView v-else-if="state.page === 'projects'" :projects="projects" :nodes="nodes" :expanded="expanded" :preferences-busy="state.busy['preferences:global']" :binding-busy="state.busy['binding-write']" :notice="bindingNotice" @add="showProjects = true" @bind="bindingProject = $event; state.errors.confirm = ''" @create-grant="bindingNotice = ''; changePage('access')" @preference="value => void updatePreferences(value, '')" />
      <SkillsView v-else-if="state.page === 'skills'" :data="state.skillData" :tickets="tickets" :projects="projects" :loading="state.busy.skills" :busy="state.busy['skill-write']" :error="!state.busy.skills ? state.errors.skills : ''" :load-error="state.errors.skills" @refresh="void loadSkillEvidence()" @replay="skillReplay" @review="skillReview" @ticket="selectTask" />
      <MemoriesView v-else-if="state.page === 'memories'" :memories="state.memories" :candidates="memoryCandidateData" :projects="projects" :busy="state.busy['memory-write']" :error="state.errors['memory-write'] || (!state.busy.resources ? state.errors.resources : '')" @save="value => void saveMemory(value)" @delete="removeMemory" @review="reviewCandidate" @source="selectTask" />
      <AccessView v-else-if="state.page === 'access'" :grants="state.grants" :projects="projects" :nodes="nodes" :busy="state.busy['grant-write']" :error="state.errors['grant-write'] || (!state.busy.resources ? state.errors.resources : '')" @create="grantCreate" @revoke="revokeGrantWithConfirmation" />
      <HelpView v-else @connect="showConnection = true" />
      <p v-if="preferenceError" class="preferences-error" role="status">{{ preferenceError }}</p>
    </main>
    <button v-if="!ticketOpen" class="mobile-new-task button primary" aria-label="新建任务" @click="startNewTicket"><AppIcon name="plus" :size="20" /></button>
    <nav class="mobile-tabs" aria-label="移动端工作空间"><button v-for="item in navItems.slice(0, 4)" :key="item.page" :class="{ active: state.page === item.page }" :aria-current="state.page === item.page ? 'page' : undefined" @click="changePage(item.page)"><AppIcon :name="item.icon" :size="20" /><span>{{ item.label }}</span></button><button :class="{ active: showMore || ['memories', 'skills', 'plans', 'access', 'help'].includes(state.page) }" :aria-expanded="showMore" @click="showMore = !showMore"><AppIcon name="menu" :size="20" /><span>更多</span></button></nav>
    <nav v-if="showMore" class="mobile-more" aria-label="更多工作空间"><button v-for="item in navItems.slice(4)" :key="item.page" @click="changePage(item.page)"><AppIcon :name="item.icon" :size="18" />{{ item.label }}</button><button @click="changePage('help')"><AppIcon name="help" :size="18" />帮助</button><button @click="showMore = false; showConnection = true"><AppIcon name="settings" :size="18" />连接设置</button></nav>
    <ProjectDialog v-if="showProjects" :busy="state.busy.project" :error="state.errors.project" @close="showProjects = false" @submit="saveProject" />
    <ConnectionDialog v-if="showConnection" :checking="state.credentialState === 'checking'" :error="state.errors.workspace" @saved="token => void onConnectionSaved(token)" @close="showConnection = false" />
    <ConfirmDialog :confirmation="confirmation" :busy="confirmationBusy" :error="confirmationError" @confirm="void confirm()" @cancel="cancelConfirm" />
    <ProjectBindingDialog v-if="bindingProject" :project="bindingProject" :nodes="nodes" :busy="state.busy['binding-write']" :error="confirmation ? '' : state.errors['binding-write']" @close="bindingProject = null" @submit="bindProject" />
    <Teleport to="body"><div v-if="sourcePanelOpen" class="modal-backdrop">
      <section class="modal source-work-modal" role="dialog" aria-modal="true" aria-labelledby="source-work-heading" @keydown.esc="!sourceSubmitting && (sourcePanelOpen = false)">
        <SourceWorkPanel :result="state.sourceTicketReceipt" :transport="sourceTransport" source-key="browser-source" thread-id="browser-thread" :projects="projects" :grants="state.grants" :nodes="nodes" :busy="sourceSubmitting || !!state.busy['source-write'] || !!state.busy['source-read']" :error="sourceError" @submit="reviewSourceWork" @open="ticket => void openSourceTicket(ticket)" @open-ticket="selectTask" @closed="sourcePanelOpen = false" />
      </section>
    </div></Teleport>
  </div>
</template>
