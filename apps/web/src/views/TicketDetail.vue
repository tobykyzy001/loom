<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ArtifactContent, ArtifactRef, Project, Ticket } from '../api/types'
import { formatBytes, formatTime, projectName, reportStatusLabel, reportStatusTone, safeJson, statusLabel, statusToneFor as statusTone } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'

const props = defineProps<{ ticket: Ticket; projects: Project[]; artifacts: Record<string, ArtifactContent>; busy?: boolean; artifactBusy?: boolean; errors?: Record<string, string> }>()
const emit = defineEmits<{ cancel: []; retry: []; approve: ['approve' | 'reject', string]; artifact: [artifact: ArtifactRef]; close: [] }>()
const approvalReason = ref('')
const approvalOpen = ref(false)
const selected = ref<ArtifactRef | null>(null)
const label = computed(() => statusLabel(props.ticket.status))
const observation = computed(() => {
  const value = props.ticket.model_observation
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (value?.schema !== 'loom.model-observation.v1' || !value.provider.trim() || !value.model.trim() || !uuid.test(value.artifact_id)) return null
  return value
})
const observedArtifact = computed(() => {
  const current = observation.value
  if (!current) return null
  return props.ticket.artifacts?.find(artifact => artifact.artifact_id === current.artifact_id && artifact.ticket_id === props.ticket.id) ?? null
})
watch(() => props.ticket.id, () => { selected.value = null; approvalOpen.value = false; approvalReason.value = '' })

function showArtifact(artifact: ArtifactRef) { selected.value = artifact; emit('artifact', artifact) }
function requestApprove(decision: 'approve' | 'reject') {
  if (!approvalReason.value.trim()) return
  emit('approve', decision, approvalReason.value.trim())
  approvalOpen.value = false
  approvalReason.value = ''
}
</script>

<template>
  <section class="ticket-detail">
    <div class="detail-top"><button class="text-link mobile-back" @click="emit('close')"><AppIcon name="arrow" :size="15" />返回新任务</button><span class="ticket-id mono">Ticket / {{ ticket.id }}</span><span class="muted small">{{ formatTime(ticket.updated_at, true) }}</span></div>
    <div class="detail-title"><span class="status-badge" :class="statusTone(ticket.status)"><span class="status-dot" />{{ label }}</span><span class="eyebrow">{{ ticket.kind === 'edit_file' ? '控制写入' : ticket.kind === 'model_text' ? '受限文本模型调用' : '资料读取' }}</span></div>
    <h1>{{ ticket.objective }}</h1>
    <div class="detail-meta"><span><AppIcon name="projects" :size="14" />{{ projectName(projects, ticket.project_id) }}</span><span v-if="ticket.relative_path && ticket.kind !== 'model_text'" class="mono">{{ ticket.relative_path }}</span><span class="muted">第 {{ ticket.attempt }} 次尝试</span></div>

    <div v-if="ticket.cancel_requested && !['cancelled', 'failed'].includes(ticket.status)" class="inline-note neutral-note"><AppIcon name="clock" :size="16" /><span>取消意图已记录。等待执行节点响应，不会强迫任务显示为已取消。</span></div>

    <article v-if="ticket.status === 'waiting_approval'" class="approval-card">
      <span class="attention-symbol"><AppIcon name="clock" :size="24" /></span><span class="eyebrow">需要你决定 · 非敏感工作区操作</span><h2>{{ ticket.approval?.summary ?? ticket.approval?.operation ?? '确认本次工作区操作' }}</h2>
      <p>{{ ticket.approval?.reason ?? '请检查结果与影响范围。此按钮不是对话文字，也不会泛化为长期授权。' }}</p>
      <div class="effect-box"><span class="eyebrow">将改变的内容</span><ul><li v-if="ticket.relative_path">目标文件：{{ ticket.relative_path }}</li><li>授权范围：当前 Ticket 内的这次操作</li><li>{{ ticket.kind === 'edit_file' ? 'Loom 会按要求写入文本内容，但不超出此项目范围。' : '本次读取仅在该项目授权范围内进行。' }}</li></ul></div>
      <button class="button primary approval-start" :disabled="busy" @click="approvalOpen = !approvalOpen"><AppIcon name="shield" :size="16" />检查并决定</button>
      <div v-if="approvalOpen" class="approval-form"><label for="approval-reason">操作理由 <span class="muted">必填，写入审计</span></label><textarea id="approval-reason" v-model="approvalReason" rows="2" maxlength="1000" placeholder="例如：检查过目标文件与内容，允许本次写入。" /><div class="button-row"><button class="button secondary" :disabled="busy || !approvalReason.trim()" @click="requestApprove('reject')">拒绝本次操作</button><button class="button primary" :disabled="busy || !approvalReason.trim()" @click="requestApprove('approve')"><span v-if="busy" class="spinner" />批准，仅限这一次</button></div></div>
    </article>

    <div v-else-if="ticket.status === 'pending'" class="next-action-card neutral-action"><AppIcon name="clock" :size="20" /><div><h3>等待匹配的执行环境</h3><p>Ticket 已保存。还没有证据表明任务开始执行，也尚未产生交付。</p></div></div>
    <div v-else-if="ticket.status === 'running'" class="next-action-card active-action"><span class="pulse-icon"><AppIcon name="sparkle" :size="21" /></span><div><h3>正在处理这项任务</h3><p>执行状态来自结构化 Report。过程消息可以在右侧按需展开。</p></div></div>
    <div v-else-if="ticket.status === 'reconciling'" class="next-action-card warning-action"><AppIcon name="warning" :size="22" /><div><h3>执行结果未知，需要对账</h3><p>不要假定已经成功。重试只创建明确的新 Attempt，不会自动重放未知副作用。</p></div></div>
    <div v-else-if="ticket.status === 'failed'" class="next-action-card danger-action"><AppIcon name="warning" :size="22" /><div><h3>这项任务未能完成</h3><p>失败报告与已产生的证据都会保留，不会被成功消息覆盖。</p></div></div>
    <div v-else-if="ticket.status === 'cancelled'" class="next-action-card neutral-action"><AppIcon name="check" :size="21" /><div><h3>任务已取消</h3><p>取消意图和已有的执行证据仍然保留。</p></div></div>
    <div v-else-if="ticket.status === 'succeeded'" class="next-action-card success-action"><AppIcon name="check" :size="21" /><div><h3>收到成功报告</h3><p>{{ ticket.artifacts?.length ? '请检查交付内容与生成证据。' : '任务已收到成功状态；尚无可用 Artifact，报告可能只包含文本证据。' }}</p></div></div>
    <div v-if="errors?.['ticket-write']" class="inline-note danger-note" role="alert">{{ errors['ticket-write'] }}</div>
    <div class="detail-actions"><button class="button secondary" @click="emit('close')"><AppIcon name="plus" :size="15" />新的任务</button><div class="button-row"><button v-if="['running', 'pending', 'waiting_approval', 'reconciling'].includes(ticket.status)" class="button secondary" :disabled="busy || ticket.cancel_requested" @click="emit('cancel')"><AppIcon name="close" :size="15" />取消任务</button><button v-if="['failed', 'reconciling'].includes(ticket.status)" class="button secondary" :disabled="busy" @click="emit('retry')"><AppIcon name="refresh" :size="15" />明确新尝试</button></div></div>

    <section class="deliverables">
      <div class="section-heading"><h2>交付产物 <span class="count-pill">{{ ticket.artifacts?.length ?? 0 }}</span></h2><span class="tiny muted">AUTHORIZED ARTIFACTS</span></div>
      <div v-if="ticket.artifacts?.length" class="artifact-grid"><button v-for="artifact in ticket.artifacts" :key="artifact.artifact_id" class="artifact-card" @click="showArtifact(artifact)"><span class="artifact-icon"><AppIcon name="document" :size="22" /></span><div><strong>{{ artifact.type ?? '任务产物' }}</strong><span>{{ formatBytes(artifact.size_bytes) }}<template v-if="artifact.media_type"> · {{ artifact.media_type }}</template></span></div><AppIcon name="arrow" :size="17" /></button></div>
      <EmptyState v-else icon="document" title="没有可下载的产物" description="产物必须来自受控存储，并关联到此 Ticket。" />
      <div v-if="selected" class="artifact-viewer"><div class="artifact-viewer-top"><div><span class="eyebrow">纯文本查看器</span><h3>{{ selected.type ?? 'Artifact' }}</h3></div><button class="icon-button" aria-label="关闭产物查看" @click="selected = null"><AppIcon name="close" /></button></div><div v-if="errors?.[`artifact:${selected.artifact_id}`]" class="inline-note danger-note" role="alert">{{ errors[`artifact:${selected.artifact_id}`] }}</div><div v-else-if="artifactBusy" class="inline-note" role="status"><span class="spinner dark" />正在读取授权内容…</div><template v-else-if="artifacts[selected.artifact_id]"><div v-if="artifacts[selected.artifact_id].truncated" class="inline-note warning-note">内容已由服务端截断。显示的并非完整内容。</div><div v-if="artifacts[selected.artifact_id].encoding === 'base64'" class="inline-note">此产物以 base64 编码返回。为避免误解，原始编码按纯文本显示，不在浏览器中执行或渲染。</div><pre class="artifact-content" tabindex="0">{{ artifacts[selected.artifact_id].content }}</pre><pre class="artifact-metadata">{{ safeJson(artifacts[selected.artifact_id].metadata) }}</pre></template><div v-else class="inline-note">尚未读取产物正文。请重试。</div></div>
    </section>

    <section v-if="observation" class="report-section" aria-labelledby="model-observation-heading">
      <div class="section-heading"><h2 id="model-observation-heading">模型观察</h2><span class="muted tiny">HOST-REPORTED EVIDENCE</span></div>
      <article class="report-card">
        <p class="small">原任务报告引用的模型调用事实，不是模型 Registry、激活状态或可恢复授权。</p>
        <dl class="observation-facts">
          <div><dt>提供方 / 模型</dt><dd class="mono">{{ observation.provider }} / {{ observation.model }}</dd></div>
          <div><dt>来源</dt><dd>宿主报告（非 controller 独立验证的商业 LLM）</dd></div>
          <div><dt>输入形式</dt><dd>{{ observation.input_modalities.join('、') }}</dd></div>
          <div><dt>执行证据</dt><dd>{{ observation.execution_observed ? '已关联模型调用报告' : '执行未确认' }}；{{ observation.output_observed ? '已关联文本输出' : '输出未确认' }}</dd></div>
          <div v-if="observation.not_live_llm !== null"><dt>运行性质</dt><dd>{{ observation.not_live_llm ? '零网络确定性 Stub；不是实际 LLM，无 Live LLM 调用。' : '非 Stub 标记已由宿主报告；不等于真实商业 LLM 验证。' }}</dd></div>
          <div><dt>Grant 操作</dt><dd>{{ observation.operation }} · <span class="mono uuid-value">{{ observation.grant_id }}</span></dd></div>
          <div><dt>授权状态</dt><dd>{{ observation.grant_current ? '关联 Grant 记录当前未撤销；仍须单独查询有效节点及 Host 能力。' : '关联 Grant 已撤销，不能用于新调用。' }}</dd></div>
          <div v-if="observation.session_id"><dt>会话 ID</dt><dd class="mono uuid-value">{{ observation.session_id }}</dd></div>
          <div><dt>观察时间</dt><dd>{{ formatTime(observation.observed_at, true) }}</dd></div>
        </dl>
        <div v-if="observedArtifact" class="observed-artifact">
          <div><dt>同级交付 Artifact</dt><dd class="mono uuid-value">{{ observedArtifact.artifact_id }}</dd></div>
          <p>关联 Ticket <span class="mono uuid-value">{{ ticket.id }}</span>；Artifact 的 ticket 关系一致。</p>
          <p v-if="observedArtifact.sha256">SHA-256：<code class="uuid-value">{{ observedArtifact.sha256 }}</code></p><p v-else>此 Artifact 未提供 SHA-256。</p>
          <button class="button secondary" @click="showArtifact(observedArtifact)"><AppIcon name="document" :size="15" />查看关联产物</button>
        </div>
        <p v-else class="warning-note observation-warning" role="note">当前 Ticket 的交付列表中没有此 Artifact ID，无法建立同级交付关联。不会推断其内容或来源。</p>
      </article>
    </section>

    <section v-if="ticket.reports?.length" class="report-section"><div class="section-heading"><h2>执行报告</h2><span class="muted tiny">STRUCTURED REPORTS</span></div><article v-for="(report, index) in ticket.reports" :key="report.id ?? index" class="report-card"><div class="report-heading"><span class="status-badge" :class="reportStatusTone(report.status)">{{ reportStatusLabel(report.status) }}</span><time>{{ formatTime(report.created_at, true) }}</time></div><p>{{ report.summary }}</p><details v-if="report.evidence"><summary>检查执行证据</summary><pre>{{ safeJson(report.evidence) }}</pre></details></article></section>

    <details v-if="ticket.assignments?.length" class="technical-details"><summary>Assignment / Lease / Grant 关联</summary><pre>{{ safeJson(ticket.assignments) }}</pre></details>
  </section>
</template>

<style scoped>
.observation-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; margin: 18px 0 0; }
.observation-facts > div, .observed-artifact > div { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; font-size: 11px; line-height: 1.8; }
.observation-facts dt, .observed-artifact dt { color: var(--muted); }
.observation-facts dd, .observed-artifact dd { margin: 0; }
.uuid-value { display: inline-block; overflow-wrap: anywhere; word-break: break-all; }
.observed-artifact { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 17px; font-size: 11px; }
.observed-artifact p { margin-top: 8px; overflow-wrap: anywhere; }
.observed-artifact .button { margin-top: 15px; }
.observation-warning { padding: 10px; border-radius: 7px; margin-top: 18px; font-size: 11px; }
@media (max-width: 520px) {
  .observation-facts { grid-template-columns: 1fr; gap: 11px; }
  .observation-facts > div, .observed-artifact > div { grid-template-columns: 76px minmax(0, 1fr); gap: 9px; font-size: 10px; }
}
</style>
