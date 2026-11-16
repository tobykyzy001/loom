<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AuditEntry, Ticket } from '../api/types'
import type { Preferences } from '../api/types'
import { delegationFor } from '../lib/delegation'
import { formatTime, reportStatusTone, reportStatusLabel, safeJson } from '../lib/format'
import AppIcon from './AppIcon.vue'
import EmptyState from './EmptyState.vue'

const props = defineProps<{ ticket: Ticket | null; audit: AuditEntry[]; expanded: boolean; preferences: Preferences; auditError?: string }>()
const emit = defineEmits<{ save: [expanded: boolean, sender: string] }>()
const tab = ref<'activity' | 'collaboration' | 'audit'>('activity')
const localExpanded = ref(props.expanded)
const sender = ref(props.preferences.sender_filter ?? '')
watch(() => props.ticket?.id, () => { localExpanded.value = props.expanded; sender.value = props.preferences.sender_filter ?? ''; tab.value = 'activity' })
watch(() => props.expanded, value => { localExpanded.value = value })

const collaborations = computed(() => props.ticket?.messages?.map(message => ({ message, delegation: delegationFor(message) })).filter(item => item.message.segment === 'collaboration' || item.message.sender_kind === 'worker' || item.message.sender_kind === 'agent') ?? [])
const visibleMessages = computed(() => collaborations.value.filter(item => !sender.value || item.message.sender === sender.value || item.message.sender_id === sender.value))
const senders = computed(() => [...new Set(collaborations.value.map(item => item.message.sender ?? item.message.sender_id).filter((s): s is string => !!s))])
  // The panel only projects authorized wire messages and center-validated relations.

</script>

<template>
  <aside class="activity-panel">
    <div class="activity-tabs" role="tablist" aria-label="任务过程视图">
      <button :class="{ selected: tab === 'activity' }" role="tab" :aria-selected="tab === 'activity'" @click="tab = 'activity'">Activity</button>
      <button :class="{ selected: tab === 'collaboration' }" role="tab" :aria-selected="tab === 'collaboration'" @click="tab = 'collaboration'">协作</button>
      <button :class="{ selected: tab === 'audit' }" role="tab" :aria-selected="tab === 'audit'" @click="tab = 'audit'">审计</button>
    </div>
    <div v-if="!ticket" class="activity-intro"><span class="mini-brand"><AppIcon name="activity" :size="19" /></span><h3>保持清晰，随时可查</h3><p>重要进展、执行者和证据在这里展开。我们默认只显示关键阶段。</p><div class="activity-principles"><span><i class="status-dot active" />状态来自结构化报告</span><span><i class="status-dot success" />产物可追溯，不靠口头承诺</span></div></div>
    <template v-else>
      <section v-if="ticket.assignments?.length" class="worker-card">
        <div class="worker-heading"><span class="worker-avatar"><AppIcon name="sparkle" :size="19" /></span><div><h3>{{ ticket.assignments.at(-1)?.worker_id || '已分配执行者' }}</h3><p>{{ ticket.assignments.at(-1)?.node_id }}<span class="online-small" /></p></div><span class="status-badge neutral">Attempt {{ ticket.attempt }}</span></div>
        <div class="worker-lease"><span>短期执行许可 Lease</span><span class="mono">#{{ ticket.assignments.at(-1)?.lease_epoch ?? '—' }}</span></div>
      </section>
      <div v-if="tab === 'activity'" class="activity-content">
        <h3 class="aside-heading">进展记录</h3>
        <div v-if="ticket.reports?.length" class="activity-timeline">
          <article v-for="(report, index) in ticket.reports" :key="report.id ?? index" class="activity-event">
            <span class="event-marker" :class="reportStatusTone(report.status)" />
            <div class="event-heading"><strong>{{ reportStatusLabel(report.status) }}</strong><span>{{ formatTime(report.created_at) }}</span></div>
            <p>{{ report.summary }}</p>
            <span v-if="report.assignment_id" class="event-label">Assignment · {{ report.assignment_id.slice(0, 12) }}</span>
          </article>
        </div>
        <div v-else-if="ticket.status === 'waiting_approval'" class="attention-box"><AppIcon name="clock" :size="20" /><h3>有一个决定等你来做</h3><p>这个工作区操作会在你明确批准后进入下一步。请在中央任务中查看范围。</p></div>
        <div v-else-if="ticket.status === 'reconciling'" class="attention-box"><AppIcon name="warning" :size="20" /><h3>结果还不能确定</h3><p>有未知副作用需要对账。Loom 不会把它标记为成功，也不会盲目重跑。</p></div>
        <EmptyState v-else icon="activity" title="等待新的进展" description="任务创建后，真实执行报告会出现在这里。" />
        <div v-if="ticket.effects?.length" class="effect-list"><h3 class="aside-heading">副作用对账</h3><div v-for="effect in ticket.effects" :key="effect.effect_id" class="effect-item"><span class="status-dot" :class="effect.status === 'confirmed' ? 'success' : 'waiting'" /><span>{{ effect.status === 'confirmed' ? '已确认' : effect.status === 'needs_person' ? '需要人工处理' : effect.status === 'unknown' ? '结果未知' : '已记录' }}</span><code>{{ effect.effect_id.slice(0, 12) }}</code></div></div>
      </div>
      <div v-else-if="tab === 'collaboration'" class="activity-content">
        <div class="display-settings"><span class="eyebrow">显示偏好 · 单任务</span><label class="switch-label"><input v-model="localExpanded" type="checkbox" @change="emit('save', localExpanded, sender)" /><span class="switch" />展开过程消息</label></div>
        <label v-if="senders.length" class="sender-filter"><AppIcon name="filter" :size="13" /><select v-model="sender" @change="emit('save', localExpanded, sender)"><option value="">全部发送者</option><option v-for="item in senders" :key="item" :value="item">{{ item }}</option></select></label>
        <template v-if="localExpanded && visibleMessages.length"><article v-for="{ message, delegation } in visibleMessages" :key="message.id" class="collab-message"><div><strong>{{ message.sender ?? message.sender_id ?? '执行者' }}</strong><span>{{ formatTime(message.created_at) }}</span></div><p>{{ message.content }}</p>
          <section v-if="delegation" class="delegation-source" data-testid="delegation-source">
            <h4>已核验的委派来源</h4>
            <dl>
              <div><dt>父任务</dt><dd class="mono">{{ delegation.ticket_id }}</dd></div>
              <div><dt>父 Artifact</dt><dd class="mono">{{ delegation.artifact_id }}</dd></div>
              <div><dt>父 Session</dt><dd class="mono">{{ delegation.parent_session_id }}</dd></div>
              <div><dt>子 Session</dt><dd class="mono">{{ delegation.child_session_id || '仅有参考信息' }}</dd></div>
            </dl>
            <p class="delegation-note">当前 Assignment 与来源关系经中心核验；仅显示公开引用，不代表完整宿主原文或新增权限。</p>
          </section></article></template>
        <EmptyState v-else icon="conversation" :title="localExpanded ? '没有可见的过程消息' : '过程已折叠'" :description="localExpanded ? '此任务尚无获授权的协作记录，或发送者筛选没有匹配记录。' : '只改变显示方式，不会删除任何审计或过程记录。'" />
        <p class="privacy-caption"><AppIcon name="lock" :size="13" />无法读取的 Host 原文会显示为缺口，不会由摘要伪造。</p>
      </div>
      <div v-else class="activity-content">
        <p class="audit-note"><AppIcon name="shield" :size="15" />权限与执行事实独立记录，隐藏过程不影响审计。</p>
        <template v-if="audit.length"><article v-for="(entry, i) in audit" :key="entry.id ?? i" class="audit-event"><span class="event-marker success" /><strong>{{ entry.summary ?? entry.action ?? entry.kind ?? '审计记录' }}</strong><time>{{ formatTime(entry.created_at, true) }}</time><p v-if="entry.actor">{{ entry.actor }}</p><pre v-if="entry.details">{{ safeJson(entry.details) }}</pre></article></template>
        <EmptyState v-else icon="shield" :title="auditError ? '审计记录暂不可用' : '暂无审计记录'" :description="auditError || '授权、分发与报告的相关事实将在这里显示。'" />
      </div>
    </template>
    <div class="activity-bottom"><span class="status-dot success" />安静运行，绝不隐瞒状态</div>
  </aside>
</template>
