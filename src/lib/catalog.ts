import type { Model, Provider } from "@/lib/types"

export function catalogModels(providers: Provider[], models: Model[]) {
  const enabledProviders = new Map(providers.filter((provider) => provider.enabled).map((provider) => [provider.id, provider]))
  return models.flatMap((model) => {
    const provider = enabledProviders.get(model.providerId)
    if (!model.enabled || !provider) return []
    return [{
      id: model.id,
      object: "model" as const,
      created: Math.floor(new Date(model.createdAt).getTime() / 1000),
      owned_by: provider.prefix,
      protocol: model.protocol || provider.protocol,
    }]
  })
}

export function catalogLiteLlmModelInfo(providers: Provider[], models: Model[]) {
  const enabledProviders = new Map(providers.filter((provider) => provider.enabled).map((provider) => [provider.id, provider]))
  return models.flatMap((model) => {
    const provider = enabledProviders.get(model.providerId)
    if (!model.enabled || !provider) return []
    const protocol = model.protocol || provider.protocol
    if (protocol !== "openai-chat") return []

    return [{
      model_name: model.id,
      litellm_params: {
        model: model.upstreamModel,
      },
      model_info: {
        id: model.id,
        db_model: false,
        mode: "chat",
      },
    }]
  })
}
