<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LoomNode, Project, ProjectBindingInput } from '../api/types'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ project: Project; nodes: LoomNode[]; busy?: boolean; error?: string }>()
const emit = defineEmits<{ close: []; submit: [value: ProjectBindingInput] }>()
const form = ref({ node_id: '', worker_id: 'default' })
const nodeSelect = ref<HTMLSelectElement>()

function onKeydown(event: KeyboardEvent) {
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

function submit() {
  if (!props.project.root?.trim() || !form.value.node_id || !form.value.worker_id.trim() || props.busy) return
  emit('submit', {
    project_id: props.project.id,
    node_id: form.value.node_id,
    worker_id: form.value.worker_id.trim(),
    // Only the already-registered Project root is submitted. The UI never chooses a new location.
    root_scope: props.project.root,
  })
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="!busy && emit('close')">
      <section id="binding-dialog" class="modal binding-dialog" role="dialog" aria-modal="true" aria-labelledby="binding-heading">
        <div class="modal-top"><span class="modal-icon"><AppIcon name="devices" :size="22" /></span><button class="icon-button" aria-label="关闭绑定本地节点资源" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></div>
        <h2 id="binding-heading">绑定本地节点资源</h2>
        <p class="modal-effect">确认「{{ project.name }}」在指定节点上的位置。项目发现不等于授权；此步骤只建立精确绑定，之后仍需单独创建 Grant。</p>
        <form @submit.prevent="submit">
          <div class="field"><label for="binding-root">已注册的项目目录</label><input id="binding-root" :value="project.root" readonly aria-describedby="binding-root-hint" /><p id="binding-root-hint" class="hint">沿用本项目登记的根目录，不会自动替换为另一个目录或节点。</p></div>
          <div class="field"><label for="binding-node">本地节点 <span class="muted">必选</span></label><select id="binding-node" ref="nodeSelect" v-model="form.node_id" required :disabled="!nodes.length"><option value="" disabled>{{ nodes.length ? '请选择执行所在节点' : '尚无已注册节点' }}</option><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name || node.id }} · {{ node.id }}{{ node.revoked_at ? '（已撤销）' : '' }}</option></select><p v-if="!nodes.length" class="hint">请先在设备页完成节点注册，不能仅凭项目目录注册本地资源。</p></div>
          <div class="field"><label for="binding-worker">Worker ID</label><input id="binding-worker" v-model="form.worker_id" required maxlength="160" autocomplete="off" /><p class="hint">默认使用 default。只有节点已登记其他 Worker 时才修改；此处不会注册新的 Worker。</p></div>
          <div class="inline-note"><AppIcon name="shield" :size="15" /><span>节点必须已在 <code>inventory.project_roots</code> 中声明此 Project ID 到上述根目录的完全一致映射。映射不匹配时，绑定会被拒绝并显示服务端原因。</span></div>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="emit('close')">取消</button><button class="button primary" type="submit" :disabled="busy || !project.root || !form.node_id || !form.worker_id.trim()"><span v-if="busy" class="spinner" />{{ busy ? '正在确认…' : '检查绑定范围' }}</button></div>
        </form>
      </section>
    </div>
  </Teleport>
</template>
