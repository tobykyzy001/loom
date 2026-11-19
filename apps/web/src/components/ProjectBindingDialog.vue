<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LoomNode, Project, ProjectBindingInput } from '../api/types'
import { nodeOptionKey, selection, type BindingIssue } from '../binding-input'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ project: Project; nodes: LoomNode[]; busy?: boolean; error?: string; obscured?: boolean }>()
const emit = defineEmits<{ close: []; submit: [value: ProjectBindingInput] }>()
const form = ref({ key: '', worker_id: 'default' })
const nodeSelect = ref<HTMLSelectElement>()

// Rendering indexes distinguish malformed raw rows only; identity is always an
// explicit Node/Installation tuple, never the first record or that index.
const choiceKey = (node: LoomNode) => nodeOptionKey(node, props.nodes)
const evaluated = computed(() => selection(props.project, props.nodes, form.value.key, form.value.worker_id.trim()))
function onKeydown(event: KeyboardEvent) {
  if (props.obscured) return
  if (event.key === 'Escape' && !props.busy) emit('close')
  if (event.key === 'Tab') {
    const focusable = [...document.querySelectorAll<HTMLElement>('#binding-dialog button:not(:disabled), #binding-dialog input:not(:disabled), #binding-dialog select:not(:disabled)')]
    if (!focusable.length) return
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus() }
    if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus() }
  }
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
watch(() => props.busy, value => { if (value === false) void nextTick(() => nodeSelect.value?.focus()) }, { immediate: true })

function nodeLabel(node: LoomNode) {
  const installation = node.installation_id?.trim() || '未提供安装 ID'
  const status = node.revoked_at ? '已撤销' : node.online === false ? '离线/陈旧' : node.online ? '自报在线' : '状态未提供'
  const platform = node.platform || '平台未知'
  return `${node.name || node.id} · ${node.id} · 安装 ${installation} · ${status} · ${platform}`
}
const localError = computed(() => {
  const messages: Record<Exclude<BindingIssue, null>, string> = {
    no_node: props.nodes.length ? '请选择有效的节点与 Installation。' : '请先在设备页完成节点注册，不能仅凭项目目录绑定。',
    selection_required: '请明确选择这个节点下的一项 Installation，不按第一行或显示状态代替。',
    not_usable: '所选节点或 Installation 已撤销、失效，或不在当前资料里。不会自动改用其它安装。请重新核对选择。',
    ambiguous_identity: '该节点存在缺失或重复的 Installation 身份，无法安全区分。请先核对中心返回的数据，不自动替换为另一条。',
    invalid_selection: '当前 Node/Installation 选择不能再被验证。请重新选择，不使用默认行代替。',
    root_required: '中心没有给出精确的项目注册根目录。不能改用其它目录代替绑定。',
    worker_required: '请填写所选 Installation 已登记的 Worker ID；不会自动改用其它安装的 Worker。',
  }
  if (props.error) return props.error
  if (evaluated.value.issue === 'selection_required' && !form.value.key) return ''
  return evaluated.value.issue ? messages[evaluated.value.issue] : ''
})

function submit() {
  if (props.busy || !evaluated.value.payload) return
  // Freeze the exact reviewed binding; it is not reconstructed during the
  // broader confirmation step or coalesced with another installation.
  const payload: ProjectBindingInput = { ...evaluated.value.payload }
  emit('submit', payload)
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="!busy && emit('close')">
      <section id="binding-dialog" class="modal binding-dialog" role="dialog" aria-modal="true" aria-labelledby="binding-heading" :inert="obscured" :aria-hidden="obscured ? true : undefined">
        <div class="modal-top"><span class="modal-icon"><AppIcon name="devices" :size="22" /></span><button class="icon-button" aria-label="关闭绑定本地节点资源" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></div>
        <h2 id="binding-heading">绑定本地节点资源</h2>
        <p class="modal-effect">确认「{{ project.name }}」在指定节点及安装上的位置。项目发现不等于授权；此步骤只建立精确绑定，之后仍需单独创建 Grant。</p>
        <form @submit.prevent="submit">
          <div class="field"><label for="binding-root">已注册的项目目录</label><input id="binding-root" :value="project.root" readonly aria-describedby="binding-root-hint" /><p id="binding-root-hint" class="hint">沿用本项目登记的根目录，不会自动替换为另一个目录或节点。</p></div>
          <div class="field"><label for="binding-node">节点 / 安装身份 <span class="muted">必选</span></label><select id="binding-node" ref="nodeSelect" v-model="form.key" required :disabled="busy || !nodes.length"><option value="" disabled>{{ nodes.length ? '请选择执行所在节点' : '尚无已注册节点' }}</option><option v-for="(node, index) in nodes" :key="`${choiceKey(node)}:${index}`" :value="choiceKey(node)" :disabled="Boolean(node.revoked_at)">{{ nodeLabel(node) }}</option></select><p id="binding-node-hint" class="hint" aria-live="polite">{{ evaluated.requiresInstallation ? '同一节点有多个未撤销安装，请明确选择一份 Installation；不以当前显示名或顺序代替。' : '请明确选择已有的节点与安装。未撤销不等于硬件已认证；列表状态只是报告显示，仍由中心进行实际绑定检查。' }}</p></div>
          <div class="field"><label for="binding-worker">Worker ID</label><input id="binding-worker" v-model="form.worker_id" required maxlength="160" autocomplete="off" aria-describedby="binding-worker-hint" /><p id="binding-worker-hint" class="hint">默认使用 default。只有所选 Installation 已登记其他 Worker 时才修改；此处不会注册新的 Worker，也不会自动借用其它安装的 Worker。</p></div>
          <div class="inline-note"><AppIcon name="shield" :size="15" /><span>节点必须已在 <code>inventory.project_roots</code> 中声明此 Project ID 到上述根目录的完全一致映射。映射不匹配时，绑定会被拒绝并显示服务端原因，不会自动尝试另一份安装。</span></div>
          <p v-if="localError" class="form-error" role="alert">{{ localError }}</p>
          <div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="emit('close')">取消</button><button class="button primary" type="submit" :disabled="busy || !evaluated.payload"><span v-if="busy" class="spinner" />{{ busy ? '正在确认…' : '检查绑定范围' }}</button></div>
        </form>
      </section>
    </div>
  </Teleport>
</template>
