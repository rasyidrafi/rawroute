import type { CanonicalModelSummary, PricingRates } from "@/lib/types"

const MODELS_DEV_URL = "https://models.dev/api.json"
const MODELS_DEV_TTL_MS = 60 * 60 * 1000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

type RawCatalog = Record<string, unknown>
type CatalogModel = CanonicalModelSummary & { source: "models.dev" }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function microsPerMillion(value: unknown) {
  const number = asNumber(value)
  return number === undefined ? 0 : Math.round(number * 1_000_000)
}

function modelPricing(detail: Record<string, unknown>): PricingRates {
  const cost = asRecord(detail.cost) || asRecord(detail.pricing) || {}
  return {
    inputMicrosPerMillion: microsPerMillion(cost.input ?? cost.prompt),
    outputMicrosPerMillion: microsPerMillion(cost.output ?? cost.completion),
    cacheReadMicrosPerMillion: microsPerMillion(cost.cache_read ?? cost.cacheRead),
    cacheCreationMicrosPerMillion: microsPerMillion(cost.cache_write ?? cost.cacheWrite),
  }
}

function contextLimit(detail: Record<string, unknown>) {
  const limit = asRecord(detail.limit)
  return asNumber(limit?.context ?? detail.context_length) ?? null
}

function toCatalogModel(provider: string, modelId: string, value: unknown): CatalogModel | undefined {
  const detail = asRecord(value)
  if (!detail) return undefined
  const id = modelId.includes("/") ? modelId : `${provider}/${modelId}`
  const name = typeof detail.name === "string" && detail.name.trim() ? detail.name.trim() : id
  const family = typeof detail.family === "string" && detail.family.trim() ? detail.family.trim() : null
  return { id, name, provider, family, pricing: modelPricing(detail), contextLimit: contextLimit(detail), source: "models.dev" }
}

function buildCatalogModels(catalog: RawCatalog) {
  const models: CatalogModel[] = []
  for (const [provider, providerValue] of Object.entries(catalog)) {
    const providerRecord = asRecord(providerValue)
    const catalogModels = asRecord(providerRecord?.models)
    if (!catalogModels) continue
    for (const [modelId, value] of Object.entries(catalogModels)) {
      const model = toCatalogModel(provider, modelId, value)
      if (model) models.push(model)
    }
  }
  const unique = new Map(models.map((model) => [model.id, model]))
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

async function loadCatalog(fetchFn: FetchLike) {
  const response = await fetchFn(MODELS_DEV_URL, { cache: "no-store" })
  if (!response.ok) throw new Error(`models.dev request failed: ${response.status} ${response.statusText}`)
  return buildCatalogModels(await response.json() as RawCatalog)
}

export function createModelsDevCatalogClient(args?: { ttlMs?: number; fetchFn?: FetchLike }) {
  const ttlMs = args?.ttlMs ?? MODELS_DEV_TTL_MS
  const fetchFn = args?.fetchFn ?? fetch
  let cachedModels: { expiresAt: number; models: CatalogModel[] } | undefined
  let pendingLoad: Promise<CatalogModel[]> | undefined

  return {
    clear() {
      cachedModels = undefined
      pendingLoad = undefined
    },
    async getModels() {
      if (cachedModels && cachedModels.expiresAt > Date.now()) return cachedModels.models
      if (!pendingLoad) {
        pendingLoad = loadCatalog(fetchFn).then((models) => {
          cachedModels = { models, expiresAt: Date.now() + ttlMs }
          return models
        }).finally(() => { pendingLoad = undefined })
      }
      return pendingLoad
    },
  }
}

const modelsDevCatalogClient = createModelsDevCatalogClient()

export function buildModelsDevCanonicalModels(catalog: RawCatalog) { return buildCatalogModels(catalog) }

export async function getModelsDevCanonicalModels() { return modelsDevCatalogClient.getModels() }

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function searchScore(model: CatalogModel, query: string) {
  if (!query) return 100
  const normalized = normalizeSearch(query)
  const searchable = `${normalizeSearch(model.id)} ${normalizeSearch(model.name)} ${normalizeSearch(model.provider)} ${normalizeSearch(model.family || "")}`
  const tokens = normalized.split(" ")
  if (!tokens.every((token) => searchable.includes(token))) return Number.POSITIVE_INFINITY
  const id = normalizeSearch(model.id)
  const name = normalizeSearch(model.name)
  if (id === normalized) return 0
  if (id.startsWith(normalized)) return 1
  if (name.startsWith(normalized)) return 2
  if (id.includes(normalized) || name.includes(normalized)) return 3
  return 4
}

export function filterModelsDevCanonicalModels(models: CatalogModel[], query = "", limit = DEFAULT_LIMIT) {
  const normalizedQuery = query.trim()
  const boundedLimit = limit === 0 ? MAX_LIMIT : Math.max(1, Math.min(MAX_LIMIT, limit))
  return models
    .map((model) => ({ model, score: searchScore(model, normalizedQuery) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || left.model.id.localeCompare(right.model.id))
    .slice(0, boundedLimit)
    .map((entry) => entry.model)
}

export async function searchModelsDevCanonicalModels(query = "", limit = DEFAULT_LIMIT) {
  return filterModelsDevCanonicalModels(await getModelsDevCanonicalModels(), query, limit)
}

export async function findModelsDevCanonicalModel(id: string) {
  const normalizedId = id.trim()
  if (!normalizedId) return undefined
  return (await getModelsDevCanonicalModels()).find((model) => model.id === normalizedId)
}

export function clearModelsDevCanonicalCache() {
  modelsDevCatalogClient.clear()
}
