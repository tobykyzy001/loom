<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Grant, LoomNode, ModelCatalogObservation, PlacementDecision, Project } from '../api/types'
import { imageGrantCandidates, imageWaitMeaning } from '../lib/imageAvailability'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  node: LoomNode
  projects: Project[]
  grants: Grant[]
  observation?: ModelCatalogObservation
  result?: { decision: PlacementDecision | null; received_at: string } | null
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ assess: [input: { node: LoomNode; grant: Grant }] }>()
const grantId = ref('')
const candidates = computed(() => imageGrantCandidates(props.node, props.projects, props.grants))
const selectedGrant = computed(() => candidates.value.find(grant => grant.id === grantId.value))
watch(() => candidates.value.map(grant => grant.id).join('|'), () => {
  if (!selectedGrant.value) grantId.value = ''
})
const probe = computed(() => props.node.inventory?.hardware_probe)
const textModels = computed(() => props.observation?.models.filter(model => model.input_modalities.every(row => row === 'text') && model.prepared_call_observed && model.catalogued) ?? [])
const requirements = 'macOS / arm64 / 64 GiB：这组仅是示例读取评估条件，不是任何图片模型的推荐规格。'
</script>

<template>
  <section class="card image-assessment" aria-labelledby="image-assessment-heading" :data-node-assessment="node.id">
    <div class="resource-heading"><div><span class="eyebrow">LOCAL PRECONDITIONS</span><h2 id="image-assessment-heading">图片生成前提评估</h2></div><AppIcon name="sparkle" :size="20" /></div>
    <p class="hint">这是对该节点当前资源与明确条件的只读评估。不会运行图像模型、生成图片、下载权重或新增 Grant / Ticket。 {{ requirements }}</p>
    <label>本次使用的现有读取 Grant
      <select :value="grantId" :aria-label="`选择 ${node.id} 的现有读取 Grant`" @change="grantId = ($event.target as HTMLSelectElement).value">
        <option value="">必须明确选择</option>
        <option v-for="grant in candidates" :key="grant.id" :value="grant.id">
          {{ grant.id }} · {{ projects.find(project => project.id === grant.project_id)?.name }} · {{ grant.worker_id }}
        </option>
      </select>
    </label>
    <div class="button-row"><button class="button secondary" :disabled="busy || !selectedGrant" @click="selectedGrant && emit('assess', { node, grant: selectedGrant })">
      <span v-if="busy" class="spinner dark" />{{ busy ? '正在评估…' : '评估此节点的图片生成前提' }}
    </button></div>
    <p v-if="!candidates.length" class="hint">没有可用于该精确 Node/Installation/Worker 的明确读取 Grant与公开项目根目录。不会借索一个相似节点补选。</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <dl class="facts">
      <div><dt>硬件实测</dt><dd>{{ probe ? `固定读取器 ${probe.inspector} · ${probe.observed_at}` : '没有当前固定硬件探针结果' }}</dd></div>
      <div><dt>模型与图片输出</dt><dd>没有图片模型存在性、下载完成或真实已生成图片的证明。只识别当前有限观察，不据此宣称支持。</dd></div>
      <div><dt>其它受限任务</dt><dd>{{ textModels.length ? '已观察到受限文本适配器，但没有实际激活、调用或生成授权。' : '未得到该节点的其它文本任务适配器证明。请单独按资源实际能力核验。' }}</dd></div>
      <div><dt>图片请求权限</dt><dd>现有读取 Grant 不自动给予任何图片执行操作。请先获得真正对应的运行条件与授权。</dd></div>
    </dl>
    <div v-if="result" class="assessment-result" aria-label="条件评估结果">
      <h3>{{ result.decision?.selected ? '给定条件可形成候选解释；尚不等于图片执行 Grant' : '这次评估未形成可执行候选，并不证明所有其它工作不可用' }}</h3>
      <p class="hint">收到本次评估：{{ result.received_at }}。这是条件判断，不是图像生成凭证。</p>
      <div v-if="result.decision?.waiting.length" class="finding-lines">
        <div v-for="reason in result.decision.waiting" :key="`${reason.code}-${reason.resource}`" class="finding-line" :data-wait-code="reason.code">
          <strong>{{ imageWaitMeaning(reason) }}</strong><span>{{ reason.resource }} · {{ reason.source }} · {{ reason.confidence }}</span>
        </div>
      </div>
      <p v-if="result.decision?.selected" class="hint">候选目标：{{ result.decision.selected.node_id }} / {{ result.decision.selected.installation_id }} / {{ result.decision.selected.worker_id }}。仍需另行完成实际限定工作和权限验证，没有图片结果。</p>
      <p class="hint">参与评估的读取 Grant版本/Root由服务端复核，不能借这个按钮添加图片操作、替换Node或发明模型能力。</p>
    </div>
    <p class="hint inventory-limit">未观测到的事实仍是未知，不能推断没有或已有能力。GPU/Metal不等于图像模型/运行时可用，内存与负载也需结合具体任务；这台机器仍可能执行另外的受限文件读取。</p>
  </section>
</template>

<style scoped>
.image-assessment { margin-top: 20px; padding: 20px; min-width: 0; }
.resource-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.image-assessment h2 { font-size: 16px; margin-top: 4px; }
.facts { margin: 16px 0; display: grid; gap: 10px; }
.facts > div { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; }
.facts dd { min-width: 0; overflow-wrap: anywhere; margin: 0; }
.hint { font-size: 11px; line-height: 1.75; }
.finding-line { padding: 8px 0; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; }
.finding-line strong, .finding-line > span { min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.assessment-result { margin-top: 18px; }
.assessment-result h3 { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.image-assessment select { width: 100%; min-width: 0; overflow-wrap: anywhere; }
.image-assessment select :deep(option) { max-width: 100%; text-overflow: ellipsis; }
@media (max-width: 520px) {
  .facts > div { grid-template-columns: 1fr; gap: 4px; }
  .resource-heading { align-items: flex-start; }
}
</style>
