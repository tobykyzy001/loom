<script setup lang="ts">
import { ref } from 'vue'
import type { MemoryCandidate, ReviewDecision } from '../lib/memoryCandidate'
import { memoryDecision, memoryProvenance, memoryText } from '../lib/memoryCandidate'
import { skillSourceRefs } from '../lib/skillProof'
import type { Project } from '../api/types'
import AppIcon from './AppIcon.vue'
import EmptyState from './EmptyState.vue'

const props = defineProps<{ candidates: MemoryCandidate[]; projects: Project[]; busy?: boolean }>()
const emit = defineEmits<{ review: [candidate: MemoryCandidate, decision: ReviewDecision]; source: [ticketId: string] }>()
const localFilter = ref<'pending' | 'later' | 'accepted' | 'never' | 'rejected'>('pending')
function candidates() { return props.candidates.filter(item => localFilter.value === 'pending' ? ['pending', 'later'].includes(item.status) : item.status === localFilter.value) }
function title(candidate: MemoryCandidate) { return props.projects.find(project => project.id === candidate.scope)?.name ?? candidate.scope }
</script>
<template>
<section class="candidate-memories">
  <div class="section-heading"><h2>待审阅的项目观察</h2><span class="muted tiny">SOURCE-BOUND, NOT HABIT AUTOMATION</span></div>
  <p class="muted small">来源可回查的偏好候选。只有人工确认才会保存；不会推断授权、总结经验或自动执行任务。</p>
  <label for="candidate-filter">查看候选状态</label>
  <select id="candidate-filter" v-model="localFilter" aria-label="审核候选项过滤"><option value="pending">待审阅 / 稍后</option><option value="later">稍后</option><option value="accepted">已接受</option><option value="never">不再建议</option><option value="rejected">已拒绝（历史）</option></select>
  <EmptyState v-if="!candidates().length" icon="memories" title="没有这一类候选" description="只有基于明确项目来源的重复选择，不会自动产生长期授权。" />
  <article v-for="candidate in candidates()" :key="candidate.id" class="memory-item card candidate-card">
    <div class="memory-item-top"><span class="scope-tag"><AppIcon name="projects" :size="13" />{{ title(candidate) }}</span><span class="scope-tag">{{ candidate.status }}</span></div>
    <p>{{ memoryText(candidate) }}</p>
    <div v-if="skillSourceRefs(candidate.source_refs).length" class="memory-source"><span class="muted tiny">已关联 {{ skillSourceRefs(candidate.source_refs).length }} 个任务来源</span><button class="text-link" @click="emit('source', skillSourceRefs(candidate.source_refs)[0])">查看最早来源 Ticket <AppIcon name="arrow" :size="13" /></button></div>
    <p v-if="memoryProvenance(candidate) === 'legacy'" class="muted tiny">旧手工候选；仅供显式审阅，没有“来自真实 Ticket”的复用证明。</p>
    <template v-if="['pending','later'].includes(candidate.status)">
      <div class="button-row"><button class="button primary" :disabled="busy" @click="emit('review', candidate, 'accept')">审阅后保存</button><button class="button secondary" :disabled="busy" @click="emit('review', candidate, 'never')">不再建议</button><button v-if="candidate.status === 'pending'" class="button secondary" :disabled="busy" @click="emit('review', candidate, 'later')">稍后审阅</button><button class="button secondary" :disabled="busy" @click="emit('review', candidate, 'reject')">拒绝来源建议</button></div>
    </template>
    <div v-else-if="candidate.status === 'accepted'" class="button-row">
      <button v-if="memoryDecision('undo', candidate) === 'undo'" class="button secondary" :disabled="busy" @click="emit('review', candidate, 'undo')">撤回保存的偏好</button>
      <p v-else class="muted tiny">旧版已接受候选；没有精确派生关联，保留历史，不猜测删除哪条 Memory。</p>
    </div>
    <div v-else-if="candidate.status === 'never'" class="button-row"><button class="button secondary" :disabled="busy" @click="emit('review', candidate, 'undo')">恢复候选</button></div>
    <p v-else class="muted tiny">已拒绝的历史候选，仅供查看；不会保存或触发执行。</p>
  </article>
</section>
</template>
