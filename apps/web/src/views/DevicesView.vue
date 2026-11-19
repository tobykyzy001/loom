<script setup lang="ts">
import { ref } from 'vue'
import type { Grant, LoomNode, Project } from '../api/types'
import type { ImageEvaluationState } from '../lib/imageAvailability'
import ImageAvailabilityAssessment from '../components/ImageAvailabilityAssessment.vue'
import { capabilityName, formatTime, heartbeatStale, nodeOnline } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import ModelInventorySection from '../components/ModelInventorySection.vue'
import EmptyState from '../components/EmptyState.vue'
import type { ModelInventoryData } from '../api/types'

type Nodes = LoomNode[]
withDefaults(defineProps<{ nodes: Nodes; projects?: Project[]; grants?: Grant[]; evaluations?: Record<string, ImageEvaluationState>; busy?: boolean; loading?: boolean; inventory?: ModelInventoryData | null; inventoryLoading?: boolean; inventoryError?: string }>(), {
  projects: () => [], grants: () => [], evaluations: () => ({}),
})
const emit = defineEmits<{ enroll: []; 'refresh-inventory': []; 'assess-image': [{ node: LoomNode; grant: Grant }] }>()
const copied = ref(false)
const copyError = ref(false)
const enrollment = ref<{ code?: string; expires_at?: string } | null>(null)

function setEnrollment(value: unknown) {
  const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  enrollment.value = {
    code: typeof entry.code === 'string' ? entry.code : typeof entry.enrollment_code === 'string' ? entry.enrollment_code : undefined,
    expires_at: typeof entry.expires_at === 'string' ? entry.expires_at : undefined,
  }
  copied.value = false
}
function factValue(node: LoomNode, resource: string): string {
  const facts = node.inventory?.facts ?? []
  const fact = facts.find(entry => entry.resource === resource)
  if (!fact) return '尚未探测'
  if (fact.value === null || fact.value === undefined) return fact.confidence === 'unknown' ? '未知（未验证）' : '无已记录事实'
  const source = fact.source === 'controller_probed' ? '控制器实测' : fact.source === 'host_reported' ? '主机上报' : fact.source
  return fact.resource === 'hardware.memory_bytes' && typeof fact.value === 'number'
    ? `${(fact.value / (1024 ** 3)).toFixed(1)} GiB · ${source}`
    : `${fact.value} · ${source}`
}
function factStatus(node: LoomNode, resource: string): string {
  const inventory = node.inventory
  const confidence = inventory?.facts?.find(fact => fact.resource === resource)?.confidence ?? 'unknown'
  const warnings = inventory?.issues?.filter(issue => issue.resource?.startsWith(resource) || issue.resource === 'workers').map(issue => issue.code) ?? []
  return [...new Set([confidence === 'unknown' ? '未知' : confidence, ...warnings])].join(' / ')
}
const onlineCount = (nodes: Nodes) => nodes.filter(nodeOnline).length
const revoked = (node: LoomNode) => Boolean(node.revoked_at)
const hasFreshSnapshot = (node: LoomNode) => nodeOnline(node)
async function copyCode() {
  copyError.value = false
  try {
    if (!enrollment.value?.code) return
    if (!navigator.clipboard) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(enrollment.value.code)
    copied.value = true
  } catch {
    copied.value = false
    copyError.value = true
  }
}
defineExpose({ setEnrollment })
</script>

<template>
  <section class="page-view">
    <div class="page-title">
      <span class="eyebrow">YOUR LOCAL NETWORK</span>
      <h1>你的设备，你的边界。</h1>
      <p>注册只是身份的第一步。在线、被信任与拥有任务授权，是三件不同的事。</p>
    </div>
    <div class="device-summary">
      <div class="summary-number"><strong>{{ onlineCount(nodes) }}</strong><span>当前在线节点</span></div>
      <div class="summary-divider" />
      <p>不以自报能力代替 Grant<br /><span>陈旧心跳和离线会单独标记</span></p>
      <button class="button secondary" :disabled="busy" @click="emit('enroll')"><AppIcon name="plus" :size="16" />生成配对码</button>
    </div>
    <div v-if="enrollment" class="enrollment-callout">
      <AppIcon name="shield" :size="20" />
      <div>
        <h3>一次性配对码已生成</h3>
        <p>请仅在你明确信任的节点上使用。此码只负责首次身份注册，不会授予项目访问权。</p>
        <div v-if="enrollment.code" class="enrollment-code">
          <code>{{ enrollment.code }}</code>
          <button class="button secondary" @click="copyCode"><AppIcon name="copy" :size="15" />{{ copied ? '已复制' : '复制' }}</button>
        </div>
        <p v-else class="small">服务端未返回可读配对码。请检查响应与本地日志，不要假定节点已注册。</p>
        <p class="muted small">有效至 <span v-if="enrollment.expires_at">{{ formatTime(enrollment.expires_at, true) }}</span><span v-else>以服务端过期策略为准</span></p>
      </div>
    </div>
    <div class="card device-view">
      <div class="section-heading"><h2>节点与心跳</h2><span class="muted small">{{ nodes.length }} 个节点</span></div>
      <p v-if="copyError" class="form-error" role="alert">无法自动复制。请选中配对码并手动复制。</p>
      <EmptyState v-if="!loading && !nodes.length" icon="devices" title="还没有已注册的设备" description="请安装并主动注册 Local Node。配对码不等于任务权限，也不会自动安装任何插件。" />
      <div v-else-if="nodes.length" class="node-list">
        <article v-for="node in nodes" :key="node.id" class="node-item">
          <span class="node-avatar" :class="{ offline: !nodeOnline(node) }"><AppIcon name="devices" :size="24" /></span>
          <div class="node-body">
            <div class="node-heading">
              <h3>{{ node.name || node.id }}</h3>
              <span class="status-badge" :class="revoked(node) || !hasFreshSnapshot(node) ? 'neutral' : node.status === 'degraded' ? 'waiting' : 'active'" :data-device-presence="revoked(node) ? 'revoked' : hasFreshSnapshot(node) ? 'active' : 'offline'"><span class="status-dot" />{{ revoked(node) ? '已撤销' : nodeOnline(node) ? (node.status === 'busy' ? '忙碌' : node.status === 'degraded' ? '降级' : '在线') : '离线' }}</span>
              <span v-if="!revoked(node) && !nodeOnline(node) && (node.freshness === 'stale_offline' || heartbeatStale(node.last_heartbeat ?? node.last_seen_at))" class="status-badge waiting" title="中心已超过新鲜阈值未收到有效心跳；节点和物理网络的实际状态没有被另行测得。">心跳陈旧</span>
            </div>
            <span class="mono muted">{{ node.id }}</span>
            <div class="node-meta"><span><AppIcon name="clock" :size="14" />最后心跳 {{ formatTime(node.last_heartbeat ?? node.last_seen_at, true) }}</span><span v-if="node.installation_id">安装 {{ node.installation_id.slice(0, 14) }}</span></div>
            <p v-if="!hasFreshSnapshot(node) && !revoked(node)" class="muted small node-presence-note">这是末次心跳快照。中心没有新的有效心跳，不能把旧状态宣称为在线；也不是实际设备或网络状态的新测量。</p>
            <p v-if="revoked(node)" class="muted small node-presence-note">该安装身份已撤销；仅保留历史心跳时间，不会因此恢复任务授权。</p>
            <div v-if="node.capabilities?.length" class="capability-list"><span v-for="capability in node.capabilities" :key="capabilityName(capability)">{{ capabilityName(capability) }}</span></div><p v-else class="muted small">未声明可用能力。不能按在线状态假定任务可执行。</p>
          </div>
          <div class="node-facts"><span>系统 · {{ factValue(node, 'hardware.os') }}</span><span>架构 · {{ factValue(node, 'hardware.arch') }}</span><span>内存 · {{ factValue(node, 'hardware.memory_bytes') }}</span><span>模型适配 · {{ factValue(node, 'model.adapter') }}</span></div>
          <div class="node-trust"><AppIcon :name="node.trusted === false ? 'warning' : 'lock'" :size="15" />{{ node.trusted === false ? '尚未信任' : node.trusted ? '已明确信任' : '信任详情未提供' }}<span v-if="factStatus(node, 'hardware') !== 'unknown'"> · {{ factStatus(node, 'hardware') }}</span></div>
          <ImageAvailabilityAssessment v-if="node.inventory" :node="node" :projects="projects" :grants="grants"
            :observation="inventory?.observations.find(value => value.node_id === node.id && value.installation_id === node.installation_id)"
            :result="evaluations[`${node.id}/${node.installation_id}`]?.result"
            :error="evaluations[`${node.id}/${node.installation_id}`]?.error"
            :busy="evaluations[`${node.id}/${node.installation_id}`]?.busy"
            @assess="input => emit('assess-image', input)" />
        </article>
      </div>
    </div>
    <ModelInventorySection :inventory="inventory" :loading="inventoryLoading" :error="inventoryError" @refresh="emit('refresh-inventory')" />
    <div class="callout"><AppIcon name="help" :size="19" /><div><strong>需要添加设备？</strong><p>使用你自己的 Concierge 地址和一次性代码，在 Local Node / DSH Loom Plugin 中主动配对。Loom 不会扫描局域网、修改 DSH Profile 或远程执行安装。</p></div></div>
  </section>
</template>
<style scoped>
.node-body { min-width: 0; }
.node-heading { min-width: 0; overflow-wrap: anywhere; }
.node-heading h3 { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.node-body > .mono { overflow-wrap: anywhere; word-break: break-all; }
</style>
