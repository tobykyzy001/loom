<script lang="ts">
import { ApiError } from '../api/client'
import type { Grant, LoomNode, Project, SourceInstance, SourceWorkDraft } from '../api/types'

export type { SourceWorkDraft } from '../api/types'
export interface SourceWorkTransport {
  registerAndRecord(input: { thread_id: string; content: string }): Promise<SourceEvent | null>
  readThread(input: { thread_id: string }): Promise<SourceThread | null>
}

export function eligibleSourceGrant(grant: Grant | undefined): grant is Grant & { project_id: string; node_id: string; worker_id: string; project_binding_id: string } {
  if (!grant || !(['id', 'project_id', 'project_binding_id', 'node_id', 'worker_id', 'installation_id'] as const)
    .every(key => typeof grant[key] === 'string' && grant[key].length > 0)) return false
  if (grant.revoked_at !== null && grant.revoked_at !== undefined) return false
  if (grant.status !== undefined && grant.status !== 'active') return false
  if (grant.node_id === 'auto') return false
  return Array.isArray(grant.operations) && grant.operations.includes('read')
}

export function publishedSourceRoot(node: LoomNode | undefined, project: Project | undefined): string {
  if (!node || !project) return ''
  const canonical = node.inventory?.canonical_project_roots?.[project.id]
  if (typeof canonical === 'string') return canonical
  if (node.inventory?.canonical_project_roots) return ''
  const declared = node.inventory?.project_roots?.[project.id]
  return typeof declared === 'string' && declared === project.root ? declared : ''
}

export function sourceWorkError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '客户端凭据无效或已过期。请更新连接后重试；没有创建 Ticket 或新 Grant。'
    if (error.code === 'credential_epoch_changed') return '凭据已更新，旧请求没有用于更新此面板；没有创建 Ticket 或新 Grant。'
    if (error.code === 'source_definition_conflict' || error.code === 'source_event_conflict' || error.code === 'source_task_rebind') return `Source 身份或已冻结任务不一致：${error.message}`
    if (error.code === 'source_task_scope' || error.code === 'grant_scope' || error.code === 'operation_scope' || error.code === 'worker_scope' || error.code === 'placement_scope' || error.code === 'source_task_grant_required') return `Grant/Project/Node/Worker 授权范围不匹配：${error.message}。没有创建新 Grant。`
    if (error.code === 'source_task_path_required') return `必须明确选择项目内文件：${error.message}`
    if (error.code === 'preview_cursor_bound') return `Source/thread 范围不匹配：${error.message}`
    return error.message
  }
  return error instanceof Error && error.message ? error.message : '操作未完成。没有创建 Ticket、Grant 或 Artifact。'
}

/** Backend-backed, bounded one-Source transport. No Ticket Activity read or global polling. */
export function createWebSourceTransport(workspace: {
  registerSource(input: { source_key: string; kind: 'web'; label: string }): Promise<SourceInstance | null>
  recordSourceMessage(input: { source_id: string; thread_id: string; content: string }): Promise<SourceEvent | null>
  loadSourceThread(sourceId: string, threadId: string, limit?: number): Promise<SourceThread | null>
  ensureWebSource(sourceKey: string, label?: string): Promise<SourceInstance | null>
}, sourceKey: string, threadId: string, label = 'User-authorized web messages'): SourceWorkTransport {
  const failure = () => 'Source 操作未完成；请检查连接、认证与错误信息。没有创建 Ticket 或新 Grant。'
  return {
    async registerAndRecord(input) {
      if (input.thread_id !== threadId) throw new Error('transport 需要调用方保持同一精确 thread。')
      const source = await workspace.registerSource({ source_key: sourceKey, kind: 'web', label })
      if (!source) throw new Error(failure())
      const event = await workspace.recordSourceMessage({ source_id: source.id, thread_id: input.thread_id, content: input.content })
      if (!event) throw new Error(failure())
      return event
    },
    async readThread(input) {
      if (input.thread_id !== threadId) throw new Error('transport 需要调用方保持同一精确 thread。')
      const source = await workspace.ensureWebSource(sourceKey, label)
      if (!source) throw new Error(failure())
      const result = await workspace.loadSourceThread(source.id, input.thread_id, 50)
      if (result === null) throw new Error(failure())
      return result
    },
  }
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { safeRelativePath, statusLabel, statusToneFor } from '../lib/format'
import { sourceIntentFromEvent } from '../lib/sourceIntent'
import type { SourceEvent, SourceTicketReceipt, SourceThread } from '../api/types'
import { acceptSourceTicketReceipt, rejectSourceSpecMismatch } from '../api/parsing'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  transport: SourceWorkTransport
  projects: Project[]
  grants: Grant[]
  nodes: LoomNode[]
  sourceKey: string
  threadId: string
  /** Set only after the parent's second confirmation and protected workspace write. */
  result?: SourceTicketReceipt | null
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{
  submit: [draft: SourceWorkDraft]
  open: [ticket: import('../api/types').Ticket]
  'open-ticket': [ticketId: string]
  recorded: [event: SourceEvent]
  closed: []
}>()

const content = ref('')
const relativePath = ref('')
const selectedGrantId = ref('')
const thread = ref<SourceThread | null>(null)
const submittedEvent = ref<SourceEvent | null>(null)
const recordedEvent = ref<SourceEvent | null>(null)
const receipt = ref<SourceTicketReceipt | null>(null)
const opening = ref(false)
const recording = ref(false)
const submitting = ref(false)
const localError = ref('')
const eligibleGrants = computed(() => props.grants.filter(eligibleSourceGrant).filter(grant => props.projects.some(project => project.id === grant.project_id) && props.nodes.some(node => node.id === grant.node_id && (node.node_id ?? node.id) === grant.node_id && !node.revoked_at)))
const selectedGrant = computed(() => eligibleGrants.value.find(grant => grant.id === selectedGrantId.value))
const selectedProject = computed(() => props.projects.find(project => project.id === selectedGrant.value?.project_id))
const selectedNode = computed(() => props.nodes.find(node => node.id === selectedGrant.value?.node_id && node.installation_id === selectedGrant.value?.installation_id))
const nodeRoot = computed(() => publishedSourceRoot(selectedNode.value, selectedProject.value))
const selectedEvent = computed(() => submittedEvent.value)
const formError = computed(() => localError.value || props.error || '')
const showResult = computed(() => receipt.value?.ticket ?? null)
const intentMessage = ref('')
function reviewConsecutiveIntent(event: SourceEvent) {
  const previous = [...(thread.value?.events ?? [])].sort((a, b) => a.thread_sequence - b.thread_sequence)
    .find(item => item.source_id === event.source_id && item.thread_id === event.thread_id
      && item.client_thread_id === event.client_thread_id && item.thread_sequence === event.thread_sequence - 1)
  const exactGrantIds = eligibleGrants.value.filter(grant => {
    const project = props.projects.find(item => item.id === grant.project_id)
    const node = props.nodes.find(item => item.id === grant.node_id && item.installation_id === grant.installation_id)
    return !!node && !node.revoked_at && publishedSourceRoot(node, project) === project?.root
  }).map(grant => grant.id)
  const candidate = sourceIntentFromEvent(event, exactGrantIds, previous)

  if (candidate.kind === 'ready') {
    if (previous?.task_ticket_id || event.task_ticket_id) throw new Error('之前或授权补充消息已关联任务，不能通过新对话重绑或自动重放；请复查原 Spec。')
    if (previous) selectEvent(previous)
    relativePath.value = candidate.relativePath
    selectedGrantId.value = candidate.grantId
    intentMessage.value = `已从同 Source/thread 的连续两条真实消息准备 ${candidate.relativePath} 与精确 Grant。原始 Objective 仍是首句原文，确认前不会创建 Ticket。`
  } else if (candidate.kind === 'need-grant') {
    relativePath.value = candidate.relativePath
    intentMessage.value = '已确认受限读取路径；下一句可明确“用 Grant <完整ID>”，不会自动选择首个现有授权。'
  } else intentMessage.value = candidate.reason
}

watch([() => props.sourceKey, () => props.threadId], () => {
  thread.value = null
  submittedEvent.value = null
  receipt.value = null
  selectedGrantId.value = ''
  relativePath.value = ''
  content.value = ''
  localError.value = ''
  intentMessage.value = ''
})
// Never auto-select a Grant when the old selection disappears or another list loads.
watch(() => props.result, result => {
  if (!result) return
  try {
    receipt.value = acceptSourceTicketReceipt(result)
    submittedEvent.value = null
    emit('open', receipt.value.ticket)
  } catch (error) { localError.value = sourceWorkError(error) }
})
watch(eligibleGrants, grants => {
  if (selectedGrantId.value && !grants.some(grant => grant.id === selectedGrantId.value)) {
    selectedGrantId.value = ''
    intentMessage.value = ''
    localError.value = '原选 Grant 已不是可用的精确读取授权，请重新选择。'
  }
})

function authoritySnapshot(grant: Grant): SourceWorkDraft['authority_snapshot'] {
  if (!Number.isSafeInteger(grant.version) || (grant.version ?? 0) < 1 || typeof grant.digest !== 'string' || !/^[a-f0-9]{64}$/.test(grant.digest)
    || !grant.project_binding_id || !grant.installation_id) return undefined
  return { grant_version: grant.version!, grant_digest: grant.digest, project_binding_id: grant.project_binding_id, installation_id: grant.installation_id }
}
function requireGrant() {
  const grant = selectedGrant.value
  if (!grant) throw new Error('请选择一个未撤销、含 read 操作、具有实际 Binding、非 auto Node 和非空 Worker 的 Grant。')
  return grant
}
function selectEvent(event: SourceEvent) {
  // An intake legacy ticket_id is explicitly not work authority.
  submittedEvent.value = { ...event }
  content.value = event.content
  receipt.value = null
  localError.value = ''
}
function summarize(event: SourceEvent) {
  if (event.kind !== 'user_message') {
    localError.value = '只有已记录的 user_message 才能进入摘要确认。'
    return
  }
  selectEvent(event)
  if (!event.task_ticket_id) {
    try {
      reviewConsecutiveIntent(event)
    } catch (error) { localError.value = sourceWorkError(error); submittedEvent.value = null; return }
  }
  if (event.task_ticket_id && event.task_spec) {
    relativePath.value = event.task_spec.relative_path
    selectedGrantId.value = eligibleSourceGrant(props.grants.find(grant => grant.id === event.task_spec?.grant_id))
      ? event.task_spec.grant_id : ''
  }
  localError.value = ''
}
async function openThread() {
  if (opening.value || props.busy) return
  opening.value = true
  localError.value = ''
  try {
    const page = await props.transport.readThread({ thread_id: props.threadId })
    if (!page) throw new Error('单 Source/thread 读取未完成；请检查认证与错误信息。')
    if (page.source_id && page.events.some(event => event.source_id !== page.source_id || event.client_thread_id !== props.threadId)) throw new Error('返回的 Source/thread 范围不匹配，已拒绝跨线程显示。')
    thread.value = page
  } catch (error) { localError.value = sourceWorkError(error) }
  finally { opening.value = false }
}
async function recordMessage() {
  if (recording.value || opening.value || props.busy) return
  if (!content.value.trim()) { localError.value = '请输入完整消息。只记录消息，不创建 Ticket。'; return }
  recording.value = true
  localError.value = ''
  receipt.value = null
  submittedEvent.value = null
  recordedEvent.value = null
  try {
    const event = await props.transport.registerAndRecord({ thread_id: props.threadId, content: content.value })
    if (!event) throw new Error('Source 记录未完成；请检查认证与错误信息。没有创建 Ticket 或新 Grant。')
    if (event.task_created || event.permission_granted || event.ticket_id) {
      throw new Error('Source 接收回包含未预期的任务/授权关联；已停止，不把它当作新任务。')
    }
    // An initially empty source/key namespace is not yet a readable thread.
    // After the acceptor has actually written its first event, fetch that exact
    // persisted source/client thread and the event instead of inventing local
    // history or leaving the legitimate stale not-found error on display.
    const stored = await props.transport.readThread({ thread_id: props.threadId })
    if (!stored || !stored.events.some(row => row.id === event.id && row.content === event.content
      && row.source_id === event.source_id && row.client_thread_id === event.client_thread_id && row.thread_sequence === event.thread_sequence)) {
      throw new Error('Source 已接收，但未能从同一精确 thread 核对原事件；不会补造历史或任务授权。')
    }
    // Recording is not itself an explicit authorization-to-create; a distinct summarize click is required.
    thread.value = stored
    intentMessage.value = ''
    recordedEvent.value = event
    emit('recorded', event)
  } catch (error) { localError.value = sourceWorkError(error) }
  finally { recording.value = false }
}
function review() {
  localError.value = ''
  if (!selectedEvent.value) { localError.value = '请先明确点击「基于此消息创建摘要」。'; return }
  try {
    const grant = requireGrant()
    if (!relativePath.value || !safeRelativePath(relativePath.value)) throw new Error('必须显式填写项目内相对文件路径，不能使用绝对路径、反斜杠、空段或 ..。')
    if (!selectedProject.value || !selectedNode.value || !nodeRoot.value) throw new Error('节点尚未公开此 Project 的已登记 root，不能由消息推断目录或补建 Binding。')
    if (selectedProject.value.root && selectedProject.value.root !== nodeRoot.value) throw new Error('Project 与节点公开的 root 不一致；请检查既有授权，不能由面板改绑。')
    if (submittedEvent.value?.task_spec) {
      const spec = submittedEvent.value.task_spec
      if (spec.root_scope !== nodeRoot.value || spec.root_scope !== selectedProject.value.root) throw new Error('原 Source Work Spec 的 root 与当前授权公开 root 不同，不能把它重放到另一位置。')
      if (spec.installation_id !== selectedNode.value.installation_id || spec.installation_id !== selectedGrant.value?.installation_id) throw new Error('原 Source Work Spec 的 installation 与当前 Node/Grant 不一致，不能改绑复查。')
    }
  } catch (error) { localError.value = sourceWorkError(error) }
}
function submitReviewed() {
  const event = selectedEvent.value
  if (!event || submitting.value || props.busy) return
  review()
  if (localError.value || !selectedEvent.value) return
  const grant = selectedGrant.value!
  const draft: SourceWorkDraft = {
    source_event: event,
    source_event_id: event.id,
    objective: event.content,
    kind: 'read_summary',
    relative_path: relativePath.value,
    project_id: grant.project_id,
    grant_id: grant.id,
    node_id: grant.node_id,
    worker_id: grant.worker_id,
    source_scope: { source_id: event.source_id, client_thread_id: event.client_thread_id },
    authority_snapshot: authoritySnapshot(grant),
  }
  if (event.task_ticket_id) {
    try { rejectSourceSpecMismatch(event, draft) } catch (error) { localError.value = sourceWorkError(error); return }
  }
  reviewConsecutiveIntent(event)
  if (localError.value || !submittedEvent.value) { submitting.value = false; return }
  const confirmedGrant = selectedGrant.value
  if (!confirmedGrant || selectedGrantId.value !== grant.id || confirmedGrant.id !== grant.id || confirmedGrant.version !== grant.version) {
    localError.value = '已选择的精确 Grant 已变化或不可用，请重新审查；不会替换授权或创建任务。'
    return
  }
  submitting.value = true
  // Parent owns the protected second confirmation and sole POST /tickets call.
  emit('submit', draft)
  submitting.value = false
}
</script>

<template>
  <section class="source-work-panel" aria-labelledby="source-work-heading">
    <div class="section-heading"><h2 id="source-work-heading">受限 Web Source</h2><span class="eyebrow">SOURCE / USER MESSAGE</span></div>
    <p class="muted small">仅记录已认证 Web Source 的消息。打开、读取与记录都不会创建 Ticket、Grant、Assignment 或 Artifact。</p>
    <p class="mono small">Source: {{ sourceKey }} · exact client thread: {{ threadId }}</p>
    <label for="source-message">用户消息 <span class="muted">完整原文，服务端保存后不写入浏览器持久存储</span></label>
    <textarea id="source-message" v-model="content" rows="5" maxlength="16000" autocomplete="off" :disabled="opening || recording || busy" />
    <p class="hint">受限两句入口：先记录“读取 input.txt”等明确相对路径，再记录“用 Grant &lt;完整ID&gt;”。授权句只能接续同 thread 的紧贴上一条读取句，仍须你在下方二次确认；不会自动选第一个 Grant 或扩大权限。</p>
    <div class="button-row">
      <button class="button secondary" :disabled="opening || busy" @click="openThread">打开单 Source / thread</button>
      <button class="button secondary" :disabled="recording || opening || busy" @click="recordMessage">{{ recording ? '正在记录…' : '记录完整消息（不创建 Ticket）' }}</button>
    </div>
    <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
    <section v-if="thread" aria-label="此 Source thread 的有界消息">
      <h3>此 thread 的消息 <span class="count-pill">{{ thread.events.length }}</span></h3>
      <p class="hint">Source event 可见性与 Ticket Activity 过滤独立；这里不使用全局轮询，也不把私有接收记录渲染到 Ticket 活动。</p>
      <article v-for="event in thread.events" :key="event.id" class="source-event-card">
        <pre>{{ event.content }}</pre>
        <span class="mono tiny">{{ event.id }} · sequence {{ event.source_sequence }}</span>
        <span v-if="event.ticket_id" class="warning-note">未验证的历史接收关联（{{ event.ticket_id }}），不是任务授权。</span>
        <button class="button secondary small-button" @click="summarize(event)">基于此消息创建摘要</button>
        <button v-if="event.task_ticket_id" class="text-link" @click="summarize(event)">复查原 Source Work Spec / 精确 duplicate</button>
        <button v-if="event.task_ticket_id" class="text-link" @click="emit('open-ticket', event.task_ticket_id)">打开独立任务：{{ event.task_ticket_id }}</button>
      </article>
      <p v-if="!thread.events.length" class="muted small">此 thread 尚无已记录消息。</p>
    </section>
    <aside v-if="recordedEvent" class="source-recorded-state" aria-live="polite" role="status">
      已接收 Source event <span class="mono tiny">{{ recordedEvent.id }}</span>：delivery_stage={{ recordedEvent.delivery_stage }}，task_created=false，permission_granted=false。尚未创建 Ticket、Grant、Assignment 或 Artifact。需由此消息另行明确选择 read_summary、文件、Grant 与 Node/Worker。
    </aside>
    <p v-if="!eligibleGrants.length" class="form-error" role="alert">没有可同时验证 Project、非 auto Node、Worker、Binding 和 read 操作的未撤销 Grant。请先在权限页建立真实授权；此处不会新建 Grant。</p>
    <section class="source-review-card" aria-labelledby="source-review-heading" :data-selected-event="submittedEvent?.id">
      <h3 id="source-review-heading">明确选择并检查 read_summary</h3>
      <p class="hint">只有再次确认后才会向 Ticket API 提交。Project / Grant / Node / Worker 必须来自同一已公开授权，不能混搭。</p>
      <p v-if="intentMessage" class="hint" role="status" data-testid="consecutive-source-intent">{{ intentMessage }}</p>
      <label for="source-grant">现有精确读取 Grant <span class="muted">必选</span></label>
      <select id="source-grant" v-model="selectedGrantId" :disabled="busy || !!submittedEvent?.task_ticket_id"><option value="">请选择，不默认选择</option><option v-for="grant in eligibleGrants" :key="grant.id" :value="grant.id">{{ grant.id }} · Project {{ grant.project_id }} · Node {{ grant.node_id }} · Worker {{ grant.worker_id }}</option></select>
      <p v-if="!submittedEvent" class="hint">请记录当前完整消息，或在上方历史消息中明确点击「基于此消息创建摘要」。未选择已接收事件时只可审查授权，不可提交。</p>      <label for="source-relative-path">显式项目内文件路径 <span class="muted">必填，不默认 README</span></label>
      <input id="source-relative-path" v-model="relativePath" maxlength="512" autocomplete="off" placeholder="例如 notes/input.txt" :disabled="busy || !!submittedEvent?.task_ticket_id" />
      <button class="button secondary" :disabled="busy" @click="review">检查这条只读工作</button>
      <dl class="source-scope-confirmation">
        <div><dt>Project</dt><dd>{{ selectedProject?.name ?? '未选择' }} <span class="mono">{{ selectedGrant?.project_id ?? '' }}</span></dd></div>
        <div><dt>Project root（已公开登记）</dt><dd class="mono">{{ nodeRoot || 'Node 尚未公开此 Project root，不能推断' }}</dd></div>
        <div><dt>Grant / Binding</dt><dd class="mono">{{ selectedGrant?.id ?? '未选择' }} / {{ selectedGrant?.project_binding_id ?? '无 Binding，不可提交' }}</dd></div>
        <div><dt>Node / Worker</dt><dd class="mono">{{ selectedNode?.id ?? '未选择' }} / {{ selectedGrant?.worker_id || '无 Worker，不可提交' }}</dd></div>
        <div><dt>冻结路径</dt><dd class="mono">{{ relativePath || '必须显式填写' }}</dd></div>
      </dl>
      <p class="hint">root / binding 信息只展示既有授权公开事实；服务端会复核 Grant 对应 Binding 的 root、installation 与 identity，不从消息推理或修改。</p>
      <dl v-if="submittedEvent?.task_spec" class="source-scope-confirmation" aria-label="原 Source Work Spec 证据">
        <div><dt>Schema / created</dt><dd class="mono">{{ submittedEvent.task_spec.schema }} / {{ submittedEvent.task_spec.created_at }}</dd></div>
        <div><dt>Binding root / digest</dt><dd class="mono">{{ submittedEvent.task_spec.root_scope }} / {{ submittedEvent.task_spec.binding_digest }}</dd></div>
        <div><dt>Grant version / digest</dt><dd class="mono">{{ submittedEvent.task_spec.grant_version }} / {{ submittedEvent.task_spec.grant_digest }}</dd></div>
        <div><dt>Task digest / Ticket</dt><dd class="mono">{{ submittedEvent.task_spec.digest }} / {{ submittedEvent.task_spec.ticket_id }}</dd></div>
      </dl>
      <p v-if="submittedEvent?.task_ticket_id && !submittedEvent.task_spec" class="form-error" role="alert">已绑定独立任务，但完整原 task_spec 未见于 thread 响应，不能仅依据 Ticket ID 重放或确认任务完成。</p>
      <button class="button primary" :disabled="submitting || busy || !submittedEvent || !selectedGrant || !relativePath" @click="submitReviewed"><AppIcon name="shield" :size="16" />提交给父层，第二次确认后创建摘要</button>
    </section>
    <section v-if="showResult && receipt" class="source-receipt" aria-live="polite">
      <h3>{{ receipt.duplicate ? '返回同一已授权 Ticket（duplicate）' : '已受理，不代表任务完成' }}</h3>
      <span class="status-badge" :class="statusToneFor(showResult.status)">{{ statusLabel(showResult.status) }}</span>
      <p class="mono">Ticket {{ showResult.id }} · Task digest {{ receipt.task_digest }}</p>
      <p class="hint">task_created={{ receipt.task_created }}；linked_existing_authorized_ticket={{ receipt.linked_existing_authorized_ticket }}。无全局刷新或全局轮询；running / waiting_approval 均不显示为完成。</p>
    </section>
    <button class="text-link" @click="emit('closed')">关闭 Source 面板</button>
  </section>
</template>

<style scoped>
.source-work-panel { display: grid; gap: 13px; }
.source-work-panel textarea, .source-work-panel input, .source-work-panel select { width: 100%; box-sizing: border-box; }
.source-event-card { padding: 12px 0; border-top: 1px solid var(--line); display: grid; gap: 8px; }
.source-event-card pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; }
.source-review-card, .source-receipt { border: 1px solid var(--line); border-radius: 8px; padding: 16px; display: grid; gap: 12px; }
.source-scope-confirmation { margin: 0; display: grid; gap: 9px; }
.source-scope-confirmation > div { display: grid; grid-template-columns: minmax(125px, 35%) 1fr; gap: 8px; }
.source-scope-confirmation dd { margin: 0; overflow-wrap: anywhere; }
.tiny { font-size: 11px; }
</style>
