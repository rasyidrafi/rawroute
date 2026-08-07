import { cleanAliasId } from "@/lib/http"
import { protocolPaths, type Model, type ModelAlias, type Protocol, type Provider } from "@/lib/types"

const providerIndexCache = new WeakMap<Provider[], Map<string, Provider>>()
const modelIndexCache = new WeakMap<Model[], Map<string, Model>>()
const aliasIndexCache = new WeakMap<ModelAlias[], Map<string, string>>()
const resolvedAliasModelCache = new WeakMap<ModelAlias[], WeakMap<Model[], Map<string, Model>>>()
const upstreamUrlCache = new Map<string, string>()
const maximumUpstreamUrlCacheEntries = 256

function providerIndex(providers: Provider[]) {
  let index = providerIndexCache.get(providers)
  if (index) return index
  index = new Map()
  for (const provider of providers) if (provider.enabled) index.set(provider.id, provider)
  providerIndexCache.set(providers, index)
  return index
}

function modelIndex(models: Model[]) {
  let index = modelIndexCache.get(models)
  if (index) return index
  index = new Map()
  for (const model of models) {
    if (!model.enabled) continue
    const gatewayModelId = model.gatewayModelId || model.id
    if (!index.has(gatewayModelId)) index.set(gatewayModelId, model)
  }
  modelIndexCache.set(models, index)
  return index
}

function aliasIndex(aliases: ModelAlias[]) {
  let index = aliasIndexCache.get(aliases)
  if (index) return index
  index = new Map()
  for (const alias of aliases) {
    const normalized = cleanAliasId(alias.alias)
    if (normalized && !index.has(normalized)) index.set(normalized, alias.targetModelId)
  }
  aliasIndexCache.set(aliases, index)
  return index
}


function resolvedAliasModels(aliases: ModelAlias[], models: Model[], modelsByGatewayId: Map<string, Model>) {
  let byModels = resolvedAliasModelCache.get(aliases)
  if (!byModels) {
    byModels = new WeakMap()
    resolvedAliasModelCache.set(aliases, byModels)
  }
  const cached = byModels.get(models)
  if (cached) return cached

  const targets = aliasIndex(aliases)
  const resolved = new Map<string, Model>()
  for (const aliasId of targets.keys()) {
    if (resolved.has(aliasId)) continue
    const path: string[] = []
    const visited = new Set<string>()
    let current = aliasId
    let model: Model | undefined
    while (!visited.has(current)) {
      const cachedModel = resolved.get(current)
      if (cachedModel) { model = cachedModel; break }
      visited.add(current)
      path.push(current)
      const target = targets.get(current)
      if (!target) break
      model = modelsByGatewayId.get(target)
      if (model) break
      const normalizedTarget = cleanAliasId(target)
      if (!normalizedTarget) break
      current = normalizedTarget
    }
    if (model) for (const id of path) resolved.set(id, model)
  }
  byModels.set(models, resolved)
  return resolved
}

export function buildUpstreamUrl(baseUrl: string, routePath: string) {
  const cacheKey = `${baseUrl}\n${routePath}`
  const cached = upstreamUrlCache.get(cacheKey)
  if (cached) return cached

  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/$/, "")
  const path = basePath.endsWith("/v1") && routePath.startsWith("/v1/")
    ? routePath.slice(3)
    : routePath
  url.pathname = `${basePath}${path.startsWith("/") ? path : `/${path}`}`
  url.search = ""
  url.hash = ""
  const value = url.toString()
  if (upstreamUrlCache.size >= maximumUpstreamUrlCacheEntries) {
    const oldest = upstreamUrlCache.keys().next().value
    if (oldest !== undefined) upstreamUrlCache.delete(oldest)
  }
  upstreamUrlCache.set(cacheKey, value)
  return value
}

export function resolveRoute(
  providers: Provider[],
  models: Model[],
  aliases: ModelAlias[],
  requestedModel: string,
  requestedProtocol: Protocol,
) {
  const modelsByGatewayId = modelIndex(models)
  let model = modelsByGatewayId.get(requestedModel)
  if (!model && aliases.length) {
    const normalized = cleanAliasId(requestedModel)
    if (normalized) model = resolvedAliasModels(aliases, models, modelsByGatewayId).get(normalized)
  }
  if (!model) return { ok: false as const, status: 404, message: `Unknown or disabled model: ${requestedModel}` }

  const provider = providerIndex(providers).get(model.providerId)
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
