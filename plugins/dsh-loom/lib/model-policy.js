/** A separate model-text permission, never implicit directory read/write permission. */
export function validTextGrant(assignment) {
  return Array.isArray(assignment.grant?.operations) && assignment.grant.operations.includes('invoke_text')
}

export function exactTextRoute(config, assignment) {
  if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') throw new Error('An explicit text provider/model binding is required')
  const route = { provider: assignment.provider || config.provider, model: assignment.model || config.model }
  if (route.provider !== config.provider || route.model !== config.model || route.provider.includes('*') || route.model.includes('*')) {
    throw new Error('Only the explicitly configured provider/model route is authorized')
  }
  if (route.provider.length > 160 || route.model.length > 160) throw new Error('Text model selector exceeds the bound')
  return route
}

/** Read only public model adapters. Do not create a Session or stream here.
 * Metadata registration is not model installation, inference permission or a
 * claim that whichever advertised provider is currently available is true.
 */
export async function inspectTextRoute(ctx, route) {
  const llm = ctx?.llm
  for (const name of ['listProviders', 'listModels', 'resolveModelInfo', 'prepareCall']) {
    if (typeof llm?.[name] !== 'function') throw new Error(`No public Host LLM ${name} surface`) // corrected in caller
  }
  const providers = await llm.listProviders()
  const provider = providers.find(({ id }) => id === route.provider)
  if (!provider) throw new Error('The explicit text provider is not publicly registered')
  const models = await llm.listModels(route.provider)
  const model = models.find(({ id, provider }) => id === route.model && provider === route.provider)
  if (!model || !Array.isArray(model.inputModalities) || !model.inputModalities.includes('text') || model.inputModalities.includes('image')) {
    throw new Error('Only the explicit text modality of this exact model is eligible')
  }
  const resolved = await llm.resolveModelInfo(route.provider, route.model)
  if (resolved.provider !== route.provider || resolved.id !== route.model || !resolved.inputModalities?.includes('text')) {
    throw new Error('Text-model resolution is either inconsistent or does not support this task type')
  }
  const call = await llm.prepareCall({ provider: route.provider, model: route.model })
  if (call?.config?.provider !== route.provider || call.config?.model !== route.model
    || call.inputModalities?.includes('text') !== true || typeof call.stream !== 'function') {
    throw new Error('No public adapter generation is ready for this exact text model')
  }
  return {
    provider: { id: provider.id, name: String(provider.name || provider.id).slice(0, 160) },
    model: { id: resolved.id, name: String(resolved.name || resolved.id).slice(0, 160), provider: resolved.provider,
      input_modalities: ['text'], ...(Number.isSafeInteger(resolved.context?.contextWindow) ? { context_window: resolved.context.contextWindow } : {}) },
    lookup_source: 'ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall',
    source: 'host_reported',
  }
}

export function modelRef(assignment, selected, observation, actualText, metadata) {
  return {
    schema: 'loom.model-ref.v1', kind: 'model_ref', provider: selected.provider, model: selected.model,
    input_modalities: ['text'], kind_name: 'deterministic_fixture_text', not_live_llm: selected.provider === 'loom-stub',
    source: 'host_reported', execution_observed: true, output_observed: Boolean(actualText),
    observed_at: new Date().toISOString(), lookup: observation,
    artifact_sha256: metadata.sha256,
    grant: { id: assignment.grant.id, operation: 'invoke_text' },
  }
}
