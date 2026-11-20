import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'
import InstallPlansView from '../src/views/InstallPlansView.vue'
import { createInstallManifest, InstallPlanActions, readInstallPlan } from '../src/lib/installPlan'
import { fixtureComponent } from '../src/lib/installPlan'
import type { InstallPlan, InstallPlanData, InstallTarget } from '../src/api/types'
import type { LoomClient } from '../src/api/client'

const digest = 'd'.repeat(64)
const nodeId = fixtureComponent.sha256
function target(status: InstallTarget['status'] = 'pending_approval', overrides: Partial<InstallTarget> = {}): InstallTarget {
  return { id: 'plan-a-target-0', host_key: 'fixture-darwin', os: 'darwin', arch: 'arm64',
    baseline_version: '0.0.0', requested_version: '0.1.0', selected: true, status,
    current_version: '0.0.0', current_operation_id: null, approved_at: null, observations: [], ...overrides }
}
function plan(targets = [target(), target('not_selected', { id: 'plan-a-target-1', host_key: 'fixture-unselected', selected: false }), target('incompatible', { id: 'plan-a-target-2', host_key: 'fixture-linux', os: 'linux', status: 'incompatible' }) ]): InstallPlan {
  return { id: 'plan-a', schema: 'loom.install-plan.v1', version: 1, plan_digest: digest,
    proof_kind: 'synthetic_plan_only', source: 'explicit_admin_inventory_manifest',
    component: { kind: 'bare_host', version: '0.1.0', sha256: nodeId, source: 'local_package_candidate' },
    authorization_revision: 'admin_plan_review_not_execution_grant', host_execution: false,
    created_at: '', updated_at: '', targets }
}
const reportingPolicy = { simulation_only: true, fixture_reporting: true, remote_execution: false, proof_kind: 'synthetic_plan_only' as const }
function response(item: InstallPlan): InstallPlanData { return { plan: item, policy: reportingPolicy } }
async function render(plans: InstallPlan[], reporting = true) {
  return renderToString(createSSRApp(InstallPlansView, { plans, policy: reporting ? reportingPolicy : { ...reportingPolicy, fixture_reporting: false }, busy: false, loading: false }))
}

describe('controlled synthetic Inventory manifest and response boundaries', () => {
  it('creates only the explicit candidate and fixture keys, no host/node URL/credentials or permissions', () => {
    const input = createInstallManifest(['fixture-darwin', 'fixture-linux'])
    expect(JSON.parse(JSON.stringify(input))).toEqual({
      schema: 'loom.install-plan.v1', source: 'explicit_admin_inventory_manifest',
      component: { kind: 'bare_host', version: '0.1.0', sha256: fixtureComponent.sha256, source: 'local_package_candidate' },
      targets: [
        { host_key: 'fixture-darwin', os: 'darwin', arch: 'arm64', baseline_version: '0.0.0', requested_version: '0.1.0', selected: true },
        { host_key: 'fixture-unselected', os: 'darwin', arch: 'arm64', baseline_version: '0.0.0', requested_version: '0.1.0', selected: false },
        { host_key: 'fixture-linux', os: 'linux', arch: 'arm64', baseline_version: '0.0.0', requested_version: '0.1.0', selected: true },
      ],
    })
    expect(input).not.toHaveProperty('grant')
    expect(input).not.toHaveProperty('plan_digest')
    expect(readInstallPlan(response(plan()))?.plan.plan_digest).toBe(digest)
    expect(readInstallPlan({ ...response(plan()), policy: { fixture_reporting: true, remote_execution: true, simulation_only: true, proof_kind: 'synthetic_plan_only' } })).toBeNull()
    expect(readInstallPlan({ ...response(plan()), plan: { ...plan(), proof_kind: 'installed' } })).toBeNull()
  })

  it('renders only selected compatible approval candidates, and never treats unselected/incompatible targets as approvals', async () => {
    const html = await render([plan()])
    expect(html).toContain('合成审阅 · 非真机部署')
    expect(html).toContain(digest)
    expect(html).toContain('fixture-darwin')
    expect(html).toContain('fixture-unselected')
    expect(html).toContain('fixture-linux')
    expect((html.match(/审阅此目标的 apply/g) ?? []).length).toBe(1)
    expect(html).toContain('此候选包不兼容')
    expect(html).not.toContain('已激活')
    const action = new InstallPlanActions({ post: vi.fn(), get: vi.fn() } as unknown as LoomClient)
    await expect(action.approve(plan(), plan().targets[1])).rejects.toThrow('快照中明确选中的兼容目标')
    expect(action.list).toBeDefined()
  })

  it('accepts only controller-derived local package evidence and never turns it into install status', async () => {
    const verified = plan()
    const source_manifest_sha256 = 'a'.repeat(64)
    verified.component.source_manifest_sha256 = source_manifest_sha256
    expect(readInstallPlan(response(verified))?.plan.component.source_manifest_sha256).toBe(source_manifest_sha256)
    const html = await render([verified])
    expect(html).toContain('本地manifest与binary已只读核验（未安装）')
    expect(html).toContain(`manifest SHA-256: ${source_manifest_sha256}`)
    expect(html).toContain('不是将来的持续安装或权限证明')
    expect((html.match(/审阅此目标的 apply/g) ?? []).length).toBe(1)
    expect(readInstallPlan(response(plan()))?.plan.component.source_manifest_sha256).toBeUndefined()
    for (const bad of ['not-a-hash', `${source_manifest_sha256}\n`, `${source_manifest_sha256}0`, null, 1]) {
      const mutated = plan()
      Object.assign(mutated.component, { source_manifest_sha256: bad })
      expect(readInstallPlan(response(mutated))).toBeNull()
    }
  })

  it('keeps unknown terminal and disables manual observation when the server has no fixture switch', async () => {
    const unknown = await render([plan([target('unknown', { current_operation_id: 'installop-unknown' })])])
    expect(unknown).toContain('未知—需具名取证对账，不会自动重试')
    expect(unknown).not.toContain('审阅回滚')
    expect(unknown).not.toContain('审阅这份合成报告')
    const disabled = await render([plan([target('approved', { current_operation_id: 'installop-apply' })])], false)
    expect(disabled).toContain('服务端未启用 fixture 报告')
    expect(disabled).not.toContain('healthy · 正常合成报告')
    const historical = await render([plan([target('rolled_back_observed', { current_version: '0.0.0', observations: [{ operation_id: 'apply-op', operation: 'apply', outcome: 'healthy', reported_at: '', report_kind: 'manual_synthetic_inventory_report', simulated: true }, { operation_id: 'rollback-op', operation: 'rollback', outcome: 'healthy', reported_at: '', report_kind: 'manual_synthetic_inventory_report', simulated: true }] })])])
    expect(historical).toContain('回滚观察（合成）')
    expect(historical).not.toContain('审阅这份合成报告')
  })

  it('binds approval and fixture requests to immutable current record without automatic network calls', async () => {
    const post = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({ plans: [], policy: reportingPolicy })
    const actions = new InstallPlanActions({ post, get } as unknown as LoomClient)
    expect(post).not.toHaveBeenCalled()
    const pending = plan().targets[0]
    await actions.approve(plan(), pending)
    expect(post).toHaveBeenCalledWith('/install-plans/plan-a/approve', { target_id: pending.id, reviewed_plan_digest: digest })
    await expect(actions.observe(plan(), { ...pending, status: 'unknown' }, { target_id: pending.id, operation: 'apply', outcome: 'healthy' }, reportingPolicy)).rejects.toThrow()
    const approved = target('approved', { current_operation_id: 'installop-apply' })
    await actions.observe(plan([approved]), approved, { target_id: approved.id, operation: 'apply', outcome: 'connection_lost' }, reportingPolicy)
    expect(post).toHaveBeenCalledWith('/install-plans/plan-a/observe', { target_id: approved.id, operation: 'apply', outcome: 'connection_lost' })
    expect(get).toHaveBeenCalledWith('/install-plans')
    expect(post.mock.calls.length).toBe(2)
    await expect(actions.rollback(plan([approved]), approved)).rejects.toThrow('合成 apply')
    const applyHistory = { operation_id: 'installop-apply', operation: 'apply' as const, outcome: 'health_failed' as const, reported_at: '2026-01-01T00:00:00Z', report_kind: 'manual_synthetic_inventory_report' as const, simulated: true as const }
    const rollbackTarget = target('rollback_approved', { current_operation_id: 'installop-rollback', rollback_parent_operation_id: 'installop-apply', observations: [applyHistory] })
    await actions.observe(plan([rollbackTarget]), rollbackTarget, { target_id: rollbackTarget.id, operation: 'rollback', outcome: 'healthy' }, reportingPolicy)
    expect(post).toHaveBeenNthCalledWith(3, '/install-plans/plan-a/observe', { target_id: rollbackTarget.id, operation: 'rollback', outcome: 'healthy' })
    await expect(actions.observe(plan([rollbackTarget]), { ...rollbackTarget, status: 'unknown', observations: [applyHistory, { ...applyHistory, operation_id: 'installop-rollback', outcome: 'connection_lost', operation: 'rollback' }] }, { target_id: rollbackTarget.id, operation: 'rollback', outcome: 'healthy' }, reportingPolicy)).rejects.toThrow('尚未观察')
    await expect(actions.rollback(plan([approved]), { ...approved, status: 'health_failed', observations: [{ ...applyHistory, operation_id: 'another-apply' }] })).rejects.toThrow('合成 apply')
    await actions.rollback(plan([approved]), { ...approved, status: 'health_failed', observations: [applyHistory] })
    expect(post).toHaveBeenNthCalledWith(4, '/install-plans/plan-a/rollback-approve', { target_id: approved.id, operation_id: 'installop-apply' })
  })
})
