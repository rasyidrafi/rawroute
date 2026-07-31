import { protocolPaths, type Model, type Protocol, type Provider } from "@/lib/types"

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
  const model = models.find((entry) => (entry.gatewayModelId || entry.id) === requestedModel && entry.enabled)
  if (!model) return { ok: false as const, status: 404, message: `Unknown or disabled model: ${requestedModel}` }
  const provider = providers.find((entry) => entry.id === model.providerId && entry.enabled)
  if (!provider) return { ok: false as const, status: 503, message: "The model provider is disabled or missing." }
  const protocol = model.protocol || provider.protocol
  const gatewayModelId = model.gatewayModelId || model.id
  if (protocol !== requestedProtocol) {
    return {
      ok: false as const,
      status: 400,
      message: `Model ${gatewayModelId} uses ${protocol}. Send it to ${protocolPaths[protocol]}.`,
    }
  }
  return { ok: true as const, model, provider, protocol, upstreamModel: model.upstreamModel }
}
