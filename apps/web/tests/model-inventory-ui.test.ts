import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ModelInventorySection from '../src/components/ModelInventorySection.vue'
import type { CatalogModel, ModelCatalogObservation, ModelInventoryData, ModelInventoryPolicy } from '../src/api/types'
import { confidenceLabel, findingLabel, modelReadError, parseModelInventory } from '../src/lib/modelInventory'
import { ApiError } from '../src/api/client'

const policy: ModelInventoryPolicy = {
  schema: 'loom.model-inventory.v1', views: 'observations', supported_operations: ['read_catalog_only'],
  install_support: 'NOT_IMPLEMENTED', activation_support: 'NOT_IMPLEMENTED', download_support: 'NOT_IMPLEMENTED',
  install: false, download: false, activation: false, generation: false,
  remote_delivery: false, billing_effects: false, universal_provider_registry: false, not_supported: ['image_generation'],
}
const model: CatalogModel = {
  id: 'catalog:' + 'a'.repeat(64), node_id: 'a'.repeat(64),
  installation_id: '11111111-1111-4111-8111-111111111111', worker_id: 'default',
  provider: 'loom-stub', model: 'loom-stub-v1', catalogued: true, prepared_call_observed: true,
  generation_observed: false, input_modalities: ['text'], context_window: 131072,
  source: 'host_reported', observed_at: '2026-11-17T07:45:00Z', resource_state: 'adapter_observed',
  activated: false, allowed: false, executable: false, controller_matches: true,
  read_source: 'authenticated_node_heartbeat', freshness: 'fresh',
}
const observation: ModelCatalogObservation = {
  schema: 'loom.model-inventory.v1', revision: 1, models: [model],
  findings: [{ state: 'prepared_call_ready', provider: 'loom-stub', model: 'loom-stub-v1', observed_at: model.observed_at }],
  resource_facts: [], policy, confidence: 'fresh_observation',
  node_id: model.node_id, installation_id: model.installation_id, worker_id: 'default',
  read_source: 'authenticated_node_heartbeat', lookup_source: 'ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall',
  controller_matches: true, permission_granted: false,
}
const good: ModelInventoryData = { schema: 'loom.model-inventory.v1', revision: 1, models: [model], observations: [observation], policy, policy_code: 'observed_only_not_activation' }

describe('strict, controller-signed model inventory observation reader', () => {
  it('accepts only the current text stub catalog and rejects foreign providers, modalities and execution flags', () => {
    const result = parseModelInventory(good)
    expect(result?.models).toHaveLength(1)
    expect(result?.observations[0].permission_granted).toBe(false)
    expect(result?.models[0].context_window).toBe(131072)
    expect(result?.models[0].activated).toBe(false)
    expect(result?.models[0].prepared_call_observed).toBe(true)
    const altered = (change: (model: CatalogModel) => void): ModelInventoryData => {
      const value = structuredClone(good)
      change(value.models[0])
      return value
    }
    const invalidPayloads: unknown[] = [
      altered(row => { row.generation_observed = true as false }),
      altered(row => { row.provider = 'deepseek' }),
      altered(row => { row.input_modalities = ['text', 'image'] as unknown as ['text'] }),
      altered(row => { row.worker_id = 'shadow-worker' }),
      { ...good, policy: { ...policy, install: true } },
      { ...good, policy: { ...policy, supported_operations: ['read_catalog_only', 'activate'] } },
      { ...good, policy_code: 'untrusted_provider' },
    ]
    for (const invalid of invalidPayloads) expect(parseModelInventory(invalid)).toBeNull()
  })

  it('keeps stale observation as history and explicitly reports an unavailable endpoint', () => {
    const historical = structuredClone(good)
    historical.models[0].freshness = 'stale'
    historical.models[0].resource_state = 'unavailable'
    historical.observations[0].confidence = 'offline_last_known'
    const result = parseModelInventory(historical)
    expect(result?.models[0].resource_state).toBe('unavailable')
    expect(result?.models[0].allowed).toBe(false)
    expect(confidenceLabel('offline_last_known')).toBe('离线 · 上次已知')
    expect(findingLabel('requested_disabled')).toBe('未启用精确目录查询')
    expect(modelReadError(new ApiError(501, 'not_implemented', '未实现', '/model-inventory'))).toContain('NOT RUN')
  })
})

describe('read-only model resources under the actual Fleet layout', () => {
  it('shows the actual host/worker/model, modality, observation time and no model lifecycle action', async () => {
    const html = await renderToString(createSSRApp(ModelInventorySection, { inventory: good }))
    expect(html).toContain('模型目录观察不等于执行 Grant。不提供下载或激活。')
    expect(html).toContain('loom-stub / loom-stub-v1')
    expect(html).toContain(model.node_id)
    expect(html).toContain('131,072 tokens 的声明窗口')
    expect(html).toContain('主机上报 · 已认证心跳')
    expect(html).toContain('已观察文本适配器（未激活）')
    expect(html).toContain('permission_granted: false')
    expect(html).toContain('data-worker-id="default"')
    expect(html).not.toContain('激活模型')
    expect(html).not.toContain('下载模型')
    expect(html).not.toContain('安装模型')
    expect(html).not.toContain('运行模型')
  })

  it('does not infer installed or running resources from missing findings or an unavailable endpoint', async () => {
    const empty = structuredClone(good)
    empty.models = []
    empty.observations[0].models = []
    empty.observations[0].confidence = 'missing_unknown'
    empty.observations[0].findings = [{ state: 'requested_disabled' }]
    const html = await renderToString(createSSRApp(ModelInventorySection, { inventory: empty }))
    const failure = await renderToString(createSSRApp(ModelInventorySection, { inventory: null, error: '目录观察接口不可用（NOT RUN）' }))
    expect(html).toContain('未知 / 尚未有适配器证据')
    expect(html).toContain('未启用精确目录查询')
    expect(html).not.toContain('模型不存在')
    expect(failure).toContain('NOT RUN')
    expect(failure).not.toContain('模型已就绪')
    expect(failure).not.toContain('激活模型')
    const noInventory = await renderToString(createSSRApp(ModelInventorySection, { inventory: null }))
    expect(noInventory).toContain('尚未读取模型观察')
    expect(noInventory).not.toContain('模型已安装')
  })
})
