import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { type DocumentData, type DocumentSnapshot, type Firestore, FieldValue, getFirestore, type Transaction } from "firebase-admin/firestore"

import { cleanAliasId, gatewayModelId, cleanId } from "@/lib/http"
import { decryptCredentialSecret, encryptCredentialSecret } from "@/lib/credential-secrets"
import type { ApiKey, AppData, Model, ModelAlias, Provider, ProviderApiKey, WorkspaceStorageMode } from "@/lib/types"
import { currentWorkspaceId, DEFAULT_WORKSPACE_ID, runInWorkspace, usesLegacyWorkspaceStorage, workspaceContext } from "@/lib/workspace-context"

const configuredCacheTtlMs = Number(process.env.ROUTING_CACHE_TTL_MS || 30_000)
const cacheTtlMs = Number.isFinite(configuredCacheTtlMs) && configuredCacheTtlMs >= 0 ? configuredCacheTtlMs : 30_000
const configuredApiKeyCacheTtlMs = Number(process.env.API_KEY_CACHE_TTL_MS || 15_000)
const apiKeyCacheTtlMs = Number.isFinite(configuredApiKeyCacheTtlMs) && configuredApiKeyCacheTtlMs >= 0 ? configuredApiKeyCacheTtlMs : 15_000
const configuredApiKeyNegativeCacheTtlMs = Number(process.env.API_KEY_NEGATIVE_CACHE_TTL_MS || 2_000)
const apiKeyNegativeCacheTtlMs = Number.isFinite(configuredApiKeyNegativeCacheTtlMs) && configuredApiKeyNegativeCacheTtlMs >= 0 ? configuredApiKeyNegativeCacheTtlMs : 2_000
const apiKeyIndexReconciliationTtlMs = 30_000
const configuredFirestoreReadConcurrency = Number(process.env.FIRESTORE_CHILD_READ_CONCURRENCY || 16)
const firestoreChildReadConcurrency = Number.isSafeInteger(configuredFirestoreReadConcurrency) && configuredFirestoreReadConcurrency > 0 ? configuredFirestoreReadConcurrency : 16
const configuredMaximumWorkspaceCacheEntries = Number(process.env.MAX_WORKSPACE_CACHE_ENTRIES || 256)
const maximumWorkspaceCacheEntries = Number.isSafeInteger(configuredMaximumWorkspaceCacheEntries) && configuredMaximumWorkspaceCacheEntries > 0 ? configuredMaximumWorkspaceCacheEntries : 256
const configuredMaximumProviderCacheEntries = Number(process.env.MAX_PROVIDER_SCOPED_CACHE_ENTRIES || 256)
const maximumProviderScopedCacheEntries = Number.isSafeInteger(configuredMaximumProviderCacheEntries) && configuredMaximumProviderCacheEntries > 0 ? configuredMaximumProviderCacheEntries : 256
let metaCache: { data: Meta; expiresAt: number } | undefined
let metaReadPromise: Promise<Meta> | undefined

interface ReadCache<T> {
  value?: T
  expiresAt: number
  inflight?: Promise<T>
}

interface WorkspaceCacheState {
  compatibilityCache?: CompatibilityCache
  compatibilityReadPromise?: Promise<AppData>
  routingDataCache?: DataCache<RoutingData>
  routingDataReadPromise?: Promise<RoutingData>
  catalogDataCache?: DataCache<CatalogData>
  catalogDataReadPromise?: Promise<CatalogData>
  providersCache: ReadCache<Provider[]>
  providerApiKeysCache: Map<string, ReadCache<ProviderApiKey[]>>
  allProviderApiKeysCache: ReadCache<ProviderApiKey[]>
  providerModelsCache: Map<string, ReadCache<Model[]>>
  modelsCache: ReadCache<Model[]>
  aliasesCache: ReadCache<ModelAlias[]>
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
    apiKeysCache: { expiresAt: 0 },
    generation: 0,
  }
  workspaceCacheStates.set(key, state)
  return state
}

interface IndexedApiKey { workspaceId: string; workspaceStorageMode: WorkspaceStorageMode; apiKey: ApiKey }

interface ApiKeyIndexCandidate {
  workspaceId: string
  workspaceStorageMode: WorkspaceStorageMode
  apiKeyId: string
  name: string
  createdAt: string
}

const apiKeyLookupCache = new Map<string, { value: IndexedApiKey | null; expiresAt: number }>()
const apiKeyLookupInflight = new Map<string, Promise<IndexedApiKey | undefined>>()
let apiKeyIndexReconciliationCache: { entries: Map<string, ApiKeyIndexCandidate | null>; expiresAt: number } | undefined
let apiKeyIndexReconciliationInflight: Promise<Map<string, ApiKeyIndexCandidate | null>> | undefined
let apiKeyIndexReconciliationGeneration = 0
const maximumApiKeyLookupEntries = 512
let apiKeyLookupGeneration = 0
let metaGeneration = 0

const documentedAdminPassword = "change-me-now"
const documentedProxyKey = "sk-local-change-me"

export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => stripUndefined(item)) as T
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, stripUndefined(item)])) as T
  }
  return value
}

export function assertProductionBootstrap(environment: Record<string, string | undefined>) {
  const adminPassword = environment.DEFAULT_ADMIN_PASSWORD
  const proxyKey = environment.DEFAULT_PROXY_API_KEY
  const sessionSecret = environment.SESSION_SECRET
  if (!adminPassword || adminPassword === documentedAdminPassword) {
    throw new Error("DEFAULT_ADMIN_PASSWORD must be set to a non-default value before production initialization.")
  }
  if (!proxyKey || proxyKey === documentedProxyKey) {
    throw new Error("DEFAULT_PROXY_API_KEY must be set to a non-default value before production initialization.")
  }
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters before production initialization.")
  }
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
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

export function verifyPassword(password: string, stored: string) {
  const [salt, expectedHex] = stored.split(":")
  if (!salt || !expectedHex) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function validatePasswordUpdate(currentPassword: string, newPassword: string, confirmPassword: string, storedHash: string) {
  if (!verifyPassword(currentPassword, storedHash)) throw new Error("Current password is incorrect.")
  if (newPassword.length < 10) throw new Error("New password must be at least 10 characters.")
  if (newPassword !== confirmPassword) throw new Error("New passwords do not match.")
  if (currentPassword === newPassword) throw new Error("New password must be different from the current password.")
}

export interface Meta {
  version: 4
  admin: { username: string; passwordHash: string; mustChangePassword: boolean }
  sessionSecret: string
}

function initialMeta(): Meta {
  if (process.env.NODE_ENV === "production") assertProductionBootstrap(process.env)
  return {
    version: 4,
    admin: {
      username: process.env.DEFAULT_ADMIN_USERNAME || "admin",
      passwordHash: hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || documentedAdminPassword),
      mustChangePassword: true,
    },
    sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  }
}

function initialGatewayApiKey(): ApiKey {
  return {
    id: crypto.randomUUID(),
    name: "Default local key",
    key: process.env.DEFAULT_PROXY_API_KEY || documentedProxyKey,
    createdAt: new Date().toISOString(),
  }
}

type LegacyProvider = Omit<Provider, "apiKeyCount" | "enabledApiKeyCount" | "modelCount" | "enabledModelCount"> &
  Partial<Pick<Provider, "apiKeyCount" | "enabledApiKeyCount" | "modelCount" | "enabledModelCount">> &
  { secret?: string }
type LegacyModel = Omit<Model, "gatewayModelId"> & { gatewayModelId?: string }
type LegacyAppData = Omit<AppData, "version" | "providers" | "providerApiKeys" | "models" | "aliases"> & {
  version?: 1 | 2
  providers?: LegacyProvider[]
  providerApiKeys?: AppData["providerApiKeys"]
  models?: LegacyModel[]
  aliases?: ModelAlias[]
}

function migrateLegacy(legacy: LegacyAppData): { meta: Meta; providers: Map<string, Provider>; providerApiKeys: Map<string, Map<string, ProviderApiKey>>; models: Map<string, Map<string, Model>>; apiKeys: Map<string, ApiKey> } {
  const migratedProviderApiKeys: ProviderApiKey[] = []
  const existingProviderKeyIds = new Set((legacy.providerApiKeys || []).map((apiKey) => apiKey.providerId))
  const providers: Provider[] = []
  for (const entry of legacy.providers || []) {
    const { secret, ...provider } = entry
    const normalizedProvider: Provider = {
      ...provider,
      apiKeyCount: provider.apiKeyCount ?? 0,
      enabledApiKeyCount: provider.enabledApiKeyCount ?? 0,
      modelCount: provider.modelCount ?? 0,
      enabledModelCount: provider.enabledModelCount ?? 0,
    }
    providers.push(normalizedProvider)
    if (secret && !existingProviderKeyIds.has(provider.id)) {
      migratedProviderApiKeys.push({
        id: crypto.randomUUID(),
        providerId: provider.id,
        name: "Migrated provider key",
        key: secret,
        enabled: true,
        createdAt: provider.createdAt || new Date().toISOString(),
      })
    }
  }
  const meta: Meta = {
    version: 4,
    admin: legacy.admin,
    sessionSecret: legacy.sessionSecret,
  }
  const providerMap = new Map<string, Provider>()
  const providerKeyMap = new Map<string, Map<string, ProviderApiKey>>()
  for (const provider of providers) providerMap.set(provider.id, { ...provider, apiKeyCount: 0, enabledApiKeyCount: 0, modelCount: 0, enabledModelCount: 0 })
  for (const apiKey of [...(legacy.providerApiKeys || []), ...migratedProviderApiKeys]) {
    const slot = providerKeyMap.get(apiKey.providerId) || new Map<string, ProviderApiKey>()
    slot.set(apiKey.id, apiKey)
    providerKeyMap.set(apiKey.providerId, slot)
    const provider = providerMap.get(apiKey.providerId)
    if (provider) {
      providerMap.set(provider.id, {
        ...provider,
        apiKeyCount: (provider.apiKeyCount || 0) + 1,
        enabledApiKeyCount: (provider.enabledApiKeyCount || 0) + (apiKey.enabled ? 1 : 0),
      })
    }
  }
  const modelMap = new Map<string, Map<string, Model>>()
  for (const model of legacy.models || []) {
    const normalizedModel: Model = { ...model, gatewayModelId: model.gatewayModelId || model.id }
    const slot = modelMap.get(model.providerId) || new Map<string, Model>()
    slot.set(model.id, normalizedModel)
    modelMap.set(model.providerId, slot)
    const provider = providerMap.get(model.providerId)
    if (provider) {
      providerMap.set(provider.id, {
        ...provider,
        modelCount: (provider.modelCount || 0) + 1,
        enabledModelCount: (provider.enabledModelCount || 0) + (normalizedModel.enabled ? 1 : 0),
      })
    }
  }
  const apiKeys = new Map<string, ApiKey>()
  for (const apiKey of legacy.apiKeys || []) apiKeys.set(apiKey.id, apiKey)
  return { meta, providers: providerMap, providerApiKeys: providerKeyMap, models: modelMap, apiKeys }
}

// Keep the old pure migration helper available to tests and small integrations.
export function migrateData(legacy: LegacyAppData): AppData {
  const migrated = migrateLegacy(legacy)
  const providerIds = new Map<string, string>()
  for (const provider of migrated.providers.values()) providerIds.set(provider.id, crypto.randomUUID())
  return {
    version: 4,
    admin: migrated.meta.admin,
    sessionSecret: migrated.meta.sessionSecret,
    providers: [...migrated.providers.values()].map((provider) => ({ ...provider, id: providerIds.get(provider.id)! })),
    providerApiKeys: [...migrated.providerApiKeys.entries()].flatMap(([providerId, slot]) => [...slot.values()].map((apiKey) => ({
      ...apiKey,
      id: crypto.randomUUID(),
      providerId: providerIds.get(providerId) || providerId,
    }))),
    models: [...migrated.models.entries()].flatMap(([providerId, slot]) => [...slot.values()].map((model) => ({
      ...model,
      id: crypto.randomUUID(),
      providerId: providerIds.get(providerId) || providerId,
      gatewayModelId: model.gatewayModelId || model.id,
    }))),
    aliases: legacy.aliases || [],
    apiKeys: [...migrated.apiKeys.values()].map((apiKey) => ({ ...apiKey, id: crypto.randomUUID() })),
  }
}

function providerDoc(provider: Provider, meta: { apiKeyCount: number; enabledApiKeyCount: number; modelCount: number; enabledModelCount: number }) {
  const { id, ...stored } = provider
  void id
  return { ...stored, ...meta }
}

function providerFromSnapshot(snapshot: DocumentSnapshot): Provider {
  return { ...snapshot.data(), id: snapshot.id } as Provider
}

function providerApiKeyFromSnapshot(snapshot: DocumentSnapshot, providerId: string): ProviderApiKey {
  const value = { ...snapshot.data(), id: snapshot.id, providerId } as ProviderApiKey
  if (value.credentialKind === "codex-oauth") {
    value.key = decryptCredentialSecret(value.key) || ""
    value.refreshToken = decryptCredentialSecret(value.refreshToken)
    value.idToken = decryptCredentialSecret(value.idToken)
  }
  return value
}

function modelFromSnapshot(snapshot: DocumentSnapshot, providerId: string): Model {
  const data = snapshot.data() as Omit<Model, "id" | "providerId"> & { gatewayModelId?: string }
  return { ...data, id: snapshot.id, providerId, gatewayModelId: data.gatewayModelId || snapshot.id } as Model
}

function apiKeyFromSnapshot(snapshot: DocumentSnapshot): ApiKey {
  return { ...snapshot.data(), id: snapshot.id } as ApiKey
}

function aliasFromSnapshot(snapshot: DocumentSnapshot): ModelAlias {
  return { ...snapshot.data(), id: snapshot.id } as ModelAlias
}

function storedProvider(provider: Provider) {
  const { id, ...data } = provider
  void id
  return stripUndefined(data)
}

function storedProviderApiKey(apiKey: ProviderApiKey) {
  const { id, providerId, ...data } = apiKey
  void id
  void providerId
  if (apiKey.credentialKind === "codex-oauth") {
    data.key = encryptCredentialSecret(apiKey.key) || ""
    data.refreshToken = encryptCredentialSecret(apiKey.refreshToken)
    data.idToken = encryptCredentialSecret(apiKey.idToken)
  }
  return stripUndefined(data)
}

function storedModel(model: Model) {
  const { id, providerId, gatewayModelId, ...data } = model
  void id
  void providerId
  return stripUndefined({ ...data, gatewayModelId: gatewayModelId || model.id })
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

function apiKeyIndexCandidate(workspaceId: string, workspaceStorageMode: WorkspaceStorageMode, apiKey: ApiKey): ApiKeyIndexCandidate {
  return {
    workspaceId,
    workspaceStorageMode,
    apiKeyId: apiKey.id,
    name: apiKey.name,
    createdAt: apiKey.createdAt,
  }
}

function indexedWorkspaceStorageMode(workspaceId: string, value: unknown): WorkspaceStorageMode {
  if (value === "legacy" || value === "dual" || value === "scoped-mirror" || value === "scoped") return value
  return workspaceId === DEFAULT_WORKSPACE_ID ? "legacy" : "scoped"
}

function storedAlias(alias: ModelAlias) {
  const { id, ...data } = alias
  void id
  return stripUndefined(data)
}

export function isMemoryBackend() {
  return process.env.STORAGE_BACKEND === "memory" || process.env.NODE_ENV === "test"
}

type RoutingData = Pick<AppData, "sessionSecret" | "providers" | "providerApiKeys" | "models" | "aliases">
type CatalogData = Pick<AppData, "providers" | "models" | "aliases">
interface DataCache<T> { data: T; expiresAt: number }
type CompatibilityCache = DataCache<AppData>

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

async function parallelMap<T, R>(items: readonly T[], mapper: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length <= firestoreChildReadConcurrency) return Promise.all(items.map(mapper))
  const output = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: firestoreChildReadConcurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      output[index] = await mapper(items[index])
    }
  }))
  return output
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

function invalidateApiKeyLookupCache(hashes?: Iterable<string>) {
  // Advance the generation so an already-running lookup cannot repopulate a
  // value that was changed while its Firestore read was in flight.
  apiKeyLookupGeneration += 1
  apiKeyIndexReconciliationGeneration += 1
  apiKeyIndexReconciliationCache = undefined
  apiKeyIndexReconciliationInflight = undefined
  if (hashes) {
    for (const hash of hashes) {
      apiKeyLookupCache.delete(hash)
      apiKeyLookupInflight.delete(hash)
    }
    return
  }
  apiKeyLookupCache.clear()
  apiKeyLookupInflight.clear()
}

function invalidateCompatibilityCache() {
  const state = workspaceCacheState()
  state.generation += 1
  state.compatibilityCache = undefined
  state.compatibilityReadPromise = undefined
  state.routingDataCache = undefined
  state.routingDataReadPromise = undefined
  state.catalogDataCache = undefined
  state.catalogDataReadPromise = undefined
  clearReadCache(state.providersCache)
  clearReadCache(state.allProviderApiKeysCache)
  clearReadCache(state.modelsCache)
  clearReadCache(state.aliasesCache)
  clearReadCache(state.apiKeysCache)
  clearReadCacheMap(state.providerApiKeysCache)
  clearReadCacheMap(state.providerModelsCache)
  state.apiKeyHashIndex = undefined
}

function invalidateGatewayApiKeyCaches(hashes?: Iterable<string>) {
  invalidateCompatibilityCache()
  invalidateApiKeyLookupCache(hashes)
}

function validateProviderApiKeyInput(input: Partial<ProviderApiKey> & { originalId?: string }) {
  if (!input.originalId && (typeof input.name !== "string" || !input.name.trim())) {
    throw new Error("API key name is required.")
  }
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80)) {
    throw new Error("API key name must be between 1 and 80 characters.")
  }
  if (!input.originalId && (typeof input.key !== "string" || !input.key.trim())) {
    throw new Error("API key value is required.")
  }
  if (input.key !== undefined && input.key !== "__unchanged__" && (typeof input.key !== "string" || !input.key.trim())) {
    throw new Error("API key value is required.")
  }
  if (input.key === "__unchanged__" && !input.originalId) throw new Error("API key value is required.")
  if (input.rpmLimit !== undefined && (!Number.isSafeInteger(input.rpmLimit) || input.rpmLimit <= 0)) {
    throw new Error("RPM limit must be a positive whole number.")
  }
  if (input.maxConcurrency !== undefined && (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency <= 0)) {
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
}

// -------------------------------------------------------------------------------------------------
// Memory backend
// -------------------------------------------------------------------------------------------------

interface MemoryState {
  meta: Meta | undefined
  providers: Map<string, Provider>
  providerApiKeys: Map<string, Map<string, ProviderApiKey>>
  models: Map<string, Map<string, Model>>
  aliases: Map<string, ModelAlias>
  apiKeys: Map<string, ApiKey>
  apiKeyIndexes: Map<string, string>
  initialized: boolean
}

interface MemoryRoot { states: Map<string, MemoryState>; meta?: Meta }
declare global { var __rawrouteMemoryStore: MemoryRoot | undefined }
function memoryRoot(): MemoryRoot {
  return globalThis.__rawrouteMemoryStore ||= { states: new Map<string, MemoryState>() }
}

function newMemoryState(): MemoryState {
  return { meta: memoryRoot().meta, providers: new Map(), providerApiKeys: new Map(), models: new Map(), aliases: new Map(), apiKeys: new Map(), apiKeyIndexes: new Map(), initialized: false }
}

function ensureMemorySeeded(workspaceId = currentWorkspaceId()): MemoryState {
  let memory = memoryRoot().states.get(workspaceId)
  if (!memory) {
    memory = newMemoryState()
    memoryRoot().states.set(workspaceId, memory)
  }
  if (!memory.initialized) {
    memoryRoot().meta ||= initialMeta()
    memory.meta = memoryRoot().meta
    if (workspaceId === DEFAULT_WORKSPACE_ID) {
    const seedKey = initialGatewayApiKey()
    memory.apiKeys.set(seedKey.id, seedKey)
    memory.apiKeyIndexes.set(apiKeyValueHash(seedKey.key), seedKey.id)
    }
    memory.initialized = true
  }
  return memory
}

function memorySnapshot(state: MemoryState) {
  return {
    meta: state.meta!,
    providers: new Map(state.providers),
    providerApiKeys: new Map(state.providerApiKeys),
    models: new Map(state.models),
    aliases: new Map(state.aliases),
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
// Firestore backend
// -------------------------------------------------------------------------------------------------

let firestoreInstance: Firestore | undefined

export function getFirestoreInstance(): Firestore {
  if (firestoreInstance) return firestoreInstance
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replaceAll("\\n", "\n")
  const configuredServiceAccount = projectId && clientEmail && privateKey
  const app = getApps().length ? getApp() : initializeApp({
    credential: configuredServiceAccount ? cert({ projectId, clientEmail, privateKey }) : applicationDefault(),
    projectId,
  })
  firestoreInstance = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || "(default)")
  return firestoreInstance
}

export function collectionPrefix() {
  return (process.env.FIRESTORE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
}

function metaRef() {
  return getFirestoreInstance().collection(`${collectionPrefix()}_system`).doc("meta")
}

function legacyMetaRef() {
  return getFirestoreInstance().collection(`${collectionPrefix()}_system`).doc("state")
}

function workspaceRootRef(workspaceId = currentWorkspaceId()) {
  return getFirestoreInstance().collection(`${collectionPrefix()}_workspaces`).doc(workspaceId)
}

function apiKeysRefForWorkspace(workspaceId: string, workspaceStorageMode: WorkspaceStorageMode) {
  return workspaceId === DEFAULT_WORKSPACE_ID && (workspaceStorageMode === "legacy" || workspaceStorageMode === "dual")
    ? getFirestoreInstance().collection(collectionPrefix()).doc("apiKeys").collection("apiKeys")
    : workspaceRootRef(workspaceId).collection("apiKeys")
}

function providersRef() {
  return usesLegacyWorkspaceStorage()
    ? getFirestoreInstance().collection(collectionPrefix()).doc("providers").collection("providers")
    : workspaceRootRef().collection("providers")
}

function providerRef(providerId: string) {
  return providersRef().doc(providerId)
}

function providerApiKeysRef(providerId: string) {
  return providerRef(providerId).collection("apiKeys")
}

function providerApiKeyRef(providerId: string, apiKeyId: string) {
  return providerApiKeysRef(providerId).doc(apiKeyId)
}

function modelsRef(providerId: string) {
  return providerRef(providerId).collection("models")
}

function modelRef(providerId: string, modelId: string) {
  return modelsRef(providerId).doc(modelId)
}

function aliasesRef() {
  return usesLegacyWorkspaceStorage()
    ? getFirestoreInstance().collection(collectionPrefix()).doc("aliases").collection("aliases")
    : workspaceRootRef().collection("aliases")
}

function aliasRef(aliasId: string) {
  return aliasesRef().doc(aliasId)
}

function apiKeysRef() {
  return apiKeysRefForWorkspace(currentWorkspaceId(), workspaceContext().storageMode)
}

function apiKeyRef(apiKeyId: string) {
  return apiKeysRef().doc(apiKeyId)
}

function apiKeyIndexesRef() {
  return getFirestoreInstance().collection(`${collectionPrefix()}_api_key_indexes`)
}

function apiKeyIndexRef(hash: string) {
  return apiKeyIndexesRef().doc(hash)
}

interface FirestoreWorkspaceScope {
  id: string
  storageMode: WorkspaceStorageMode
}

async function firestoreWorkspaceScopes(): Promise<FirestoreWorkspaceScope[]> {
  const snapshot = await getFirestoreInstance().collection(`${collectionPrefix()}_workspaces`).get()
  const scopes = snapshot.docs.map((document) => ({
    id: document.id,
    storageMode: indexedWorkspaceStorageMode(document.id, document.data().storageMode),
  }))
  if (!scopes.some((scope) => scope.id === DEFAULT_WORKSPACE_ID)) scopes.unshift({ id: DEFAULT_WORKSPACE_ID, storageMode: "legacy" })
  return scopes
}

async function firestoreReadApiKeyIndexCandidates(): Promise<Map<string, ApiKeyIndexCandidate | null>> {
  const scopes = await firestoreWorkspaceScopes()
  const snapshots = await parallelMap(scopes, async (scope) => ({
    scope,
    snapshot: await apiKeysRefForWorkspace(scope.id, scope.storageMode).get(),
  }))
  const candidates = new Map<string, ApiKeyIndexCandidate | null>()
  for (const { scope, snapshot } of snapshots) {
    for (const document of snapshot.docs) {
      const apiKey = apiKeyFromSnapshot(document)
      if (typeof apiKey.key !== "string" || typeof apiKey.name !== "string" || typeof apiKey.createdAt !== "string") continue
      const hash = apiKeyValueHash(apiKey.key)
      const candidate = apiKeyIndexCandidate(scope.id, scope.storageMode, apiKey)
      if (candidates.has(hash)) {
        // A duplicate value violates the global uniqueness invariant. Keep it
        // unresolved instead of letting a repair choose an arbitrary tenant.
        candidates.set(hash, null)
      } else {
        candidates.set(hash, candidate)
      }
    }
  }
  return candidates
}

async function reconciledApiKeyIndexCandidates() {
  const now = Date.now()
  if (apiKeyIndexReconciliationCache && apiKeyIndexReconciliationCache.expiresAt > now) return apiKeyIndexReconciliationCache.entries
  if (apiKeyIndexReconciliationInflight) return apiKeyIndexReconciliationInflight

  const generation = apiKeyIndexReconciliationGeneration
  const promise = firestoreReadApiKeyIndexCandidates().then((entries) => {
    if (generation === apiKeyIndexReconciliationGeneration) {
      apiKeyIndexReconciliationCache = { entries, expiresAt: Date.now() + apiKeyIndexReconciliationTtlMs }
    }
    return entries
  }).finally(() => {
    if (apiKeyIndexReconciliationInflight === promise) apiKeyIndexReconciliationInflight = undefined
  })
  apiKeyIndexReconciliationInflight = promise
  return promise
}

function indexedApiKeyFromCandidate(candidate: ApiKeyIndexCandidate, normalized: string): IndexedApiKey {
  return {
    workspaceId: candidate.workspaceId,
    workspaceStorageMode: candidate.workspaceStorageMode,
    apiKey: {
      id: candidate.apiKeyId,
      name: candidate.name,
      key: normalized,
      createdAt: candidate.createdAt,
    },
  }
}

async function repairMissingApiKeyIndex(hash: string, normalized: string, candidate: ApiKeyIndexCandidate): Promise<IndexedApiKey | undefined> {
  const repaired = await getFirestoreInstance().runTransaction(async (transaction) => {
    const indexRef = apiKeyIndexRef(hash)
    const indexSnapshot = await transaction.get(indexRef)
    const existing = indexSnapshot.exists ? indexSnapshot.data() as ApiKeyIndexData : undefined
    if (existing?.apiKeyId && (existing.apiKeyId !== candidate.apiKeyId || (existing.workspaceId && existing.workspaceId !== candidate.workspaceId))) {
      return { kind: "existing" as const, data: existing }
    }

    const keyRef = apiKeysRefForWorkspace(candidate.workspaceId, candidate.workspaceStorageMode).doc(candidate.apiKeyId)
    const keySnapshot = await transaction.get(keyRef)
    if (!keySnapshot.exists) return { kind: "missing" as const }
    const apiKey = apiKeyFromSnapshot(keySnapshot)
    if (typeof apiKey.key !== "string" || apiKeyValueHash(apiKey.key) !== hash) return { kind: "missing" as const }
    const indexDocument = apiKeyIndexDocumentForWorkspace(candidate.workspaceId, candidate.workspaceStorageMode, apiKey)
    if (indexSnapshot.exists) transaction.set(indexRef, indexDocument)
    else transaction.create(indexRef, indexDocument)
    return { kind: "repaired" as const, value: indexedApiKeyFromCandidate(apiKeyIndexCandidate(candidate.workspaceId, candidate.workspaceStorageMode, apiKey), normalized) }
  })

  if (repaired.kind === "repaired") return repaired.value
  if (repaired.kind !== "existing") return undefined
  const existing = repaired.data
  const apiKeyId = existing.apiKeyId
  if (!apiKeyId) return undefined
  const workspaceId = existing.workspaceId || DEFAULT_WORKSPACE_ID
  const workspaceStorageMode = indexedWorkspaceStorageMode(workspaceId, existing.workspaceStorageMode)
  if (typeof existing.name === "string" && typeof existing.createdAt === "string") {
    return { workspaceId, workspaceStorageMode, apiKey: { id: apiKeyId, name: existing.name, key: normalized, createdAt: existing.createdAt } }
  }
  const snapshot = await apiKeysRefForWorkspace(workspaceId, workspaceStorageMode).doc(apiKeyId).get()
  if (!snapshot.exists) return undefined
  const apiKey = apiKeyFromSnapshot(snapshot)
  return typeof apiKey.key === "string" && apiKeyValueHash(apiKey.key) === hash
    ? { workspaceId, workspaceStorageMode, apiKey: { ...apiKey, key: normalized } }
    : undefined
}

// -------------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------------

async function readSharedMeta(): Promise<Meta> {
  if (isMemoryBackend()) return ensureMemorySeeded().meta!
  if (metaCache && metaCache.expiresAt > Date.now()) return metaCache.data
  if (!metaReadPromise) {
    const generation = metaGeneration
    const promise = firestoreReadMeta().then((meta) => {
      const data = structuredClone(meta)
      if (generation === metaGeneration) metaCache = { data, expiresAt: Date.now() + cacheTtlMs }
      return data
    }).finally(() => {
      if (metaReadPromise === promise) metaReadPromise = undefined
    })
    metaReadPromise = promise
  }
  return metaReadPromise
}

export async function readMeta(): Promise<Meta> {
  return structuredClone(await readSharedMeta())
}

/** Read-only session signing secret for hot authentication paths. */
export async function readSessionSecret(): Promise<string> {
  return (await readSharedMeta()).sessionSecret
}

export async function writeMeta(meta: Meta): Promise<void> {
  if (isMemoryBackend()) {
    memoryRoot().meta = meta
    for (const state of memoryRoot().states.values()) state.meta = meta
    metaGeneration += 1
    metaReadPromise = undefined
    metaCache = { data: structuredClone(meta), expiresAt: Date.now() + cacheTtlMs }
    invalidateCompatibilityCache()
    return
  }
  await metaRef().set(stripUndefined(meta))
  metaGeneration += 1
  metaReadPromise = undefined
  metaCache = { data: structuredClone(meta), expiresAt: Date.now() + cacheTtlMs }
  invalidateCompatibilityCache()
}

export async function updateMeta(mutator: (meta: Meta) => void | Promise<void>): Promise<Meta> {
  if (isMemoryBackend()) {
    ensureMemorySeeded()
    await mutator(memoryRoot().meta!)
    for (const state of memoryRoot().states.values()) state.meta = memoryRoot().meta
    metaGeneration += 1
    metaReadPromise = undefined
    metaCache = { data: structuredClone(memoryRoot().meta!), expiresAt: Date.now() + cacheTtlMs }
    invalidateCompatibilityCache()
    return memoryRoot().meta!
  }
  const meta = await firestoreUpdateMeta(mutator)
  metaGeneration += 1
  metaReadPromise = undefined
  metaCache = { data: structuredClone(meta), expiresAt: Date.now() + cacheTtlMs }
  invalidateCompatibilityCache()
  return meta
}

export async function listProviders(): Promise<Provider[]> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    return [...state.providers.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  return cachedRead(workspaceCacheState().providersCache, firestoreListProviders)
}

export async function getProvider(providerId: string): Promise<Provider | undefined> {
  if (isMemoryBackend()) {
    return ensureMemorySeeded().providers.get(providerId)
  }
  const cache = workspaceCacheState().providersCache
  if (cache.value && cache.expiresAt > Date.now()) {
    return cache.value.find((provider) => provider.id === providerId)
  }
  return firestoreGetProvider(providerId)
}

export async function upsertProvider(input: Partial<Provider> & { originalId?: string }, expected?: Provider): Promise<Provider> {
  const provider = isMemoryBackend() ? memoryUpsertProvider(input, expected) : await firestoreUpsertProvider(input, expected)
  invalidateCompatibilityCache()
  return provider
}

export async function deleteProvider(providerId: string): Promise<void> {
  if (isMemoryBackend()) memoryDeleteProvider(providerId)
  else await firestoreDeleteProvider(providerId)
  invalidateCompatibilityCache()
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
  return cachedRead(providerScopedCache(state.providerApiKeysCache, providerId), () => firestoreListProviderApiKeys(providerId))
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
  } else {
    await firestoreReorderProviderApiKeys(providerId, orderedIds)
  }
  invalidateCompatibilityCache()
}

export async function listAllProviderApiKeys(): Promise<ProviderApiKey[]> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const out: ProviderApiKey[] = []
    for (const slot of state.providerApiKeys.values()) out.push(...slot.values())
    return out
  }
  return cachedRead(workspaceCacheState().allProviderApiKeysCache, firestoreListAllProviderApiKeys)
}

export async function upsertProviderApiKey(providerId: string, input: Partial<ProviderApiKey> & { originalId?: string }): Promise<ProviderApiKey> {
  validateProviderApiKeyInput(input)
  const apiKey = isMemoryBackend() ? memoryUpsertProviderApiKey(providerId, input) : await firestoreUpsertProviderApiKey(providerId, input)
  invalidateCompatibilityCache()
  return apiKey
}

export async function deleteProviderApiKey(providerId: string, apiKeyId: string): Promise<void> {
  if (isMemoryBackend()) memoryDeleteProviderApiKey(providerId, apiKeyId)
  else await firestoreDeleteProviderApiKey(providerId, apiKeyId)
  invalidateCompatibilityCache()
}

export async function listModels(): Promise<Model[]> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const out: Model[] = []
    for (const slot of state.models.values()) out.push(...slot.values())
    return out
  }
  return cachedRead(workspaceCacheState().modelsCache, firestoreListModels)
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
  return cachedRead(providerScopedCache(state.providerModelsCache, providerId), () => firestoreListProviderModels(providerId))
}

export async function upsertModel(providerId: string, input: Partial<Model> & { originalId?: string }): Promise<Model> {
  const model = isMemoryBackend() ? memoryUpsertModel(providerId, input) : await firestoreUpsertModel(providerId, input)
  invalidateCompatibilityCache()
  return model
}

export async function deleteModel(providerId: string, modelId: string): Promise<void> {
  if (isMemoryBackend()) memoryDeleteModel(providerId, modelId)
  else await firestoreDeleteModel(providerId, modelId)
  invalidateCompatibilityCache()
}

export async function listAliases(): Promise<ModelAlias[]> {
  if (isMemoryBackend()) {
    return [...ensureMemorySeeded().aliases.values()].sort(compareAliases)
  }
  return cachedRead(workspaceCacheState().aliasesCache, firestoreListAliases)
}

function compareAliases(left: ModelAlias, right: ModelAlias) {
  return left.alias.localeCompare(right.alias, undefined, { sensitivity: "base", numeric: true })
}

export async function upsertAlias(input: Partial<ModelAlias> & { originalId?: string }): Promise<ModelAlias> {
  validateAliasInput(input)
  const alias = isMemoryBackend() ? memoryUpsertAlias(input) : await firestoreUpsertAlias(input)
  invalidateCompatibilityCache()
  return alias
}

export async function deleteAlias(aliasId: string): Promise<void> {
  if (isMemoryBackend()) memoryDeleteAlias(aliasId)
  else await firestoreDeleteAlias(aliasId)
  invalidateCompatibilityCache()
}

export async function listApiKeys(): Promise<ApiKey[]> {
  if (isMemoryBackend()) {
    return [...ensureMemorySeeded().apiKeys.values()]
  }
  const state = workspaceCacheState()
  const apiKeys = await cachedRead(state.apiKeysCache, firestoreListApiKeys)
  if (!state.apiKeyHashIndex && state.apiKeysCache.value === apiKeys && state.apiKeysCache.expiresAt > Date.now()) {
    state.apiKeyHashIndex = new Map(apiKeys.map((apiKey) => [apiKeyValueHash(apiKey.key), apiKey]))
  }
  return apiKeys
}

export async function createApiKey(name: string, customKey?: string): Promise<ApiKey> {
  const apiKey = isMemoryBackend() ? memoryCreateApiKey(name, customKey) : await firestoreCreateApiKey(name, customKey)
  invalidateGatewayApiKeyCaches([apiKeyValueHash(apiKey.key)])
  return apiKey
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
    invalidateGatewayApiKeyCaches([apiKeyValueHash(updated.key)])
    return updated
  }
  const firestore = getFirestoreInstance()
  const updated = await firestore.runTransaction(async (transaction) => {
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

export async function _setApiKey(apiKey: ApiKey): Promise<void> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const previous = state.apiKeys.get(apiKey.id)
    const normalized = normalizeApiKeyValue(apiKey.key)
    const hash = apiKeyValueHash(normalized)
    const owner = memoryApiKeyOwner(hash)
    if (owner && (owner.workspaceId !== currentWorkspaceId() || owner.apiKeyId !== apiKey.id)) throw new ApiKeyConflictError()
    const previousHash = previous ? apiKeyValueHash(previous.key) : undefined
    if (previousHash && previousHash !== hash) state.apiKeyIndexes.delete(previousHash)
    state.apiKeys.set(apiKey.id, { ...apiKey, key: normalized })
    state.apiKeyIndexes.set(hash, apiKey.id)
    invalidateGatewayApiKeyCaches(previousHash && previousHash !== hash ? [previousHash, hash] : [hash])
    return
  }
  const firestore = getFirestoreInstance()
  const hashes = await firestore.runTransaction(async (transaction) => {
    const ref = apiKeyRef(apiKey.id)
    const previousSnapshot = await transaction.get(ref)
    const normalized = normalizeApiKeyValue(apiKey.key)
    const hash = apiKeyValueHash(normalized)
    const indexRef = apiKeyIndexRef(hash)
    const indexSnapshot = await transaction.get(indexRef)
    const owner = indexSnapshot.data() as ApiKeyIndexData | undefined
    if (indexSnapshot.exists && (owner?.workspaceId || DEFAULT_WORKSPACE_ID) !== currentWorkspaceId()) throw new ApiKeyConflictError()
    if (indexSnapshot.exists && owner?.apiKeyId !== apiKey.id) throw new ApiKeyConflictError()
    const next = { ...apiKey, key: normalized }
    let previousHash: string | undefined
    if (previousSnapshot.exists) {
      const previous = apiKeyFromSnapshot(previousSnapshot)
      const previousHashValue = apiKeyValueHash(previous.key)
      previousHash = previousHashValue
      if (previousHashValue !== hash) transaction.delete(apiKeyIndexRef(previousHashValue))
    }
    transaction.set(ref, storedApiKey(next))
    transaction.set(indexRef, apiKeyIndexDocument(next))
    return previousHash && previousHash !== hash ? [previousHash, hash] : [hash]
  })
  invalidateGatewayApiKeyCaches(hashes)
}

export async function deleteApiKey(apiKeyId: string): Promise<void> {
  const hash = isMemoryBackend() ? memoryDeleteApiKey(apiKeyId) : await firestoreDeleteApiKey(apiKeyId)
  invalidateGatewayApiKeyCaches(hash ? [hash] : [])
}

async function deleteApiKeyForSync(apiKeyId: string): Promise<void> {
  const hash = isMemoryBackend() ? memoryDeleteApiKey(apiKeyId, false) : await firestoreDeleteApiKeyWithInvariant(apiKeyId, false)
  invalidateGatewayApiKeyCaches(hash ? [hash] : [])
}

// -------------------------------------------------------------------------------------------------
// Compatibility shim (preserved for proxy/auth/catalog)
// -------------------------------------------------------------------------------------------------

async function readSharedCatalogData(): Promise<CatalogData> {
  const state = workspaceCacheState()
  if (state.catalogDataCache && state.catalogDataCache.expiresAt > Date.now()) return state.catalogDataCache.data
  if (!state.catalogDataReadPromise) {
    const generation = state.generation
    const promise = Promise.all([listProviders(), listModels(), listAliases()]).then(([providers, models, aliases]) => {
      const data: CatalogData = { providers, models, aliases }
      if (generation === state.generation) state.catalogDataCache = { data, expiresAt: Date.now() + cacheTtlMs }
      return data
    }).finally(() => {
      if (state.catalogDataReadPromise === promise) state.catalogDataReadPromise = undefined
    })
    state.catalogDataReadPromise = promise
  }
  return state.catalogDataReadPromise
}

async function readSharedRoutingData(): Promise<RoutingData> {
  const state = workspaceCacheState()
  if (state.routingDataCache && state.routingDataCache.expiresAt > Date.now()) return state.routingDataCache.data
  if (!state.routingDataReadPromise) {
    const generation = state.generation
    const promise = Promise.all([readSharedCatalogData(), listAllProviderApiKeys(), readSharedMeta()]).then(([catalog, providerApiKeys, meta]) => {
      const data: RoutingData = { ...catalog, providerApiKeys, sessionSecret: meta.sessionSecret }
      if (generation === state.generation) state.routingDataCache = { data, expiresAt: Date.now() + cacheTtlMs }
      return data
    }).finally(() => {
      if (state.routingDataReadPromise === promise) state.routingDataReadPromise = undefined
    })
    state.routingDataReadPromise = promise
  }
  return state.routingDataReadPromise
}

async function readSharedData(): Promise<AppData> {
  const state = workspaceCacheState()
  if (state.compatibilityCache && state.compatibilityCache.expiresAt > Date.now()) return state.compatibilityCache.data
  if (!state.compatibilityReadPromise) {
    const generation = state.generation
    const promise = Promise.all([readSharedRoutingData(), listApiKeys(), readSharedMeta()]).then(([routing, apiKeys, meta]) => {
      const data: AppData = { version: 4, admin: meta.admin, ...routing, apiKeys }
      if (generation === state.generation) state.compatibilityCache = { data, expiresAt: Date.now() + cacheTtlMs }
      return data
    }).finally(() => {
      if (state.compatibilityReadPromise === promise) state.compatibilityReadPromise = undefined
    })
    state.compatibilityReadPromise = promise
  }
  return state.compatibilityReadPromise
}

/** Read-only catalog snapshot. Do not mutate it. */
export async function readCatalogData(): Promise<CatalogData> {
  return readSharedCatalogData()
}

/** Read-only routing snapshot for latency-sensitive server paths. Do not mutate it. */
export async function readRoutingData(): Promise<RoutingData> {
  return readSharedRoutingData()
}

export async function readData(): Promise<AppData> {
  return structuredClone(await readSharedData())
}

export async function findIndexedApiKeyByValue(value: string): Promise<IndexedApiKey | undefined> {
  const normalized = normalizeApiKeyValue(value)
  if (!normalized) return undefined
  if (isMemoryBackend()) {
    const found = memoryFindApiKeyByHash(apiKeyValueHash(normalized))
    return found
      ? { workspaceId: found.workspaceId, workspaceStorageMode: indexedWorkspaceStorageMode(found.workspaceId, undefined), apiKey: { ...found.apiKey, key: normalized } }
      : undefined
  }
  const hash = apiKeyValueHash(normalized)
  const cached = apiKeyLookupCache.get(hash)
  if (cached && cached.expiresAt > Date.now()) return cached.value || undefined

  const existing = apiKeyLookupInflight.get(hash)
  if (existing) return existing
  const generation = apiKeyLookupGeneration
  const promise = (async () => {
    const index = await apiKeyIndexRef(hash).get()
    const indexData = index.exists ? index.data() as ApiKeyIndexData : undefined
    const apiKeyId = indexData?.apiKeyId
    if (!apiKeyId) {
      const candidates = await reconciledApiKeyIndexCandidates()
      const candidate = candidates.get(hash)
      const value = candidate ? await repairMissingApiKeyIndex(hash, normalized, candidate) : undefined
      if (generation === apiKeyLookupGeneration) cacheApiKeyLookup(hash, value)
      return value
    }
    const workspaceId = indexData.workspaceId || DEFAULT_WORKSPACE_ID
    const workspaceStorageMode = indexedWorkspaceStorageMode(workspaceId, indexData.workspaceStorageMode)
    if (typeof indexData.name === "string" && typeof indexData.createdAt === "string") {
      const value = { workspaceId, workspaceStorageMode, apiKey: { id: apiKeyId, name: indexData.name, key: normalized, createdAt: indexData.createdAt } }
      if (generation === apiKeyLookupGeneration) cacheApiKeyLookup(hash, value)
      return value
    }

    // Older index rows did not contain all authentication metadata. Pay the
    // second document read once, then self-heal the index for subsequent hits.
    const snapshot = await apiKeysRefForWorkspace(workspaceId, workspaceStorageMode).doc(apiKeyId).get()
    const apiKey = snapshot.exists ? apiKeyFromSnapshot(snapshot) : undefined
    const value = apiKey && typeof apiKey.key === "string" && apiKeyValueHash(apiKey.key) === hash
      ? { workspaceId, workspaceStorageMode, apiKey: { ...apiKey, key: normalized } }
      : undefined
    if (generation === apiKeyLookupGeneration) cacheApiKeyLookup(hash, value)
    if (value && generation === apiKeyLookupGeneration) {
      void runInWorkspace({ id: workspaceId, storageMode: workspaceStorageMode }, () => apiKeyIndexRef(hash).set(apiKeyIndexDocument(value.apiKey), { merge: true })).catch(() => undefined)
    } else if (!value && generation === apiKeyLookupGeneration) {
      void apiKeyIndexRef(hash).delete().catch(() => undefined)
    }
    return value
  })().finally(() => {
    if (apiKeyLookupInflight.get(hash) === promise) apiKeyLookupInflight.delete(hash)
  })
  apiKeyLookupInflight.set(hash, promise)
  return promise
}

export async function findApiKeyByValue(value: string): Promise<ApiKey | undefined> {
  return (await findIndexedApiKeyByValue(value))?.apiKey
}

export async function writeData(data: AppData) {
  void data
  throw new Error("writeData is no longer supported; use the collection-scoped helpers in src/lib/store.ts.")
}

export async function updateData(mutator: (data: AppData) => void | Promise<void>) {
  const before = await readData()
  const data = structuredClone(before)
  await mutator(data)
  await updateMeta((meta) => {
    meta.admin = data.admin
    meta.sessionSecret = data.sessionSecret
  })
  // Sync providers
  const beforeProviderIds = new Set(before.providers.map((p) => p.id))
  const afterProviderIds = new Set(data.providers.map((p) => p.id))
  for (const id of beforeProviderIds) if (!afterProviderIds.has(id)) await deleteProvider(id)
  const providerIdMap = new Map<string, string>()
  for (const provider of data.providers) {
    const originalId = beforeProviderIds.has(provider.id) ? provider.id : undefined
    const saved = await upsertProvider({ ...provider, ...(originalId ? { originalId } : {}) }, provider)
    providerIdMap.set(provider.id, saved.id)
  }
  // Sync provider api keys (scoped per provider)
  const beforeKeysByProvider = new Map<string, Set<string>>()
  for (const apiKey of before.providerApiKeys) {
    const slot = beforeKeysByProvider.get(apiKey.providerId) || new Set<string>()
    slot.add(apiKey.id)
    beforeKeysByProvider.set(apiKey.providerId, slot)
  }
  const afterKeysByProvider = new Map<string, Set<string>>()
  for (const apiKey of data.providerApiKeys) {
    const slot = afterKeysByProvider.get(apiKey.providerId) || new Set<string>()
    slot.add(apiKey.id)
    afterKeysByProvider.set(apiKey.providerId, slot)
  }
  const allProviderIds = new Set([...beforeKeysByProvider.keys(), ...afterKeysByProvider.keys()])
  for (const providerId of allProviderIds) {
    const beforeIds = beforeKeysByProvider.get(providerId) || new Set<string>()
    const afterIds = afterKeysByProvider.get(providerId) || new Set<string>()
    for (const id of beforeIds) if (!afterIds.has(id)) await deleteProviderApiKey(providerId, id)
  }
  for (const apiKey of data.providerApiKeys) {
    const providerId = providerIdMap.get(apiKey.providerId) || apiKey.providerId
    const originalId = before.providerApiKeys.some((entry) => entry.id === apiKey.id && entry.providerId === apiKey.providerId) ? apiKey.id : undefined
    await upsertProviderApiKey(providerId, { ...apiKey, providerId, ...(originalId ? { originalId } : {}) })
  }
  // Sync models (scoped per provider)
  const beforeModelsByProvider = new Map<string, Set<string>>()
  for (const model of before.models) {
    const slot = beforeModelsByProvider.get(model.providerId) || new Set<string>()
    slot.add(model.id)
    beforeModelsByProvider.set(model.providerId, slot)
  }
  const afterModelsByProvider = new Map<string, Set<string>>()
  for (const model of data.models) {
    const slot = afterModelsByProvider.get(model.providerId) || new Set<string>()
    slot.add(model.id)
    afterModelsByProvider.set(model.providerId, slot)
  }
  const allModelProviderIds = new Set([...beforeModelsByProvider.keys(), ...afterModelsByProvider.keys()])
  for (const providerId of allModelProviderIds) {
    const beforeIds = beforeModelsByProvider.get(providerId) || new Set<string>()
    const afterIds = afterModelsByProvider.get(providerId) || new Set<string>()
    for (const id of beforeIds) if (!afterIds.has(id)) await deleteModel(providerId, id)
  }
  for (const model of data.models) {
    const providerId = providerIdMap.get(model.providerId) || model.providerId
    const provider = data.providers.find((entry) => entry.id === model.providerId)
    const nextGatewayModelId = provider ? gatewayModelId(provider.prefix, model.gatewayModelId || model.id) : (model.gatewayModelId || model.id)
    const originalId = before.models.some((entry) => entry.id === model.id && entry.providerId === model.providerId) ? model.id : undefined
    const modelInput: Partial<Model> & { originalId?: string } = { ...model, providerId, gatewayModelId: nextGatewayModelId, ...(originalId ? { originalId } : {}) }
    if (!Object.hasOwn(model, "protocol")) modelInput.protocol = undefined
    if (!Object.hasOwn(model, "upstreamPath")) modelInput.upstreamPath = ""
    if (!Object.hasOwn(model, "requestOverrides")) modelInput.requestOverrides = {}
    await upsertModel(providerId, modelInput)
  }
  // Sync gateway api keys
  const beforeKeyIds = new Set(before.apiKeys.map((k) => k.id))
  const afterKeyIds = new Set(data.apiKeys.map((k) => k.id))
  for (const id of beforeKeyIds) if (!afterKeyIds.has(id)) await deleteApiKeyForSync(id)
  for (const apiKey of data.apiKeys) {
    await _setApiKey(apiKey)
  }
  workspaceCacheState().compatibilityCache = undefined
  return data
}

// -------------------------------------------------------------------------------------------------
// Firestore implementations
// -------------------------------------------------------------------------------------------------

async function firestoreReadMeta(): Promise<Meta> {
  const ref = metaRef()
  const current = await ref.get()
  const currentData = current.exists ? current.data() as Meta : undefined
  if (currentData && currentData.version >= 4) return currentData

  return getFirestoreInstance().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref)
    if (snapshot.exists) {
      const meta = snapshot.data() as Meta
      if (meta.version >= 4) return meta
      return firestoreMigrateCurrentDocuments(transaction, meta)
    }
    const legacyRef = legacyMetaRef()
    const legacy = await transaction.get(legacyRef)
    if (legacy.exists) {
      const migrated = migrateLegacy(legacy.data() as LegacyAppData)
      const providerIds = new Map<string, string>()
      for (const provider of migrated.providers.values()) providerIds.set(provider.id, providersRef().doc().id)
      const meta = { ...migrated.meta, version: 4 as const }
      transaction.set(ref, stripUndefined(meta))
      for (const provider of migrated.providers.values()) transaction.set(providerRef(providerIds.get(provider.id)!), providerDoc(provider, {
        apiKeyCount: provider.apiKeyCount,
        enabledApiKeyCount: provider.enabledApiKeyCount,
        modelCount: provider.modelCount,
        enabledModelCount: provider.enabledModelCount,
      }))
      for (const [oldProviderId, slot] of migrated.providerApiKeys) {
        const newProviderId = providerIds.get(oldProviderId)
        if (!newProviderId) continue
        for (const apiKey of slot.values()) {
          const ref = providerApiKeysRef(newProviderId).doc()
          transaction.set(ref, storedProviderApiKey(apiKey))
        }
      }
      for (const [oldProviderId, slot] of migrated.models) {
        const newProviderId = providerIds.get(oldProviderId)
        if (!newProviderId) continue
        for (const model of slot.values()) transaction.set(modelsRef(newProviderId).doc(), storedModel(model))
      }
      for (const apiKey of migrated.apiKeys.values()) {
        const keyRef = apiKeysRef().doc()
        const migratedKey = { ...apiKey, id: keyRef.id }
        transaction.set(keyRef, storedApiKey(migratedKey))
        transaction.set(apiKeyIndexRef(apiKeyValueHash(migratedKey.key)), apiKeyIndexDocument(migratedKey))
      }
      return meta
    }
    const meta = initialMeta()
    transaction.create(ref, meta)
    const seedRef = apiKeysRef().doc()
    const seedKey = { ...initialGatewayApiKey(), id: seedRef.id }
    transaction.set(seedRef, storedApiKey(seedKey))
    transaction.set(apiKeyIndexRef(apiKeyValueHash(seedKey.key)), apiKeyIndexDocument(seedKey))
    return meta
  })
}

async function firestoreMigrateCurrentDocuments(transaction: Transaction, meta: Meta): Promise<Meta> {
  const providerSnapshot = await transaction.get(providersRef())
  const gatewayKeySnapshot = await transaction.get(apiKeysRef())
  const children: Array<{ providerId: string; keys: FirebaseFirestore.QuerySnapshot<DocumentData>; models: FirebaseFirestore.QuerySnapshot<DocumentData> }> = []
  for (const provider of providerSnapshot.docs) {
    children.push({
      providerId: provider.id,
      keys: await transaction.get(providerApiKeysRef(provider.id)),
      models: await transaction.get(modelsRef(provider.id)),
    })
  }

  const providerIds = new Map<string, string>()
  for (const provider of providerSnapshot.docs) providerIds.set(provider.id, providersRef().doc().id)

  for (const provider of providerSnapshot.docs) {
    const nextId = providerIds.get(provider.id)!
    transaction.set(providerRef(nextId), storedProvider({ ...provider.data(), id: provider.id } as Provider))
  }
  for (const child of children) {
    const nextProviderId = providerIds.get(child.providerId)!
    for (const doc of child.keys.docs) {
      const apiKey = { ...doc.data(), id: doc.id, providerId: child.providerId } as ProviderApiKey
      transaction.set(providerApiKeysRef(nextProviderId).doc(), storedProviderApiKey(apiKey))
    }
    for (const doc of child.models.docs) {
      const data = doc.data() as Partial<Model>
      const model = {
        ...data,
        id: doc.id,
        providerId: child.providerId,
        gatewayModelId: data.gatewayModelId || data.id || doc.id,
      } as Model
      transaction.set(modelsRef(nextProviderId).doc(), storedModel(model))
    }
  }
  for (const doc of gatewayKeySnapshot.docs) {
    const keyRef = apiKeysRef().doc()
    const apiKey = { ...doc.data(), id: keyRef.id } as ApiKey
    transaction.set(keyRef, storedApiKey(apiKey))
    transaction.set(apiKeyIndexRef(apiKeyValueHash(apiKey.key)), apiKeyIndexDocument(apiKey))
  }

  for (const provider of providerSnapshot.docs) {
    for (const child of children.find((entry) => entry.providerId === provider.id)?.keys.docs || []) transaction.delete(child.ref)
    for (const child of children.find((entry) => entry.providerId === provider.id)?.models.docs || []) transaction.delete(child.ref)
    transaction.delete(provider.ref)
  }
  for (const doc of gatewayKeySnapshot.docs) transaction.delete(doc.ref)

  const nextMeta: Meta = { ...meta, version: 4 }
  transaction.set(metaRef(), nextMeta)
  return nextMeta
}

async function firestoreUpdateMeta(mutator: (meta: Meta) => void | Promise<void>): Promise<Meta> {
  return getFirestoreInstance().runTransaction(async (transaction) => {
    const ref = metaRef()
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) throw new Error("System metadata is missing.")
    const meta = snapshot.data() as Meta
    await mutator(meta)
    transaction.set(ref, stripUndefined(meta))
    return meta
  })
}

async function firestoreListProviders(): Promise<Provider[]> {
  const snapshot = await providersRef().get()
  return snapshot.docs.map(providerFromSnapshot).sort((a, b) => a.name.localeCompare(b.name))
}

async function firestoreGetProvider(providerId: string): Promise<Provider | undefined> {
  const snapshot = await providerRef(providerId).get()
  return snapshot.exists ? providerFromSnapshot(snapshot) : undefined
}

async function firestoreUpsertProvider(input: Partial<Provider> & { originalId?: string }, expected?: Provider): Promise<Provider> {
  const firestore = getFirestoreInstance()
  return firestore.runTransaction(async (transaction) => {
    const originalId = input.originalId
    const allProviders = await transaction.get(providersRef())
    for (const doc of allProviders.docs) {
      const provider = doc.data() as Provider
      if (provider.prefix === input.prefix && doc.id !== originalId) throw new Error("Provider prefix is already in use.")
    }
    const existingSnapshot = originalId ? await transaction.get(providerRef(originalId)) : undefined
    const existing = existingSnapshot?.exists ? providerFromSnapshot(existingSnapshot) : undefined
    if (originalId && !existing) throw new Error("Provider not found.")
    const existingModels = existing && input.prefix && existing.prefix !== input.prefix
      ? await transaction.get(modelsRef(existing.id))
      : undefined
    const providerInput = { ...input }
    delete providerInput.originalId
    delete providerInput.id
    const id = existing ? originalId! : providersRef().doc().id
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
      enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      apiKeyCount: existing?.apiKeyCount ?? 0,
      enabledApiKeyCount: existing?.enabledApiKeyCount ?? 0,
      modelCount: existing?.modelCount ?? 0,
      enabledModelCount: existing?.enabledModelCount ?? 0,
    } as Provider
    transaction.set(providerRef(id), storedProvider(provider))
    if (existingModels) {
      const models = existingModels.docs.map((snapshot) => modelFromSnapshot(snapshot, id))
      for (const model of migrateProviderModels(models, provider.prefix).values()) {
        transaction.set(modelRef(id, model.id), storedModel(model))
      }
    }
    return provider
  })
}

async function firestoreDeleteProvider(providerId: string): Promise<void> {
  const firestore = getFirestoreInstance()
  await firestore.runTransaction(async (transaction) => {
    const [apiKeys, models] = await Promise.all([
      transaction.get(providerApiKeysRef(providerId)),
      transaction.get(modelsRef(providerId)),
    ])
    apiKeys.docs.forEach((doc) => transaction.delete(doc.ref))
    models.docs.forEach((doc) => transaction.delete(doc.ref))
    transaction.delete(providerRef(providerId))
  })
}

async function firestoreListProviderApiKeys(providerId: string): Promise<ProviderApiKey[]> {
  const snapshot = await providerApiKeysRef(providerId).get()
  return snapshot.docs.map((doc) => providerApiKeyFromSnapshot(doc, providerId)).sort(compareProviderApiKeys)
}

async function firestoreReorderProviderApiKeys(providerId: string, orderedIds: string[]): Promise<void> {
  const firestore = getFirestoreInstance()
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(providerApiKeysRef(providerId))
    const ids = snapshot.docs.map((doc) => doc.id)
    if (ids.length !== orderedIds.length || ids.some((id) => !orderedIds.includes(id))) throw new Error("API key order is out of date.")
    orderedIds.forEach((id, index) => transaction.update(providerApiKeyRef(providerId, id), { priority: orderedIds.length - index - 1 }))
  })
}

async function firestoreListAllProviderApiKeys(): Promise<ProviderApiKey[]> {
  const providers = (await listProviders()).filter((provider) => provider.apiKeyCount !== 0)
  const snapshots = await parallelMap(providers, async (provider) => ({
    providerId: provider.id,
    snapshot: await providerApiKeysRef(provider.id).get(),
  }))
  return snapshots.flatMap(({ providerId, snapshot }) => snapshot.docs.map((document) => providerApiKeyFromSnapshot(document, providerId)))
}

async function firestoreUpsertProviderApiKey(providerId: string, input: Partial<ProviderApiKey> & { originalId?: string }): Promise<ProviderApiKey> {
  const firestore = getFirestoreInstance()
  return firestore.runTransaction(async (transaction) => {
    const providerDocSnapshot = await transaction.get(providerRef(providerId))
    if (!providerDocSnapshot.exists) throw new Error("Provider is missing.")
    const existingSnapshot = input.originalId ? await transaction.get(providerApiKeyRef(providerId, input.originalId)) : undefined
    const existing = existingSnapshot?.exists ? providerApiKeyFromSnapshot(existingSnapshot, providerId) : undefined
    if (input.originalId && !existing) throw new Error("Provider API key not found.")
    const apiKeyId = existing ? input.originalId! : providerApiKeysRef(providerId).doc().id
    const inputWithoutIds = { ...input }
    delete inputWithoutIds.id
    delete inputWithoutIds.originalId
    const apiKey: ProviderApiKey = {
      ...(existing || {}),
      ...inputWithoutIds,
      id: apiKeyId,
      providerId,
      name: input.name || existing?.name || "",
      key: input.key !== undefined && input.key !== "__unchanged__" ? input.key : (existing?.key || ""),
      enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
      rpmLimit: input.rpmLimit ?? existing?.rpmLimit,
      maxConcurrency: input.maxConcurrency ?? existing?.maxConcurrency,
      priority: input.priority ?? existing?.priority,
      createdAt: existing?.createdAt || new Date().toISOString(),
    }
    transaction.set(providerApiKeyRef(providerId, apiKeyId), storedProviderApiKey(apiKey))
    if (!existing) {
      transaction.update(providerRef(providerId), { apiKeyCount: FieldValue.increment(1), enabledApiKeyCount: FieldValue.increment(apiKey.enabled ? 1 : 0) })
    } else if (existing.enabled !== apiKey.enabled) {
      transaction.update(providerRef(providerId), { enabledApiKeyCount: FieldValue.increment(apiKey.enabled ? 1 : -1) })
    }
    return apiKey
  })
}

async function firestoreDeleteProviderApiKey(providerId: string, apiKeyId: string): Promise<void> {
  const firestore = getFirestoreInstance()
  await firestore.runTransaction(async (transaction) => {
    const ref = providerApiKeyRef(providerId, apiKeyId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return
    const apiKey = snapshot.data() as ProviderApiKey
    transaction.delete(ref)
    transaction.update(providerRef(providerId), {
      apiKeyCount: FieldValue.increment(-1),
      enabledApiKeyCount: FieldValue.increment(apiKey.enabled ? -1 : 0),
    })
  })
}

async function firestoreListModels(): Promise<Model[]> {
  const providers = (await listProviders()).filter((provider) => provider.modelCount !== 0)
  const snapshots = await parallelMap(providers, async (provider) => ({
    providerId: provider.id,
    snapshot: await modelsRef(provider.id).get(),
  }))
  return snapshots.flatMap(({ providerId, snapshot }) => snapshot.docs.map((document) => modelFromSnapshot(document, providerId)))
}

async function firestoreListProviderModels(providerId: string): Promise<Model[]> {
  const snapshot = await modelsRef(providerId).get()
  return snapshot.docs.map((doc) => modelFromSnapshot(doc, providerId))
}

async function firestoreUpsertModel(providerId: string, input: Partial<Model> & { originalId?: string }): Promise<Model> {
  const firestore = getFirestoreInstance()
  return firestore.runTransaction(async (transaction) => {
    const providerDocSnapshot = await transaction.get(providerRef(providerId))
    if (!providerDocSnapshot.exists) throw new Error("Provider is missing.")
    const allModels = await transaction.get(modelsRef(providerId))
    const existingSnapshot = input.originalId ? await transaction.get(modelRef(providerId, input.originalId)) : undefined
    const existing = existingSnapshot?.exists ? modelFromSnapshot(existingSnapshot, providerId) : undefined
    if (input.originalId && !existing) throw new Error("Model not found.")
    const gatewayModelId = input.gatewayModelId || (!input.originalId ? input.id : undefined) || existing?.gatewayModelId || existing?.id || ""
    if (!input.name || !input.upstreamModel || !gatewayModelId) throw new Error("Model fields are incomplete.")
    for (const doc of allModels.docs) {
      const data = doc.data() as Partial<Model>
      const currentGatewayModelId = data.gatewayModelId || data.id || doc.id
      if (currentGatewayModelId === gatewayModelId && doc.id !== input.originalId) {
        throw new Error("Gateway model ID is already in use.")
      }
    }
    const modelId = existing ? input.originalId! : modelsRef(providerId).doc().id
    const inputWithoutIds = { ...input }
    delete inputWithoutIds.id
    delete inputWithoutIds.originalId
    delete inputWithoutIds.providerId
    delete inputWithoutIds.gatewayModelId
    const hasUpstreamPath = Object.hasOwn(input, "upstreamPath")
    const hasRequestOverrides = Object.hasOwn(input, "requestOverrides")
    const hasProtocol = Object.hasOwn(input, "protocol")
    const model: Model = {
      ...(existing || {}),
      id: modelId,
      providerId,
      gatewayModelId,
      ...inputWithoutIds,
      name: input.name,
      upstreamModel: input.upstreamModel,
      protocol: hasProtocol ? input.protocol : existing?.protocol,
      upstreamPath: hasUpstreamPath ? (input.upstreamPath || undefined) : existing?.upstreamPath,
      requestOverrides: hasRequestOverrides ? input.requestOverrides : existing?.requestOverrides,
      enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
    }
    transaction.set(modelRef(providerId, modelId), storedModel(model))
    if (!existing) {
      transaction.update(providerRef(providerId), { modelCount: FieldValue.increment(1), enabledModelCount: FieldValue.increment(model.enabled ? 1 : 0) })
    } else if (existing.enabled !== model.enabled) {
      transaction.update(providerRef(providerId), { enabledModelCount: FieldValue.increment(model.enabled ? 1 : -1) })
    }
    return model
  })
}

async function firestoreDeleteModel(providerId: string, modelId: string): Promise<void> {
  const firestore = getFirestoreInstance()
  await firestore.runTransaction(async (transaction) => {
    const ref = modelRef(providerId, modelId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return
    const model = snapshot.data() as Model
    transaction.delete(ref)
    transaction.update(providerRef(providerId), {
      modelCount: FieldValue.increment(-1),
      enabledModelCount: FieldValue.increment(model.enabled ? -1 : 0),
    })
  })
}

async function firestoreListAliases(): Promise<ModelAlias[]> {
  const snapshot = await aliasesRef().get()
  return snapshot.docs.map(aliasFromSnapshot).sort(compareAliases)
}

async function firestoreUpsertAlias(input: Partial<ModelAlias> & { originalId?: string }): Promise<ModelAlias> {
  const firestore = getFirestoreInstance()
  return firestore.runTransaction(async (transaction) => {
    const allAliases = await transaction.get(aliasesRef())
    const existingSnapshot = input.originalId ? await transaction.get(aliasRef(input.originalId)) : undefined
    const existing = existingSnapshot?.exists ? aliasFromSnapshot(existingSnapshot) : undefined
    if (input.originalId && !existing) throw new Error("Alias not found.")
    const normalizedAlias = cleanAliasId(input.alias || existing?.alias || "")
    if (!normalizedAlias) throw new Error("Alias is required.")
    for (const doc of allAliases.docs) {
      const data = doc.data() as Partial<ModelAlias>
      if (cleanAliasId(data.alias || doc.id) === normalizedAlias && doc.id !== input.originalId) {
        throw new Error("Alias is already in use.")
      }
    }
    const aliasId = existing ? input.originalId! : aliasesRef().doc().id
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
      createdAt: existing?.createdAt || new Date().toISOString(),
    }
    transaction.set(aliasRef(aliasId), storedAlias(alias))
    return alias
  })
}

async function firestoreDeleteAlias(aliasId: string): Promise<void> {
  const firestore = getFirestoreInstance()
  await firestore.runTransaction(async (transaction) => {
    const ref = aliasRef(aliasId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return
    transaction.delete(ref)
  })
}

async function firestoreListApiKeys(): Promise<ApiKey[]> {
  const snapshot = await apiKeysRef().get()
  return snapshot.docs.map(apiKeyFromSnapshot)
}

async function firestoreCreateApiKey(name: string, customKey?: string): Promise<ApiKey> {
  const normalizedCustomKey = customKey === undefined ? undefined : validateGatewayApiKeyValue(customKey)
  if (normalizedCustomKey !== undefined) {
    if (await findIndexedApiKeyByValue(normalizedCustomKey)) throw new ApiKeyConflictError()
    if ((await reconciledApiKeyIndexCandidates()).has(apiKeyValueHash(normalizedCustomKey))) throw new ApiKeyConflictError()
  }
  const firestore = getFirestoreInstance()
  return firestore.runTransaction(async (transaction) => {
    const apiKey = {
      id: apiKeysRef().doc().id,
      name,
      key: normalizedCustomKey === undefined ? `sk-rr-${crypto.randomUUID().replaceAll("-", "")}` : normalizedCustomKey,
      createdAt: new Date().toISOString(),
    } satisfies ApiKey
    const apiKeyRefValue = apiKeyRef(apiKey.id)
    const requestedHash = apiKeyValueHash(apiKey.key)
    const existingIndex = await transaction.get(apiKeyIndexRef(requestedHash))
    if (existingIndex.exists) throw new ApiKeyConflictError()
    transaction.create(apiKeyRefValue, storedApiKey(apiKey))
    transaction.set(apiKeyIndexRef(requestedHash), apiKeyIndexDocument(apiKey))
    return apiKey
  })
}

async function firestoreDeleteApiKey(apiKeyId: string): Promise<string | undefined> {
  return firestoreDeleteApiKeyWithInvariant(apiKeyId, false)
}

async function firestoreDeleteApiKeyWithInvariant(apiKeyId: string, enforceAtLeastOne: boolean): Promise<string | undefined> {
  const firestore = getFirestoreInstance()
  return firestore.runTransaction(async (transaction) => {
    const ref = apiKeyRef(apiKeyId)
    const target = await transaction.get(ref)
    if (!target.exists) return undefined
    void enforceAtLeastOne
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
  const providerInput = { ...input }
  delete providerInput.originalId
  delete providerInput.id
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
    enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    ...counters,
  } as Provider
  const existingModels = existing && existing.prefix !== provider.prefix ? state.models.get(id) : undefined
  const migratedModels = existingModels ? migrateProviderModels(existingModels.values(), provider.prefix) : undefined
  state.providers.set(id, provider)
  if (migratedModels) state.models.set(id, migratedModels)
  workspaceCacheState().compatibilityCache = undefined
  return provider
}

function memoryDeleteProvider(providerId: string): void {
  const state = ensureMemorySeeded()
  state.providers.delete(providerId)
  state.providerApiKeys.delete(providerId)
  state.models.delete(providerId)
  workspaceCacheState().compatibilityCache = undefined
}

function memoryUpsertProviderApiKey(providerId: string, input: Partial<ProviderApiKey> & { originalId?: string }): ProviderApiKey {
  const state = ensureMemorySeeded()
  const provider = state.providers.get(providerId)
  if (!provider) throw new Error("Provider is missing.")
  const slot = state.providerApiKeys.get(providerId) || new Map<string, ProviderApiKey>()
  const existing = input.originalId ? slot.get(input.originalId) : undefined
  if (input.originalId && !existing) throw new Error("Provider API key not found.")
  const apiKeyId = existing ? input.originalId! : crypto.randomUUID()
  const inputWithoutIds = { ...input }
  delete inputWithoutIds.id
  delete inputWithoutIds.originalId
  const apiKey: ProviderApiKey = {
    ...(existing || {}),
    ...inputWithoutIds,
    id: apiKeyId,
    providerId,
    name: input.name || existing?.name || "",
    key: input.key !== undefined && input.key !== "__unchanged__" ? input.key : (existing?.key || ""),
    enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
    rpmLimit: input.rpmLimit ?? existing?.rpmLimit,
    maxConcurrency: input.maxConcurrency ?? existing?.maxConcurrency,
    priority: input.priority ?? existing?.priority,
    createdAt: existing?.createdAt || new Date().toISOString(),
  }
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
  workspaceCacheState().compatibilityCache = undefined
  return apiKey
}

function memoryDeleteProviderApiKey(providerId: string, apiKeyId: string): void {
  const state = ensureMemorySeeded()
  const provider = state.providers.get(providerId)
  if (!provider) return
  const slot = state.providerApiKeys.get(providerId)
  const apiKey = slot?.get(apiKeyId)
  if (!apiKey || !slot) return
  slot.delete(apiKeyId)
  state.providers.set(providerId, {
    ...provider,
    apiKeyCount: Math.max(0, provider.apiKeyCount - 1),
    enabledApiKeyCount: Math.max(0, provider.enabledApiKeyCount - (apiKey.enabled ? 1 : 0)),
  })
  workspaceCacheState().compatibilityCache = undefined
}

function memoryUpsertModel(providerId: string, input: Partial<Model> & { originalId?: string }): Model {
  const state = ensureMemorySeeded()
  const provider = state.providers.get(providerId)
  if (!provider) throw new Error("Provider is missing.")
  const slot = state.models.get(providerId) || new Map<string, Model>()
  const existing = input.originalId ? slot.get(input.originalId) : undefined
  if (input.originalId && !existing) throw new Error("Model not found.")
  const modelId = existing ? input.originalId! : crypto.randomUUID()
  const gatewayModelId = input.gatewayModelId || (!input.originalId ? input.id : undefined) || existing?.gatewayModelId || existing?.id || ""
  if (!input.name || !input.upstreamModel || !gatewayModelId) throw new Error("Model fields are incomplete.")
  for (const model of slot.values()) {
    if (model.id !== input.originalId && (model.gatewayModelId || model.id) === gatewayModelId) throw new Error("Gateway model ID is already in use.")
  }
  const inputWithoutIds = { ...input }
  delete inputWithoutIds.id
  delete inputWithoutIds.originalId
  delete inputWithoutIds.providerId
  delete inputWithoutIds.gatewayModelId
  const hasUpstreamPath = Object.hasOwn(input, "upstreamPath")
  const hasRequestOverrides = Object.hasOwn(input, "requestOverrides")
  const hasProtocol = Object.hasOwn(input, "protocol")
  const model: Model = {
    ...(existing || {}),
    ...inputWithoutIds,
    id: modelId,
    providerId,
    gatewayModelId,
    name: input.name,
    upstreamModel: input.upstreamModel,
    protocol: hasProtocol ? input.protocol : existing?.protocol,
    upstreamPath: hasUpstreamPath ? (input.upstreamPath || undefined) : existing?.upstreamPath,
    requestOverrides: hasRequestOverrides ? input.requestOverrides : existing?.requestOverrides,
    enabled: input.enabled !== undefined ? input.enabled : existing?.enabled !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
  }
  slot.set(modelId, model)
  state.models.set(providerId, slot)
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
  workspaceCacheState().compatibilityCache = undefined
  return model
}

function memoryDeleteModel(providerId: string, modelId: string): void {
  const state = ensureMemorySeeded()
  const provider = state.providers.get(providerId)
  if (!provider) return
  const slot = state.models.get(providerId)
  const model = slot?.get(modelId)
  if (!model || !slot) return
  slot.delete(modelId)
  state.providers.set(providerId, {
    ...provider,
    modelCount: Math.max(0, provider.modelCount - 1),
    enabledModelCount: Math.max(0, provider.enabledModelCount - (model.enabled ? 1 : 0)),
  })
  workspaceCacheState().compatibilityCache = undefined
}

function memoryUpsertAlias(input: Partial<ModelAlias> & { originalId?: string }): ModelAlias {
  const state = ensureMemorySeeded()
  const existing = input.originalId ? state.aliases.get(input.originalId) : undefined
  if (input.originalId && !existing) throw new Error("Alias not found.")
  const normalizedAlias = cleanAliasId(input.alias || existing?.alias || "")
  if (!normalizedAlias) throw new Error("Alias is required.")
  for (const alias of state.aliases.values()) {
    if (alias.id !== input.originalId && cleanAliasId(alias.alias || alias.id) === normalizedAlias) throw new Error("Alias is already in use.")
  }
  const aliasId = existing ? input.originalId! : crypto.randomUUID()
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
    createdAt: existing?.createdAt || new Date().toISOString(),
  }
  state.aliases.set(aliasId, alias)
  workspaceCacheState().compatibilityCache = undefined
  return alias
}

function memoryDeleteAlias(aliasId: string): void {
  const state = ensureMemorySeeded()
  state.aliases.delete(aliasId)
  workspaceCacheState().compatibilityCache = undefined
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
  workspaceCacheState().compatibilityCache = undefined
  return apiKey
}

function memoryDeleteApiKey(apiKeyId: string, enforceAtLeastOne = false): string | undefined {
  const state = ensureMemorySeeded()
  if (!state.apiKeys.has(apiKeyId)) return undefined
  void enforceAtLeastOne
  const apiKey = state.apiKeys.get(apiKeyId)
  state.apiKeys.delete(apiKeyId)
  const hash = apiKey ? apiKeyValueHash(apiKey.key) : undefined
  if (hash) state.apiKeyIndexes.delete(hash)
  workspaceCacheState().compatibilityCache = undefined
  return hash
}

// Test-only accessor for memory backend snapshots.
export function _memorySnapshot() {
  return memorySnapshot(ensureMemorySeeded())
}

// Test-only accessor for simulating a legacy key document whose global index
// row was never written.
export function _deleteMemoryApiKeyIndex(value: string) {
  const hash = apiKeyValueHash(value)
  for (const state of memoryRoot().states.values()) state.apiKeyIndexes.delete(hash)
  invalidateApiKeyLookupCache([hash])
}

export function _resetMemoryBackend() {
  globalThis.__rawrouteMemoryStore = { states: new Map() }
  workspaceCacheStates.clear()
  invalidateApiKeyLookupCache()
  metaCache = undefined
  metaReadPromise = undefined
}

export function _deleteMemoryWorkspace(workspaceId: string) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) throw new Error("Default workspace cannot be deleted.")
  const state = memoryRoot().states.get(workspaceId)
  const hashes = state ? [...state.apiKeys.values()].map((apiKey) => apiKeyValueHash(apiKey.key)) : []
  memoryRoot().states.delete(workspaceId)
  workspaceCacheStates.delete(workspaceId)
  invalidateApiKeyLookupCache(hashes)
}

export function _invalidateApiKeyLookupCache(hashes?: Iterable<string>) {
  invalidateApiKeyLookupCache(hashes)
}
