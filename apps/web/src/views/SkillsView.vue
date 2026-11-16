<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import { candidateContent, replayRequirement, saveRecordedProof, skillSourceRefs } from '../lib/skillProof'
import { statusLabel } from '../lib/format'
import type { Project, SkillCandidate, SkillWorkspaceData, Ticket } from '../api/types'

const props = defineProps<{ data: SkillWorkspaceData | null; projects: Project[]; tickets: Ticket[]; loading?: boolean; busy?: boolean; error?: string; loadError?: string }>()
const emit = defineEmits<{
  refresh: []
  replay: [candidate: SkillCandidate, sourceTicketId: string]
  review: [candidate: SkillCandidate, decision: 'accept' | 'reject' | 'undo']
  ticket: [ticketId: string]
}>()

const selections = reactive<Record<string, string>>({})
const entries = computed(() => (props.data?.candidates ?? []).filter(item => item.kind === 'skill').map(candidate => {
  const replay = props.data?.skill_replays.find(row => row.candidate_id === candidate.id) ?? null
  const saved = props.data?.skills.find(skill => skill.candidate_id === candidate.id)
  const proof = saved ? saveRecordedProof(saved) : null
  const refs = skillSourceRefs(candidate.source_refs)
  const content = candidateContent(candidate)
  const chosen = selections[candidate.id] && refs.includes(selections[candidate.id]) ? selections[candidate.id] : refs[0]
  const source = props.tickets.find(ticket => ticket.id === chosen)
  const validSource = source && source.kind === 'read_summary' && source.status === 'succeeded' && !source.cancel_requested && source.project_id === candidate.scope && source.artifacts?.length === 1
  const replaySourceTicket = props.tickets.find(ticket => ticket.id === replay?.source_ticket_id)
  const replaySourceArtifact = replaySourceTicket?.artifacts?.find(artifact => artifact.artifact_id === replay?.source_artifact_id)
  const replayTicket = props.tickets.find(ticket => ticket.id === replay?.replay_ticket_id)
  const replayArtifact = replayTicket?.artifacts?.find(artifact => artifact.artifact_id === replay?.replay_artifact_id)
  let rejection = replayRequirement(replay, candidate)
  if (replay && !rejection) {
    if (!replayTicket || replayTicket.kind !== 'read_summary' || replayTicket.id === replaySourceTicket?.id || !replaySourceTicket || replaySourceTicket.kind !== 'read_summary' || !replaySourceArtifact || !replayArtifact) rejection = '普通原任务或回放 Artifact 关系不完整'
    else if (!replay.grant_id || replaySourceArtifact.sha256 !== replay.expected_sha256 || replayArtifact.sha256 !== replay.expected_sha256) rejection = '原产物、回放产物与预期哈希不一致'
    else if (replaySourceTicket.project_id !== candidate.scope || replayTicket.project_id !== candidate.scope || replaySourceTicket.project_id !== replayTicket.project_id) rejection = '来源和回放的项目范围不一致'
    else if (!proof && saved) rejection = '已保存证明的关联不完整'
  }
  const canReplay = candidate.status === 'pending' && !replay && !!content && refs.length > 0 && !!validSource
  return { candidate, refs, content, replay, saved, proof, source, validSource, rejection, canReplay }
}))
watch(() => props.data, data => {
  for (const candidate of data?.candidates.filter(item => item.kind === 'skill') ?? []) {
    const refs = skillSourceRefs(candidate.source_refs)
    if (refs.length && !refs.includes(selections[candidate.id])) selections[candidate.id] = refs[0]
  }
}, { immediate: true })
const pending = computed(() => entries.value.filter(entry => entry.candidate.status !== 'accepted'))
const accepted = computed(() => entries.value.filter(entry => entry.candidate.status === 'accepted'))
const statusTitle: Record<string, string> = { awaiting_execution: '等待真实执行', verified: '回放证据已通过', sample_mismatch: '回放样本不一致', failed: '回放已失败', reconciling: '结果需要对账' }
function projectName(scope: string) { return props.projects.find(project => project.id === scope)?.name ?? '项目范围（不可映射）' }
function badge(status: string) { return status === 'verified' ? 'success' : status === 'sample_mismatch' || status === 'failed' ? 'danger' : 'waiting' }
</script>

<template>
  <section class="page-view skills-view">
    <div class="page-title"><span class="eyebrow">REVIEW REAL REPLAY PROOF</span><h1>让证据带你审阅 Skill。</h1><p>来自真实普通 read_summary 任务的有限回放。候选、记忆和已保存证明分开查看；保存 Skill 不产生常驻执行权。</p></div>
    <div class="skill-policy"><AppIcon name="shield" :size="19" /><p>{{ data?.policy || '仅展示 bounded exact read_summary 回放证据；不提供 Skill 运行、安装、Agent 或通用工作流。' }}</p><button class="button secondary refresh-skills" :disabled="loading || busy" @click="emit('refresh')"><AppIcon name="refresh" :size="15" />{{ loading ? '正在刷新…' : '刷新' }}</button></div>
    <div v-if="error" class="inline-note danger-note" role="alert">{{ error }}</div>
    <EmptyState v-if="loading && !data" icon="sparkle" title="正在读取证据" description="无自动回放或启动操作。" />
    <EmptyState v-else-if="loadError && !data" icon="warning" title="暂时无法读取 Skill 证据" :description="loadError"><button class="button secondary" @click="emit('refresh')">重新读取</button></EmptyState>
    <template v-else>
      <section class="skill-section" aria-labelledby="pending-skills-heading">
        <div class="section-heading"><h2 id="pending-skills-heading">候选与回放 <span class="count-pill">{{ pending.length }}</span></h2><span class="muted tiny">READ-ONLY PROOF</span></div>
        <EmptyState v-if="!pending.length" icon="sparkle" title="没有待审阅的 Skill 候选" description="只有真实的 Skill 候选出现在这里，不改变 Memory。" />
        <article v-for="entry in pending" :key="entry.candidate.id" class="skill-card card" :data-candidate-id="entry.candidate.id">
          <div class="skill-card-heading"><h3>{{ entry.content ?? '候选内容未提供可安全读取的摘要' }}</h3><span class="status-badge" :class="entry.candidate.status === 'pending' ? 'waiting' : 'neutral'">{{ entry.candidate.status === 'pending' ? '等待证据或审阅' : entry.candidate.status === 'rejected' ? '已拒绝' : entry.candidate.status === 'later' ? '稍后审阅' : '当前状态不可用' }}</span></div>
          <span class="muted small skill-scope"><AppIcon name="projects" :size="13" />{{ projectName(entry.candidate.scope) }} · <code>{{ entry.candidate.scope }}</code> · v{{ entry.candidate.version }}</span>
          <div v-if="!entry.refs.length" class="inline-note warning-note"><AppIcon name="warning" :size="16" />缺少合法的实际 source_ticket_id。无法启动回放，不会猜测原任务。</div>
          <template v-else-if="!entry.replay && entry.candidate.status === 'pending'">
            <div class="skill-source-field"><label :for="`source-${entry.candidate.id}`">选择已列出的原始任务</label><select :id="`source-${entry.candidate.id}`" v-model="selections[entry.candidate.id]" :aria-label="`${entry.candidate.id} 的原始任务`"><option v-for="ticketId in entry.refs" :key="ticketId" :value="ticketId">{{ ticketId }}</option></select></div>
            <p v-if="!entry.validSource" class="inline-note warning-note">原 Ticket 不存在、缺少唯一 Artifact、项目不匹配，或不是未取消的成功 read_summary。不能用于回放。</p>
            <p v-else class="source-note">真实原任务 {{ selections[entry.candidate.id] || entry.refs[0] }} · {{ entry.source?.status ? statusLabel(entry.source.status) : '不可确认' }}</p>
            <button class="ticket-link" @click="emit('ticket', selections[entry.candidate.id] || entry.refs[0])"><AppIcon name="document" :size="14" />查看原始任务</button>
            <button class="button secondary skill-action" :disabled="!entry.canReplay" @click="emit('replay', entry.candidate, selections[entry.candidate.id])">审阅回放影响<AppIcon name="arrow" :size="15" /></button>
          </template>
          <template v-if="entry.replay">
            <div class="replay-associated"><span class="status-badge" :class="badge(entry.replay.status)">{{ statusTitle[entry.replay.status] || '尚未确认的证据' }}</span><template v-if="entry.replay.status === 'awaiting_execution'"><button class="button secondary skill-action" :disabled="loading || busy" @click="emit('refresh')"><AppIcon name="refresh" :size="14" />检查真实结果</button></template></div>
            <p class="replay-reason" :class="{ 'danger-text': entry.rejection }">{{ entry.rejection || '服务端报告已验证；此提示不构成独立验证。再次检查后方可接受。' }}</p>
            <p v-if="entry.replay.reason" class="muted small replay-reason">{{ entry.replay.reason }}</p>
            <dl class="skill-evidence">
              <div><dt>原任务</dt><dd><button class="ticket-link" @click="emit('ticket', entry.replay.source_ticket_id)">{{ entry.replay.source_ticket_id }}</button></dd></div>
              <div><dt>回放任务</dt><dd><button class="ticket-link" @click="emit('ticket', entry.replay.replay_ticket_id)">{{ entry.replay.replay_ticket_id }}</button></dd></div>
              <div><dt>原始 Artifact</dt><dd class="uuid">{{ entry.replay.source_artifact_id }}</dd></div>
              <div><dt>回放 Artifact</dt><dd v-if="entry.replay.replay_artifact_id" class="uuid">{{ entry.replay.replay_artifact_id }}</dd><dd v-else>尚未产出</dd></div>
              <div><dt>预期 SHA-256</dt><dd class="uuid">{{ entry.replay.expected_sha256 }}</dd></div>
              <div><dt>Grant 记录</dt><dd class="uuid">{{ entry.replay.grant_id || '未提供' }}</dd></div>
            </dl>
            <p class="muted small">采样 {{ entry.replay.sample?.path ?? '不可用' }} · 行数 {{ entry.replay.sample?.line_count ?? '未知' }}</p>
            <p v-if="entry.replay.grant_revocation_denied_at" class="inline-note warning-note">原 Grant 已撤销，不能用于首次审核；历史可回看。历史任务证据没有被隐藏或删除。</p>
            <div v-if="entry.candidate.status === 'pending'" class="skill-review-actions"><button class="button primary" :disabled="!!entry.rejection" @click="emit('review', entry.candidate, 'accept')">接受已验证证据</button><button class="button secondary" :disabled="busy" @click="emit('review', entry.candidate, 'reject')">拒绝候选</button></div>
          </template>
          <p v-if="!entry.replay && entry.candidate.status === 'pending'" class="muted tiny action-footnote">必须用户确认后才发起一次普通只读 Ticket；不会自行轮询或执行任意代码。</p>
          <p v-if="entry.saved && !entry.proof" class="inline-note warning-note">已保存的 Skill 证明格式不完整，仅保留此不可解析记录，不声明已验证。</p>
        </article>
      </section>

      <section class="skill-section saved-skills" aria-labelledby="saved-skills-heading">
        <div class="section-heading"><h2 id="saved-skills-heading">已保存的证据 <span class="count-pill">{{ accepted.length }}</span></h2><span class="muted tiny">HISTORICAL PROOF ONLY</span></div>
        <EmptyState v-if="!accepted.length" icon="check" title="尚未保存 Skill 证明" description="接受只建立在原 Grant 仍有效、真实回放通过且独立 Artifact 字节匹配的记录上。" />
        <article v-for="entry in accepted" :key="entry.candidate.id" class="skill-card card saved-proof" :data-candidate-id="entry.candidate.id">
          <div class="skill-card-heading"><h3>{{ entry.content ?? '已保存 Skill' }}</h3><span class="status-badge neutral">历史证明 · 非激活</span></div>
          <p class="muted small">{{ projectName(entry.candidate.scope) }} · <code>{{ entry.candidate.id }}</code></p>
          <template v-if="entry.saved && entry.proof">
            <p class="saved-description">已保存原 read_summary 的只读证据。不是可执行 Skill，不是新授权、provider 或工具；原 Grant 撤销后历史仍可查看。</p>
            <dl class="skill-evidence"><div><dt>原始 Ticket</dt><dd><button class="ticket-link" @click="emit('ticket', entry.proof.source_ticket_id)">{{ entry.proof.source_ticket_id }}</button></dd></div><div><dt>回放 Ticket</dt><dd><button class="ticket-link" @click="emit('ticket', entry.proof.replay_ticket_id)">{{ entry.proof.replay_ticket_id }}</button></dd></div><div><dt>原始 Artifact</dt><dd class="uuid">{{ entry.proof.source_artifact_id }}</dd></div><div><dt>回放 Artifact</dt><dd class="uuid">{{ entry.proof.replay_artifact_id }}</dd></div><div><dt>记录 SHA-256</dt><dd class="uuid">{{ entry.replay?.expected_sha256 || '回放数据缺失，请保留记录并核对' }}</dd></div><div><dt>proof SHA-256</dt><dd class="uuid">{{ entry.proof.sha256 }}</dd></div><div><dt>关联 Grant</dt><dd class="uuid">{{ entry.proof.grant_id }}</dd></div></dl>
            <button class="button secondary skill-action" :disabled="busy" @click="emit('review', entry.candidate, 'undo')">撤销这次已保存审阅</button>
          </template>
          <div v-else class="inline-note warning-note"><AppIcon name="warning" :size="16" />历史 proof 不可用或引用不一致，不能宣布此 Skill 已验证，也不能运行。</div>
        </article>
      </section>
    </template>
  </section>
</template>

<style scoped>
.skill-policy { display: flex; gap: 14px; align-items: center; padding: 14px 18px; background: #fff; border: 1px solid var(--line); border-radius: 11px; color: #686579; }
.skill-policy p { flex: 1; font-size: 11px; line-height: 1.75; overflow-wrap: anywhere; }
.skill-policy > svg { flex-shrink: 0; }
.refresh-skills { flex-shrink: 0; }
.skill-section { margin-top: 29px; }
.skill-card { padding: 22px; margin-top: 15px; }
.skill-card-heading { display: flex; gap: 15px; justify-content: space-between; align-items: flex-start; }
.skill-card h3 { font-size: 15px; line-height: 1.65; font-weight: 600; overflow-wrap: anywhere; word-break: break-word; }
.skill-scope { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 11px; overflow-wrap: anywhere; }
.skill-source-field { display: grid; grid-template-columns: 175px minmax(0, 1fr); align-items: center; gap: 12px; margin-top: 18px; }
.skill-source-field label { color: #777080; font-size: 11px; }
.skill-source-field select { font-family: var(--mono); font-size: 10px; border: 1px solid #dfdce5; border-radius: 6px; background: #fff; padding: 9px; min-width: 0; color: #4f465c; }
.replay-associated { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-top: 20px; flex-wrap: wrap; }
.replay-reason { font-size: 11px; color: #6e6978; margin-top: 10px; overflow-wrap: anywhere; }
.skill-evidence { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; margin-top: 18px; padding-top: 17px; border-top: 1px solid #efedf2; }
.skill-evidence > div { display: grid; gap: 5px; font-size: 10px; align-items: start; }
.skill-evidence dt { color: #7a7384; }
.skill-evidence dd { margin: 0; min-width: 0; font-size: 10px; line-height: 1.9; }
.uuid { font-family: var(--mono); overflow-wrap: anywhere; word-break: break-all; }
.ticket-link { display: block; color: var(--purple); font-size: 10px; font-family: var(--mono); padding: 2px 0; overflow-wrap: anywhere; word-break: break-all; }
.skill-action, .source-note { margin-top: 14px; }
.action-footnote { margin-top: 10px; font-size: 9px; line-height: 1.9; }
.source-note { color: #77727d; font-size: 10px; overflow-wrap: anywhere; }
.skill-review-actions { display: flex; gap: 10px; margin-top: 21px; }
.saved-proof { border-color: #e2e0eb; }
.saved-description { color: #786c85; font-size: 11px; line-height: 1.8; margin-top: 15px; }
@media (max-width: 520px) {
  .skill-policy { align-items: flex-start; flex-wrap: wrap; padding: 13px; }
  .skill-policy p { font-size: 10px; }
  .skill-policy .refresh-skills { margin-left: auto; }
  .skill-card { padding: 17px; }
  .skill-card-heading { flex-direction: column; gap: 10px; }
  .skill-source-field { grid-template-columns: 1fr; gap: 7px; }
  .skill-evidence { grid-template-columns: 1fr; gap: 14px; }
  .skill-evidence dd, .uuid, .ticket-link { font-size: 10px; }
  .skill-review-actions { flex-wrap: wrap; }
}
</style>
