import { inspectTextRoute } from './model-policy.js'

const LOOKUP_SOURCE = 'ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall'
const NO_LIFECYCLE = Object.freeze({ install: false, download: false, activation: false, generation: false })
const ROUTE = /^[a-z0-9][a-z0-9._:-]{0,159}$/
const freeze = (value) => {
  if (value && typeof value === 'object') for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}

/** Bounded DSH SDK adapter catalog observations, never a general Provider lifecycle or execution Grant. */
export async function inspectModelCatalog(ctx, config, now = () => new Date().toISOString()) {
  const route = selector(config)
  if (config?.model_text_tasks !== true) return observation(route, 'requested_disabled', now)
  if (route.provider !== 'loom-stub' || route.model !== 'loom-stub-v1') return observation(route, 'unsupported_route', now)
  try {
    const facts = await inspectTextRoute(ctx, route)
    if (facts.lookup_source !== LOOKUP_SOURCE || facts.source !== 'host_reported') return observation(route, 'lookup_failed', now)
    const modalities = facts.model.input_modalities
    if (modalities.length !== 1 || modalities[0] !== 'text') return observation(route, 'unsupported_modality', now)
    if (facts.provider.id !== 'loom-stub' || facts.model.id !== 'loom-stub-v1') return observation(route, 'lookup_failed', now)
    const context_window = facts.model.context_window
    if (!Number.isSafeInteger(context_window) || context_window <= 0 || context_window > 1_048_576) {
      return observation(route, 'lookup_failed', now)
    }
    const observedAt = now()
    if (!validTimestamp(observedAt)) return observation(route, 'lookup_failed', now)
    return observation(route, 'prepared_call_ready', now, [{
      provider: 'loom-stub', model: 'loom-stub-v1', source: 'host_reported', observed_at: observedAt,
      resource_state: 'adapter_observed', prepared_call_observed: true, generation_observed: false,
      input_modalities: ['text'], context_window,
    }])
  } catch (error) {
    // No raw errors/credentials/Profile paths or trait-derived model capabilities in transport.
    const missing = /No public Host LLM/.test(error.message)
    return observation(route, missing ? 'lookup_unavailable' : 'lookup_failed', now)
  }
}

/** An explicit empty observation is never a fallback provider/model registration. */
export function emptyModelCatalog(worker_id, state = 'lookup_failed') {
  return observation({ worker_id }, state, () => new Date().toISOString())
}

/** Worker ID is from the same enrollment-derived Worker fact, never extracted from catalog/provider data. */
export function mergeModelCatalogFacts(base, cached) {
  if (!base || !Array.isArray(base.workers) || typeof base.inventory !== 'object') throw new TypeError('Base node Worker facts are required')
  if (!cached || cached.worker_id === undefined) throw new Error('Model observation has not completed')
  if (cached.worker_id !== base.workers[0]?.worker_id) throw new Error('Model observation belongs to a different Worker')
  const facts = base
  return { ...facts, workers: facts.workers,
    inventory: { ...facts.inventory, model_catalog: cached } }
}

function observation(route, state, now, models = []) {
  const at = now()
  const safeRoute = route.provider && route.model ? { provider: route.provider, model: route.model } : {}
  return freeze({
    schema: 'loom.model-inventory.v1', revision: 1, worker_id: route.worker_id,
    lookup_source: LOOKUP_SOURCE, source: 'host_reported', observed_at: at,
    models, findings: [{ state, ...safeRoute, source: 'host_reported', observed_at: at }], policy: { ...NO_LIFECYCLE },
  })
}
function selector(config) {
  const provider = typeof config.provider === 'string' && ROUTE.test(config.provider) ? config.provider : undefined
  const model = typeof config.model === 'string' && ROUTE.test(config.model) ? config.model : undefined
  // Worker can be absent initially; merge never allows choosing a Worker via model metadata.
  return { provider, model, worker_id: config.actual_worker_id }
}
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
