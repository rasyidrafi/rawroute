import type { Model, ModelAlias, ModelCombo, Provider, SharedModelView } from "@/lib/types"

function enabledProviderIndex(providers: Provider[]) {
  const index = new Map<string, Provider>()
  for (const provider of providers) if (provider.enabled) index.set(provider.id, provider)
  return index
}

function modelGatewayId(model: Model) {
  return model.gatewayModelId || model.id
}

export function catalogModels(providers: Provider[], models: Model[], aliases: ModelAlias[] = [], combos: ModelCombo[] = [], sharedModels: SharedModelView[] = []) {
  const enabledProviders = enabledProviderIndex(providers)
  const enabledModels = new Map<string, { model: Model; provider: Provider }>()
  const entries: Array<{ id: string; object: "model"; created: number; owned_by: string; protocol: string }> = []

  for (const model of models) {
    if (!model.enabled) continue
    const provider = enabledProviders.get(model.providerId)
    if (!provider) continue
    const gatewayModelId = modelGatewayId(model)
    if (!enabledModels.has(gatewayModelId)) enabledModels.set(gatewayModelId, { model, provider })
    entries.push({
      id: gatewayModelId,
      object: "model",
      created: Math.floor(Date.parse(model.createdAt) / 1000),
      owned_by: provider.prefix,
      protocol: provider.protocol,
    })
  }

  for (const alias of aliases) {
    const target = enabledModels.get(alias.targetModelId)
    if (!target) continue
    entries.push({
      id: alias.alias,
      object: "model",
      created: Math.floor(Date.parse(alias.createdAt) / 1000),
      owned_by: target.provider.prefix,
      protocol: target.provider.protocol,
    })
  }
  const availableAliases = new Set(aliases.filter((alias) => enabledModels.has(alias.targetModelId) || Boolean(alias.sharedModelId)).map((alias) => alias.alias))
  const availableShares = new Set(sharedModels.filter((model) => model.status === "active").map((model) => model.id))
  for (const combo of combos) {
    if (!combo.members.some((member) => member.sharedModelId ? availableShares.has(member.sharedModelId) : enabledModels.has(member.modelId) || availableAliases.has(member.modelId))) continue
    entries.push({
      id: combo.combo,
      object: "model",
      created: Math.floor(Date.parse(combo.createdAt) / 1000),
      owned_by: "rawroute",
      protocol: "openai-chat",
    })
  }
  return entries
}

export function catalogLiteLlmModelInfo(providers: Provider[], models: Model[], aliases: ModelAlias[] = []) {
  const enabledProviders = enabledProviderIndex(providers)
  const enabledModels = new Map<string, { model: Model; provider: Provider }>()
  const entries: Array<{
    model_name: string
    litellm_params: { model: string }
    model_info: { id: string; db_model: false; mode: "chat" }
  }> = []

  for (const model of models) {
    if (!model.enabled) continue
    const provider = enabledProviders.get(model.providerId)
    if (!provider) continue
    const gatewayModelId = modelGatewayId(model)
    if (!enabledModels.has(gatewayModelId)) enabledModels.set(gatewayModelId, { model, provider })
    if (provider.protocol !== "openai-chat") continue
    entries.push({
      model_name: gatewayModelId,
      litellm_params: { model: model.upstreamModel },
      model_info: { id: gatewayModelId, db_model: false, mode: "chat" },
    })
  }

  for (const alias of aliases) {
    const target = enabledModels.get(alias.targetModelId)
    if (!target || target.provider.protocol !== "openai-chat") continue
    entries.push({
      model_name: alias.alias,
      litellm_params: { model: target.model.upstreamModel },
      model_info: { id: alias.alias, db_model: false, mode: "chat" },
    })
  }
  return entries
}
