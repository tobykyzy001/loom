<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import { fixtureComponent, installFixtureHosts, installStatusText } from '../lib/installPlan'
import type { InstallOutcome, InstallPlan, InstallPlanPolicy, InstallTarget } from '../api/types'

const props = defineProps<{ plans: InstallPlan[]; policy: InstallPlanPolicy | null; loading?: boolean; busy?: boolean; error?: string; readError?: string }>()
const emit = defineEmits<{
  refresh: []
  create: [ids: string[]]
  approve: [plan: InstallPlan, target: InstallTarget]
  rollback: [plan: InstallPlan, target: InstallTarget]
  observe: [plan: InstallPlan, target: InstallTarget, operation: 'apply' | 'rollback', outcome: InstallOutcome]
}>()
const selected = ref(new Set(installFixtureHosts.filter(host => host.selectedByDefault).map(host => host.host_key)))
const observationChoice = ref<Record<string, InstallOutcome>>({})
function toggle(id: string) {
  const choices = new Set(selected.value)
  if (choices.has(id)) choices.delete(id)
  else choices.add(id)
  selected.value = choices
}
function mode(status: string) { return ['healthy_observed', 'rolled_back_observed'].includes(status) ? 'synthetic' : ['health_failed', 'incompatible'].includes(status) ? 'danger' : status === 'not_selected' ? 'neutral' : 'waiting' }
function operationType(target: InstallTarget): 'apply' | 'rollback' | null {
  if (target.status === 'approved') return 'apply'
  if (target.status === 'rollback_approved') return 'rollback'
  return null
}
</script>

<template>
  <section class="page-view install-plans-view">
    <div class="page-title"><span class="eyebrow">SYNTHETIC INVENTORY ONLY</span><h1>先审阅计划，再核对证据。</h1><p>只支持合成 Inventory 的 Bare 候选包。这里没有任何真实主机安装、SSH、Grant 或 Profile 变更操作。</p></div>
    <div class="plans-policy"><AppIcon name="shield" :size="18" /><div><strong>合成审阅 · 非真机部署</strong><p>{{ policy && policy.fixture_reporting ? '服务端已显式启用 fixture 报告：只记录测试提供的观察，不代表真实节点反馈。' : 'fixture 报告当前关闭。仅可审阅计划，无法记录健康观察或回滚结果。' }}</p></div><span class="status-badge" :class="policy?.fixture_reporting ? 'waiting' : 'neutral'">{{ policy?.fixture_reporting ? '模拟模式（服务端允许）' : '仅审阅' }}</span></div>
    <p v-if="error" class="inline-note danger-note" role="alert">{{ error }}</p>
    <article class="card plan-draft">
      <div class="section-heading"><h2>选择合成 Inventory</h2><span class="muted tiny">固定静态清单，不扫描任何机器</span></div>
      <div class="fixture-component"><span class="package-icon"><AppIcon name="document" :size="21" /></span><div><strong>本机 Bare 候选包 · 版本 {{ fixtureComponent.version }}</strong><span>SHA-256 / <code class="wrap-value">{{ fixtureComponent.sha256 }}</code></span><span class="muted small">预算大小 {{ fixtureComponent.size_bytes.toLocaleString('en-US') }} B · {{ fixtureComponent.source }}</span></div></div>
      <fieldset class="fixture-inventory"><legend>仅限下述合成 Inventory；不表示已发现或信任节点</legend><label v-for="host in installFixtureHosts" :key="host.host_key" class="fixture-choice"><input type="checkbox" :checked="selected.has(host.host_key)" @change="toggle(host.host_key)" /><span><strong>{{ host.host_key }}</strong><small>{{ host.os }} / {{ host.arch }} · baseline 0.0.0 → 候选 0.1.0<template v-if="host.os === 'linux'">（与此包不兼容）</template></small></span></label></fieldset>
      <div class="draft-footer"><span class="muted small">只创建可审阅计划；不会创建 Ticket、Grant、节点或安装任何对象。</span><button class="button primary" :disabled="busy || !selected.size" @click="emit('create', [...selected])">检查计划创建影响<AppIcon name="arrow" :size="15" /></button></div>
    </article>

    <div class="plans-list-heading"><h2>已有审阅计划 <span class="count-pill">{{ plans.length }}</span></h2><button class="button secondary" :disabled="loading || busy" @click="emit('refresh')"><AppIcon name="refresh" :size="14" />刷新</button></div>
    <div v-if="readError && plans.length" class="inline-note warning-note" role="status">刷新未完成：{{ readError }}。下面是上一次顺利取得的历史内容，不保证实时有效。</div>
    <EmptyState v-if="loading && !plans.length" icon="sparkle" title="正在读取计划" description="仅读取，不自动创建计划或连接目标。" />
    <EmptyState v-else-if="readError && !plans.length" icon="warning" title="无法读取合成计划" :description="readError"><button class="button secondary" @click="emit('refresh')">重试读取</button></EmptyState>
    <EmptyState v-else-if="!plans.length" icon="document" title="还没有合成审阅计划" description="从上面的受控 Inventory 创建第一份工作计划。它不会产生真实部署或授权。" />

    <article v-for="plan in plans" :key="plan.id" class="card install-plan-card" :data-plan-id="plan.id" :data-plan-digest="plan.plan_digest">
      <div class="plan-card-heading"><div><span class="eyebrow">合成审阅 · 非真机部署</span><h2>{{ plan.id }}</h2></div><span class="status-badge neutral">v{{ plan.version }} · {{ plan.proof_kind }}</span></div>
      <p class="plan-provenance">{{ plan.source }} · {{ plan.authorization_revision }}</p>
      <dl class="plan-digest"><dt>不可变计划摘要</dt><dd class="wrap-value">{{ plan.plan_digest }}</dd></dl>
      <div class="install-targets"><article v-for="target in plan.targets" :key="target.id" class="install-target" :data-target-id="target.id" :data-status="target.status">
        <div class="target-heading"><div><h3>{{ target.host_key }} <span class="muted small">{{ target.os }}/{{ target.arch }}</span></h3><code class="target-id wrap-value">{{ target.id }}</code></div><span class="status-badge" :class="mode(target.status)">{{ installStatusText(target.status) }}</span></div>
        <div class="version-line"><span>基线 <code>{{ target.baseline_version }}</code></span><AppIcon name="arrow" :size="14" /><span>候选 <code>{{ target.requested_version }}</code></span><span>当前记录 <code>{{ target.current_version }}</code></span></div>
        <div v-if="target.current_operation_id" class="operation-line">操作引用 <code class="wrap-value">{{ target.current_operation_id }}</code></div>
        <p v-if="target.status === 'unknown'" class="inline-note warning-note">未知—需具名取证对账，不会自动重试。此状态不能作为健康或失败结论，也不能再次执行同一操作。</p>
        <p v-if="target.status === 'incompatible'" class="muted small">此目标仅为合成 Inventory 示例。当前候选仅适合 darwin/arm64；不会下载或安装其他平台包。</p>
        <p v-if="target.status === 'not_selected'" class="muted small">创建此计划时未选中，不给此目标建立审批或任何操作。</p>
        <div v-if="target.observations?.length" class="observation-history"><span v-for="(observation, index) in target.observations" :key="`${observation.operation}-${index}`" class="observation-tag">{{ observation.operation }} · {{ observation.outcome }} · 合成记录</span><span class="muted tiny">都是 operator 提交的 fixture 观察，不是主机遥测。</span></div>
        <div v-if="target.status === 'pending_approval'" class="target-actions"><button class="button secondary" :disabled="busy || !target.selected" @click="emit('approve', plan, target)">审阅此目标的 apply<AppIcon name="arrow" :size="14" /></button><span class="muted tiny">仅验证此 plan_digest 下的此一个目标，不批准全部目标。</span></div>
        <div v-else-if="target.status === 'healthy_observed' || target.status === 'health_failed'" class="target-actions"><button class="button secondary" :disabled="busy || !target.current_operation_id" @click="emit('rollback', plan, target)">审阅回滚此合成 apply</button></div>
        <template v-else-if="policy?.fixture_reporting && operationType(target)">
          <div class="synthetic-driver"><label :for="`observation-${target.id}`">报告一次合成观察（测试驱动）</label><select :id="`observation-${target.id}`" v-model="observationChoice[target.id]"><option disabled :value="undefined">选择受控 fixture 结果</option><option value="healthy">healthy · 正常合成报告</option><option value="health_failed">health_failed · 失败合成报告</option><option value="connection_lost">connection_lost · 未知，不可盲目重试</option></select><button class="button secondary" :disabled="busy || !observationChoice[target.id]" @click="emit('observe', plan, target, operationType(target)!, observationChoice[target.id])">审阅这份合成报告</button></div>
        </template>
        <p v-else-if="(target.status === 'approved' || target.status === 'rollback_approved') && !policy?.fixture_reporting" class="muted small">已审批计划动作。服务端未启用 fixture 报告，不能伪造健康或回滚结果。</p>
      </article></div>
    </article>
  </section>
</template>

<style scoped>
.plans-policy { display: flex; gap: 13px; align-items: center; padding: 15px 18px; border: 1px solid var(--line); border-radius: 11px; background: #fff; margin-bottom: 25px; color: #71647d; }
.plans-policy > div { flex: 1; }
.plans-policy strong { font-size: 12px; font-weight: 600; }
.plans-policy p { font-size: 10px; margin-top: 5px; }
.plans-policy svg { flex-shrink: 0; }
.plan-draft { padding: 22px; }
.fixture-component { display: flex; gap: 13px; align-items: center; padding: 16px 0; border-bottom: 1px solid var(--line); }
.fixture-component > div { display: grid; gap: 7px; font-size: 11px; overflow-wrap: anywhere; }
.fixture-component > div > span { color: var(--muted); }
.package-icon { display: grid; place-items: center; width: 42px; height: 42px; background: var(--purple-soft); color: var(--purple); border-radius: 9px; flex-shrink: 0; }
.wrap-value { overflow-wrap: anywhere; word-break: break-all; }
.fixture-inventory { border: 0; padding: 0; margin: 18px 0 0; }
.fixture-inventory legend { font-size: 10px; color: var(--muted); padding: 0; margin-bottom: 9px; }
.fixture-choice { display: flex; gap: 10px; align-items: flex-start; padding: 11px 0; border-bottom: 1px solid #f1eff5; cursor: pointer; }
.fixture-choice input { accent-color: var(--purple); width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }
.fixture-choice > span { display: grid; gap: 5px; }
.fixture-choice strong { font-size: 11px; font-weight: 550; }
.fixture-choice small { font-size: 10px; line-height: 1.8; color: var(--muted); }
.draft-footer { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding-top: 19px; }
.draft-footer > span { font-size: 10px; }
.draft-footer .button { flex-shrink: 0; }
.plans-list-heading { display: flex; justify-content: space-between; align-items: center; margin-top: 28px; margin-bottom: 14px; }
.install-plan-card { padding: 23px; margin-top: 17px; }
.plan-card-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; }
.plan-card-heading h2 { font-size: 15px; font-weight: 600; margin-top: 8px; overflow-wrap: anywhere; }
.plan-provenance { font-size: 10px; margin-top: 10px; color: var(--muted); overflow-wrap: anywhere; }
.plan-digest { display: grid; grid-template-columns: 117px minmax(0, 1fr); gap: 11px; padding: 15px; background: #faf9fd; border: 1px solid #efedf4; border-radius: 8px; margin: 19px 0 0; }
.plan-digest dt { color: var(--muted); font-size: 10px; }
.plan-digest dd { margin: 0; font-family: var(--mono); font-size: 10px; line-height: 1.8; }
.install-targets { margin-top: 20px; }
.install-target { padding: 17px 0; border-top: 1px solid var(--line); }
.target-heading { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
.target-heading h3 { font-size: 13px; font-weight: 600; }
.target-heading h3 > span { margin-left: 8px; font-size: 10px; font-weight: 400; }
.target-id { display: block; margin-top: 7px; font-size: 9px; color: var(--muted); line-height: 1.8; }
.version-line { display: flex; gap: 13px; align-items: center; flex-wrap: wrap; font-size: 10px; margin-top: 15px; color: #736a81; }
.operation-line { font-size: 10px; margin-top: 10px; color: var(--muted); }
.operation-line code { margin-left: 9px; }
.target-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 16px; }
.target-actions > span { max-width: 350px; font-size: 9px; line-height: 1.8; }
.synthetic-driver { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 17px; padding: 13px; border: 1px solid #e9ddc6; background: #fffcf5; border-radius: 8px; }
.synthetic-driver label { grid-column: 1 / -1; color: #9c7747; font-size: 10px; font-weight: 500; }
.synthetic-driver select { min-width: 0; font-size: 11px; padding: 7px; background: #fff; border: 1px solid #dfd2bd; border-radius: 6px; color: #695847; }
.observation-history { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 14px; }
.observation-tag { font-size: 10px; padding: 5px 8px; background: #faf4e8; border: 1px solid #eadcbf; border-radius: 5px; color: #987346; }
.observation-history .tiny { font-size: 9px; line-height: 1.8; }
.status-badge.synthetic { color: #806538; background: #fff4dd; }
@media (max-width: 520px) {
  .plans-policy { flex-wrap: wrap; gap: 10px; padding: 13px; }
  .plans-policy p { font-size: 10px; }
  .plans-policy > span { margin-left: auto; }
  .plan-draft, .install-plan-card { padding: 17px; }
  .draft-footer { flex-wrap: wrap; gap: 15px; }
  .draft-footer .button { margin-left: auto; }
  .plan-card-heading { flex-wrap: wrap; }
  .plan-digest { grid-template-columns: 1fr; gap: 7px; }
  .target-heading { flex-wrap: wrap; }
  .target-heading h3 > span { display: block; margin: 5px 0 0; }
  .synthetic-driver { grid-template-columns: 1fr; }
  .synthetic-driver label { grid-column: 1; }
}
</style>
