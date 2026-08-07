import { createHash } from "node:crypto"

import type { Model, Provider } from "@/lib/types"

const DEFAULT_CLIPROXY_URL = "http://cli-proxy-api:8317"
const catalogTtlMs = 30_000
let catalogCache: { providers: Provider[]; models: Model[]; expiresAt: number } | undefined
let catalogInflight: Promise<{ providers: Provider[]; models: Model[] }> | undefined

function baseUrl() {
  return (process.env.CLIPROXY_URL || DEFAULT_CLIPROXY_URL).replace(/\/$/, "")
}

function internalKey() {
  return process.env.CLIPROXY_API_KEY?.trim()
}

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash("sha1").update(value).digest("hex").slice(0, 20)}`
}

function cleanPrefix(value: string) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "cliproxy"
}

function createdAt(value: unknown) {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : new Date().toISOString()
}

function asModelRows(payload: unknown) {
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).data
    : undefined
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const row = entry as Record<string, unknown>
    const modelId = typeof row.id === "string" ? row.id.trim() : ""
    if (!modelId) return []
    const owner = typeof row.owned_by === "string" && row.owned_by.trim() ? row.owned_by.trim() : "CLIProxyAPI"
    const providerId = stableId("cliproxy-provider", owner.toLowerCase())
    const provider: Provider = {
      id: providerId,
      name: `CLIProxyAPI · ${owner}`,
      prefix: cleanPrefix(owner),
      baseUrl: baseUrl(),
      protocol: "openai-chat",
      authType: "none",
      headers: {},
      enabled: true,
      createdAt: createdAt(row.created),
      apiKeyCount: 0,
      enabledApiKeyCount: 0,
      modelCount: 0,
      enabledModelCount: 0,
    }
    const model: Model = {
      id: stableId("cliproxy-model", modelId),
      providerId,
      gatewayModelId: modelId,
      name: modelId,
      upstreamModel: modelId,
      protocol: "openai-chat",
      enabled: true,
      createdAt: createdAt(row.created),
    }
    return [{ provider, model }]
  })
}

async function loadCatalog() {
  if (process.env.NODE_ENV === "test") return { providers: [], models: [] }
  const key = internalKey()
  if (!key) return { providers: [], models: [] }
  const response = await fetch(`${baseUrl()}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(1_500),
  })
  if (!response.ok) throw new Error(`CLIProxy model catalog failed (${response.status}).`)
  const payload = await response.json().catch(() => undefined)
  const rows = asModelRows(payload)
  const providers = new Map<string, Provider>()
  const models: Model[] = []
  for (const { provider, model } of rows) {
    if (!providers.has(provider.id)) providers.set(provider.id, provider)
    models.push(model)
  }
  for (const provider of providers.values()) {
    const count = models.filter((model) => model.providerId === provider.id).length
    provider.modelCount = count
    provider.enabledModelCount = count
  }
  return { providers: [...providers.values()], models }
}

export async function listCliProxyCatalog() {
  const now = Date.now()
  if (catalogCache && catalogCache.expiresAt > now) return catalogCache
  if (!catalogInflight) {
    catalogInflight = loadCatalog()
      .catch(() => ({ providers: [], models: [] }))
      .then((value) => {
        catalogCache = { ...value, expiresAt: Date.now() + catalogTtlMs }
        return catalogCache
      })
      .finally(() => { catalogInflight = undefined })
  }
  return catalogInflight
}

export async function listCliProxyModels() {
  return (await listCliProxyCatalog()).models
}

export function resetCliProxyCatalogForTests() {
  catalogCache = undefined
  catalogInflight = undefined
}
