<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Memory, Project } from '../api/types'
import { formatTime } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import MemoryCandidateList from '../components/MemoryCandidateList.vue'
import type { MemoryCandidate, ReviewDecision } from '../lib/memoryCandidate'

const props = defineProps<{ memories: Memory[]; candidates?: MemoryCandidate[]; projects: Project[]; busy?: boolean; error?: string }>()
const emit = defineEmits<{ save: [value: { id?: string; content: string; project_id?: string | null; scope: string }]; delete: [id: string]; review: [candidate: MemoryCandidate, decision: ReviewDecision]; edit: [candidate: MemoryCandidate, content: string]; source: [ticketId: string] }>()
function emptyForm() { return { id: '', content: '', project_id: '', scope: 'project' } }
const form = ref(emptyForm())
const editing = ref(false)
const filter = ref('all')

watch(filter, (value, previous) => { if (value !== previous) { form.value = emptyForm(); editing.value = false } })
watch(() => props.memories, memories => {
  if (!editing.value || !form.value.id) return
  // Once the authoritative collection confirms this ID is gone, do not leave
  // an editor pointing at a deleted Memory after a later re-acceptance. A
  // failed read keeps the previous collection, hence it cannot clear a draft.
  if (!memories.some(memory => memory.id === form.value.id)) {
    form.value = emptyForm()
    editing.value = false
  }
})

function filtered(memories: Memory[]) { return memories.filter(memory => filter.value === 'all' || (filter.value === 'user' ? !memory.project_id : memory.project_id === filter.value)) }
function edit(memory: Memory) { form.value = { id: memory.id, content: memory.content, project_id: memory.project_id ?? '', scope: memory.project_id ? 'project' : 'user' }; editing.value = true }
function submit() {
  if (!form.value.content.trim()) return
  emit('save', { ...(form.value.id ? { id: form.value.id } : {}), content: form.value.content.trim(), project_id: form.value.scope === 'project' ? form.value.project_id : null, scope: form.value.scope })
}
</script>

<template>
  <section class="page-view"><div class="page-title"><span class="eyebrow">EXPLICIT MEMORY</span><h1>重要的约定，留在这里。</h1><p>只有明确保存的偏好。保存记忆，不会顺带得到执行权限。</p></div><div class="memory-layout"><MemoryCandidateList v-if="candidates?.length" :candidates="candidates" :projects="projects" :busy="busy" @review="(candidate, decision) => emit('review', candidate, decision)" @edit="(candidate, content) => emit('edit', candidate, content)" @source="ticketId => emit('source', ticketId)" />
    <div class="card memory-form"><div class="section-heading"><h2>{{ editing ? '编辑一条记忆' : '记住什么？' }}</h2><AppIcon name="memories" :size="22" /></div><form @submit.prevent="submit"><div class="field"><label for="memory-content">记忆内容</label><textarea id="memory-content" v-model="form.content" rows="4" placeholder="例如：报告默认使用中文，列出待确认项。" maxlength="4000" /></div><div class="field"><label for="memory-scope">作用范围</label><select id="memory-scope" v-model="form.scope"><option value="project">仅当前选择的项目</option><option value="user">用户级偏好 · 适用于当前用户</option></select></div><div v-if="form.scope === 'project'" class="field"><label for="memory-project">项目</label><select id="memory-project" v-model="form.project_id" required><option value="" disabled>选择一个真实项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></div><div class="inline-note"><AppIcon name="lock" :size="15" />不会自动记录对话、推断授权或常驻执行。</div><div class="modal-actions"><button v-if="editing" type="button" class="button secondary" @click="editing = false; form = emptyForm()">取消编辑</button><button type="submit" class="button primary" :disabled="busy || !form.content.trim() || (form.scope === 'project' && !form.project_id)"><span v-if="busy" class="spinner" />{{ editing ? '保存修改' : '保存记忆' }}</button></div></form><p v-if="error" class="form-error" role="alert">{{ error }}</p></div>
      <div class="memory-list"><div class="memory-list-heading"><h2>已保存的约定</h2><select v-model="filter" aria-label="筛选记忆项目"><option value="all">全部范围</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option><option value="user">用户级偏好</option></select></div><EmptyState v-if="!filtered(memories).length" icon="memories" title="这里还很安静" description="保存你确定的约定，不积累无关的观察。" /><article v-for="memory in filtered(memories)" :key="memory.id" class="memory-item card"><p>{{ memory.content }}</p><div class="memory-item-top"><span class="scope-tag"><AppIcon :name="memory.project_id ? 'projects' : 'memories'" :size="13" />{{ memory.project_id ? projects.find(p => p.id === memory.project_id)?.name ?? '项目范围' : '用户级偏好' }}</span><div><button class="icon-button small-button" aria-label="编辑记忆" @click="edit(memory)"><AppIcon name="edit" :size="15" /></button><button class="icon-button small-button danger-text" aria-label="删除记忆" :disabled="busy" @click="emit('delete', memory.id)"><AppIcon name="trash" :size="15" /></button></div></div><span v-if="memory.updated_at || memory.created_at" class="muted tiny">{{ formatTime(memory.updated_at ?? memory.created_at, true) }}</span></article></div>
    </div>
  </section>
</template>
