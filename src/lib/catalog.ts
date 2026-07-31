import type { Model, ModelAlias, Provider } from "@/lib/types"

type AliasTarget = { alias: ModelAlias; model: Model; provider: Provider }

function enabledAliasTargets(providers: Provider[], models: Model[], aliases: ModelAlias[]): AliasTarget[] {
  return aliases.flatMap((alias) => {
    const model = models.find((entry) => (entry.gatewayModelId || entry.id) === alias.targetModelId && entry.enabled)
    if (!model) return []
    const provider = providers.find((entry) => entry.id === model.providerId && entry.enabled)
    if (!provider) return []
    return [{ alias, model, provider }]
  })
}

export function catalogModels(providers: Provider[], models: Model[], aliases: ModelAlias[] = []) {
  const enabledProviders = new Map(providers.filter((provider) => provider.enabled).map((provider) => [provider.id, provider]))
  const entries = models.flatMap((model) => {
    const provider = enabledProviders.get(model.providerId)
    if (!model.enabled || !provider) return []
    const gatewayModelId = model.gatewayModelId || model.id
    return [{
      id: gatewayModelId,
      object: "model" as const,
      created: Math.floor(new Date(model.createdAt).getTime() / 1000),
      owned_by: provider.prefix,
      protocol: model.protocol || provider.protocol,
    }]
  })
  for (const { alias, model, provider } of enabledAliasTargets(providers, models, aliases)) {
    entries.push({
      id: alias.alias,
      object: "model" as const,
      created: Math.floor(new Date(alias.createdAt).getTime() / 1000),
      owned_by: provider.prefix,
      protocol: model.protocol || provider.protocol,
    })
  }
  return entries
}

export function catalogLiteLlmModelInfo(providers: Provider[], models: Model[], aliases: ModelAlias[] = []) {
  const enabledProviders = new Map(providers.filter((provider) => provider.enabled).map((provider) => [provider.id, provider]))
  const entries = models.flatMap((model) => {
    const provider = enabledProviders.get(model.providerId)
    if (!model.enabled || !provider) return []
    const gatewayModelId = model.gatewayModelId || model.id
    const protocol = model.protocol || provider.protocol
    if (protocol !== "openai-chat") return []

    return [{
      model_name: gatewayModelId,
      litellm_params: {
        model: model.upstreamModel,
      },
      model_info: {
        id: gatewayModelId,
        db_model: false,
        mode: "chat",
      },
    }]
  })
  for (const { alias, model, provider } of enabledAliasTargets(providers, models, aliases)) {
    const protocol = model.protocol || provider.protocol
    if (protocol !== "openai-chat") continue
    entries.push({
      model_name: alias.alias,
      litellm_params: {
        model: model.upstreamModel,
      },
      model_info: {
        id: alias.alias,
        db_model: false,
        mode: "chat",
      },
    })
  }
  return entries
}
