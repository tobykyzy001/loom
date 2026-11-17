<script setup lang="ts">
import type { ModelInventoryData, ModelCatalogObservation } from '../api/types'
import { confidenceLabel, findingLabel, resourceUnknown } from '../lib/modelInventory'
import { formatTime } from '../lib/format'
import AppIcon from './AppIcon.vue'
import EmptyState from './EmptyState.vue'

const props = defineProps<{ inventory?: ModelInventoryData | null; loading?: boolean; error?: string }>()
const emit = defineEmits<{ refresh: [] }>()
function findingTime(observation: ModelCatalogObservation, index: number): string {
  const time = observation.findings[index]?.observed_at
  return time ? formatTime(time, true) : '未提供观察时间'
}
</script>

<template>
  <section class="card model-inventory-section" aria-labelledby="model-inventory-heading">
    <div class="resource-heading"><div><h2 id="model-inventory-heading">模型资源观察</h2><p class="muted small">模型目录观察不等于执行 Grant。不提供下载或激活。</p></div><button class="button secondary" :disabled="loading" @click="emit('refresh')" aria-label="刷新资源观察"><span v-if="loading" class="spinner dark" /><AppIcon v-else name="refresh" :size="14" />刷新资源观察</button></div>
    <p v-if="error" class="inline-note danger-note" role="alert">{{ error }}。无法确认最新模型资源；不将其解释为模型不存在。</p>
    <div v-if="!inventory && loading" class="inline-note" role="status"><span class="spinner dark" />读取已认证节点上报的资源观察…</div>
    <EmptyState v-else-if="!inventory && !error" icon="sparkle" title="尚未读取模型观察" description="没有已加载的目录证据。这不是“模型不存在”的结论。" />
    <template v-else-if="inventory">
      <div v-if="inventory.models.length" class="catalog-list">
        <article v-for="model in inventory.models" :key="model.id" class="catalog-row" :data-model-id="model.id" :data-node-id="model.node_id" :data-worker-id="model.worker_id">
          <div class="catalog-row-heading"><span class="catalog-provider">{{ model.provider }} / {{ model.model }}</span><span class="status-badge" :class="resourceUnknown(model) ? 'neutral' : 'synthetic'">{{ resourceUnknown(model) ? '仅历史观察 · 当前不可用' : '观察已关联（未激活）' }}</span></div>
          <dl class="catalog-facts"><div><dt>资源范围</dt><dd>Node <code class="wrap-value">{{ model.node_id }}</code> · Worker <code class="wrap-value">{{ model.worker_id }}</code></dd></div><div><dt>来源</dt><dd>主机上报 · 已认证心跳</dd></div><div><dt>当前状态</dt><dd>{{ model.resource_state === 'adapter_observed' ? '已观察文本适配器（未激活）' : '不可用（保留历史证据）' }}</dd></div><div><dt>输入 / 窗口</dt><dd>{{ model.input_modalities.join('、') }}<template v-if="model.context_window"> · {{ model.context_window.toLocaleString('en-US') }} tokens 的声明窗口；不代表可执行能力</template><template v-else> · 上下文窗口未知</template></dd></div><div><dt>观察时间</dt><dd>{{ formatTime(model.observed_at, true) }}</dd></div></dl>
          <p class="resource-note">目录 ID <code class="wrap-value">{{ model.id }}</code> · {{ model.freshness === 'fresh' ? '最新观察' : '上次已知（陈旧）' }}。对应已认证的安装/Worker，而不是全局 Provider 或安装许可。</p>
        </article>
      </div>
      <p v-else class="inline-note">未知 / 尚未有适配器证据。请只依据节点 findings 判断，不推断模型已经安装或不存在。</p>
      <div v-if="inventory.observations.length" class="node-findings">
        <article v-for="observation in inventory.observations" :key="`${observation.node_id}-${observation.worker_id}`" class="finding-row" :data-workspace-node-id="observation.node_id">
          <div class="finding-heading"><strong>Node <code class="wrap-value">{{ observation.node_id }}</code> · Worker <code class="wrap-value">{{ observation.worker_id || '未声明' }}</code></strong><span class="status-badge" :class="observation.confidence === 'fresh_observation' ? 'synthetic' : 'neutral'">{{ confidenceLabel(observation.confidence) }}</span></div>
          <div v-if="observation.findings.length" class="finding-lines"><div v-for="(finding, index) in observation.findings" :key="`${finding.state}-${index}`" class="finding-line"><span>{{ findingLabel(finding.state) }}</span><time>{{ findingTime(observation, index) }}</time><code v-if="finding.provider || finding.model" class="wrap-value">{{ [finding.provider, finding.model].filter(Boolean).join(' / ') }}</code></div></div>
          <p v-else class="muted small">没有已知的 findings。不能推断安装、激活或可执行能力。</p>
          <p class="finding-source">{{ observation.read_source === 'authenticated_node_heartbeat' ? '主机上报 · 已认证心跳' : observation.read_source }}<template v-if="observation.lookup_source !== 'unverified_or_missing'"> · {{ observation.lookup_source }}</template> · permission_granted: false</p>
        </article>
      </div>
      <div v-else-if="!inventory.models.length"><EmptyState icon="help" title="尚无节点目录观察" description="没有已注册的实际目录观察。不是通用模型或 Provider 的就绪清单。" /></div>
      <p class="inventory-limit">仅只读目录 / host_reported。安装、下载、激活、生成与远程交付均未实现，不因本页显示授予新的运行权限。</p>
    </template>
  </section>
</template>

<style scoped>
.model-inventory-section { padding: 22px; margin-top: 22px; }
.resource-heading { display: flex; align-items: center; gap: 15px; justify-content: space-between; }
.resource-heading h2 { font-size: 16px; font-weight: 550; }
.resource-heading p { margin-top: 5px; font-size: 9px; }
.resource-heading .button { font-size: 10px; flex-shrink: 0; }
.catalog-list { margin-top: 18px; }
.catalog-row { padding: 16px 0; border-top: 1px solid var(--line); }
.catalog-row-heading { display: flex; align-items: flex-start; gap: 15px; justify-content: space-between; }
.catalog-provider { font-size: 12px; font-weight: 600; line-height: 1.7; overflow-wrap: anywhere; word-break: break-word; }
.catalog-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 15px; }
.catalog-facts > div { display: flex; gap: 9px; font-size: 10px; line-height: 1.75; }
.catalog-facts dt { color: var(--muted); white-space: nowrap; }
.catalog-facts dd { margin: 0; min-width: 0; }
.resource-note { font-size: 9px; color: var(--muted); margin-top: 15px; line-height: 1.9; }
.wrap-value { overflow-wrap: anywhere; word-break: break-all; }
.node-findings { margin-top: 18px; padding-top: 13px; border-top: 1px solid var(--line); }
.finding-row { padding: 13px 0; }
.finding-heading { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
.finding-heading strong { font-weight: 400; font-size: 9px; line-height: 1.9; }
.finding-lines { margin-top: 13px; display: grid; gap: 9px; }
.finding-line { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; font-size: 10px; line-height: 1.8; color: #706079; }
.finding-line time { color: var(--muted); margin-left: auto; }
.finding-source { font-size: 9px; color: var(--muted); margin-top: 15px; line-height: 1.75; overflow-wrap: anywhere; }
.inventory-limit { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 13px; color: var(--muted); font-size: 9px; line-height: 1.8; }
.status-badge.synthetic { color: #806538; background: #fff4dd; }
@media (max-width: 520px) {
  .model-inventory-section { padding: 17px; }
  .resource-heading { flex-direction: column; align-items: flex-start; gap: 10px; }
  .resource-heading .button { font-size: 10px; }
  .catalog-row-heading, .finding-heading { flex-wrap: wrap; gap: 9px; }
  .catalog-facts { grid-template-columns: 1fr; gap: 8px; }
  .catalog-facts > div { font-size: 10px; }
  .finding-line { gap: 8px; font-size: 10px; }
  .finding-line time { margin-left: 0; }
}
</style>
