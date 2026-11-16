<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { NewTicket, Project, TicketKind } from '../api/types'
import { safeRelativePath } from '../lib/format'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ projects: Project[]; isNew: boolean; busy?: boolean; error?: string }>()
const emit = defineEmits<{ submit: [ticket: NewTicket]; 'add-project': [] }>()
const form = reactive<NewTicket & { project_id: string }>({ project_id: '', objective: '', kind: 'read_summary', relative_path: '', content: '' })
const localError = computed(() => {
  if (!form.objective.trim()) return '请描述要完成的任务。'
  if (!form.project_id) return '请先选择一个项目。'
  if (form.relative_path && !safeRelativePath(form.relative_path)) return '请使用项目内相对路径，不能含 ..、绝对路径或反斜杠。'
  if (form.kind === 'edit_file' && (!form.relative_path || !safeRelativePath(form.relative_path))) return '写入文件需要一个安全的项目相对路径。'
  if (form.kind === 'edit_file' && (form.content?.length ?? 0) > 100_000) return 'M0 写入正文不能超过 100,000 字符。'
  return ''
})
const readOnly = computed(() => props.projects.find(p => p.id === form.project_id)?.mode === 'read_only')

watch(() => props.isNew, isNew => {
  if (isNew) {
    form.objective = ''
    form.kind = 'read_summary'
    form.relative_path = ''
    form.content = ''
  }
}, { immediate: true })
watch(() => props.projects, projects => {
  if (!projects.some(project => project.id === form.project_id)) form.project_id = projects[0]?.id ?? ''
  if (form.kind === 'edit_file' && projects.find(p => p.id === form.project_id)?.mode !== 'read_write') form.kind = 'read_summary'
}, { immediate: true, deep: true })

function setKind(kind: TicketKind) { form.kind = kind }
function submit() {
  if (localError.value || props.busy) return
  emit('submit', { ...form, objective: form.objective.trim(), relative_path: form.relative_path?.trim() })
}
</script>

<template>
  <section class="composer" aria-label="新任务">
    <div v-if="form.kind === 'read_summary'" class="optional-read-path"><label for="read-relative-path">读取路径 <span class="muted">可选 · 默认由服务确定</span></label><input id="read-relative-path" v-model="form.relative_path" placeholder="例如 README.md，不填则读取项目简报" maxlength="512" autocomplete="off" /></div>

    <div class="composer-topline">
      <span class="eyebrow composer-label"><AppIcon name="sparkle" :size="14" /> 交给 Loom</span>
      <span class="small muted">一个小步骤，也是一个好开始</span>
    </div>
    <label class="sr-only" for="task-objective">任务目标</label>
    <textarea id="task-objective" v-model="form.objective" placeholder="描述要完成的任务…" maxlength="2000" rows="3" @keydown.meta.enter="submit" @keydown.ctrl.enter="submit" />
    <div class="composer-project">
      <label for="project-select">项目</label>
      <select id="project-select" :value="form.project_id" @change="form.project_id = ($event.target as HTMLSelectElement).value">
        <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }} · {{ project.mode === 'read_write' ? '读写' : '只读' }}</option>
      </select>
      <button class="icon-button small-button" aria-label="创建新项目" title="添加项目" @click="emit('add-project')"><AppIcon name="plus" :size="17" /></button>
      <span class="composer-project-spacer" />
      <span class="muted small path-hint">仅访问授权的工作目录</span>
    </div>
    <div class="composer-toolbar">
      <div class="kind-buttons" role="group" aria-label="执行类型">
        <button class="kind-button" :class="{ chosen: form.kind === 'read_summary' }" :aria-pressed="form.kind === 'read_summary'" @click="setKind('read_summary')"><AppIcon name="document" :size="16" />读取摘要</button>
        <button class="kind-button" :class="{ chosen: form.kind === 'edit_file' }" :disabled="readOnly" :aria-pressed="form.kind === 'edit_file'" @click="setKind('edit_file')"><AppIcon name="edit" :size="16" />写入文件</button>
      </div>
      <span class="muted small shortcut">⌘ ↵ 提交</span>
    </div>
    <div v-if="form.kind === 'edit_file'" class="edit-fields">
      <div v-if="readOnly" class="inline-note warning-note"><AppIcon name="lock" :size="15" />此项目为只读。请切换到有写入权限的项目，或保持只读任务。</div>
      <div class="field">
        <label for="relative-path">项目内的文件路径 <span class="muted">必填</span></label>
        <input id="relative-path" v-model="form.relative_path" placeholder="例如 notes/summary.md" maxlength="512" autocomplete="off" />
        <p class="hint">仅限相对路径。不能越过项目根目录，也不能写入其他位置。</p>
      </div>
      <div class="field">
        <label for="edit-content">文件内容</label>
        <textarea id="edit-content" v-model="form.content" class="code-input" rows="5" placeholder="写入文件的文本内容…" maxlength="100000" />
      </div>
    </div>
    <div v-else-if="form.relative_path !== undefined && form.kind === 'read_summary'" class="read-context">
      <span class="source-pill"><AppIcon name="document" :size="12" />项目已授权目录</span>
      <span class="muted small">以简报执行读取任务，不修改原文件。</span>
    </div>
    <div v-if="!isNew" class="inline-note composer-existing"><AppIcon name="activity" :size="16" />你正在查看一个已创建的任务。请在下方检查状态，或从右上角新建任务。</div>
    <p v-if="error || (localError && form.objective && form.relative_path)" class="form-error" role="alert">{{ error || localError }}</p>
    <div class="composer-submit">
      <span class="muted small">创建后仍为待执行，直到获得匹配的执行授权。</span>
      <button class="button primary submit-button" :disabled="busy || !!localError" title="" @click="submit">
        <span v-if="busy" class="spinner" /><AppIcon v-else name="send" :size="16" />{{ busy ? '正在创建…' : '开始任务' }}
      </button>
    </div>
  </section>
</template>
