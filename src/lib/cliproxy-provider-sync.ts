import { createHash, randomUUID } from "node:crypto"

import { cliproxyManagement, cliproxyManagementJson } from "@/lib/cliproxy-management"
import { normalizeProviderBaseUrl, validateProviderCliProxyCompatibility } from "@/lib/cliproxy-provider-capabilities"
import { localRedisDelete, localRedisGet, localRedisSet, localRedisSetIfAbsent } from "@/lib/local-redis"
import { writeLog } from "@/lib/logger"
import { listProviderApiKeys, listProviderModels, getProvider } from "@/lib/store"
import { currentWorkspaceId } from "@/lib/workspace-context"
import type { Model, Provider } from "@/lib/types"

const SYNC_TTL_MS = 5 * 60 * 1000
const LOCK_TTL_MS = 60 * 1000
const MANAGEMENT_PREFIX = "rr-managed-"

type OpenAICompatKeyEntry = {
  "api-key": string
}

type OpenAICompatModel = {
  name: string
  alias: string
  "force-mapping": true
}

type OpenAICompatProjection = {
  name: string
  priority?: number
  disabled: false
  prefix: string
  "base-url": string
  "support-prompt-cache-key"?: true
  "api-key-entries"?: OpenAICompatKeyEntry[]
  models: OpenAICompatModel[]
  headers?: Record<string, string>
}

type ClaudeModel = {
  name: string
  alias: string
  "force-mapping": true
}

type ClaudeProjection = {
  "api-key": string
  priority?: number
  prefix: string
  "base-url": string
  models: ClaudeModel[]
  headers?: Record<string, string>
}

type RemoteEntry = Record<string, unknown>

type Projection = {
  workspaceId: string
  providerId: string
  namespace: string
  namePrefix: string
  kind: "openai" | "claude" | undefined
  openai: OpenAICompatProjection[]
  claude: ClaudeProjection[]
  fingerprint: string
}

type ProjectionShape = Omit<Projection, "fingerprint">

export class CliProxyProviderSyncError extends Error {
  readonly status = 502

  constructor(message: string) {
    super(message)
    this.name = "CliProxyProviderSyncError"
  }
}

const projectionState = new Map<string, { fingerprint: string; expiresAt: number }>()
const projectionInflight = new Map<string, Promise<void>>()
let fillFirstValidUntil = 0

function managementKeyConfigured() {
  return Boolean(process.env.CLIPROXY_MANAGEMENT_KEY?.trim())
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function shortDigest(value: string, length: number) {
  return digest(value).slice(0, length)
}

export function nonCodexProviderPrefix(workspaceId: string, providerId: string) {
  return `rr-ws-${shortDigest(`workspace:${workspaceId}`, 16)}-p-${shortDigest(`provider:${providerId}`, 12)}`
}

function managedNamePrefix(workspaceId: string, providerId: string) {
  return `${MANAGEMENT_PREFIX}${shortDigest(`workspace:${workspaceId}`, 16)}-${shortDigest(`provider:${providerId}`, 12)}-`
}

function managedName(workspaceId: string, providerId: string, credentialId: string) {
  return `${managedNamePrefix(workspaceId, providerId)}${shortDigest(`credential:${credentialId}`, 16)}`
}

function syncKey(workspaceId: string, providerId: string) {
  return `${workspaceId}:${providerId}`
}

function redisStateKey(workspaceId: string, providerId: string) {
  return `rawroute:cliproxy-provider-sync:v1:state:${workspaceId}:${providerId}`
}

function redisLockKey(workspaceId: string, providerId: string) {
  return `rawroute:cliproxy-provider-sync:v1:lock:${workspaceId}:${providerId}`
}

function cleanHeaders(headers: Record<string, string>) {
  const result: Record<string, string> = {}
  for (const name of Object.keys(headers).sort((left, right) => left.localeCompare(right))) {
    result[name] = headers[name]
  }
  return result
}

function modelSuffix(provider: Provider, model: Model) {
  const gatewayModelId = model.gatewayModelId || model.id
  const prefix = `${provider.prefix}/`
  if (!gatewayModelId.startsWith(prefix)) {
    throw new CliProxyProviderSyncError(`Model ${gatewayModelId} is not normalized under provider prefix ${provider.prefix}/.`)
  }
  const suffix = gatewayModelId.slice(prefix.length).trim()
  if (!suffix) throw new CliProxyProviderSyncError(`Model ${gatewayModelId} has no gateway suffix.`)
  return suffix
}

function projectionModels(provider: Provider, models: Model[]) {
  const seenAliases = new Set<string>()
  return models.filter((model) => model.enabled).map((model) => {
    const alias = modelSuffix(provider, model)
    const aliasKey = alias.toLowerCase()
    if (seenAliases.has(aliasKey)) throw new CliProxyProviderSyncError(`Provider ${provider.name} has duplicate model alias ${alias}.`)
    seenAliases.add(aliasKey)
    return {
      name: model.upstreamModel.trim(),
      alias,
      "force-mapping": true,
    } satisfies OpenAICompatModel
  })
}

function projectionFingerprint(projection: ProjectionShape) {
  const safe = {
    workspaceId: projection.workspaceId,
    providerId: projection.providerId,
    namespace: projection.namespace,
    kind: projection.kind,
    openai: projection.openai.map((entry) => ({
      ...entry,
      "api-key-entries": entry["api-key-entries"]?.map((key) => ({ "api-key-sha256": digest(key["api-key"]) })),
    })),
    claude: projection.claude.map((entry) => ({
      ...entry,
      "api-key-sha256": digest(entry["api-key"]),
      "api-key": undefined,
    })),
  }
  return digest(JSON.stringify(safe))
}

function withFingerprint(projection: ProjectionShape): Projection {
  return { ...projection, fingerprint: projectionFingerprint(projection) }
}

async function desiredProjection(providerId: string): Promise<Projection> {
  const workspaceId = currentWorkspaceId()
  const namespace = nonCodexProviderPrefix(workspaceId, providerId)
  const namePrefix = managedNamePrefix(workspaceId, providerId)
  const provider = await getProvider(providerId)
  if (!provider || provider.prefix === "codex") {
    return withFingerprint({ workspaceId, providerId, namespace, namePrefix, kind: undefined, openai: [], claude: [] })
  }

  const [apiKeys, models] = await Promise.all([listProviderApiKeys(providerId), listProviderModels(providerId)])
  const mappedModels = provider.enabled ? projectionModels(provider, models) : []
  const kind = provider.protocol === "anthropic-messages" ? "claude" : "openai"
  const baseUrl = normalizeProviderBaseUrl(provider.protocol, provider.baseUrl)
  const enabledKeys = apiKeys.filter((apiKey) => apiKey.enabled && apiKey.key.trim())
  const headers = Object.keys(provider.headers || {}).length ? cleanHeaders(provider.headers) : undefined

  if (!provider.enabled || mappedModels.length === 0) {
    return withFingerprint({ workspaceId, providerId, namespace, namePrefix, kind, openai: [], claude: [] })
  }

  validateProviderCliProxyCompatibility({ protocol: provider.protocol, baseUrl, authType: provider.authType })

  if (provider.authType === "none") {
    if (enabledKeys.length) throw new CliProxyProviderSyncError(`Provider ${provider.name} uses no authentication but has enabled API keys.`)
    const entry = {
      name: managedName(workspaceId, providerId, "anonymous"),
      disabled: false,
      prefix: namespace,
      "base-url": baseUrl,
      models: mappedModels,
      ...(provider.supportPromptCacheKey === true && kind === "openai" ? { "support-prompt-cache-key": true as const } : {}),
      ...(headers ? { headers } : {}),
    } satisfies OpenAICompatProjection
    return withFingerprint({ workspaceId, providerId, namespace, namePrefix, kind, openai: [entry], claude: [] })
  }

  if (!enabledKeys.length) {
    return withFingerprint({ workspaceId, providerId, namespace, namePrefix, kind, openai: [], claude: [] })
  }

  if (kind === "openai") {
    const openai = enabledKeys.map((apiKey, index) => ({
      name: managedName(workspaceId, providerId, apiKey.id),
      ...(enabledKeys.length - index - 1 > 0 ? { priority: enabledKeys.length - index - 1 } : {}),
      disabled: false,
      prefix: namespace,
      "base-url": baseUrl,
      "api-key-entries": [{ "api-key": apiKey.key }],
      models: mappedModels,
      ...(provider.supportPromptCacheKey === true ? { "support-prompt-cache-key": true as const } : {}),
      ...(headers ? { headers } : {}),
    } satisfies OpenAICompatProjection))
    return withFingerprint({ workspaceId, providerId, namespace, namePrefix, kind, openai, claude: [] })
  }

  const claude = enabledKeys.map((apiKey, index) => ({
    "api-key": apiKey.key,
    ...(enabledKeys.length - index - 1 > 0 ? { priority: enabledKeys.length - index - 1 } : {}),
    prefix: namespace,
    "base-url": baseUrl,
    models: mappedModels,
    ...(headers ? { headers } : {}),
  } satisfies ClaudeProjection))
  return withFingerprint({ workspaceId, providerId, namespace, namePrefix, kind, openai: [], claude })
}

function entryName(entry: RemoteEntry) {
  return typeof entry.name === "string" ? entry.name : ""
}

function entryPrefix(entry: RemoteEntry) {
  return typeof entry.prefix === "string" ? entry.prefix : ""
}

function stripRuntimeAuthIndex(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRuntimeAuthIndex)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "auth-index").map(([key, nested]) => [key, stripRuntimeAuthIndex(nested)]))
}

function stableJson(value: unknown) {
  return JSON.stringify(stripRuntimeAuthIndex(value))
}

function isManagedEntry(entry: RemoteEntry, projection: Projection) {
  return entryPrefix(entry) === projection.namespace && entryName(entry).startsWith(projection.namePrefix)
}

function configurationEntries(data: unknown, key: string) {
  const value = data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined
  if (!Array.isArray(value)) return undefined
  if (!value.every((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))) return undefined
  return value as RemoteEntry[]
}

async function managementList() {
  if (!managementKeyConfigured()) throw new CliProxyProviderSyncError("CLIProxy management key is not configured.")
  const [openai, claude] = await Promise.all([
    cliproxyManagementJson<{ "openai-compatibility"?: unknown }>("/v0/management/openai-compatibility"),
    cliproxyManagementJson<{ "claude-api-key"?: unknown }>("/v0/management/claude-api-key"),
  ])
  if (!openai.response.ok) throw new CliProxyProviderSyncError(`CLIProxy OpenAI-compatible configuration read failed (${openai.response.status}).`)
  if (!claude.response.ok) throw new CliProxyProviderSyncError(`CLIProxy Anthropic configuration read failed (${claude.response.status}).`)
  const openaiEntries = configurationEntries(openai.data, "openai-compatibility")
  const claudeEntries = configurationEntries(claude.data, "claude-api-key")
  if (!openaiEntries) throw new CliProxyProviderSyncError("CLIProxy OpenAI-compatible configuration response was invalid.")
  if (!claudeEntries) throw new CliProxyProviderSyncError("CLIProxy Anthropic configuration response was invalid.")
  return {
    openai: openaiEntries,
    claude: claudeEntries,
  }
}

async function ensureFillFirst(force = false) {
  if (!force && fillFirstValidUntil > Date.now()) return
  const current = await cliproxyManagementJson<{ strategy?: unknown }>("/v0/management/routing/strategy")
  if (!current.response.ok) throw new CliProxyProviderSyncError(`CLIProxy routing strategy read failed (${current.response.status}).`)
  if (typeof current.data?.strategy !== "string") throw new CliProxyProviderSyncError("CLIProxy routing strategy response was invalid.")
  if (current.data?.strategy !== "fill-first") {
    const updated = await cliproxyManagement("/v0/management/routing/strategy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "fill-first" }),
    })
    if (!updated.ok) throw new CliProxyProviderSyncError(`CLIProxy routing strategy update failed (${updated.status}).`)
  }
  fillFirstValidUntil = Date.now() + SYNC_TTL_MS
}

async function putConfiguration(path: string, value: unknown, label: string) {
  const response = await cliproxyManagement(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  })
  if (!response.ok) throw new CliProxyProviderSyncError(`CLIProxy ${label} update failed (${response.status}).`)
}

async function applyProjection(projection: Projection, force: boolean) {
  const current = await managementList()
  const openaiConflict = current.openai.some((entry) => entryPrefix(entry) === projection.namespace && !isManagedEntry(entry, projection))
  const claudeConflict = current.claude.some((entry) => entryPrefix(entry) === projection.namespace && !isManagedEntry(entry, projection))
  if (openaiConflict || claudeConflict) {
    throw new CliProxyProviderSyncError(`CLIProxy namespace ${projection.namespace} is already used by unmanaged configuration.`)
  }
  const nextOpenAI = [...current.openai.filter((entry) => !isManagedEntry(entry, projection)), ...projection.openai]
  const nextClaude = [...current.claude.filter((entry) => !isManagedEntry(entry, projection)), ...projection.claude]

  if (stableJson(current.openai) !== stableJson(nextOpenAI)) {
    await putConfiguration("/v0/management/openai-compatibility", nextOpenAI, "OpenAI-compatible configuration")
  }
  if (stableJson(current.claude) !== stableJson(nextClaude)) {
    await putConfiguration("/v0/management/claude-api-key", nextClaude, "Anthropic configuration")
  }
  await ensureFillFirst(force)
}

async function reconcile(providerId: string, force: boolean) {
  const workspaceId = currentWorkspaceId()
  const stateKey = syncKey(workspaceId, providerId)
  const now = Date.now()
  const local = projectionState.get(stateKey)
  if (!force) {
    if (local && local.expiresAt > now) return
    const sharedFingerprint = await localRedisGet(redisStateKey(workspaceId, providerId))
    if (typeof sharedFingerprint === "string" && sharedFingerprint) {
      projectionState.set(stateKey, { fingerprint: sharedFingerprint, expiresAt: now + SYNC_TTL_MS })
      return
    }
  }

  const running = projectionInflight.get(stateKey)
  if (running) {
    await running
    if (!force) return
    if (projectionInflight.get(stateKey) === running) projectionInflight.delete(stateKey)
    return reconcile(providerId, true)
  }

  const projection = await desiredProjection(providerId)
  const projectionStateKey = syncKey(projection.workspaceId, providerId)

  const promise = (async () => {
    const lock = await localRedisSetIfAbsent(redisLockKey(projection.workspaceId, providerId), randomUUID(), LOCK_TTL_MS)
    if (lock === false) {
      if (await localRedisGet(redisStateKey(projection.workspaceId, providerId)) === projection.fingerprint) {
        projectionState.set(projectionStateKey, { fingerprint: projection.fingerprint, expiresAt: Date.now() + SYNC_TTL_MS })
        return
      }
      throw new CliProxyProviderSyncError(`CLIProxy projection sync is already running for provider ${providerId}.`)
    }
    try {
      await applyProjection(projection, force)
      projectionState.set(projectionStateKey, { fingerprint: projection.fingerprint, expiresAt: Date.now() + SYNC_TTL_MS })
      await localRedisSet(redisStateKey(projection.workspaceId, providerId), projection.fingerprint, SYNC_TTL_MS)
      writeLog("info", "admin", "CLIProxy provider projection reconciled", {
        providerId,
        projectedCredentials: projection.openai.length || projection.claude.length,
        projectedModels: projection.openai[0]?.models.length || projection.claude[0]?.models.length || 0,
        supportPromptCacheKey: projection.openai.some((entry) => entry["support-prompt-cache-key"] === true),
      })
    } catch (error) {
      projectionState.delete(projectionStateKey)
      await localRedisDelete(redisStateKey(projection.workspaceId, providerId))
      throw error
    }
  })()
  projectionInflight.set(stateKey, promise)
  try {
    await promise
  } finally {
    if (projectionInflight.get(stateKey) === promise) projectionInflight.delete(stateKey)
  }
}

export async function syncNonCodexProviderProjection(providerId: string) {
  try {
    await reconcile(providerId, true)
  } catch (error) {
    if (error instanceof CliProxyProviderSyncError) throw error
    throw new CliProxyProviderSyncError(error instanceof Error ? error.message : "CLIProxy provider projection sync failed.")
  }
}

export async function ensureNonCodexProviderProjection(providerId: string) {
  try {
    await reconcile(providerId, false)
  } catch (error) {
    if (error instanceof CliProxyProviderSyncError) throw error
    throw new CliProxyProviderSyncError(error instanceof Error ? error.message : "CLIProxy provider projection reconcile failed.")
  }
}
