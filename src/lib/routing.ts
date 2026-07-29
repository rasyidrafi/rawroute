import { protocolPaths, type Model, type Protocol, type Provider, type ProviderApiKey } from "@/lib/types"

const providerKeyCursor = new Map<string, number>()

export function selectProviderApiKey(providerId: string, apiKeys: ProviderApiKey[]) {
  const eligible = apiKeys.filter((apiKey) => apiKey.providerId === providerId && apiKey.enabled)
  if (!eligible.length) return undefined
  const cursor = providerKeyCursor.get(providerId) || 0
  providerKeyCursor.set(providerId, (cursor + 1) % eligible.length)
  return eligible[cursor % eligible.length]
}

export function buildUpstreamUrl(baseUrl: string, routePath: string) {
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/$/, "")
  const path = basePath.endsWith("/v1") && routePath.startsWith("/v1/")
    ? routePath.slice(3)
    : routePath
  url.pathname = `${basePath}${path.startsWith("/") ? path : `/${path}`}`
  url.search = ""
  return url
}

export function resolveRoute(
  providers: Provider[],
  models: Model[],
  requestedModel: string,
  requestedProtocol: Protocol,
) {
  const model = models.find((entry) => entry.id === requestedModel && entry.enabled)
  if (!model) return { ok: false as const, status: 404, message: `Unknown or disabled model: ${requestedModel}` }
  const provider = providers.find((entry) => entry.id === model.providerId && entry.enabled)
  if (!provider) return { ok: false as const, status: 503, message: "The model provider is disabled or missing." }
  const protocol = model.protocol || provider.protocol
  if (protocol !== requestedProtocol) {
    return {
      ok: false as const,
      status: 400,
      message: `Model ${model.id} uses ${protocol}. Send it to ${protocolPaths[protocol]}.`,
    }
  }
  return { ok: true as const, model, provider, protocol, upstreamModel: model.upstreamModel }
}
