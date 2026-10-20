import type { Model, ModelAlias, ModelCombo, Provider, SharedModelView } from "./domain"

function enabledProviderIndex(providers: Provider[]) {
  const index = new Map<string, Provider>()
  for (const provider of providers) if (provider.enabled) index.set(provider.id, provider)
  return index
}

function modelGatewayId(model: Model) {
  return model.gatewayModelId || model.id
}

export interface RoutingModelOption {
  id: string
  name: string
  provider: string
  kind: "model" | "alias" | "combo"
  available: boolean
  unavailableReason?: string
  members: string[]
}

export function routingModelCatalog(providers: Provider[], models: Model[], aliases: ModelAlias[] = [], combos: ModelCombo[] = [], sharedModels: SharedModelView[] = []) {
  const providerIndex = new Map(providers.map((provider) => [provider.id, provider]))
  const modelIndex = new Map(models.flatMap((model) => [[model.id, model], [modelGatewayId(model), model]] as const))
  const shares = new Map(sharedModels.map((share) => [share.id, share]))
  const modelAvailable = (model: Model | undefined) => Boolean(model?.enabled && providerIndex.get(model.providerId)?.enabled)
  const aliasAvailable = (alias: ModelAlias) => alias.sharedModelId
    ? shares.get(alias.sharedModelId)?.status === "active"
    : modelAvailable(modelIndex.get(alias.targetModelId))
  const availableAliases = new Set(aliases.filter(aliasAvailable).map((alias) => alias.alias))
  const entries: Array<RoutingModelOption & { created: number; owned_by: string; protocol: string }> = []
  for (const model of models) {
    const provider = providerIndex.get(model.providerId)
    const available = modelAvailable(model)
    entries.push({
      id: modelGatewayId(model), name: model.name || modelGatewayId(model), provider: provider?.name || "Unknown provider", kind: "model", available,
      ...(!available ? { unavailableReason: !model.enabled ? "Model disabled" : "Provider unavailable" } : {}), members: [],
      created: Math.floor(Date.parse(model.createdAt) / 1000), owned_by: provider?.prefix || "rawroute", protocol: provider?.protocol || "openai-chat",
    })
  }
  for (const alias of aliases) {
    const target = modelIndex.get(alias.targetModelId)
    const provider = target ? providerIndex.get(target.providerId) : undefined
    const available = aliasAvailable(alias)
    entries.push({
      id: alias.alias, name: alias.name || alias.alias, provider: "Alias", kind: "alias", available,
      ...(!available ? { unavailableReason: "Target model unavailable" } : {}), members: [alias.targetModelId],
      created: Math.floor(Date.parse(alias.createdAt) / 1000), owned_by: provider?.prefix || "rawroute", protocol: provider?.protocol || "openai-chat",
    })
  }
  for (const combo of combos) {
    const available = combo.members.some((member) => member.sharedModelId
      ? shares.get(member.sharedModelId)?.status === "active"
      : modelAvailable(modelIndex.get(member.modelId)) || availableAliases.has(member.modelId))
    entries.push({
      id: combo.combo, name: combo.name || combo.combo, provider: "Combo", kind: "combo", available,
      ...(!available ? { unavailableReason: "No available members" } : {}),
      members: combo.members.map((member) => {
        const share = member.sharedModelId ? shares.get(member.sharedModelId) : undefined
        return member.sharedModelId ? `${member.modelId} (budget: ${share?.ownerWorkspaceName || "owner workspace"})` : member.modelId
      }),
      created: Math.floor(Date.parse(combo.createdAt) / 1000), owned_by: "rawroute", protocol: "openai-chat",
    })
  }
  return entries
}

export function catalogModels(providers: Provider[], models: Model[], aliases: ModelAlias[] = [], combos: ModelCombo[] = [], sharedModels: SharedModelView[] = []) {
  return routingModelCatalog(providers, models, aliases, combos, sharedModels)
    .filter((entry) => entry.available)
    .map(({ id, created, owned_by, protocol }) => ({ id, object: "model" as const, created, owned_by, protocol }))
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
