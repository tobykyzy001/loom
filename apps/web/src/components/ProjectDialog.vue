<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { ProjectMode } from '../api/types'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ busy?: boolean; error?: string }>()
const emit = defineEmits<{ close: []; submit: [value: { name: string; root: string; mode: ProjectMode; confirm: boolean }] }>()
const form = reactive({ name: '', root: '', mode: 'read_only' as ProjectMode, confirm: false })
const nameInput = ref<HTMLInputElement>()

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !props.busy) emit('close')
  if (event.key === 'Tab') {
    const focusable = [...document.querySelectorAll<HTMLElement>('#project-dialog button:not(:disabled), #project-dialog input, #project-dialog select')]
    if (!focusable.length) return
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus() }
    if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus() }
  }
}
document.addEventListener('keydown', onKeydown)
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
watch(() => props.busy, value => { if (value === false) void nextTick(() => nameInput.value?.focus()) }, { immediate: true })
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="!busy && emit('close')">
      <section id="project-dialog" class="modal project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-heading">
        <div class="modal-top"><span class="modal-icon"><AppIcon name="projects" :size="22" /></span><button class="icon-button" aria-label="关闭创建项目" :disabled="busy" @click="emit('close')"><AppIcon name="close" /></button></div>
        <h2 id="project-heading">把一个项目交给 Loom</h2>
        <p class="modal-effect">这是单用户管理操作。服务器只对你明确输入的已存在目录建立项目索引，不会由此获得任意文件访问权。</p>
        <form @submit.prevent="emit('submit', { ...form })">
          <div class="field"><label for="project-name">项目名称</label><input id="project-name" ref="nameInput" v-model="form.name" required maxlength="100" placeholder="例如：季度资料整理" autofocus /></div>
          <div class="field"><label for="project-root">目录位置</label><input id="project-root" v-model="form.root" required maxlength="4096" autocomplete="off" placeholder="/path/to/an/existing/project" /><p class="hint">使用协调器所在机器上已存在的目录。它会由服务端规范化验证。</p></div>
          <div class="field"><label for="project-mode">访问方式</label><select id="project-mode" v-model="form.mode"><option value="read_only">只读 · 可以读取与生成独立摘要</option><option value="read_write">读写 · 仍须逐项 Grant 才能写入</option></select></div>
          <div class="effect-box"><span class="eyebrow">此操作的实际作用</span><ul><li>建立一个项目引用，不自动执行任务。</li><li>{{ form.mode === 'read_write' ? '允许后续申请受控写入；不等于立即授权修改。' : '当前仅允许读取，不会授权修改原文件。' }}</li><li>目录路径不会作为通用 Artifact URI。</li></ul></div>
          <label class="confirmation-check"><input v-model="form.confirm" type="checkbox" /><span>我确认这是本人有权管理的目录，并理解注册项目不等于授予任务执行权。</span></label>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="emit('close')">取消</button><button class="button primary" type="submit" :disabled="busy || !form.name.trim() || !form.root.trim() || !form.confirm"><span v-if="busy" class="spinner" />{{ busy ? '正在注册…' : '确认并创建项目' }}</button></div>
        </form>
      </section>
    </div>
  </Teleport>
</template>
