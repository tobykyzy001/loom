<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Project, Ticket, TicketStatus } from '../api/types'
import { projectName, statusLabel, statusToneFor as statusTone } from '../lib/format'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ tickets: Ticket[]; projects: Project[]; selectedId?: string | null }>()
const emit = defineEmits<{ select: [id: string] }>()
const filters: { value: 'all' | TicketStatus; label: string }[] = [
  { value: 'all', label: '全部任务' }, { value: 'running', label: '执行中' },
  { value: 'waiting_approval', label: '等待你' }, { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' }, { value: 'cancelled', label: '已取消' },
  { value: 'reconciling', label: '待对账' },
]
const filter = ref('all')
const visible = computed(() => filter.value === 'all' ? props.tickets : props.tickets.filter(t => t.status === filter.value))
const openCount = computed(() => props.tickets.filter(t => t.status === 'waiting_approval').length)
</script>

<template>
  <section class="ticket-list card">
    <div class="section-heading list-title"><div><span class="eyebrow">进行中的工作</span><h2>任务 <span class="count-pill">{{ tickets.length }}</span></h2></div><span class="filter-button"><AppIcon name="filter" :size="17" /></span></div>
    <div class="task-filters" role="tablist" aria-label="任务状态筛选">
      <button v-for="item in filters" :key="item.value" class="filter-tab" :class="{ selected: filter === item.value }" role="tab" :aria-selected="filter === item.value" @click="filter = item.value">{{ item.label }}<span v-if="item.value === 'waiting_approval' && openCount" class="filter-count">{{ openCount }}</span></button>
    </div>
    <div v-if="visible.length" class="ticket-scroll">
      <button v-for="ticket in visible" :key="ticket.id" class="ticket-item" :class="{ current: selectedId === ticket.id }" @click="emit('select', ticket.id)">
        <div class="ticket-item-top"><span class="status-badge" :class="statusTone(ticket.status)"><span class="status-dot" />{{ statusLabel(ticket.status) }}</span><span class="muted tiny">#{{ ticket.id.slice(0, 6) }}</span></div>
        <p>{{ ticket.objective }}</p>
        <div class="ticket-item-meta"><span><AppIcon name="projects" :size="12" />{{ projectName(projects, ticket.project_id) }}</span><span class="muted">{{ ticket.kind === 'edit_file' ? '写入' : ticket.kind === 'model_text' ? '文本模型' : '读取' }}</span></div>
      </button>
    </div>
    <div v-else class="ticket-list-empty"><AppIcon name="activity" :size="21" /><p>{{ tickets.length ? '这个筛选中没有任务。' : '暂无任务。描述目标，开始第一个小步骤。' }}</p><button v-if="tickets.length" class="text-link" @click="filter = 'all'">查看全部任务</button></div>
    <div class="list-bottom"><AppIcon name="shield" :size="14" /><span>每个结果，都能找到来路。</span><span class="secured-dot" /></div>
  </section>
</template>
