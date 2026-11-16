<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AuditEntry, Project, Ticket } from '../api/types'
import { projectName, statusLabel, statusToneFor as statusTone } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'

const props = defineProps<{ tickets: Ticket[]; projects: Project[]; audit: AuditEntry[] }>()
const emit = defineEmits<{ select: [id: string] }>()
const filter = ref('all')
const labels: { value: string; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'pending', label: '待执行' }, { value: 'running', label: '执行中' }, { value: 'waiting_approval', label: '等待批准' }, { value: 'succeeded', label: '已完成' }, { value: 'failed', label: '失败' }, { value: 'cancelled', label: '已取消' }, { value: 'reconciling', label: '对账中' },
]
const visible = computed(() => filter.value === 'all' ? props.tickets : props.tickets.filter(ticket => ticket.status === filter.value))
</script>

<template>
  <section class="page-view"><div class="page-title"><span class="eyebrow">WORKSPACE JOURNAL</span><h1>每一项工作，都有迹可循。</h1><p>不看热闹的过程，只看真实的执行、决定和结果。</p></div>
    <div class="card activity-workview"><div class="status-filter-list" role="group" aria-label="活动状态"><button v-for="item in labels" :key="item.value" :class="{ selected: filter === item.value }" @click="filter = item.value">{{ item.label }}</button></div>
      <EmptyState v-if="!visible.length" icon="activity" title="还没有此类记录" description="任务报告、取消与待对账状态会原样显示。" />
      <div v-else class="journal-list"><button v-for="ticket in visible" :key="ticket.id" class="journal-item" @click="emit('select', ticket.id)"><span class="status-dot" :class="statusTone(ticket.status)" /><div><strong>{{ ticket.objective }}</strong><span>{{ projectName(projects, ticket.project_id) }} · {{ ticket.reports?.length ?? 0 }} 份报告 · {{ ticket.artifacts?.length ?? 0 }} 个产物</span><span class="mono muted">Attempt {{ ticket.attempt }} · {{ ticket.id.slice(0, 16) }}</span></div><span class="status-badge" :class="statusTone(ticket.status)">{{ statusLabel(ticket.status) }}</span><AppIcon name="chevron" :size="16" /></button></div>
    </div>
    <div class="callout"><AppIcon name="shield" :size="19" /><div><strong>结果不是一个“成功”气泡</strong><p>如果执行结果未知，Loom 会进入对账；若不能访问某台 Host 的过程记录，会如实提示缺口。</p></div></div>
  </section>
</template>
