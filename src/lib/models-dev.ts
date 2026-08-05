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
  type CatalogState = { expiresAt: number; models: CatalogModel[]; byId: Map<string, CatalogModel> }
  let cachedCatalog: CatalogState | undefined
  let pendingLoad: Promise<CatalogState> | undefined
  let generation = 0

  async function getCatalog() {
    if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) return cachedCatalog
    if (!pendingLoad) {
      const loadGeneration = generation
      const promise = loadCatalog(fetchFn).then((models) => {
        const catalog = { models, byId: new Map(models.map((model) => [model.id, model])), expiresAt: Date.now() + ttlMs }
        if (loadGeneration === generation) cachedCatalog = catalog
        return catalog
      }).finally(() => {
        if (pendingLoad === promise) pendingLoad = undefined
      })
      pendingLoad = promise
    }
    return pendingLoad
  }

  return {
    clear() {
      generation += 1
      cachedCatalog = undefined
      pendingLoad = undefined
    },
    async getModels() {
      return (await getCatalog()).models
    },
    async getModel(id: string) {
      return (await getCatalog()).byId.get(id)
    },
    async getModelsByIds(ids: Iterable<string>) {
      const byId = (await getCatalog()).byId
      const result: CatalogModel[] = []
      for (const id of ids) {
        const model = byId.get(id)
        if (model) result.push(model)
      }
      return result
    },
  }
}

const modelsDevCatalogClient = createModelsDevCatalogClient()

export function buildModelsDevCanonicalModels(catalog: RawCatalog) { return buildCatalogModels(catalog) }

export async function getModelsDevCanonicalModels() { return modelsDevCatalogClient.getModels() }

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

interface SearchIndexEntry { id: string; name: string; searchable: string }
const modelSearchIndex = new WeakMap<CatalogModel, SearchIndexEntry>()

function indexedSearchText(model: CatalogModel) {
  let indexed = modelSearchIndex.get(model)
  if (!indexed) {
    const id = normalizeSearch(model.id)
    const name = normalizeSearch(model.name)
    indexed = {
      id,
      name,
      searchable: `${id} ${name} ${normalizeSearch(model.provider)} ${normalizeSearch(model.family || "")}`,
    }
    modelSearchIndex.set(model, indexed)
  }
  return indexed
}

function searchScore(model: CatalogModel, normalized: string, tokens: string[]) {
  const indexed = indexedSearchText(model)
  for (const token of tokens) if (!indexed.searchable.includes(token)) return -1
  if (indexed.id === normalized) return 0
  if (indexed.id.startsWith(normalized)) return 1
  if (indexed.name.startsWith(normalized)) return 2
  if (indexed.id.includes(normalized) || indexed.name.includes(normalized)) return 3
  return 4
}

export function filterModelsDevCanonicalModels(models: CatalogModel[], query = "", limit = DEFAULT_LIMIT) {
  const boundedLimit = limit === 0 ? MAX_LIMIT : Math.max(1, Math.min(MAX_LIMIT, limit))
  const normalized = normalizeSearch(query)
  if (!normalized) return models.slice(0, boundedLimit)

  const tokens = normalized.split(" ")
  const buckets: CatalogModel[][] = [[], [], [], [], []]
  for (const model of models) {
    const score = searchScore(model, normalized, tokens)
    if (score >= 0) buckets[score].push(model)
  }

  const result: CatalogModel[] = []
  for (const bucket of buckets) {
    bucket.sort((left, right) => left.id.localeCompare(right.id))
    const remaining = boundedLimit - result.length
    if (remaining <= 0) break
    if (bucket.length <= remaining) result.push(...bucket)
    else result.push(...bucket.slice(0, remaining))
  }
  return result
}

export async function searchModelsDevCanonicalModels(query = "", limit = DEFAULT_LIMIT) {
  return filterModelsDevCanonicalModels(await getModelsDevCanonicalModels(), query, limit)
}

export async function findModelsDevCanonicalModel(id: string) {
  const normalizedId = id.trim()
  if (!normalizedId) return undefined
  return modelsDevCatalogClient.getModel(normalizedId)
}

export async function findModelsDevCanonicalModels(ids: Iterable<string>) {
  return modelsDevCatalogClient.getModelsByIds(ids)
}

export function clearModelsDevCanonicalCache() {
  modelsDevCatalogClient.clear()
}
