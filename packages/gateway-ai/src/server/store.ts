import { mapConcurrent } from "@rawroute/platform/server/concurrency"
import { createHash, randomBytes } from "node:crypto"
import { type DocumentSnapshot, FieldValue, getSqliteDatabase, type SqliteDatabase, type Transaction } from "@rawroute/platform/server/database"
import { initializeAiPersistence } from "./local-db"
import { collectionPrefix, isMemoryBackend } from "@rawroute/platform/server/storage-config"

import { gatewayModelId, cleanAliasId } from "./model-identifiers"
import { localCacheDelete, localCacheGet, localCacheSet } from "@rawroute/platform/server/local-cache"
import type { ApiKey, AppData, Model, ModelAlias, ModelCombo, Provider, ProviderApiKey, ProviderApiKeyInput } from "../contracts/domain"
import { DEFAULT_WORKSPACE_ID, type WorkspaceStorageMode } from "@rawroute/platform/contracts/workspace"
import { currentWorkspaceId, workspaceContext } from "@rawroute/platform/server/workspace-context"
import { appendMemoryAudit, type AuditAction, type AuditResource } from "@rawroute/platform/server/audit"
import { deleteMemoryCodexCredentialSecrets, deleteWorkspaceMemoryCodexCredentials, resetCodexCredentialMemory, stageCodexCredentialSecretsRemoval } from "./codex-credential-secrets"

function memorySecurityMutation<T>(resource: AuditResource, action: AuditAction, mutate: () => T): T {
  const workspaceId = currentWorkspaceId()
  const result = mutate()
  appendMemoryAudit({ resource, action, workspaceId, result: "success" })
  return result
}

const cacheTtlMs = 60_000
const apiKeyCacheTtlMs = 60_000
const apiKeyNegativeCacheTtlMs = 10_000
const databaseChildReadConcurrency = 16
const maximumWorkspaceCacheEntries = 256
const maximumProviderScopedCacheEntries = 256
const routingFullRefreshIntervalMs = 15 * 60_000

interface ReadCache<T> {
  value?: T
  expiresAt: number
  inflight?: Promise<T>
}

interface WorkspaceCacheState {
  routingDataCache?: DataCache<RoutingData>
  routingDataReadPromise?: Promise<RoutingData>
  catalogDataCache?: DataCache<CatalogData>
  catalogDataReadPromise?: Promise<CatalogData>
  routingRevisionCache?: { value: string; expiresAt: number }
  routingRevisionReadPromise?: Promise<string>
  providersCache: ReadCache<Provider[]>
  providerApiKeysCache: Map<string, ReadCache<ProviderApiKey[]>>
  allProviderApiKeysCache: ReadCache<ProviderApiKey[]>
  providerModelsCache: Map<string, ReadCache<Model[]>>
  modelsCache: ReadCache<Model[]>
  aliasesCache: ReadCache<ModelAlias[]>
  combosCache: ReadCache<ModelCombo[]>
  apiKeysCache: ReadCache<ApiKey[]>
  apiKeyHashIndex?: Map<string, ApiKey>
  generation: number
}

const workspaceCacheStates = new Map<string, WorkspaceCacheState>()

function workspaceCacheState() {
  const key = currentWorkspaceId()
  const cached = workspaceCacheStates.get(key)
  if (cached) {
    // Refresh insertion order so the bound behaves as a small LRU cache.
    workspaceCacheStates.delete(key)
    workspaceCacheStates.set(key, cached)
    return cached
  }

  while (workspaceCacheStates.size >= maximumWorkspaceCacheEntries) {
    const oldest = workspaceCacheStates.keys().next().value
    if (oldest === undefined) break
    workspaceCacheStates.delete(oldest)
  }
  const state: WorkspaceCacheState = {
    providersCache: { expiresAt: 0 },
    providerApiKeysCache: new Map(),
    allProviderApiKeysCache: { expiresAt: 0 },
    providerModelsCache: new Map(),
    modelsCache: { expiresAt: 0 },
    aliasesCache: { expiresAt: 0 },
    combosCache: { expiresAt: 0 },
    apiKeysCache: { expiresAt: 0 },
    generation: 0,
  }
  workspaceCacheStates.set(key, state)
  return state
}

interface IndexedApiKey { workspaceId: string; workspaceStorageMode: WorkspaceStorageMode; apiKey: ApiKey }

const apiKeyLookupCache = new Map<string, { value: IndexedApiKey | null; expiresAt: number }>()
const apiKeyLookupInflight = new Map<string, Promise<IndexedApiKey | undefined>>()
let apiKeyNamesCache: { value: Map<string, string>; expiresAt: number; inflight?: Promise<Map<string, string>> } | undefined
const maximumApiKeyLookupEntries = 512
const apiKeyCachePrefix = "rawroute:api-key-lookup:v1:"
const apiKeyCacheMiss = "__rawroute_missing__"
let apiKeyLookupGeneration = 0

export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => stripUndefined(item)) as T
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, stripUndefined(item)])) as T
  }
  return value
}

export class ApiKeyConflictError extends Error {
  constructor() {
    super("API key value is already in use.")
    this.name = "ApiKeyConflictError"
  }
}

export function normalizeApiKeyValue(value: string) {
  return value.trim()
}

export function apiKeyValueHash(value: string) {
  return createHash("sha256").update(normalizeApiKeyValue(value), "utf8").digest("hex")
}

function validateGatewayApiKeyValue(value: unknown) {
  if (typeof value !== "string") throw new Error("API key value is required.")
  const normalized = normalizeApiKeyValue(value)
  if (!normalized) throw new Error("API key value is required.")
  if (normalized.length > 256) throw new Error("API key value must be 256 characters or fewer.")
  return normalized
}

function initialGatewayApiKey(): ApiKey {
  return {
    id: crypto.randomUUID(),
    name: "Default gateway key",
    key: `sk-${randomBytes(32).toString("hex")}`,
    createdAt: new Date().toISOString(),
  }
}

function providerFromSnapshot(snapshot: DocumentSnapshot): Provider {
  const data = snapshot.data() as Partial<Provider>
  return {
    id: snapshot.id,
    name: data.name || "",
    prefix: data.prefix || "",
    baseUrl: data.baseUrl || "",
    protocol: data.protocol || "openai-chat",
    authType: data.authType || "bearer",
    headers: data.headers || {},
    supportPromptCacheKey: data.supportPromptCacheKey === true,
    enabled: data.enabled !== false,
    createdAt: data.createdAt || "",
    apiKeyCount: data.apiKeyCount || 0,
    enabledApiKeyCount: data.enabledApiKeyCount || 0,
    modelCount: data.modelCount || 0,
    enabledModelCount: data.enabledModelCount || 0,
  }
}

function providerApiKeyFromSnapshot(snapshot: DocumentSnapshot, providerId: string): ProviderApiKey {
  const value = { ...snapshot.data(), id: snapshot.id, providerId } as ProviderApiKey
  return value
}

function modelFromSnapshot(snapshot: DocumentSnapshot, providerId: string): Model {
  const data = snapshot.data() as Partial<Model>
  return {
    id: snapshot.id,
    providerId,
    gatewayModelId: data.gatewayModelId || snapshot.id,
    name: data.name || "",
    upstreamModel: data.upstreamModel || "",
    enabled: data.enabled !== false,
    source: data.source || "custom",
    discovery: data.discovery,
    reasoningCapability: data.reasoningCapability,
    createdAt: data.createdAt || "",
  }
}

function apiKeyFromSnapshot(snapshot: DocumentSnapshot): ApiKey {
  return { ...snapshot.data(), id: snapshot.id } as ApiKey
}

function aliasFromSnapshot(snapshot: DocumentSnapshot): ModelAlias {
  return { ...snapshot.data(), id: snapshot.id } as ModelAlias
}

function comboFromSnapshot(snapshot: DocumentSnapshot): ModelCombo {
  const data = snapshot.data() as Partial<ModelCombo>
  if (!Array.isArray(data.members)) throw new Error("Combo data requires the current schema. Run the data conversion script before starting RawRoute.")
  const members = data.members
  return {
    id: snapshot.id,
    combo: data.combo || "",
    name: data.name || "",
    members,
    createdAt: data.createdAt || "",
  }
}

function storedProvider(provider: Provider) {
  return stripUndefined({
    name: provider.name,
    prefix: provider.prefix,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    authType: provider.authType,
    headers: provider.headers,
    supportPromptCacheKey: provider.supportPromptCacheKey,
    enabled: provider.enabled,
    createdAt: provider.createdAt,
    apiKeyCount: provider.apiKeyCount,
    enabledApiKeyCount: provider.enabledApiKeyCount,
    modelCount: provider.modelCount,
    enabledModelCount: provider.enabledModelCount,
  })
}

function storedProviderApiKey(apiKey: ProviderApiKey) {
  const { id, providerId, ...data } = apiKey
  void id
  void providerId
  return stripUndefined(data)
}

/** Codex OAuth sessions live in the server-only Codex credential store. */
function normalizeCodexCredentialApiKey(apiKey: ProviderApiKey) {
  apiKey.key = ""
  apiKey.rpmLimit = undefined
  apiKey.maxConcurrency = undefined
}

function storedModel(model: Model) {
  return stripUndefined({
    gatewayModelId: model.gatewayModelId || model.id,
    name: model.name,
    upstreamModel: model.upstreamModel,
    enabled: model.enabled,
    source: model.source,
    discovery: model.discovery,
    reasoningCapability: model.reasoningCapability,
    createdAt: model.createdAt,
  })
}

function migrateProviderModels(models: Iterable<Model>, prefix: string): Map<string, Model> {
  const migrated = new Map<string, Model>()
  const gatewayIds = new Set<string>()
  for (const model of models) {
    const nextGatewayModelId = gatewayModelId(prefix, model.gatewayModelId || model.id)
    if (gatewayIds.has(nextGatewayModelId)) throw new Error(`Provider prefix would conflict with model ID ${nextGatewayModelId}.`)
    gatewayIds.add(nextGatewayModelId)
    migrated.set(model.id, { ...model, gatewayModelId: nextGatewayModelId })
  }
  return migrated
}

function storedApiKey(apiKey: ApiKey) {
  const { id, ...data } = apiKey
  void id
  return stripUndefined(data)
}

interface ApiKeyIndexData {
  workspaceId?: string
  workspaceStorageMode?: WorkspaceStorageMode
  apiKeyId?: string
  name?: string
  createdAt?: string
}

function apiKeyIndexDocumentForWorkspace(workspaceId: string, workspaceStorageMode: WorkspaceStorageMode, apiKey: ApiKey): Required<ApiKeyIndexData> {
  return {
    workspaceId,
    workspaceStorageMode,
    apiKeyId: apiKey.id,
    name: apiKey.name,
    createdAt: apiKey.createdAt,
  }
}

function apiKeyIndexDocument(apiKey: ApiKey): Required<ApiKeyIndexData> {
  return apiKeyIndexDocumentForWorkspace(currentWorkspaceId(), workspaceContext().storageMode, apiKey)
}

function storedAlias(alias: ModelAlias) {
  const { id, ...data } = alias
  void id
  return stripUndefined(data)
}

function storedCombo(combo: ModelCombo) {
  const { id, ...data } = combo
  void id
  return stripUndefined(data)
}

type RoutingData = Pick<AppData, "providers" | "providerApiKeys" | "models" | "aliases" | "combos">
type CatalogData = Pick<AppData, "providers" | "models" | "aliases" | "combos">
interface DataCache<T> { data: T; expiresAt: number; revision?: string; fullRefreshAt?: number }

function clearReadCache<T>(cache: ReadCache<T>) {
  cache.value = undefined
  cache.expiresAt = 0
  cache.inflight = undefined
}

function clearReadCacheMap<T>(cache: Map<string, ReadCache<T>>) {
  cache.clear()
}

async function cachedRead<T>(cache: ReadCache<T>, loader: () => Promise<T>): Promise<T> {
  const now = Date.now()
  if (cache.value !== undefined && cache.expiresAt > now) return cache.value
  if (cache.inflight) return cache.inflight

  const state = workspaceCacheState()
  const generation = state.generation
  const promise = loader().then((value) => {
    if (generation === state.generation) {
      cache.value = value
      cache.expiresAt = Date.now() + cacheTtlMs
    }
    return value
  }).finally(() => {
    if (cache.inflight === promise) cache.inflight = undefined
  })
  cache.inflight = promise
  return promise
}

function parallelMap<T, R>(items: readonly T[], mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  return mapConcurrent(items, databaseChildReadConcurrency, mapper)
}

function providerScopedCache<T>(cache: Map<string, ReadCache<T>>, providerId: string) {
  const cached = cache.get(providerId)
  if (cached) {
    cache.delete(providerId)
    cache.set(providerId, cached)
    return cached
  }
  while (cache.size >= maximumProviderScopedCacheEntries) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  const entry: ReadCache<T> = { expiresAt: 0 }
  cache.set(providerId, entry)
  return entry
}

function cacheApiKeyLookup(hash: string, value: IndexedApiKey | undefined) {
  if (!apiKeyLookupCache.has(hash) && apiKeyLookupCache.size >= maximumApiKeyLookupEntries) {
    const oldest = apiKeyLookupCache.keys().next().value
    if (oldest !== undefined) apiKeyLookupCache.delete(oldest)
  }
  apiKeyLookupCache.set(hash, { value: value || null, expiresAt: Date.now() + (value ? apiKeyCacheTtlMs : apiKeyNegativeCacheTtlMs) })
}

function apiKeyCacheKey(hash: string) {
  return `${apiKeyCachePrefix}${hash}`
}

function cacheApiKeyLookupInCache(hash: string, value: IndexedApiKey | undefined) {
  const record = value
    ? JSON.stringify({
      workspaceId: value.workspaceId,
      workspaceStorageMode: value.workspaceStorageMode,
      apiKeyId: value.apiKey.id,
      name: value.apiKey.name,
      createdAt: value.apiKey.createdAt,
    })
    : apiKeyCacheMiss
  void localCacheSet(apiKeyCacheKey(hash), record, value ? apiKeyCacheTtlMs : apiKeyNegativeCacheTtlMs)
}

async function readApiKeyLookupFromCache(hash: string): Promise<IndexedApiKey | null | undefined> {
  const raw = await localCacheGet(apiKeyCacheKey(hash))
  if (raw === undefined || raw === null) return undefined
  if (raw === apiKeyCacheMiss) return null
  try {
    const value = JSON.parse(raw) as { workspaceId?: unknown; workspaceStorageMode?: unknown; apiKeyId?: unknown; name?: unknown; createdAt?: unknown }
    if (typeof value.workspaceId !== "string" || typeof value.apiKeyId !== "string" || typeof value.name !== "string" || typeof value.createdAt !== "string") return undefined
    return {
      workspaceId: value.workspaceId,
      workspaceStorageMode: "scoped",
      apiKey: { id: value.apiKeyId, name: value.name, key: "", createdAt: value.createdAt },
    }
  } catch {
    return undefined
  }
}

function invalidateApiKeyLookupCache(hashes?: Iterable<string>) {
  // Advance the generation so an already-running lookup cannot repopulate a
  // value that was changed while its database read was in flight.
  apiKeyLookupGeneration += 1
  apiKeyNamesCache = undefined
  if (hashes) {
    const cacheKeys: string[] = []
    for (const hash of hashes) {
      apiKeyLookupCache.delete(hash)
      apiKeyLookupInflight.delete(hash)
      cacheKeys.push(apiKeyCacheKey(hash))
    }
    if (!isMemoryBackend()) void localCacheDelete(...cacheKeys)
    return
  }
  apiKeyLookupCache.clear()
  apiKeyLookupInflight.clear()
}

export function invalidateRoutingCaches() {
  const state = workspaceCacheState()
  state.generation += 1
  state.routingDataCache = undefined
  state.routingDataReadPromise = undefined
  state.catalogDataCache = undefined
  state.catalogDataReadPromise = undefined
  state.routingRevisionCache = undefined
  state.routingRevisionReadPromise = undefined
  clearReadCache(state.providersCache)
  clearReadCache(state.allProviderApiKeysCache)
  clearReadCache(state.modelsCache)
  clearReadCache(state.aliasesCache)
  clearReadCache(state.combosCache)
  clearReadCache(state.apiKeysCache)
  clearReadCacheMap(state.providerApiKeysCache)
  clearReadCacheMap(state.providerModelsCache)
  state.apiKeyHashIndex = undefined
}

/** Monotonic in-process revision for callers that must reject stale snapshots. */
export function routingConfigurationRevision() {
  return workspaceCacheState().generation
}

function invalidateGatewayApiKeyCaches(hashes?: Iterable<string>) {
  invalidateRoutingCaches()
  invalidateApiKeyLookupCache(hashes)
}

function validateProviderApiKeyInput(input: ProviderApiKeyInput) {
  const withoutApiKeyValue = input.credentialKind === "codex-oauth"
  if (!input.originalId && (typeof input.name !== "string" || !input.name.trim())) {
    throw new Error("API key name is required.")
  }
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80)) {
    throw new Error("API key name must be between 1 and 80 characters.")
  }
  if (!withoutApiKeyValue && !input.originalId && (typeof input.key !== "string" || !input.key.trim())) {
    throw new Error("API key value is required.")
  }
  if (!withoutApiKeyValue && input.key !== undefined && input.key !== "__unchanged__" && (typeof input.key !== "string" || !input.key.trim())) {
    throw new Error("API key value is required.")
  }
  if (!withoutApiKeyValue && input.key === "__unchanged__" && !input.originalId) throw new Error("API key value is required.")
  if (input.rpmLimit !== undefined && input.rpmLimit !== null && (!Number.isSafeInteger(input.rpmLimit) || input.rpmLimit <= 0)) {
    throw new Error("RPM limit must be a positive whole number.")
  }
  if (input.maxConcurrency !== undefined && input.maxConcurrency !== null && (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency <= 0)) {
    throw new Error("Maximum concurrency must be a positive whole number.")
  }
  if (input.priority !== undefined && (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 100)) {
    throw new Error("Priority must be a whole number from 0 to 100.")
  }
}

function validateAliasInput(input: Partial<ModelAlias> & { originalId?: string }) {
  if (!input.originalId && (typeof input.name !== "string" || !input.name.trim())) {
    throw new Error("Alias name is required.")
  }
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80)) {
    throw new Error("Alias name must be between 1 and 80 characters.")
  }
  if (input.alias !== undefined && (typeof input.alias !== "string" || !cleanAliasId(input.alias))) {
    throw new Error("Alias is required.")
  }
  if (input.targetModelId !== undefined && (typeof input.targetModelId !== "string" || !input.targetModelId.trim())) {
    throw new Error("Alias target model is required.")
  }
  if (input.sharedModelId !== undefined && typeof input.sharedModelId !== "string") {
    throw new Error("Shared model reference is invalid.")
  }
}

function validateComboInput(input: Partial<ModelCombo> & { originalId?: string }) {
  if (!input.originalId && (typeof input.name !== "string" || !input.name.trim())) throw new Error("Combo name is required.")
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80)) throw new Error("Combo name must be between 1 and 80 characters.")
  if (input.combo !== undefined && (typeof input.combo !== "string" || !cleanAliasId(input.combo))) throw new Error("Combo gateway ID is required.")
  if (input.members !== undefined && (!Array.isArray(input.members) || input.members.some((member) => !member || typeof member.modelId !== "string" || !member.modelId.trim()))) throw new Error("Combo models are invalid.")
}

function managedModelInput(existing: Model | undefined, input: Partial<Model>, discover: boolean) {
  if (discover) {
    if (existing && existing.source !== "discovered") throw new Error("Custom model owns this gateway ID.")
    return { ...input, source: "discovered" as const, enabled: existing?.enabled ?? true, reasoningCapability: existing?.reasoningCapability }
  }
  if (existing?.source === "discovered") {
    if (input.gatewayModelId && input.gatewayModelId !== existing.gatewayModelId || input.upstreamModel && input.upstreamModel !== existing.upstreamModel || input.name && input.name !== existing.name || input.reasoningCapability || input.source && input.source !== existing.source || input.discovery) throw new Error("Discovered model identity is managed automatically.")
  }
  return input
}

/** Internal catalog writer; ownership is checked again inside the transaction. */
export async function reconcileDiscoveredModel(providerId: string, input: Pick<Model, "gatewayModelId" | "name" | "upstreamModel" | "discovery">) {
  const model = isMemoryBackend() ? memoryUpsertModel(providerId, input, true) : await sqliteUpsertModel(providerId, input, true)
  invalidateRoutingCaches()
  return model
}

// -------------------------------------------------------------------------------------------------
// Memory backend
// -------------------------------------------------------------------------------------------------

interface MemoryState {
  providers: Map<string, Provider>
  providerApiKeys: Map<string, Map<string, ProviderApiKey>>
  models: Map<string, Map<string, Model>>
  aliases: Map<string, ModelAlias>
  combos: Map<string, ModelCombo>
  gatewayIds: Map<string, string>
  apiKeys: Map<string, ApiKey>
  apiKeyIndexes: Map<string, string>
  initialized: boolean
}

interface MemoryRoot { states: Map<string, MemoryState> }
declare global { var __rawrouteMemoryStore: MemoryRoot | undefined }
function memoryRoot(): MemoryRoot {
  return globalThis.__rawrouteMemoryStore ||= { states: new Map<string, MemoryState>() }
}

function newMemoryState(): MemoryState {
  return { providers: new Map(), providerApiKeys: new Map(), models: new Map(), aliases: new Map(), combos: new Map(), gatewayIds: new Map(), apiKeys: new Map(), apiKeyIndexes: new Map(), initialized: false }
}

function ensureMemorySeeded(workspaceId = currentWorkspaceId()): MemoryState {
  let memory = memoryRoot().states.get(workspaceId)
  if (!memory) {
    memory = newMemoryState()
    memoryRoot().states.set(workspaceId, memory)
  }
  if (!memory.initialized) {
    if (workspaceId === DEFAULT_WORKSPACE_ID) {
    const seedKey = initialGatewayApiKey()
    memory.apiKeys.set(seedKey.id, seedKey)
    memory.apiKeyIndexes.set(apiKeyValueHash(seedKey.key), seedKey.id)
    appendMemoryAudit({ action: "credential.create", resource: "gateway-key", workspaceId: DEFAULT_WORKSPACE_ID, result: "success" })
    }
    memory.initialized = true
  }
  return memory
}

function memorySnapshot(state: MemoryState) {
  return {
    providers: new Map(state.providers),
    providerApiKeys: new Map(state.providerApiKeys),
    models: new Map(state.models),
    aliases: new Map(state.aliases),
    combos: new Map(state.combos),
    apiKeys: new Map(state.apiKeys),
    apiKeyIndexes: new Map(state.apiKeyIndexes),
  }
}

function memoryApiKeyOwner(hash: string) {
  for (const [workspaceId, state] of memoryRoot().states) {
    const apiKeyId = state.apiKeyIndexes.get(hash)
    if (apiKeyId) return { workspaceId, apiKeyId }
  }
  return undefined
}

function memoryFindApiKeyByHash(hash: string) {
  const indexedOwner = memoryApiKeyOwner(hash)
  if (indexedOwner) {
    const indexedApiKey = memoryRoot().states.get(indexedOwner.workspaceId)?.apiKeys.get(indexedOwner.apiKeyId)
    if (indexedApiKey && apiKeyValueHash(indexedApiKey.key) === hash) {
      return { workspaceId: indexedOwner.workspaceId, apiKey: indexedApiKey }
    }
    memoryRoot().states.get(indexedOwner.workspaceId)?.apiKeyIndexes.delete(hash)
  }

  let found: { workspaceId: string; apiKey: ApiKey } | undefined
  for (const [workspaceId, state] of memoryRoot().states) {
    for (const apiKey of state.apiKeys.values()) {
      if (apiKeyValueHash(apiKey.key) !== hash) continue
      if (found) return undefined
      found = { workspaceId, apiKey }
    }
  }
  if (!found) return undefined
  memoryRoot().states.get(found.workspaceId)?.apiKeyIndexes.set(hash, found.apiKey.id)
  return found
}

function memoryApiKeyValueExists(hash: string) {
  if (memoryFindApiKeyByHash(hash)) return true
  for (const state of memoryRoot().states.values()) {
    for (const apiKey of state.apiKeys.values()) {
      if (apiKeyValueHash(apiKey.key) === hash) return true
    }
  }
  return false
}

// -------------------------------------------------------------------------------------------------
// SQLite document backend
// -------------------------------------------------------------------------------------------------

let localDatabase: SqliteDatabase | undefined

function getLocalDatabase(): SqliteDatabase {
  initializeAiPersistence()
  return localDatabase ||= getSqliteDatabase()
}

function workspaceRootRef(workspaceId = currentWorkspaceId()) {
  return getLocalDatabase().collection(`${collectionPrefix()}_workspaces`).doc(workspaceId)
}

function apiKeysRefForWorkspace(workspaceId: string) {
  return workspaceRootRef(workspaceId).collection("apiKeys")
}

function providersRef() {
  return workspaceRootRef().collection("providers")
}

export function providerRef(providerId: string) {
  return providersRef().doc(providerId)
}

export function providerApiKeysRef(providerId: string) {
  return providerRef(providerId).collection("apiKeys")
}

export function providerApiKeyRef(providerId: string, apiKeyId: string) {
  return providerApiKeysRef(providerId).doc(apiKeyId)
}

function modelsRef(providerId: string) {
  return providerRef(providerId).collection("models")
}

function modelRef(providerId: string, modelId: string) {
  return modelsRef(providerId).doc(modelId)
}

function aliasesRef() {
  return workspaceRootRef().collection("aliases")
}

function aliasRef(aliasId: string) {
  return aliasesRef().doc(aliasId)
}

function combosRef() {
  return workspaceRootRef().collection("combos")
}

function comboRef(comboId: string) {
  return combosRef().doc(comboId)
}

function gatewayIdRef(id: string) {
  return workspaceRootRef().collection("gatewayIds").doc(Buffer.from(id, "utf8").toString("base64url"))
}

function apiKeysRef() {
  return apiKeysRefForWorkspace(currentWorkspaceId())
}

function apiKeyRef(apiKeyId: string) {
  return apiKeysRef().doc(apiKeyId)
}

function apiKeyIndexesRef() {
  return getLocalDatabase().collection(`${collectionPrefix()}_api_key_indexes`)
}

function routingRevisionRef(workspaceId = currentWorkspaceId()) {
  return getLocalDatabase().collection(`${collectionPrefix()}_routing_revisions`).doc(workspaceId)
}

export function bumpRoutingRevision(transaction: Transaction) {
  transaction.set(routingRevisionRef(), {
    revision: FieldValue.increment(1),
    updatedAt: new Date().toISOString(),
  }, { merge: true })
}

function apiKeyIndexRef(hash: string) {
  return apiKeyIndexesRef().doc(hash)
}

// -------------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------------

export async function listProviders(): Promise<Provider[]> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    return [...state.providers.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  return cachedRead(workspaceCacheState().providersCache, sqliteListProviders)
}

export async function getProvider(providerId: string): Promise<Provider | undefined> {
  if (isMemoryBackend()) {
    return ensureMemorySeeded().providers.get(providerId)
  }
  const cache = workspaceCacheState().providersCache
  if (cache.value && cache.expiresAt > Date.now()) {
    return cache.value.find((provider) => provider.id === providerId)
  }
  return sqliteGetProvider(providerId)
}

export async function upsertProvider(input: Partial<Provider> & { originalId?: string }, expected?: Provider): Promise<Provider> {
  const provider = isMemoryBackend() ? memorySecurityMutation("provider", "config.update", () => memoryUpsertProvider(input, expected)) : await sqliteUpsertProvider(input, expected)
  invalidateRoutingCaches()
  return provider
}

export async function deleteProvider(providerId: string): Promise<void> {
  if (isMemoryBackend()) memorySecurityMutation("provider", "config.delete", () => memoryDeleteProvider(providerId))
  else await sqliteDeleteProvider(providerId)
  invalidateRoutingCaches()
}

export async function listProviderApiKeys(providerId: string): Promise<ProviderApiKey[]> {
  if (isMemoryBackend()) {
    const map = ensureMemorySeeded().providerApiKeys.get(providerId) || new Map<string, ProviderApiKey>()
    return [...map.values()].sort(compareProviderApiKeys)
  }
  const state = workspaceCacheState()
  if (state.allProviderApiKeysCache.value && state.allProviderApiKeysCache.expiresAt > Date.now()) {
    return state.allProviderApiKeysCache.value.filter((apiKey) => apiKey.providerId === providerId).sort(compareProviderApiKeys)
  }
  return cachedRead(providerScopedCache(state.providerApiKeysCache, providerId), () => sqliteListProviderApiKeys(providerId))
}

/** Read the committed provider and credentials together for an outbound attempt. */
export async function getProviderCredentialRoutingSnapshot(providerId: string): Promise<{ provider?: Provider; apiKeys: ProviderApiKey[] }> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const provider = state.providers.get(providerId)
    const apiKeys = [...(state.providerApiKeys.get(providerId)?.values() || [])].sort(compareProviderApiKeys)
    return { provider, apiKeys }
  }
  return getLocalDatabase().runTransaction(async (transaction) => {
    const [providerSnapshot, apiKeySnapshot] = await Promise.all([
      transaction.get(providerRef(providerId)),
      transaction.get(providerApiKeysRef(providerId)),
    ])
    return {
      provider: providerSnapshot.exists ? providerFromSnapshot(providerSnapshot) : undefined,
      apiKeys: apiKeySnapshot.docs.map((document) => providerApiKeyFromSnapshot(document, providerId)).sort(compareProviderApiKeys),
    }
  })
}

/**
 * Run pre-dispatch selection and initiate the request against the same committed
 * provider/credential snapshot. The callback must return synchronously; it may
 * start I/O but must not await the upstream response while holding the DB queue.
 */
export async function withProviderCredentialRoutingSnapshot<T>(
  providerId: string,
  callback: (snapshot: { provider?: Provider; apiKeys: ProviderApiKey[] }) => T & (T extends PromiseLike<unknown> ? never : unknown),
): Promise<T> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const provider = state.providers.get(providerId)
    const apiKeys = [...(state.providerApiKeys.get(providerId)?.values() || [])].sort(compareProviderApiKeys)
    const result = callback({ provider, apiKeys })
    if (isPromiseLike(result)) throw new TypeError("Provider routing snapshot callbacks must complete synchronously.")
    return result
  }
  let callbackResult: T | undefined
  let callbackCalled = false
  await getLocalDatabase().runTransaction(async (transaction) => {
    const [providerSnapshot, apiKeySnapshot] = await Promise.all([
      transaction.get(providerRef(providerId)),
      transaction.get(providerApiKeysRef(providerId)),
    ])
    return {
      provider: providerSnapshot.exists ? providerFromSnapshot(providerSnapshot) : undefined,
      apiKeys: apiKeySnapshot.docs.map((document) => providerApiKeyFromSnapshot(document, providerId)).sort(compareProviderApiKeys),
    }
  }, (snapshot) => {
    const result = callback(snapshot)
    if (isPromiseLike(result)) throw new TypeError("Provider routing snapshot callbacks must complete synchronously.")
    callbackResult = result
    callbackCalled = true
  })
  if (!callbackCalled) throw new Error("Provider routing snapshot did not commit.")
  return callbackResult as T
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function"
}

export async function getProviderApiKey(providerId: string, apiKeyId: string): Promise<ProviderApiKey | undefined> {
  if (isMemoryBackend()) return ensureMemorySeeded().providerApiKeys.get(providerId)?.get(apiKeyId)
  const state = workspaceCacheState()
  const cached = state.providerApiKeysCache.get(providerId)
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value.find((apiKey) => apiKey.id === apiKeyId)
  if (state.allProviderApiKeysCache.value && state.allProviderApiKeysCache.expiresAt > Date.now()) {
    return state.allProviderApiKeysCache.value.find((apiKey) => apiKey.providerId === providerId && apiKey.id === apiKeyId)
  }
  const snapshot = await providerApiKeyRef(providerId, apiKeyId).get()
  return snapshot.exists ? providerApiKeyFromSnapshot(snapshot, providerId) : undefined
}

function compareProviderApiKeys(left: ProviderApiKey, right: ProviderApiKey) {
  return (right.priority ?? 0) - (left.priority ?? 0) || left.createdAt.localeCompare(right.createdAt)
}

export async function reorderProviderApiKeys(providerId: string, orderedIds: string[]): Promise<void> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const slot = state.providerApiKeys.get(providerId)
    if (!slot || slot.size !== orderedIds.length || orderedIds.some((id) => !slot.has(id))) throw new Error("API key order is out of date.")
    orderedIds.forEach((id, index) => slot.set(id, { ...slot.get(id)!, priority: orderedIds.length - index - 1 }))
    appendMemoryAudit({ resource: "provider-credential", action: "credential.update", workspaceId: currentWorkspaceId(), result: "success" })
  } else {
    await sqliteReorderProviderApiKeys(providerId, orderedIds)
  }
  invalidateRoutingCaches()
}

export async function listAllProviderApiKeys(): Promise<ProviderApiKey[]> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const out: ProviderApiKey[] = []
    for (const slot of state.providerApiKeys.values()) out.push(...slot.values())
    return out
  }
  return cachedRead(workspaceCacheState().allProviderApiKeysCache, sqliteListAllProviderApiKeys)
}

export async function upsertProviderApiKey(providerId: string, input: ProviderApiKeyInput): Promise<ProviderApiKey> {
  validateProviderApiKeyInput(input)
  const apiKey = isMemoryBackend() ? memorySecurityMutation("provider-credential", input.originalId ? "credential.update" : "credential.create", () => memoryUpsertProviderApiKey(providerId, input)) : await sqliteUpsertProviderApiKey(providerId, input)
  invalidateRoutingCaches()
  return apiKey
}

export async function deleteProviderApiKey(providerId: string, apiKeyId: string): Promise<void> {
  if (isMemoryBackend()) memorySecurityMutation("provider-credential", "credential.revoke", () => memoryDeleteProviderApiKey(providerId, apiKeyId))
  else await sqliteDeleteProviderApiKey(providerId, apiKeyId)
  invalidateRoutingCaches()
}

export async function listModels(): Promise<Model[]> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const out: Model[] = []
    for (const slot of state.models.values()) out.push(...slot.values())
    return out
  }
  return cachedRead(workspaceCacheState().modelsCache, sqliteListModels)
}

export async function listProviderModels(providerId: string): Promise<Model[]> {
  if (isMemoryBackend()) {
    const map = ensureMemorySeeded().models.get(providerId) || new Map<string, Model>()
    return [...map.values()]
  }
  const state = workspaceCacheState()
  if (state.modelsCache.value && state.modelsCache.expiresAt > Date.now()) {
    return state.modelsCache.value.filter((model) => model.providerId === providerId)
  }
  return cachedRead(providerScopedCache(state.providerModelsCache, providerId), () => sqliteListProviderModels(providerId))
}

export async function upsertModel(providerId: string, input: Partial<Model> & { originalId?: string }): Promise<Model> {
  const model = isMemoryBackend() ? memorySecurityMutation("model", "config.update", () => memoryUpsertModel(providerId, input)) : await sqliteUpsertModel(providerId, input)
  invalidateRoutingCaches()
  return model
}

export async function deleteModel(providerId: string, modelId: string): Promise<void> {
  if (isMemoryBackend()) memorySecurityMutation("model", "config.delete", () => memoryDeleteModel(providerId, modelId))
  else await sqliteDeleteModel(providerId, modelId)
  invalidateRoutingCaches()
}

export async function listAliases(): Promise<ModelAlias[]> {
  if (isMemoryBackend()) {
    return [...ensureMemorySeeded().aliases.values()].sort(compareAliases)
  }
  return cachedRead(workspaceCacheState().aliasesCache, sqliteListAliases)
}

function compareAliases(left: ModelAlias, right: ModelAlias) {
  return left.alias.localeCompare(right.alias, undefined, { sensitivity: "base", numeric: true })
}

export async function upsertAlias(input: Partial<ModelAlias> & { originalId?: string }): Promise<ModelAlias> {
  validateAliasInput(input)
  const alias = isMemoryBackend() ? memorySecurityMutation("alias", "config.update", () => memoryUpsertAlias(input)) : await sqliteUpsertAlias(input)
  invalidateRoutingCaches()
  return alias
}

export async function deleteAlias(aliasId: string): Promise<void> {
  if (isMemoryBackend()) memorySecurityMutation("alias", "config.delete", () => memoryDeleteAlias(aliasId))
  else await sqliteDeleteAlias(aliasId)
  invalidateRoutingCaches()
}

export async function listCombos(): Promise<ModelCombo[]> {
  if (isMemoryBackend()) return [...ensureMemorySeeded().combos.values()].sort(compareCombos)
  return cachedRead(workspaceCacheState().combosCache, sqliteListCombos)
}

function compareCombos(left: ModelCombo, right: ModelCombo) {
  return left.combo.localeCompare(right.combo, undefined, { sensitivity: "base", numeric: true })
}

export async function upsertCombo(input: Partial<ModelCombo> & { originalId?: string }): Promise<ModelCombo> {
  validateComboInput(input)
  const combo = isMemoryBackend() ? memorySecurityMutation("combo", "config.update", () => memoryUpsertCombo(input)) : await sqliteUpsertCombo(input)
  invalidateRoutingCaches()
  return combo
}

export async function deleteCombo(comboId: string): Promise<void> {
  if (isMemoryBackend()) memorySecurityMutation("combo", "config.delete", () => memoryDeleteCombo(comboId))
  else await sqliteDeleteCombo(comboId)
  invalidateRoutingCaches()
}

export async function listApiKeys(): Promise<ApiKey[]> {
  if (isMemoryBackend()) {
    return [...ensureMemorySeeded().apiKeys.values()]
  }
  const state = workspaceCacheState()
  const apiKeys = await cachedRead(state.apiKeysCache, sqliteListApiKeys)
  if (!state.apiKeyHashIndex && state.apiKeysCache.value === apiKeys && state.apiKeysCache.expiresAt > Date.now()) {
    state.apiKeyHashIndex = new Map(apiKeys.map((apiKey) => [apiKeyValueHash(apiKey.key), apiKey]))
  }
  return apiKeys
}

/**
 * Return names from the global API-key index without exposing key values.
 * Public usage can contain historical events whose key document belongs to a
 * different workspace; this lets the dashboard render the real name instead
 * of inventing a placeholder or showing the document ID.
 */
export async function listIndexedApiKeyNames(): Promise<Map<string, string>> {
  if (isMemoryBackend()) {
    const names = new Map<string, string>()
    for (const state of memoryRoot().states.values()) {
      for (const apiKey of state.apiKeys.values()) names.set(apiKey.id, apiKey.name)
    }
    return names
  }
  const now = Date.now()
  if (apiKeyNamesCache && apiKeyNamesCache.expiresAt > now) return apiKeyNamesCache.value
  if (apiKeyNamesCache?.inflight) return apiKeyNamesCache.inflight
  const generation = apiKeyLookupGeneration
  const promise = apiKeyIndexesRef().get().then((snapshot) => {
    const names = new Map<string, string>()
    for (const document of snapshot.docs) {
      const data = document.data() as ApiKeyIndexData
      if (typeof data.apiKeyId === "string" && typeof data.name === "string" && data.name.trim()) names.set(data.apiKeyId, data.name.trim())
    }
    if (generation === apiKeyLookupGeneration) apiKeyNamesCache = { value: names, expiresAt: Date.now() + apiKeyCacheTtlMs }
    return names
  }).finally(() => {
    if (apiKeyNamesCache?.inflight === promise) apiKeyNamesCache.inflight = undefined
  })
  apiKeyNamesCache = { value: new Map(), expiresAt: 0, inflight: promise }
  return promise
}

export async function createApiKey(name: string, customKey?: string): Promise<ApiKey> {
  const apiKey = isMemoryBackend() ? memorySecurityMutation("gateway-key", "credential.create", () => memoryCreateApiKey(name, customKey)) : await sqliteCreateApiKey(name, customKey)
  invalidateGatewayApiKeyCaches([apiKeyValueHash(apiKey.key)])
  return apiKey
}

export async function rotateApiKey(apiKeyId: string, customKey?: string): Promise<ApiKey> {
  const normalizedCustomKey = customKey === undefined ? undefined : validateGatewayApiKeyValue(customKey)
  const rotated = isMemoryBackend()
    ? memorySecurityMutation("gateway-key", "credential.update", () => memoryRotateApiKey(apiKeyId, normalizedCustomKey))
    : await sqliteRotateApiKey(apiKeyId, normalizedCustomKey)
  invalidateGatewayApiKeyCaches([rotated.previousHash, apiKeyValueHash(rotated.apiKey.key)])
  return rotated.apiKey
}

export async function updateApiKeyName(apiKeyId: string, name: string): Promise<ApiKey> {
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error("API key name is required.")
  if (normalizedName.length > 80) throw new Error("API key name must be 80 characters or fewer.")
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const existing = state.apiKeys.get(apiKeyId)
    if (!existing) throw new Error("API key not found.")
    const updated = { ...existing, name: normalizedName }
    state.apiKeys.set(apiKeyId, updated)
    appendMemoryAudit({ resource: "gateway-key", action: "credential.update", workspaceId: currentWorkspaceId(), result: "success" })
    invalidateGatewayApiKeyCaches([apiKeyValueHash(updated.key)])
    return updated
  }
  const sqlite = getLocalDatabase()
  const updated = await sqlite.runTransaction(async (transaction) => {
    const ref = apiKeyRef(apiKeyId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) throw new Error("API key not found.")
    const updated = { ...apiKeyFromSnapshot(snapshot), name: normalizedName }
    transaction.update(ref, { name: normalizedName })
    transaction.set(apiKeyIndexRef(apiKeyValueHash(updated.key)), apiKeyIndexDocument(updated), { merge: true })
    return updated
  })
  invalidateGatewayApiKeyCaches([apiKeyValueHash(updated.key)])
  return updated
}
export async function deleteApiKey(apiKeyId: string): Promise<void> {
  const hash = isMemoryBackend() ? memorySecurityMutation("gateway-key", "credential.revoke", () => memoryDeleteApiKey(apiKeyId)) : await sqliteDeleteApiKey(apiKeyId)
  invalidateGatewayApiKeyCaches(hash ? [hash] : [])
}

// -------------------------------------------------------------------------------------------------
// Routing revision cache
// -------------------------------------------------------------------------------------------------

async function readRoutingRevisionFresh() {
  if (isMemoryBackend()) return "0"
  const snapshot = await routingRevisionRef().get()
  const value = snapshot.exists ? snapshot.data()?.revision : 0
  return Number.isFinite(Number(value)) ? String(value) : "0"
}

async function readRoutingRevisionCached() {
  const state = workspaceCacheState()
  const now = Date.now()
  if (state.routingRevisionCache && state.routingRevisionCache.expiresAt > now) return state.routingRevisionCache.value
  if (state.routingRevisionReadPromise) return state.routingRevisionReadPromise
  const promise = readRoutingRevisionFresh().then((value) => {
    state.routingRevisionCache = { value, expiresAt: Date.now() + cacheTtlMs }
    return value
  }).finally(() => {
    if (state.routingRevisionReadPromise === promise) state.routingRevisionReadPromise = undefined
  })
  state.routingRevisionReadPromise = promise
  return promise
}

function clearConfigurationSourceCaches(state: WorkspaceCacheState) {
  clearReadCache(state.providersCache)
  clearReadCache(state.allProviderApiKeysCache)
  clearReadCache(state.modelsCache)
  clearReadCache(state.aliasesCache)
  clearReadCache(state.combosCache)
  clearReadCacheMap(state.providerApiKeysCache)
  clearReadCacheMap(state.providerModelsCache)
}

async function loadStableConfiguration<T>(loader: () => Promise<T>, initialRevision?: string) {
  const state = workspaceCacheState()
  let latestData: T | undefined
  let latestRevision = "0"
  let stable = false
  // A revision read on both sides prevents a mutation that lands during the
  // multi-query snapshot from being mistaken for a stable configuration.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = attempt === 0 && initialRevision !== undefined
      ? initialRevision
      : await readRoutingRevisionFresh()
    clearConfigurationSourceCaches(state)
    latestData = await loader()
    const after = await readRoutingRevisionFresh()
    latestRevision = after
    if (before === after) {
      stable = true
      break
    }
  }
  const cacheRevision = stable ? latestRevision : `unstable:${latestRevision}:${Date.now()}`
  state.routingRevisionCache = { value: latestRevision, expiresAt: Date.now() + cacheTtlMs }
  return { data: latestData!, revision: cacheRevision }
}

function reusableConfigurationCache<T>(cache: DataCache<T> | undefined, revision: string, now: number) {
  if (!cache || cache.revision !== revision || (cache.fullRefreshAt || 0) <= now) return undefined
  cache.expiresAt = now + cacheTtlMs
  return cache.data
}

async function loadCatalogSource(): Promise<CatalogData> {
  const [providers, models, aliases, combos] = await Promise.all([listProviders(), listModels(), listAliases(), listCombos()])
  return { providers, models, aliases, combos }
}

async function readSharedCatalogData(): Promise<CatalogData> {
  const state = workspaceCacheState()
  const now = Date.now()
  if (state.catalogDataCache && state.catalogDataCache.expiresAt > now) return state.catalogDataCache.data
  if (state.routingDataCache && state.routingDataCache.expiresAt > now) {
    const { providers, models, aliases, combos } = state.routingDataCache.data
    return { providers, models, aliases, combos }
  }
  if (!state.catalogDataReadPromise) {
    const generation = state.generation
    const promise = (async () => {
      const revision = await readRoutingRevisionCached()
      const reused = reusableConfigurationCache(state.catalogDataCache, revision, Date.now())
      if (reused) return reused
      const loaded = await loadStableConfiguration(loadCatalogSource, revision)
      const fullRefreshAt = Date.now() + routingFullRefreshIntervalMs
      if (generation === state.generation) {
        state.catalogDataCache = { data: loaded.data, revision: loaded.revision, expiresAt: Date.now() + cacheTtlMs, fullRefreshAt }
      }
      return loaded.data
    })().finally(() => {
      if (state.catalogDataReadPromise === promise) state.catalogDataReadPromise = undefined
    })
    state.catalogDataReadPromise = promise
  }
  return state.catalogDataReadPromise
}

async function readSharedRoutingData(): Promise<RoutingData> {
  const state = workspaceCacheState()
  const now = Date.now()
  if (state.routingDataCache && state.routingDataCache.expiresAt > now) return state.routingDataCache.data
  if (!state.routingDataReadPromise) {
    const generation = state.generation
    const promise = (async () => {
      const revision = await readRoutingRevisionCached()
      const reused = reusableConfigurationCache(state.routingDataCache, revision, Date.now())
      if (reused) return reused
      const loaded = await loadStableConfiguration(async () => {
        const [catalog, providerApiKeys] = await Promise.all([loadCatalogSource(), listAllProviderApiKeys()])
        return { ...catalog, providerApiKeys } satisfies RoutingData
      }, revision)
      const fullRefreshAt = Date.now() + routingFullRefreshIntervalMs
      if (generation === state.generation) {
        state.routingDataCache = { data: loaded.data, revision: loaded.revision, expiresAt: Date.now() + cacheTtlMs, fullRefreshAt }
        const { providers, models, aliases, combos } = loaded.data
        state.catalogDataCache = {
          data: { providers, models, aliases, combos },
          revision: loaded.revision,
          expiresAt: Date.now() + cacheTtlMs,
          fullRefreshAt,
        }
      }
      return loaded.data
    })().finally(() => {
      if (state.routingDataReadPromise === promise) state.routingDataReadPromise = undefined
    })
    state.routingDataReadPromise = promise
  }
  return state.routingDataReadPromise
}

/** Read-only catalog snapshot. Do not mutate it. */
export async function readCatalogData(): Promise<CatalogData> {
  return readSharedCatalogData()
}

/** Read-only routing snapshot for latency-sensitive server paths. Do not mutate it. */
export async function readRoutingData(): Promise<RoutingData> {
  return readSharedRoutingData()
}

export async function findIndexedApiKeyByValue(value: string): Promise<IndexedApiKey | undefined> {
  const normalized = normalizeApiKeyValue(value)
  if (!normalized) return undefined
  if (isMemoryBackend()) {
    const found = memoryFindApiKeyByHash(apiKeyValueHash(normalized))
    return found
      ? { workspaceId: found.workspaceId, workspaceStorageMode: "scoped", apiKey: { ...found.apiKey, key: normalized } }
      : undefined
  }
  const hash = apiKeyValueHash(normalized)
  const cached = apiKeyLookupCache.get(hash)
  if (cached && cached.expiresAt > Date.now()) return cached.value || undefined

  const existing = apiKeyLookupInflight.get(hash)
  if (existing) return existing
  const generation = apiKeyLookupGeneration
  const promise = (async () => {
    const cacheCached = await readApiKeyLookupFromCache(hash)
    if (cacheCached !== undefined) {
      const value = cacheCached
        ? { ...cacheCached, apiKey: { ...cacheCached.apiKey, key: normalized } }
        : undefined
      if (generation === apiKeyLookupGeneration) cacheApiKeyLookup(hash, value)
      return value
    }
    const index = await apiKeyIndexRef(hash).get()
    const indexData = index.exists ? index.data() as ApiKeyIndexData : undefined
    const apiKeyId = indexData?.apiKeyId
    if (!apiKeyId) {
      const value = undefined
      if (generation === apiKeyLookupGeneration) {
        cacheApiKeyLookup(hash, value)
        cacheApiKeyLookupInCache(hash, value)
      }
      return value
    }
    const workspaceId = indexData.workspaceId
    const workspaceStorageMode = "scoped" as const
    if (typeof workspaceId === "string" && typeof indexData.name === "string" && typeof indexData.createdAt === "string") {
      const value = { workspaceId, workspaceStorageMode, apiKey: { id: apiKeyId, name: indexData.name, key: normalized, createdAt: indexData.createdAt } }
      if (generation === apiKeyLookupGeneration) {
        cacheApiKeyLookup(hash, value)
        cacheApiKeyLookupInCache(hash, value)
      }
      return value
    }

    if (generation === apiKeyLookupGeneration) {
      cacheApiKeyLookup(hash, undefined)
      cacheApiKeyLookupInCache(hash, undefined)
    }
    return undefined
  })().finally(() => {
    if (apiKeyLookupInflight.get(hash) === promise) apiKeyLookupInflight.delete(hash)
  })
  apiKeyLookupInflight.set(hash, promise)
  return promise
}

export async function findApiKeyByValue(value: string): Promise<ApiKey | undefined> {
  return (await findIndexedApiKeyByValue(value))?.apiKey
}


// -------------------------------------------------------------------------------------------------
// SQLite implementations
// -------------------------------------------------------------------------------------------------

export function initializeGatewayIdentity(transaction: Transaction) {
  const seedRef = apiKeysRefForWorkspace(DEFAULT_WORKSPACE_ID).doc()
  const seedKey = { ...initialGatewayApiKey(), id: seedRef.id }
  transaction.set(seedRef, storedApiKey(seedKey))
  transaction.set(apiKeyIndexRef(apiKeyValueHash(seedKey.key)), apiKeyIndexDocumentForWorkspace(DEFAULT_WORKSPACE_ID, "scoped", seedKey))
}

export function identitySigningChanged(transaction?: Transaction) {
  if (transaction) transaction.set(routingRevisionRef(DEFAULT_WORKSPACE_ID), { revision: FieldValue.increment(1), updatedAt: new Date().toISOString() }, { merge: true })
  else {
    workspaceCacheStates.clear()
    invalidateApiKeyLookupCache()
  }
}

async function sqliteListProviders(): Promise<Provider[]> {
  const snapshot = await providersRef().get()
  return snapshot.docs.map(providerFromSnapshot).sort((a, b) => a.name.localeCompare(b.name))
}

async function sqliteGetProvider(providerId: string): Promise<Provider | undefined> {
  const snapshot = await providerRef(providerId).get()
  return snapshot.exists ? providerFromSnapshot(snapshot) : undefined
}

function gatewayIdOwner(kind: "alias" | "combo" | "model", id: string) {
  return `${kind}:${id}`
}

function normalizedGatewayId(id: string) {
  return cleanAliasId(id)
}

async function assertSqliteGatewayIdAvailable(transaction: Transaction, id: string, owner: string) {
  const normalizedId = normalizedGatewayId(id)
  if (!normalizedId) throw new Error("Gateway model ID is required.")
  const [reservation, aliases, combos, providers] = await Promise.all([
    transaction.get(gatewayIdRef(normalizedId)),
    transaction.get(aliasesRef()),
    transaction.get(combosRef()),
    transaction.get(providersRef()),
  ])
  const modelSnapshots = await Promise.all(providers.docs.map(async (provider) => ({ providerId: provider.id, snapshot: await transaction.get(modelsRef(provider.id)) })))
  const claimedBy = reservation.exists ? reservation.data()?.owner : undefined
  if (typeof claimedBy === "string" && claimedBy !== owner) throw new Error("Gateway model ID is already in use.")
  for (const alias of aliases.docs) {
    if (normalizedGatewayId(aliasFromSnapshot(alias).alias) !== normalizedId) continue
    if (gatewayIdOwner("alias", alias.id) !== owner) throw new Error("Gateway model ID is already in use.")
  }
  for (const combo of combos.docs) {
    if (normalizedGatewayId(comboFromSnapshot(combo).combo) !== normalizedId) continue
    if (gatewayIdOwner("combo", combo.id) !== owner) throw new Error("Gateway model ID is already in use.")
  }
  for (const { providerId, snapshot } of modelSnapshots) {
    for (const model of snapshot.docs) {
      if (normalizedGatewayId(modelFromSnapshot(model, providerId).gatewayModelId) !== normalizedId) continue
      if (gatewayIdOwner("model", `${providerId}:${model.id}`) !== owner) throw new Error("Gateway model ID is already in use.")
    }
  }
  return normalizedId
}

async function sqliteGatewayIdReservation(transaction: Transaction, id: string, owner: string) {
  const normalizedId = normalizedGatewayId(id)
  if (!normalizedId) return undefined
  const snapshot = await transaction.get(gatewayIdRef(normalizedId))
  return snapshot.exists && snapshot.data()?.owner === owner ? normalizedId : undefined
}

function reserveSqliteGatewayId(transaction: Transaction, id: string, owner: string) {
  transaction.set(gatewayIdRef(id), { owner })
}

function releaseSqliteGatewayId(transaction: Transaction, id: string | undefined) {
  if (id) transaction.delete(gatewayIdRef(id))
}

function assertMemoryGatewayIdAvailable(state: MemoryState, id: string, owner: string) {
  const normalizedId = normalizedGatewayId(id)
  if (!normalizedId) throw new Error("Gateway model ID is required.")
  const claimedBy = state.gatewayIds.get(normalizedId)
  if (claimedBy && claimedBy !== owner) throw new Error("Gateway model ID is already in use.")
  for (const alias of state.aliases.values()) {
    if (normalizedGatewayId(alias.alias) === normalizedId && gatewayIdOwner("alias", alias.id) !== owner) throw new Error("Gateway model ID is already in use.")
  }
  for (const combo of state.combos.values()) {
    if (normalizedGatewayId(combo.combo) === normalizedId && gatewayIdOwner("combo", combo.id) !== owner) throw new Error("Gateway model ID is already in use.")
  }
  for (const [providerId, models] of state.models) {
    for (const model of models.values()) {
      if (normalizedGatewayId(model.gatewayModelId || model.id) === normalizedId && gatewayIdOwner("model", `${providerId}:${model.id}`) !== owner) throw new Error("Gateway model ID is already in use.")
    }
  }
  return normalizedId
}

function reserveMemoryGatewayId(state: MemoryState, id: string, owner: string) {
  state.gatewayIds.set(id, owner)
}

function releaseMemoryGatewayId(state: MemoryState, id: string, owner: string) {
  if (state.gatewayIds.get(id) === owner) state.gatewayIds.delete(id)
}

async function sqliteUpsertProvider(input: Partial<Provider> & { originalId?: string }, expected?: Provider): Promise<Provider> {
  const sqlite = getLocalDatabase()
  return sqlite.runTransaction(async (transaction) => {
    const originalId = input.originalId
    const existingSnapshot = originalId ? await transaction.get(providerRef(originalId)) : undefined
    const existing = existingSnapshot?.exists ? providerFromSnapshot(existingSnapshot) : undefined
    if (originalId && !existing) throw new Error("Provider not found.")

    const id = existing ? originalId! : providersRef().doc().id
    const desiredPrefix = input.prefix || existing?.prefix || expected?.prefix || id
    const prefixMatches = await transaction.get(providersRef().where("prefix", "==", desiredPrefix).limit(2))
    if (prefixMatches.docs.some((document) => document.id !== originalId)) throw new Error("Provider prefix is already in use.")

    const existingModels = existing && existing.prefix !== desiredPrefix
      ? await transaction.get(modelsRef(existing.id))
      : undefined
    const migratedModels = existingModels
      ? migrateProviderModels(existingModels.docs.map((snapshot) => modelFromSnapshot(snapshot, id)), desiredPrefix)
      : undefined
    const migratedReservations = migratedModels
      ? await Promise.all([...migratedModels.values()].map(async (model) => {
          const owner = gatewayIdOwner("model", `${id}:${model.id}`)
          const normalizedId = await assertSqliteGatewayIdAvailable(transaction, model.gatewayModelId, owner)
          const previous = existingModels!.docs.find((snapshot) => snapshot.id === model.id)!
          const previousId = normalizedGatewayId(modelFromSnapshot(previous, id).gatewayModelId)
          const previousReservation = previousId !== normalizedId ? await sqliteGatewayIdReservation(transaction, previousId, owner) : undefined
          return { model, owner, normalizedId, previousReservation }
        }))
      : undefined
    const providerInput = stripUndefined({
      name: input.name,
      prefix: input.prefix,
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      authType: input.authType,
      headers: input.headers,
      supportPromptCacheKey: input.supportPromptCacheKey,
      enabled: input.enabled,
    }) as Partial<Provider>
    const provider: Provider = {
      ...(existing || expected || {}),
      ...providerInput,
      id,
      name: input.name || (existing?.name ?? ""),
      prefix: desiredPrefix,
      baseUrl: input.baseUrl || (existing?.baseUrl ?? ""),
      protocol: input.protocol || existing?.protocol || "openai-chat",
      authType: input.authType || existing?.authType || "bearer",
      headers: input.headers || existing?.headers || {},
      supportPromptCacheKey: input.supportPromptCacheKey !== undefined ? input.supportPromptCacheKey : (existing?.supportPromptCacheKey ?? expected?.supportPromptCacheKey ?? false),
      enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      apiKeyCount: existing?.apiKeyCount ?? 0,
      enabledApiKeyCount: existing?.enabledApiKeyCount ?? 0,
      modelCount: existing?.modelCount ?? 0,
      enabledModelCount: existing?.enabledModelCount ?? 0,
    } as Provider
    transaction.set(providerRef(id), storedProvider(provider))
    if (migratedReservations) {
      for (const { model, owner, normalizedId, previousReservation } of migratedReservations) {
        transaction.set(modelRef(id, model.id), storedModel(model))
        reserveSqliteGatewayId(transaction, normalizedId, owner)
        releaseSqliteGatewayId(transaction, previousReservation)
      }
    }
    bumpRoutingRevision(transaction)
    return provider
  })
}

async function sqliteDeleteProvider(providerId: string): Promise<void> {
  const sqlite = getLocalDatabase()
  await sqlite.runTransaction(async (transaction) => {
    const [apiKeys, models] = await Promise.all([
      transaction.get(providerApiKeysRef(providerId)),
      transaction.get(modelsRef(providerId)),
    ])
    const modelReservations = await Promise.all(models.docs.map(async (doc) => {
      const model = modelFromSnapshot(doc, providerId)
      return sqliteGatewayIdReservation(transaction, model.gatewayModelId, gatewayIdOwner("model", `${providerId}:${model.id}`))
    }))
    apiKeys.docs.forEach((doc) => {
      const stored = doc.data() as Partial<ProviderApiKey> | undefined
      // Codex sessions must not survive the provider's public accounts.
      if (stored?.credentialKind === "codex-oauth") stageCodexCredentialSecretsRemoval(transaction, doc.id)
      transaction.delete(doc.ref)
    })
    models.docs.forEach((doc) => transaction.delete(doc.ref))
    modelReservations.forEach((reservation) => releaseSqliteGatewayId(transaction, reservation))
    transaction.delete(providerRef(providerId))
    bumpRoutingRevision(transaction)
  })
}

async function sqliteListProviderApiKeys(providerId: string): Promise<ProviderApiKey[]> {
  const snapshot = await providerApiKeysRef(providerId).get()
  return snapshot.docs.map((doc) => providerApiKeyFromSnapshot(doc, providerId)).sort(compareProviderApiKeys)
}

async function sqliteReorderProviderApiKeys(providerId: string, orderedIds: string[]): Promise<void> {
  const sqlite = getLocalDatabase()
  await sqlite.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(providerApiKeysRef(providerId))
    const ids = snapshot.docs.map((doc) => doc.id)
    const orderedIdSet = new Set(orderedIds)
    if (ids.length !== orderedIdSet.size || ids.some((id) => !orderedIdSet.has(id))) throw new Error("API key order is out of date.")
    orderedIds.forEach((id, index) => transaction.update(providerApiKeyRef(providerId, id), { priority: orderedIds.length - index - 1 }))
    bumpRoutingRevision(transaction)
  })
}

async function sqliteListAllProviderApiKeys(): Promise<ProviderApiKey[]> {
  const providers = (await listProviders()).filter((provider) => provider.apiKeyCount !== 0)
  const snapshots = await parallelMap(providers, async (provider) => ({
    providerId: provider.id,
    snapshot: await providerApiKeysRef(provider.id).get(),
  }))
  return snapshots.flatMap(({ providerId, snapshot }) => snapshot.docs.map((document) => providerApiKeyFromSnapshot(document, providerId)))
}

async function sqliteUpsertProviderApiKey(providerId: string, input: ProviderApiKeyInput): Promise<ProviderApiKey> {
  const sqlite = getLocalDatabase()
  return sqlite.runTransaction(async (transaction) => {
    const providerDocSnapshot = await transaction.get(providerRef(providerId))
    if (!providerDocSnapshot.exists) throw new Error("Provider is missing.")
    const existingSnapshot = input.originalId ? await transaction.get(providerApiKeyRef(providerId, input.originalId)) : undefined
    const existing = existingSnapshot?.exists ? providerApiKeyFromSnapshot(existingSnapshot, providerId) : undefined
    if (input.originalId && !existing) throw new Error("Provider API key not found.")
    const apiKeyId = existing ? input.originalId! : providerApiKeysRef(providerId).doc().id
    const inputWithoutIds = stripUndefined({
      name: input.name,
      key: input.key,
      credentialKind: input.credentialKind,
      accountId: input.accountId,
      email: input.email,
      planType: input.planType,
      expiresAt: input.expiresAt,
      lastRefresh: input.lastRefresh,
      enabled: input.enabled,
      priority: input.priority,
    }) as Partial<ProviderApiKey>
    const apiKey = stripUndefined({
      ...(existing || {}),
      ...inputWithoutIds,
      id: apiKeyId,
      providerId,
      name: input.name || existing?.name || "",
      key: input.key !== undefined && input.key !== "__unchanged__" ? input.key : (existing?.key || ""),
      enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
      rpmLimit: input.rpmLimit === null ? undefined : input.rpmLimit ?? existing?.rpmLimit,
      maxConcurrency: input.maxConcurrency === null ? undefined : input.maxConcurrency ?? existing?.maxConcurrency,
      priority: input.priority ?? existing?.priority,
      createdAt: existing?.createdAt || new Date().toISOString(),
    }) as ProviderApiKey
    if (apiKey.credentialKind === "codex-oauth") normalizeCodexCredentialApiKey(apiKey)
    transaction.set(providerApiKeyRef(providerId, apiKeyId), storedProviderApiKey(apiKey))
    if (!existing) {
      transaction.update(providerRef(providerId), { apiKeyCount: FieldValue.increment(1), enabledApiKeyCount: FieldValue.increment(apiKey.enabled ? 1 : 0) })
    } else if (existing.enabled !== apiKey.enabled) {
      transaction.update(providerRef(providerId), { enabledApiKeyCount: FieldValue.increment(apiKey.enabled ? 1 : -1) })
    }
    bumpRoutingRevision(transaction)
    return apiKey
  })
}

async function sqliteDeleteProviderApiKey(providerId: string, apiKeyId: string): Promise<void> {
  const sqlite = getLocalDatabase()
  await sqlite.runTransaction(async (transaction) => {
    const ref = providerApiKeyRef(providerId, apiKeyId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return
    const apiKey = snapshot.data() as ProviderApiKey
    if (apiKey.credentialKind === "codex-oauth") stageCodexCredentialSecretsRemoval(transaction, apiKeyId)
    transaction.delete(ref)
    transaction.update(providerRef(providerId), {
      apiKeyCount: FieldValue.increment(-1),
      enabledApiKeyCount: FieldValue.increment(apiKey.enabled ? -1 : 0),
    })
    bumpRoutingRevision(transaction)
  })
}

async function sqliteListModels(): Promise<Model[]> {
  const providers = (await listProviders()).filter((provider) => provider.modelCount !== 0)
  const snapshots = await parallelMap(providers, async (provider) => ({
    providerId: provider.id,
    snapshot: await modelsRef(provider.id).get(),
  }))
  return snapshots.flatMap(({ providerId, snapshot }) => snapshot.docs.map((document) => modelFromSnapshot(document, providerId)))
}

async function sqliteListProviderModels(providerId: string): Promise<Model[]> {
  const snapshot = await modelsRef(providerId).get()
  return snapshot.docs.map((doc) => modelFromSnapshot(doc, providerId))
}

async function sqliteUpsertModel(providerId: string, input: Partial<Model> & { originalId?: string }, discover = false): Promise<Model> {
  const sqlite = getLocalDatabase()
  return sqlite.runTransaction(async (transaction) => {
    const providerDocSnapshot = await transaction.get(providerRef(providerId))
    if (!providerDocSnapshot.exists) throw new Error("Provider is missing.")
    if (discover) {
      if (providerDocSnapshot.data()?.prefix !== "codex") throw new Error("Discovery requires a Codex provider.")
      const matches = await transaction.get(modelsRef(providerId).where("gatewayModelId", "==", input.gatewayModelId).limit(1))
      input = { ...input, originalId: matches.docs[0]?.id }
    }
    const existingSnapshot = input.originalId ? await transaction.get(modelRef(providerId, input.originalId)) : undefined
    const existing = existingSnapshot?.exists ? modelFromSnapshot(existingSnapshot, providerId) : undefined
    if (input.originalId && !existing) throw new Error("Model not found.")

    input = { ...input, ...managedModelInput(existing, input, discover) }
    const rawGatewayModelId = input.gatewayModelId || (!input.originalId ? input.id : undefined) || existing?.gatewayModelId || existing?.id || ""
    const gatewayModelId = normalizedGatewayId(rawGatewayModelId)
    const name = input.name || existing?.name || ""
    const upstreamModel = input.upstreamModel || existing?.upstreamModel || ""
    if (!name || !upstreamModel || !gatewayModelId) throw new Error("Model fields are incomplete.")

    const gatewayMatches = await transaction.get(modelsRef(providerId).where("gatewayModelId", "==", gatewayModelId).limit(2))
    if (gatewayMatches.docs.some((document) => document.id !== input.originalId)) throw new Error("Gateway model ID is already in use.")

    const modelId = existing ? input.originalId! : modelsRef(providerId).doc().id
    const owner = gatewayIdOwner("model", `${providerId}:${modelId}`)
    const normalizedId = await assertSqliteGatewayIdAvailable(transaction, gatewayModelId, owner)
    const previousId = existing ? normalizedGatewayId(existing.gatewayModelId || existing.id) : undefined
    const previousReservation = previousId && previousId !== normalizedId
      ? await sqliteGatewayIdReservation(transaction, previousId, owner)
      : undefined
    const inputWithoutIds = stripUndefined({
      name: input.name,
      upstreamModel: input.upstreamModel,
      enabled: input.enabled,
      source: input.source,
      discovery: input.discovery,
      reasoningCapability: input.reasoningCapability,
    }) as Partial<Model>
    const model: Model = {
      ...(existing || {}),
      id: modelId,
      providerId,
      gatewayModelId,
      ...inputWithoutIds,
      name,
      upstreamModel,
      source: input.source || existing?.source || "custom",
      enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
    }
    transaction.set(modelRef(providerId, modelId), storedModel(model))
    reserveSqliteGatewayId(transaction, normalizedId, owner)
    releaseSqliteGatewayId(transaction, previousReservation)
    if (!existing) {
      transaction.update(providerRef(providerId), { modelCount: FieldValue.increment(1), enabledModelCount: FieldValue.increment(model.enabled ? 1 : 0) })
    } else if (existing.enabled !== model.enabled) {
      transaction.update(providerRef(providerId), { enabledModelCount: FieldValue.increment(model.enabled ? 1 : -1) })
    }
    bumpRoutingRevision(transaction)
    return model
  })
}

async function sqliteDeleteModel(providerId: string, modelId: string): Promise<void> {
  const sqlite = getLocalDatabase()
  await sqlite.runTransaction(async (transaction) => {
    const ref = modelRef(providerId, modelId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return
    const model = modelFromSnapshot(snapshot, providerId)
    if (model.source === "discovered") throw new Error("Managed models cannot be deleted; disable them instead.")
    const reservation = await sqliteGatewayIdReservation(transaction, model.gatewayModelId || model.id, gatewayIdOwner("model", `${providerId}:${model.id}`))
    transaction.delete(ref)
    releaseSqliteGatewayId(transaction, reservation)
    transaction.update(providerRef(providerId), {
      modelCount: FieldValue.increment(-1),
      enabledModelCount: FieldValue.increment(model.enabled ? -1 : 0),
    })
    bumpRoutingRevision(transaction)
  })
}

async function sqliteListAliases(): Promise<ModelAlias[]> {
  const snapshot = await aliasesRef().get()
  return snapshot.docs.map(aliasFromSnapshot).sort(compareAliases)
}

async function sqliteUpsertAlias(input: Partial<ModelAlias> & { originalId?: string }): Promise<ModelAlias> {
  const sqlite = getLocalDatabase()
  return sqlite.runTransaction(async (transaction) => {
    const existingSnapshot = input.originalId ? await transaction.get(aliasRef(input.originalId)) : undefined
    const existing = existingSnapshot?.exists ? aliasFromSnapshot(existingSnapshot) : undefined
    if (input.originalId && !existing) throw new Error("Alias not found.")
    const normalizedAlias = cleanAliasId(input.alias || existing?.alias || "")
    if (!normalizedAlias) throw new Error("Alias is required.")

    const aliasMatches = await transaction.get(aliasesRef().where("alias", "==", normalizedAlias).limit(2))
    if (aliasMatches.docs.some((document) => document.id !== input.originalId)) throw new Error("Alias is already in use.")

    const aliasId = existing ? input.originalId! : aliasesRef().doc().id
    const owner = gatewayIdOwner("alias", aliasId)
    const normalizedId = await assertSqliteGatewayIdAvailable(transaction, normalizedAlias, owner)
    const previousId = existing ? normalizedGatewayId(existing.alias) : undefined
    const previousReservation = previousId && previousId !== normalizedId
      ? await sqliteGatewayIdReservation(transaction, previousId, owner)
      : undefined
    const inputWithoutIds = { ...input }
    delete inputWithoutIds.id
    delete inputWithoutIds.originalId
    const alias: ModelAlias = {
      ...(existing || {}),
      ...inputWithoutIds,
      id: aliasId,
      alias: normalizedAlias,
      name: input.name?.trim() || existing?.name || "",
      targetModelId: input.targetModelId?.trim() || existing?.targetModelId || "",
      ...(input.sharedModelId !== undefined ? (input.sharedModelId.trim() ? { sharedModelId: input.sharedModelId.trim() } : {}) : existing?.sharedModelId ? { sharedModelId: existing.sharedModelId } : {}),
      createdAt: existing?.createdAt || new Date().toISOString(),
    }
    transaction.set(aliasRef(aliasId), storedAlias(alias))
    reserveSqliteGatewayId(transaction, normalizedId, owner)
    releaseSqliteGatewayId(transaction, previousReservation)
    bumpRoutingRevision(transaction)
    return alias
  })
}

async function sqliteDeleteAlias(aliasId: string): Promise<void> {
  const sqlite = getLocalDatabase()
  await sqlite.runTransaction(async (transaction) => {
    const ref = aliasRef(aliasId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return
    const alias = aliasFromSnapshot(snapshot)
    const reservation = await sqliteGatewayIdReservation(transaction, alias.alias, gatewayIdOwner("alias", alias.id))
    transaction.delete(ref)
    releaseSqliteGatewayId(transaction, reservation)
    bumpRoutingRevision(transaction)
  })
}

async function sqliteListCombos(): Promise<ModelCombo[]> {
  const snapshot = await combosRef().get()
  return snapshot.docs.map(comboFromSnapshot).sort(compareCombos)
}

async function sqliteUpsertCombo(input: Partial<ModelCombo> & { originalId?: string }): Promise<ModelCombo> {
  const sqlite = getLocalDatabase()
  return sqlite.runTransaction(async (transaction) => {
    const existingSnapshot = input.originalId ? await transaction.get(comboRef(input.originalId)) : undefined
    const existing = existingSnapshot?.exists ? comboFromSnapshot(existingSnapshot) : undefined
    if (input.originalId && !existing) throw new Error("Combo not found.")
    const normalizedCombo = cleanAliasId(input.combo || existing?.combo || "")
    if (!normalizedCombo) throw new Error("Combo gateway ID is required.")
    const matches = await transaction.get(combosRef().where("combo", "==", normalizedCombo).limit(2))
    if (matches.docs.some((document) => document.id !== input.originalId)) throw new Error("Combo gateway ID is already in use.")
    const comboId = existing ? input.originalId! : combosRef().doc().id
    const owner = gatewayIdOwner("combo", comboId)
    const normalizedId = await assertSqliteGatewayIdAvailable(transaction, normalizedCombo, owner)
    const previousId = existing ? normalizedGatewayId(existing.combo) : undefined
    const previousReservation = previousId && previousId !== normalizedId
      ? await sqliteGatewayIdReservation(transaction, previousId, owner)
      : undefined
    const members = input.members === undefined ? existing?.members || []
      : input.members.map((member) => ({ ...member, modelId: member.modelId.trim() }))
    const combo: ModelCombo = {
      id: comboId,
      combo: normalizedCombo,
      name: input.name?.trim() || existing?.name || "",
      members,
      createdAt: existing?.createdAt || new Date().toISOString(),
    }
    transaction.set(comboRef(comboId), storedCombo(combo))
    reserveSqliteGatewayId(transaction, normalizedId, owner)
    releaseSqliteGatewayId(transaction, previousReservation)
    bumpRoutingRevision(transaction)
    return combo
  })
}

async function sqliteDeleteCombo(comboId: string): Promise<void> {
  const sqlite = getLocalDatabase()
  await sqlite.runTransaction(async (transaction) => {
    const ref = comboRef(comboId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return
    const combo = comboFromSnapshot(snapshot)
    const reservation = await sqliteGatewayIdReservation(transaction, combo.combo, gatewayIdOwner("combo", combo.id))
    transaction.delete(ref)
    releaseSqliteGatewayId(transaction, reservation)
    bumpRoutingRevision(transaction)
  })
}

async function sqliteListApiKeys(): Promise<ApiKey[]> {
  const snapshot = await apiKeysRef().get()
  return snapshot.docs.map(apiKeyFromSnapshot)
}

function isSqliteAlreadyExistsError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  return code === "DOCUMENT_EXISTS"
}

async function sqliteCreateApiKey(name: string, customKey?: string): Promise<ApiKey> {
  const normalizedCustomKey = customKey === undefined ? undefined : validateGatewayApiKeyValue(customKey)
  const sqlite = getLocalDatabase()
  const apiKey = {
    id: apiKeysRef().doc().id,
    name,
    key: normalizedCustomKey === undefined ? `sk-rr-${crypto.randomUUID().replaceAll("-", "")}` : normalizedCustomKey,
    createdAt: new Date().toISOString(),
  } satisfies ApiKey
  const requestedHash = apiKeyValueHash(apiKey.key)
  const batch = sqlite.batch()
  // Create preconditions enforce global uniqueness atomically without a
  // transaction retry loop, preflight lookup, or all-workspace scan.
  batch.create(apiKeyRef(apiKey.id), storedApiKey(apiKey))
  batch.create(apiKeyIndexRef(requestedHash), apiKeyIndexDocument(apiKey))
  try {
    await batch.commit()
    return apiKey
  } catch (error) {
    if (isSqliteAlreadyExistsError(error)) throw new ApiKeyConflictError()
    throw error
  }
}

async function sqliteRotateApiKey(apiKeyId: string, customKey?: string): Promise<{ apiKey: ApiKey; previousHash: string }> {
  const sqlite = getLocalDatabase()
  try {
    return await sqlite.runTransaction(async (transaction) => {
      const ref = apiKeyRef(apiKeyId)
      const snapshot = await transaction.get(ref)
      if (!snapshot.exists) throw new Error("API key not found.")
      const existing = apiKeyFromSnapshot(snapshot)
      const replacement = customKey === undefined ? `sk-rr-${crypto.randomUUID().replaceAll("-", "")}` : customKey
      const previousHash = apiKeyValueHash(existing.key)
      const replacementHash = apiKeyValueHash(replacement)
      if (replacementHash === previousHash) throw new ApiKeyConflictError()

      const updated = { ...existing, key: replacement }
      transaction.create(apiKeyIndexRef(replacementHash), apiKeyIndexDocument(updated))
      transaction.update(ref, { key: replacement })
      transaction.delete(apiKeyIndexRef(previousHash))
      return { apiKey: updated, previousHash }
    })
  } catch (error) {
    if (isSqliteAlreadyExistsError(error)) throw new ApiKeyConflictError()
    throw error
  }
}

async function sqliteDeleteApiKey(apiKeyId: string): Promise<string | undefined> {
  const sqlite = getLocalDatabase()
  return sqlite.runTransaction(async (transaction) => {
    const ref = apiKeyRef(apiKeyId)
    const target = await transaction.get(ref)
    if (!target.exists) return undefined
    const apiKey = apiKeyFromSnapshot(target)
    const hash = apiKeyValueHash(apiKey.key)
    transaction.delete(ref)
    transaction.delete(apiKeyIndexRef(hash))
    return hash
  })
}

// -------------------------------------------------------------------------------------------------
// Memory implementations
// -------------------------------------------------------------------------------------------------

function memoryUpsertProvider(input: Partial<Provider> & { originalId?: string }, expected?: Provider): Provider {
  const state = ensureMemorySeeded()
  const originalId = input.originalId
  const existing = originalId ? state.providers.get(originalId) : undefined
  if (originalId && !existing) throw new Error("Provider not found.")
  const id = existing ? originalId! : crypto.randomUUID()
  const providerInput = stripUndefined({
    name: input.name,
    prefix: input.prefix,
    baseUrl: input.baseUrl,
    protocol: input.protocol,
    authType: input.authType,
    headers: input.headers,
    supportPromptCacheKey: input.supportPromptCacheKey,
    enabled: input.enabled,
  }) as Partial<Provider>
  for (const provider of state.providers.values()) {
    if (provider.prefix === input.prefix && provider.id !== id) throw new Error("Provider prefix is already in use.")
  }
  const counters = { apiKeyCount: 0, enabledApiKeyCount: 0, modelCount: 0, enabledModelCount: 0 }
  if (existing) {
    counters.apiKeyCount = existing.apiKeyCount
    counters.enabledApiKeyCount = existing.enabledApiKeyCount
    counters.modelCount = existing.modelCount
    counters.enabledModelCount = existing.enabledModelCount
  }
  const provider: Provider = {
    ...(existing || expected || {}),
    ...providerInput,
    id,
    name: input.name || (existing?.name ?? ""),
    prefix: input.prefix || (existing?.prefix ?? id),
    baseUrl: input.baseUrl || (existing?.baseUrl ?? ""),
    protocol: input.protocol || existing?.protocol || "openai-chat",
    authType: input.authType || existing?.authType || "bearer",
    headers: input.headers || existing?.headers || {},
    supportPromptCacheKey: input.supportPromptCacheKey !== undefined ? input.supportPromptCacheKey : (existing?.supportPromptCacheKey ?? expected?.supportPromptCacheKey ?? false),
    enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    ...counters,
  } as Provider
  const existingModels = existing && existing.prefix !== provider.prefix ? state.models.get(id) : undefined
  const migratedModels = existingModels ? migrateProviderModels(existingModels.values(), provider.prefix) : undefined
  const migratedReservations = migratedModels ? [...migratedModels.values()].map((model) => {
    const owner = gatewayIdOwner("model", `${id}:${model.id}`)
    const normalizedId = assertMemoryGatewayIdAvailable(state, model.gatewayModelId, owner)
    const previous = existingModels!.get(model.id)!
    const previousId = normalizedGatewayId(previous.gatewayModelId || previous.id)
    return { owner, normalizedId, previousId, model }
  }) : undefined
  state.providers.set(id, provider)
  if (migratedModels) state.models.set(id, migratedModels)
  if (migratedReservations) {
    for (const { owner, normalizedId, previousId } of migratedReservations) {
      reserveMemoryGatewayId(state, normalizedId, owner)
      if (previousId !== normalizedId) releaseMemoryGatewayId(state, previousId, owner)
    }
  }

  return provider
}

function memoryDeleteProvider(providerId: string): void {
  const state = ensureMemorySeeded()
  for (const model of state.models.get(providerId)?.values() || []) {
    releaseMemoryGatewayId(state, normalizedGatewayId(model.gatewayModelId || model.id), gatewayIdOwner("model", `${providerId}:${model.id}`))
  }
  for (const account of state.providerApiKeys.get(providerId)?.values() || []) {
    if (account.credentialKind === "codex-oauth") deleteMemoryCodexCredentialSecrets(account.id)
  }
  state.providers.delete(providerId)
  state.providerApiKeys.delete(providerId)
  state.models.delete(providerId)

}

function memoryUpsertProviderApiKey(providerId: string, input: ProviderApiKeyInput): ProviderApiKey {
  const state = ensureMemorySeeded()
  const provider = state.providers.get(providerId)
  if (!provider) throw new Error("Provider is missing.")
  const slot = state.providerApiKeys.get(providerId) || new Map<string, ProviderApiKey>()
  const existing = input.originalId ? slot.get(input.originalId) : undefined
  if (input.originalId && !existing) throw new Error("Provider API key not found.")
  const apiKeyId = existing ? input.originalId! : crypto.randomUUID()
  const inputWithoutIds = stripUndefined({
    name: input.name,
    key: input.key,
    credentialKind: input.credentialKind,
    accountId: input.accountId,
    email: input.email,
    planType: input.planType,
    expiresAt: input.expiresAt,
    lastRefresh: input.lastRefresh,
    enabled: input.enabled,
    priority: input.priority,
  }) as Partial<ProviderApiKey>
  const apiKey = stripUndefined({
    ...(existing || {}),
    ...inputWithoutIds,
    id: apiKeyId,
    providerId,
    name: input.name || existing?.name || "",
    key: input.key !== undefined && input.key !== "__unchanged__" ? input.key : (existing?.key || ""),
    enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
    rpmLimit: input.rpmLimit === null ? undefined : input.rpmLimit ?? existing?.rpmLimit,
    maxConcurrency: input.maxConcurrency === null ? undefined : input.maxConcurrency ?? existing?.maxConcurrency,
    priority: input.priority ?? existing?.priority,
    createdAt: existing?.createdAt || new Date().toISOString(),
  }) as ProviderApiKey
  if (apiKey.credentialKind === "codex-oauth") normalizeCodexCredentialApiKey(apiKey)
  slot.set(apiKeyId, apiKey)
  state.providerApiKeys.set(providerId, slot)
  if (!existing) {
    state.providers.set(providerId, {
      ...provider,
      apiKeyCount: provider.apiKeyCount + 1,
      enabledApiKeyCount: provider.enabledApiKeyCount + (apiKey.enabled ? 1 : 0),
    })
  } else if (existing.enabled !== apiKey.enabled) {
    state.providers.set(providerId, {
      ...provider,
      enabledApiKeyCount: provider.enabledApiKeyCount + (apiKey.enabled ? 1 : -1),
    })
  }

  return apiKey
}

function memoryDeleteProviderApiKey(providerId: string, apiKeyId: string): void {
  const state = ensureMemorySeeded()
  const provider = state.providers.get(providerId)
  if (!provider) return
  const slot = state.providerApiKeys.get(providerId)
  const apiKey = slot?.get(apiKeyId)
  if (!apiKey || !slot) return
  if (apiKey.credentialKind === "codex-oauth") deleteMemoryCodexCredentialSecrets(apiKeyId)
  slot.delete(apiKeyId)
  state.providers.set(providerId, {
    ...provider,
    apiKeyCount: Math.max(0, provider.apiKeyCount - 1),
    enabledApiKeyCount: Math.max(0, provider.enabledApiKeyCount - (apiKey.enabled ? 1 : 0)),
  })

}

function memoryUpsertModel(providerId: string, input: Partial<Model> & { originalId?: string }, discover = false): Model {
  const state = ensureMemorySeeded()
  const provider = state.providers.get(providerId)
  if (!provider) throw new Error("Provider is missing.")
  const slot = state.models.get(providerId) || new Map<string, Model>()
  if (discover) {
    if (provider.prefix !== "codex") throw new Error("Discovery requires a Codex provider.")
    input = { ...input, originalId: [...slot.values()].find((model) => model.gatewayModelId === input.gatewayModelId)?.id }
  }
  const existing = input.originalId ? slot.get(input.originalId) : undefined
  if (input.originalId && !existing) throw new Error("Model not found.")

  input = { ...input, ...managedModelInput(existing, input, discover) }
  const modelId = existing ? input.originalId! : crypto.randomUUID()
  const rawGatewayModelId = input.gatewayModelId || (!input.originalId ? input.id : undefined) || existing?.gatewayModelId || existing?.id || ""
  const gatewayModelId = normalizedGatewayId(rawGatewayModelId)
  const name = input.name || existing?.name || ""
  const upstreamModel = input.upstreamModel || existing?.upstreamModel || ""
  if (!name || !upstreamModel || !gatewayModelId) throw new Error("Model fields are incomplete.")
  for (const model of slot.values()) {
    if (model.id !== input.originalId && (model.gatewayModelId || model.id) === gatewayModelId) throw new Error("Gateway model ID is already in use.")
  }
  const owner = gatewayIdOwner("model", `${providerId}:${modelId}`)
  const normalizedId = assertMemoryGatewayIdAvailable(state, gatewayModelId, owner)
  const previousId = existing ? normalizedGatewayId(existing.gatewayModelId || existing.id) : undefined
  const inputWithoutIds = stripUndefined({
    name: input.name,
    upstreamModel: input.upstreamModel,
    enabled: input.enabled,
    source: input.source,
    discovery: input.discovery,
    reasoningCapability: input.reasoningCapability,
  }) as Partial<Model>
  const model: Model = {
    ...(existing || {}),
    ...inputWithoutIds,
    id: modelId,
    providerId,
    gatewayModelId,
    name,
    upstreamModel,
    source: input.source || existing?.source || "custom",
    enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
  }
  slot.set(modelId, model)
  state.models.set(providerId, slot)
  reserveMemoryGatewayId(state, normalizedId, owner)
  if (previousId && previousId !== normalizedId) releaseMemoryGatewayId(state, previousId, owner)
  if (!existing) {
    state.providers.set(providerId, {
      ...provider,
      modelCount: provider.modelCount + 1,
      enabledModelCount: provider.enabledModelCount + (model.enabled ? 1 : 0),
    })
  } else if (existing.enabled !== model.enabled) {
    state.providers.set(providerId, {
      ...provider,
      enabledModelCount: provider.enabledModelCount + (model.enabled ? 1 : -1),
    })
  }

  return model
}

function memoryDeleteModel(providerId: string, modelId: string): void {
  const state = ensureMemorySeeded()
  const provider = state.providers.get(providerId)
  if (!provider) return
  const slot = state.models.get(providerId)
  const model = slot?.get(modelId)
  if (!model || !slot) return
  if (model.source === "discovered") throw new Error("Managed models cannot be deleted; disable them instead.")
  slot.delete(modelId)
  releaseMemoryGatewayId(state, normalizedGatewayId(model.gatewayModelId || model.id), gatewayIdOwner("model", `${providerId}:${model.id}`))
  state.providers.set(providerId, {
    ...provider,
    modelCount: Math.max(0, provider.modelCount - 1),
    enabledModelCount: Math.max(0, provider.enabledModelCount - (model.enabled ? 1 : 0)),
  })

}

function memoryUpsertAlias(input: Partial<ModelAlias> & { originalId?: string }): ModelAlias {
  const state = ensureMemorySeeded()
  const existing = input.originalId ? state.aliases.get(input.originalId) : undefined
  if (input.originalId && !existing) throw new Error("Alias not found.")
  const normalizedAlias = cleanAliasId(input.alias || existing?.alias || "")
  if (!normalizedAlias) throw new Error("Alias is required.")
  for (const alias of state.aliases.values()) {
    if (alias.id !== input.originalId && (alias.alias || alias.id) === normalizedAlias) throw new Error("Alias is already in use.")
  }
  const aliasId = existing ? input.originalId! : crypto.randomUUID()
  const owner = gatewayIdOwner("alias", aliasId)
  const normalizedId = assertMemoryGatewayIdAvailable(state, normalizedAlias, owner)
  const previousId = existing ? normalizedGatewayId(existing.alias) : undefined
  const inputWithoutIds = { ...input }
  delete inputWithoutIds.id
  delete inputWithoutIds.originalId
  const alias: ModelAlias = {
    ...(existing || {}),
    ...inputWithoutIds,
    id: aliasId,
    alias: normalizedAlias,
    name: input.name?.trim() || existing?.name || "",
    targetModelId: input.targetModelId?.trim() || existing?.targetModelId || "",
    ...(input.sharedModelId !== undefined ? (input.sharedModelId.trim() ? { sharedModelId: input.sharedModelId.trim() } : {}) : existing?.sharedModelId ? { sharedModelId: existing.sharedModelId } : {}),
    createdAt: existing?.createdAt || new Date().toISOString(),
  }
  state.aliases.set(aliasId, alias)
  reserveMemoryGatewayId(state, normalizedId, owner)
  if (previousId && previousId !== normalizedId) releaseMemoryGatewayId(state, previousId, owner)

  return alias
}

function memoryDeleteAlias(aliasId: string): void {
  const state = ensureMemorySeeded()
  const alias = state.aliases.get(aliasId)
  if (alias) releaseMemoryGatewayId(state, normalizedGatewayId(alias.alias), gatewayIdOwner("alias", alias.id))
  state.aliases.delete(aliasId)

}

function memoryUpsertCombo(input: Partial<ModelCombo> & { originalId?: string }): ModelCombo {
  const state = ensureMemorySeeded()
  const existing = input.originalId ? state.combos.get(input.originalId) : undefined
  if (input.originalId && !existing) throw new Error("Combo not found.")
  const normalizedCombo = cleanAliasId(input.combo || existing?.combo || "")
  if (!normalizedCombo) throw new Error("Combo gateway ID is required.")
  for (const combo of state.combos.values()) {
    if (combo.id !== input.originalId && combo.combo === normalizedCombo) throw new Error("Combo gateway ID is already in use.")
  }
  const comboId = existing ? input.originalId! : crypto.randomUUID()
  const owner = gatewayIdOwner("combo", comboId)
  const normalizedId = assertMemoryGatewayIdAvailable(state, normalizedCombo, owner)
  const previousId = existing ? normalizedGatewayId(existing.combo) : undefined
  const combo: ModelCombo = {
    id: comboId,
    combo: normalizedCombo,
    name: input.name?.trim() || existing?.name || "",
    members: input.members === undefined ? existing?.members || []
      : input.members.map((member) => ({ ...member, modelId: member.modelId.trim() })),
    createdAt: existing?.createdAt || new Date().toISOString(),
  }
  state.combos.set(combo.id, combo)
  reserveMemoryGatewayId(state, normalizedId, owner)
  if (previousId && previousId !== normalizedId) releaseMemoryGatewayId(state, previousId, owner)
  return combo
}

function memoryDeleteCombo(comboId: string): void {
  const state = ensureMemorySeeded()
  const combo = state.combos.get(comboId)
  if (combo) releaseMemoryGatewayId(state, normalizedGatewayId(combo.combo), gatewayIdOwner("combo", combo.id))
  state.combos.delete(comboId)
}

function memoryCreateApiKey(name: string, customKey?: string): ApiKey {
  const state = ensureMemorySeeded()
  const apiKey: ApiKey = {
    id: crypto.randomUUID(),
    name,
    key: customKey === undefined ? `sk-rr-${crypto.randomUUID().replaceAll("-", "")}` : validateGatewayApiKeyValue(customKey),
    createdAt: new Date().toISOString(),
  }
  const hash = apiKeyValueHash(apiKey.key)
  if (memoryApiKeyValueExists(hash)) throw new ApiKeyConflictError()
  state.apiKeys.set(apiKey.id, apiKey)
  state.apiKeyIndexes.set(hash, apiKey.id)

  return apiKey
}

function memoryRotateApiKey(apiKeyId: string, customKey?: string): { apiKey: ApiKey; previousHash: string } {
  const state = ensureMemorySeeded()
  const existing = state.apiKeys.get(apiKeyId)
  if (!existing) throw new Error("API key not found.")

  const replacement = customKey === undefined ? `sk-rr-${crypto.randomUUID().replaceAll("-", "")}` : customKey
  const previousHash = apiKeyValueHash(existing.key)
  const replacementHash = apiKeyValueHash(replacement)
  if (replacementHash === previousHash || memoryApiKeyValueExists(replacementHash)) throw new ApiKeyConflictError()

  const updated = { ...existing, key: replacement }
  state.apiKeys.set(apiKeyId, updated)
  state.apiKeyIndexes.delete(previousHash)
  state.apiKeyIndexes.set(replacementHash, apiKeyId)
  return { apiKey: updated, previousHash }
}

function memoryDeleteApiKey(apiKeyId: string): string | undefined {
  const state = ensureMemorySeeded()
  if (!state.apiKeys.has(apiKeyId)) return undefined
  const apiKey = state.apiKeys.get(apiKeyId)
  state.apiKeys.delete(apiKeyId)
  const hash = apiKey ? apiKeyValueHash(apiKey.key) : undefined
  if (hash) state.apiKeyIndexes.delete(hash)

  return hash
}

// Test-only accessor for memory backend snapshots.
export function _memorySnapshot() {
  return memorySnapshot(ensureMemorySeeded())
}

// Test-only accessor for simulating a missing global index row.
export function _deleteMemoryApiKeyIndex(value: string) {
  const hash = apiKeyValueHash(value)
  for (const state of memoryRoot().states.values()) state.apiKeyIndexes.delete(hash)
  invalidateApiKeyLookupCache([hash])
}

export function _resetMemoryBackend() {
  globalThis.__rawrouteMemoryStore = { states: new Map() }
  workspaceCacheStates.clear()
  invalidateApiKeyLookupCache()
  resetCodexCredentialMemory()
}

function deleteMemoryWorkspace(workspaceId: string) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) throw new Error("Default workspace cannot be deleted.")
  const state = memoryRoot().states.get(workspaceId)
  const hashes = state ? [...state.apiKeys.values()].map((apiKey) => apiKeyValueHash(apiKey.key)) : []
  memoryRoot().states.delete(workspaceId)
  deleteWorkspaceMemoryCodexCredentials(workspaceId)
  workspaceCacheStates.delete(workspaceId)
  invalidateApiKeyLookupCache(hashes)
}

export async function cleanupAiWorkspace(workspaceId: string) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) throw new Error("Default workspace cannot be deleted.")
  if (isMemoryBackend()) {
    deleteMemoryWorkspace(workspaceId)
    return () => {}
  }
  const apiKeys = await workspaceRootRef(workspaceId).collection("apiKeys").get()
  const hashes: string[] = []
  for (let offset = 0; offset < apiKeys.docs.length; offset += 400) {
    const batch = getLocalDatabase().batch()
    let operations = 0
    for (const apiKey of apiKeys.docs.slice(offset, offset + 400)) {
      const value = apiKey.data()?.key
      if (typeof value !== "string") continue
      const hash = apiKeyValueHash(value)
      hashes.push(hash)
      batch.delete(apiKeyIndexesRef().doc(hash))
      operations += 1
    }
    if (operations > 0) await batch.commit()
  }
  await getLocalDatabase().recursiveDelete(workspaceRootRef(workspaceId), { preserveRoot: true })
  await routingRevisionRef(workspaceId).delete()
  workspaceCacheStates.delete(workspaceId)
  return () => invalidateApiKeyLookupCache(hashes)
}
