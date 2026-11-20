import type { CatalogModel, ModelFinding, ModelInventoryData, ModelInventoryPolicy, ModelCatalogObservation } from '../api/types'
import { ApiError } from '../api/client'

const safeIdentity = /^[a-z0-9][a-z0-9:_-]{1,159}$/i
const safeName = /^[a-z][a-z0-9._:-]{0,159}$/
const confidenceLabels: Record<string, string> = {
  fresh_observation: '最新观察', stale_last_known: '陈旧 · 上次已知', offline_last_known: '离线 · 上次已知',
  missing_unknown: '尚未获得目录证据', invalid_observation: '观察不可用或字段不完整', revoked_last_known: '已撤销 · 仅存历史观察', worker_offline: 'Worker 离线 · 保留历史记录',
}
const findingLabels: Record<string, string> = {
  prepared_call_ready: '已观察文本适配器（未激活）', model_catalog_missing: '尚无目录观察', requested_disabled: '未启用精确目录查询',
  lookup_unavailable: '查询未就绪，无法确认模型可用性', lookup_failed: '查询失败，无法确认模型可用性', source_invalid: '来源或字段不符合目录约束',
  worker_mismatch: '工作器范围不匹配', worker_offline: '此 Worker 已离线 · 仅存历史观察', invalid_observation: '无效目录观察', unsupported_provider: '不提供该 Provider', unsupported_model: '不识别该模型',
  unsupported_route: '路由未支持', unsupported_modality: '模态未支持', not_granted: '旁路或未见准备的目录证据',
  prepared_call_failed: '目录准备失败', runtime_disposed: '适配器已释放（仅历史）', missing_unknown: '目录信息缺失 / 未知', duplicate_model_source: '重复模型来源（不新增记录）',
}
export function confidenceLabel(value: string): string { return confidenceLabels[value] ?? '目录状态不明确 · 不推断当前可用' }
export function findingLabel(value: string): string { return findingLabels[value] ?? `未知检查结果：${value}` }
export function modelReplayTime(value: string): boolean { return typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)) }
function identity(value: unknown): boolean { return typeof value === 'string' && safeIdentity.test(value) }
function rawPolicy(policy: unknown): boolean {
  if (!policy || typeof policy !== 'object') return false
  const value = policy as ModelInventoryPolicy
  return value.schema === 'loom.model-inventory.v1' && value.install === false && value.download === false && value.activation === false && value.generation === false && value.remote_delivery === false && value.billing_effects === false && value.universal_provider_registry === false && Array.isArray(value.supported_operations) && value.supported_operations.length === 1 && value.supported_operations[0] === 'read_catalog_only'
}
function validModel(value: unknown, observation: ModelCatalogObservation): value is CatalogModel {
  const row = value as CatalogModel
  if (!row || typeof row !== 'object' || row.source !== 'host_reported' || row.read_source !== 'authenticated_node_heartbeat' || row.provider !== 'loom-stub' || row.model !== 'loom-stub-v1' || typeof row.id !== 'string' || !Array.isArray(row.input_modalities)) return false
  if (observation.worker_id && (row.node_id !== observation.node_id || row.installation_id !== observation.installation_id || row.worker_id !== observation.worker_id)) return false
  return row.id.startsWith('catalog:') && safeIdentity.test(row.id.slice(8)) && safeName.test(row.provider) && safeName.test(row.model) &&
    identity(row.node_id) && identity(row.installation_id) && identity(row.worker_id) && modelReplayTime(row.observed_at) &&
    row.catalogued === true && row.prepared_call_observed === true && row.generation_observed === false && row.activated === false && row.allowed === false && row.executable === false &&
    row.controller_matches === true && row.input_modalities.length === 1 && row.input_modalities[0] === 'text' && (row.freshness === 'fresh' || row.freshness === 'stale') &&
    (row.resource_state === 'adapter_observed' || row.resource_state === 'unavailable') && (row.context_window === undefined || (Number.isSafeInteger(row.context_window) && row.context_window > 0 && row.context_window <= 1_048_576))
}
function validFinding(value: unknown): value is ModelFinding {
  if (!value || typeof value !== 'object' || (value as ModelFinding).state === undefined) return false
  const row = value as ModelFinding
  return typeof row.state === 'string' && /^[a-z0-9_:-]{1,80}$/.test(row.state) && (row.provider === undefined || safeName.test(row.provider)) && (row.model === undefined || safeName.test(row.model)) && (row.observed_at === undefined || modelReplayTime(row.observed_at))
}
function validObservation(value: unknown): value is ModelCatalogObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as ModelCatalogObservation
  if (row.schema !== 'loom.model-inventory.v1' || row.revision !== 1 || row.read_source !== 'authenticated_node_heartbeat' || row.permission_granted !== false || !identity(row.node_id) || !identity(row.installation_id) || (row.worker_id && !identity(row.worker_id))) return false
  if (row.confidence === 'fresh_observation' && (row.lookup_source !== 'ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall' || row.controller_matches !== true)) return false
  if (!row.confidence.match(/^(fresh_observation|stale_last_known|offline_last_known|revoked_last_known|missing_unknown|invalid_observation|worker_offline)$/) || !Array.isArray(row.findings) || row.findings.length > 8 || row.findings.some(finding => !validFinding(finding))) return false
  if (row.confidence === 'worker_offline' && row.models.some(model => model.resource_state !== 'unavailable' || model.freshness !== 'stale')) return false
  return rawPolicy(row.policy) && Array.isArray(row.models) && row.models.length <= 8 && row.models.every(model => validModel(model, row))
}
export function parseModelInventory(value: unknown): ModelInventoryData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as ModelInventoryData
  if (body.schema !== 'loom.model-inventory.v1' || body.revision !== 1 || body.policy_code !== 'observed_only_not_activation' || !rawPolicy(body.policy)) return null
  if (!Array.isArray(body.observations) || body.observations.length > 16 || body.observations.some(row => !validObservation(row))) return null
  if (!Array.isArray(body.models) || body.models.length > 8) return null
  const flattenedObservationsWithModels = body.observations.every(row => row.models.every(model => validModel(model, row)))
  if (!flattenedObservationsWithModels || !body.models.every(model => body.observations.some(row => validModel(model, row)))) return null
  return body
}
export function modelReadError(error: unknown): string {
  if (error instanceof ApiError && [404, 501].includes(error.status)) return '目录观察接口不可用（NOT RUN）'
  return error instanceof Error ? error.message : '读取目录观察失败，无法判断资源状态。'
}
export function resourceUnknown(model?: CatalogModel): boolean {
  return !model || model.resource_state !== 'adapter_observed' || model.freshness !== 'fresh'
}
