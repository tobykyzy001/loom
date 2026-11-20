import { LoomClient } from '../api/client'
import type { InstallObservationRequest, InstallPlan, InstallPlanData, InstallPlanPolicy, InstallTarget } from '../api/types'

const ID = /^[a-z0-9_-]{1,64}$/
const VERSION = /^\d+\.\d+\.\d+$/
const outcomes = ['healthy', 'health_failed', 'connection_lost']
/** A fixed descriptor for a demonstrated local candidate, not a discovered host/package store. */
export const fixtureComponent = Object.freeze({
  kind: 'bare_host', version: '0.1.0',
  sha256: '1c9dc260a2d689602a6e133b9017561d9b69c30136834e08f51aaa05de3542c5',
  source: 'local_package_candidate', size_bytes: 21_778_296,
} as const)
export const installFixtureHosts = Object.freeze([
  { host_key: 'fixture-darwin', os: 'darwin', arch: 'arm64', selectedByDefault: true },
  { host_key: 'fixture-unselected', os: 'darwin', arch: 'arm64', selectedByDefault: false },
  { host_key: 'fixture-linux', os: 'linux', arch: 'arm64', selectedByDefault: false },
].map(host => Object.freeze(host)))

export function createInstallManifest(selected: string[]): Record<string, unknown> {
  const choice = new Set(selected)
  return {
    schema: 'loom.install-plan.v1', source: 'explicit_admin_inventory_manifest',
    component: { kind: fixtureComponent.kind, version: fixtureComponent.version, sha256: fixtureComponent.sha256, source: fixtureComponent.source },
    targets: installFixtureHosts.map(host => ({
      host_key: host.host_key, os: host.os, arch: host.arch,
      baseline_version: '0.0.0', requested_version: fixtureComponent.version, selected: choice.has(host.host_key),
    })),
  }
}

function validPolicy(value: unknown): value is InstallPlanPolicy {
  const policy = value as InstallPlanPolicy
  return !!policy && typeof policy === 'object' && policy.simulation_only === true && policy.remote_execution === false && policy.proof_kind === 'synthetic_plan_only' && typeof policy.fixture_reporting === 'boolean'
}
function isTarget(value: unknown): value is InstallTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as InstallTarget
  const observations = target.observations ?? []
  return ID.test(target.id) && ID.test(target.host_key) && target.host_key.startsWith('fixture-') && typeof target.status === 'string' && target.status.length < 80 &&
    VERSION.test(target.baseline_version) && VERSION.test(target.requested_version) && VERSION.test(target.current_version) &&
    typeof target.os === 'string' && target.os.length <= 32 && typeof target.arch === 'string' && target.arch.length <= 32 && typeof target.selected === 'boolean' &&
    Array.isArray(observations) && observations.length <= 2 && observations.every(item => ['apply', 'rollback'].includes(item.operation) && typeof item.operation_id === 'string' && ID.test(item.operation_id)) && observations.every(item => item.simulated === true && item.report_kind === 'manual_synthetic_inventory_report' && outcomes.includes(item.outcome))
}
export function readInstallPlan(value: unknown): InstallPlanData | null {
  if (!value || typeof value !== 'object') return null
  const { plan, policy } = value as Partial<InstallPlanData>
  if (!validPolicy(policy) || !plan || plan.schema !== 'loom.install-plan.v1' || plan.proof_kind !== 'synthetic_plan_only' || !ID.test(plan.id) || plan.host_execution !== false || plan.version !== 1 || plan.source !== 'explicit_admin_inventory_manifest') return null
  if (!/^[a-f0-9]{64}$/.test(plan.plan_digest) || !Array.isArray(plan.targets) || plan.targets.length < 1 || plan.targets.length > 4 || plan.targets.some(target => !isTarget(target))) return null
  const component = plan.component
  if (!component || component.kind !== fixtureComponent.kind || component.version !== fixtureComponent.version || component.sha256 !== fixtureComponent.sha256 || component.source !== fixtureComponent.source) return null
  if (component.source_manifest_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(component.source_manifest_sha256)) return null
  return { plan, policy }
}
function assertSelection(selected: string[]) {
  if (!selected.length || new Set(selected).size !== selected.length || selected.length > 4 || !selected.every(id => installFixtureHosts.some(host => host.host_key === id))) throw new Error('请至少选择一个受限合成 Inventory 目标。')
}
function belongs(plan: InstallPlan, target: InstallTarget): boolean {
  return plan.targets.some(item => item.id === target.id && item.host_key === target.host_key)
}
export function installStatusText(status: string): string {
  return ({
    pending_approval: '待审阅', approved: '已审阅（仅计划）', healthy_observed: '健康观察（合成）', health_failed: '健康失败（合成）',
    rollback_approved: '回滚待合成观察', rolled_back_observed: '回滚观察（合成）', unknown: '未知—需取证对账', not_selected: '未选中', incompatible: '此候选包不兼容',
  } as Record<string, string>)[status] ?? '未知状态—不可操作'
}

export interface InstallPlanRefresh { plans: InstallPlan[]; policy: InstallPlanPolicy }
export class InstallPlanActions {
  constructor(private readonly client: LoomClient) {}
  async list(): Promise<InstallPlanRefresh> {
    const response = await this.client.get<unknown>('/install-plans')
    if (!response || typeof response !== 'object') throw new Error('计划接口响应不完整。')
    const body = response as { plans?: unknown; policy?: unknown }
    if (!Array.isArray(body.plans) || body.plans.length > 32 || !validPolicy(body.policy)) throw new Error('计划响应缺少合成 Inventory 边界。')
    const plans = await Promise.all(body.plans.map(async raw => {
      const value = raw as Partial<InstallPlan>
      if (!value || typeof value.id !== 'string' || !ID.test(value.id)) throw new Error('计划 ID 不可用。')
      const planId = value.id
      const detail = readInstallPlan(await this.client.get<unknown>(`/install-plans/${encodeURIComponent(planId)}`))
      if (!detail) throw new Error('计划快照或合成策略无法验证，不可用于审阅。')
      return detail.plan
    }))
    return { plans, policy: body.policy }
  }
  async create(selected: string[]): Promise<InstallPlanRefresh> {
    assertSelection(selected)
    await this.client.post('/install-plans', createInstallManifest(selected))
    return this.list()
  }
  async approve(plan: InstallPlan, target: InstallTarget): Promise<InstallPlanRefresh> {
    if (!belongs(plan, target) || target.status !== 'pending_approval' || !target.selected) throw new Error('只能审阅快照中明确选中的兼容目标。')
    await this.client.post(`/install-plans/${encodeURIComponent(plan.id)}/approve`, { target_id: target.id, reviewed_plan_digest: plan.plan_digest })
    return this.list()
  }
  async rollback(plan: InstallPlan, target: InstallTarget): Promise<InstallPlanRefresh> {
    const lastApply = target.observations?.at(-1)
    if (!belongs(plan, target) || !['healthy_observed', 'health_failed'].includes(target.status) || !ID.test(target.current_operation_id ?? '') || lastApply?.operation !== 'apply' || lastApply.operation_id !== target.current_operation_id || lastApply.outcome === 'connection_lost') throw new Error('仅完成且未失联的合成 apply 操作可审阅回滚。')
    await this.client.post(`/install-plans/${encodeURIComponent(plan.id)}/rollback-approve`, { target_id: target.id, operation_id: target.current_operation_id })
    return this.list()
  }
  async observe(plan: InstallPlan, target: InstallTarget, request: InstallObservationRequest, policy: InstallPlanPolicy): Promise<InstallPlanRefresh> {
    const alreadyObserved = target.observations?.some(observation => observation.operation_id === target.current_operation_id) ?? false
    if (!validPolicy(policy) || !policy.fixture_reporting || !belongs(plan, target) || !ID.test(target.current_operation_id ?? '') || alreadyObserved || request.target_id !== target.id) throw new Error('仅允许在当前预批准且尚未观察的操作下记录一次合成报告。')
    if ((request.operation !== 'apply' || target.status !== 'approved') && (request.operation !== 'rollback' || target.status !== 'rollback_approved')) throw new Error('合成报告的 operation 与当前状态不匹配。')
    if (!outcomes.includes(request.outcome)) throw new Error('未知合成结果。')
    await this.client.post(`/install-plans/${encodeURIComponent(plan.id)}/observe`, request)
    return this.list()
  }
}
