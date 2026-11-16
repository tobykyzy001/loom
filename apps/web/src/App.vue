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
import EmptyState from './components/EmptyState.vue'
import TicketDetail from './views/TicketDetail.vue'
import ActivityView from './views/ActivityView.vue'
import DevicesView from './views/DevicesView.vue'
import ProjectsView from './views/ProjectsView.vue'
import MemoriesView from './views/MemoriesView.vue'
import AccessView from './views/AccessView.vue'
import HelpView from './views/HelpView.vue'
import { useWorkspace, refresh, navigate, startNewTicket, selectTicket, createTicket, createProject, updatePreferences, cancelTicket, retryTicket, decideApproval, loadArtifact, createEnrollmentCode, createGrant, createProjectBinding, revokeGrant, startPolling, stopPolling, saveMemory, deleteMemory, loadResources } from './state/workspace'
import { heartbeatStale, nodeConnected } from './lib/format'
import { grantOperationsSummary } from './lib/permissions'
import type { Grant, GrantOperation, NewTicket, Page, Project, ProjectBindingInput, ProjectMode } from './api/types'

const { state, ticket, projects, tickets, nodes, bootstrap, expanded } = useWorkspace()
const showProjects = ref(false)
const showConnection = ref(false)
const bindingProject = ref<Project | null>(null)
const bindingNotice = ref('')
const showMore = ref(false)
const confirmation = ref<Confirmation | null>(null)
const pendingAction = ref<(() => Promise<boolean>) | null>(null)
const devicesView = ref<InstanceType<typeof DevicesView>>()
const confirmationBusy = computed(() => state.busy['ticket-write'] || state.busy['grant-write'] || state.busy['memory-write'] || state.busy['binding-write'])
const confirmationError = computed(() => state.errors['ticket-write'] || state.errors['grant-write'] || state.errors['memory-write'] || state.errors['binding-write'] || state.errors.confirm)
const greeting = computed(() => new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好')
const principalName = computed(() => bootstrap.value?.principal?.display_name ?? bootstrap.value?.principal?.name ?? bootstrap.value?.identity?.name ?? bootstrap.value?.identity?.principal ?? '个人工作空间')
const protocolName = computed(() => bootstrap.value?.client_api ?? bootstrap.value?.api ?? bootstrap.value?.protocol_version ?? bootstrap.value?.version ?? '协议版本未知')
const nodeStatus = computed(() => !state.connected ? '未连接' : !nodes.value.length ? '未注册节点' : nodes.value.some(n => nodeConnected(n.status) && !heartbeatStale(n.last_heartbeat ?? n.last_seen_at)) ? '节点在线' : '节点离线')
const navItems: { page: Page; label: string; icon: IconName }[] = [
  { page: 'conversation', label: '对话', icon: 'conversation' }, { page: 'activity', label: '活动', icon: 'activity' },
  { page: 'devices', label: '设备', icon: 'devices' }, { page: 'projects', label: '项目', icon: 'projects' },
  { page: 'memories', label: '记忆', icon: 'memories' }, { page: 'access', label: '权限', icon: 'access' },
]
const ticketOpen = computed(() => state.page === 'conversation' && !!state.selectedTicketId)

function ask(confirm: Confirmation, action: () => Promise<boolean>) { confirmation.value = confirm; pendingAction.value = action; state.errors.confirm = '' }
async function confirm() {
  const action = pendingAction.value
  if (!action) return
  const succeeded = await action()
  if (succeeded) { confirmation.value = null; pendingAction.value = null; state.errors.confirm = '' }
}
function cancelConfirm() { confirmation.value = null; pendingAction.value = null; state.errors.confirm = '' }
function changePage(page: Page) {
  showMore.value = false
  navigate(page)
  if (['devices', 'access', 'memories'].includes(page)) void loadResources()
  if (page === 'projects') void refresh()
}
function selectTask(id: string) { void selectTicket(id, 'conversation') }
function ticketCancel() {
  const id = ticket.value?.id
  if (!id) return
  ask({ title: '取消这项任务？', effect: '持久记录取消意图并禁止新执行。已经产生的副作用与对账证据会保留。', changes: ['取消意图与此 Ticket 关联', '未被节点响应前不标记为完成取消'], danger: true, confirmLabel: '确认取消任务' }, () => cancelTicket(id))
}
function ticketRetry() {
  const id = ticket.value?.id
  if (!id || !['failed', 'reconciling'].includes(ticket.value!.status)) return
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
function onConnectionSaved() { showConnection.value = false; void refresh() }
function onVisibility() { if (document.visibilityState === 'visible') void refresh() }
onMounted(() => {
  void refresh()
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
    <div v-if="state.errors.workspace" class="connection-banner" role="alert"><AppIcon name="warning" :size="17" /><span>{{ state.errors.workspace }}</span><button class="text-link" @click="void refresh()">重试</button><button class="button secondary small-button" @click="showConnection = true">连接设置</button></div>
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
        <ActivityPanel :class="{ 'mobile-inline-activity': ticketOpen }" :ticket="ticketOpen ? ticket : null" :audit="state.audit" :expanded="expanded" :preferences="state.preferences" :audit-error="state.errors.audit" @save="(value, sender) => void updatePreferences(value, sender, state.selectedTicketId ?? undefined)" />
      </template>
      <ActivityView v-else-if="state.page === 'activity'" :tickets="tickets" :projects="projects" :audit="state.audit" @select="selectTask" />
      <template v-else-if="state.page === 'devices'">
        <DevicesView ref="devicesView" :nodes="nodes" :busy="state.busy.enrollment" :loading="state.busy.resources" @enroll="void enroll()" />
        <p v-if="state.errors.enrollment" class="form-error" role="alert">{{ state.errors.enrollment }}</p>
      </template>
      <ProjectsView v-else-if="state.page === 'projects'" :projects="projects" :nodes="nodes" :expanded="expanded" :preferences-busy="state.busy.preferences" :binding-busy="state.busy['binding-write']" :notice="bindingNotice" @add="showProjects = true" @bind="bindingProject = $event; state.errors.confirm = ''" @create-grant="bindingNotice = ''; changePage('access')" @preference="value => void updatePreferences(value, '')" />
      <MemoriesView v-else-if="state.page === 'memories'" :memories="state.memories" :projects="projects" :busy="state.busy['memory-write']" :error="state.errors['memory-write'] || (!state.busy.resources ? state.errors.resources : '')" @save="value => void saveMemory(value)" @delete="removeMemory" />
      <AccessView v-else-if="state.page === 'access'" :grants="state.grants" :projects="projects" :nodes="nodes" :busy="state.busy['grant-write']" :error="state.errors['grant-write'] || (!state.busy.resources ? state.errors.resources : '')" @create="grantCreate" @revoke="revokeGrantWithConfirmation" />
      <HelpView v-else @connect="showConnection = true" />
      <p v-if="state.errors.preferences" class="preferences-error" role="status">{{ state.errors.preferences }}</p>
    </main>
    <button v-if="!ticketOpen" class="mobile-new-task button primary" aria-label="新建任务" @click="startNewTicket"><AppIcon name="plus" :size="20" /></button>
    <nav class="mobile-tabs" aria-label="移动端工作空间"><button v-for="item in navItems.slice(0, 4)" :key="item.page" :class="{ active: state.page === item.page }" :aria-current="state.page === item.page ? 'page' : undefined" @click="changePage(item.page)"><AppIcon :name="item.icon" :size="20" /><span>{{ item.label }}</span></button><button :class="{ active: showMore || ['memories', 'access', 'help'].includes(state.page) }" :aria-expanded="showMore" @click="showMore = !showMore"><AppIcon name="menu" :size="20" /><span>更多</span></button></nav>
    <nav v-if="showMore" class="mobile-more" aria-label="更多工作空间"><button v-for="item in navItems.slice(4)" :key="item.page" @click="changePage(item.page)"><AppIcon :name="item.icon" :size="18" />{{ item.label }}</button><button @click="changePage('help')"><AppIcon name="help" :size="18" />帮助</button><button @click="showMore = false; showConnection = true"><AppIcon name="settings" :size="18" />连接设置</button></nav>
    <ProjectDialog v-if="showProjects" :busy="state.busy.project" :error="state.errors.project" @close="showProjects = false" @submit="saveProject" />
    <ConnectionDialog v-if="showConnection" @saved="onConnectionSaved" />
    <ConfirmDialog :confirmation="confirmation" :busy="confirmationBusy" :error="confirmationError" @confirm="void confirm()" @cancel="cancelConfirm" />
    <ProjectBindingDialog v-if="bindingProject" :project="bindingProject" :nodes="nodes" :busy="state.busy['binding-write']" :error="confirmation ? '' : state.errors['binding-write']" @close="bindingProject = null" @submit="bindProject" />
  </div>
</template>
