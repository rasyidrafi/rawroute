import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { type DocumentData, type DocumentSnapshot, type Firestore, FieldValue, getFirestore, type Transaction } from "firebase-admin/firestore"

import { gatewayModelId, cleanId } from "@/lib/http"
import { decryptCredentialSecret, encryptCredentialSecret } from "@/lib/credential-secrets"
import type { ApiKey, AppData, Model, ModelAlias, Provider, ProviderApiKey } from "@/lib/types"

const configuredCacheTtlMs = Number(process.env.ROUTING_CACHE_TTL_MS || 2_000)
const cacheTtlMs = Number.isFinite(configuredCacheTtlMs) && configuredCacheTtlMs >= 0 ? configuredCacheTtlMs : 2_000
let compatibilityCache: CompatibilityCache | undefined

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

function storedAlias(alias: ModelAlias) {
  const { id, ...data } = alias
  void id
  return stripUndefined(data)
}

function isMemoryBackend() {
  return process.env.STORAGE_BACKEND === "memory" || process.env.NODE_ENV === "test"
}

interface CompatibilityCache { data: AppData; expiresAt: number }

function invalidateCompatibilityCache() {
  compatibilityCache = undefined
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
  if (input.alias !== undefined && (typeof input.alias !== "string" || !cleanId(input.alias))) {
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

const memory: MemoryState = {
  meta: undefined,
  providers: new Map(),
  providerApiKeys: new Map(),
  models: new Map(),
  aliases: new Map(),
  apiKeys: new Map(),
  apiKeyIndexes: new Map(),
  initialized: false,
}

function ensureMemorySeeded(): MemoryState {
  if (!memory.initialized) {
    memory.meta = initialMeta()
    const seedKey = initialGatewayApiKey()
    memory.apiKeys.set(seedKey.id, seedKey)
    memory.apiKeyIndexes.set(apiKeyValueHash(seedKey.key), seedKey.id)
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

// -------------------------------------------------------------------------------------------------
// Firestore backend
// -------------------------------------------------------------------------------------------------

let firestoreInstance: Firestore | undefined

function getFirestoreInstance(): Firestore {
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

function collectionPrefix() {
  return (process.env.FIRESTORE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
}

function metaRef() {
  return getFirestoreInstance().collection(`${collectionPrefix()}_system`).doc("meta")
}

function legacyMetaRef() {
  return getFirestoreInstance().collection(`${collectionPrefix()}_system`).doc("state")
}

function providersRef() {
  return getFirestoreInstance().collection(collectionPrefix()).doc("providers").collection("providers")
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
  return getFirestoreInstance().collection(collectionPrefix()).doc("aliases").collection("aliases")
}

function aliasRef(aliasId: string) {
  return aliasesRef().doc(aliasId)
}

function apiKeysRef() {
  return getFirestoreInstance().collection(collectionPrefix()).doc("apiKeys").collection("apiKeys")
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

// -------------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------------

export async function readMeta(): Promise<Meta> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    return state.meta!
  }
  return firestoreReadMeta()
}

export async function writeMeta(meta: Meta): Promise<void> {
  if (isMemoryBackend()) {
    ensureMemorySeeded().meta = meta
    invalidateCompatibilityCache()
    return
  }
  await metaRef().set(stripUndefined(meta))
  invalidateCompatibilityCache()
}

export async function updateMeta(mutator: (meta: Meta) => void | Promise<void>): Promise<Meta> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    await mutator(state.meta!)
    invalidateCompatibilityCache()
    return state.meta!
  }
  const meta = await firestoreUpdateMeta(mutator)
  invalidateCompatibilityCache()
  return meta
}

export async function listProviders(): Promise<Provider[]> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    return [...state.providers.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  return firestoreListProviders()
}

export async function getProvider(providerId: string): Promise<Provider | undefined> {
  if (isMemoryBackend()) {
    return ensureMemorySeeded().providers.get(providerId)
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
  return firestoreListProviderApiKeys(providerId)
}

export async function getProviderApiKey(providerId: string, apiKeyId: string): Promise<ProviderApiKey | undefined> {
  if (isMemoryBackend()) return ensureMemorySeeded().providerApiKeys.get(providerId)?.get(apiKeyId)
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
  return firestoreListAllProviderApiKeys()
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
  return firestoreListModels()
}

export async function listProviderModels(providerId: string): Promise<Model[]> {
  if (isMemoryBackend()) {
    const map = ensureMemorySeeded().models.get(providerId) || new Map<string, Model>()
    return [...map.values()]
  }
  return firestoreListProviderModels(providerId)
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
  return firestoreListAliases()
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
  return firestoreListApiKeys()
}

export async function createApiKey(name: string, customKey?: string): Promise<ApiKey> {
  const apiKey = isMemoryBackend() ? memoryCreateApiKey(name, customKey) : await firestoreCreateApiKey(name, customKey)
  invalidateCompatibilityCache()
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
    invalidateCompatibilityCache()
    return updated
  }
  const firestore = getFirestoreInstance()
  const updated = await firestore.runTransaction(async (transaction) => {
    const ref = apiKeyRef(apiKeyId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) throw new Error("API key not found.")
    transaction.update(ref, { name: normalizedName })
    return { ...apiKeyFromSnapshot(snapshot), name: normalizedName }
  })
  invalidateCompatibilityCache()
  return updated
}

export async function _setApiKey(apiKey: ApiKey): Promise<void> {
  if (isMemoryBackend()) {
    const state = ensureMemorySeeded()
    const previous = state.apiKeys.get(apiKey.id)
    const normalized = normalizeApiKeyValue(apiKey.key)
    const hash = apiKeyValueHash(normalized)
    const owner = state.apiKeyIndexes.get(hash)
    if (owner && owner !== apiKey.id) throw new ApiKeyConflictError()
    if (previous) state.apiKeyIndexes.delete(apiKeyValueHash(previous.key))
    state.apiKeys.set(apiKey.id, { ...apiKey, key: normalized })
    state.apiKeyIndexes.set(hash, apiKey.id)
    invalidateCompatibilityCache()
    return
  }
  const firestore = getFirestoreInstance()
  await firestore.runTransaction(async (transaction) => {
    const ref = apiKeyRef(apiKey.id)
    const previousSnapshot = await transaction.get(ref)
    const normalized = normalizeApiKeyValue(apiKey.key)
    const indexRef = apiKeyIndexRef(apiKeyValueHash(normalized))
    const indexSnapshot = await transaction.get(indexRef)
    if (indexSnapshot.exists && (indexSnapshot.data() as { apiKeyId?: string }).apiKeyId !== apiKey.id) throw new ApiKeyConflictError()
    const next = { ...apiKey, key: normalized }
    if (previousSnapshot.exists) {
      const previous = apiKeyFromSnapshot(previousSnapshot)
      transaction.delete(apiKeyIndexRef(apiKeyValueHash(previous.key)))
    }
    transaction.set(ref, storedApiKey(next))
    transaction.set(indexRef, { apiKeyId: apiKey.id, createdAt: apiKey.createdAt })
  })
  invalidateCompatibilityCache()
}

export async function deleteApiKey(apiKeyId: string): Promise<void> {
  if (isMemoryBackend()) memoryDeleteApiKey(apiKeyId)
  else await firestoreDeleteApiKey(apiKeyId)
  invalidateCompatibilityCache()
}

async function deleteApiKeyForSync(apiKeyId: string): Promise<void> {
  if (isMemoryBackend()) memoryDeleteApiKey(apiKeyId, false)
  else await firestoreDeleteApiKeyWithInvariant(apiKeyId, false)
  invalidateCompatibilityCache()
}

// -------------------------------------------------------------------------------------------------
// Compatibility shim (preserved for proxy/auth/catalog)
// -------------------------------------------------------------------------------------------------

export async function readData(): Promise<AppData> {
  if (compatibilityCache && compatibilityCache.expiresAt > Date.now()) return structuredClone(compatibilityCache.data)
  const [providers, providerApiKeys, models, aliases, apiKeys, meta] = await Promise.all([
    listProviders(),
    listAllProviderApiKeys(),
    listModels(),
    listAliases(),
    listApiKeys(),
    readMeta(),
  ])
  const data: AppData = {
    version: 4,
    admin: meta.admin,
    sessionSecret: meta.sessionSecret,
    providers,
    providerApiKeys,
    models,
    aliases,
    apiKeys,
  }
  compatibilityCache = { data: structuredClone(data), expiresAt: Date.now() + cacheTtlMs }
  return structuredClone(data)
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
  compatibilityCache = undefined
  return data
}

// -------------------------------------------------------------------------------------------------
// Firestore implementations
// -------------------------------------------------------------------------------------------------

async function firestoreReadMeta(): Promise<Meta> {
  return getFirestoreInstance().runTransaction(async (transaction) => {
    const ref = metaRef()
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
      for (const apiKey of migrated.apiKeys.values()) transaction.set(apiKeysRef().doc(), storedApiKey(apiKey))
      return meta
    }
    const meta = initialMeta()
    transaction.create(ref, meta)
    const seedKey = initialGatewayApiKey()
    transaction.set(apiKeysRef().doc(), storedApiKey(seedKey))
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
  for (const doc of gatewayKeySnapshot.docs) transaction.set(apiKeysRef().doc(), storedApiKey({ ...doc.data(), id: doc.id } as ApiKey))

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
  const snapshot = await providersRef().get()
  const out: ProviderApiKey[] = []
  for (const doc of snapshot.docs) {
    const sub = await providerApiKeysRef(doc.id).get()
    sub.docs.forEach((subDoc) => out.push(providerApiKeyFromSnapshot(subDoc, doc.id)))
  }
  return out
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
  const providers = await providersRef().get()
  const out: Model[] = []
  for (const doc of providers.docs) {
    const sub = await modelsRef(doc.id).get()
    sub.docs.forEach((subDoc) => out.push(modelFromSnapshot(subDoc, doc.id)))
  }
  return out
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
    const normalizedAlias = cleanId(input.alias || existing?.alias || "")
    if (!normalizedAlias) throw new Error("Alias is required.")
    for (const doc of allAliases.docs) {
      const data = doc.data() as Partial<ModelAlias>
      if ((data.alias || doc.id) === normalizedAlias && doc.id !== input.originalId) {
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
  const firestore = getFirestoreInstance()
  return firestore.runTransaction(async (transaction) => {
    const apiKey = {
      id: apiKeysRef().doc().id,
      name,
      key: customKey === undefined ? `sk-rr-${crypto.randomUUID().replaceAll("-", "")}` : validateGatewayApiKeyValue(customKey),
      createdAt: new Date().toISOString(),
    } satisfies ApiKey
    const apiKeyRefValue = apiKeyRef(apiKey.id)
    const requestedHash = apiKeyValueHash(apiKey.key)
    const [existingKeys, existingIndexes] = await Promise.all([
      transaction.get(apiKeysRef()),
      transaction.get(apiKeyIndexesRef()),
    ])
    const existingKeyIds = new Set(existingKeys.docs.map((document) => document.id))
    const indexByHash = new Map(existingIndexes.docs.map((document) => [document.id, document.data() as { apiKeyId?: string }]))

    for (const document of existingKeys.docs) {
      const existing = apiKeyFromSnapshot(document)
      const hash = apiKeyValueHash(existing.key)
      const index = indexByHash.get(hash)
      if (!index || !existingKeyIds.has(index.apiKeyId || "")) {
        transaction.set(apiKeyIndexRef(hash), { apiKeyId: document.id, createdAt: existing.createdAt })
        indexByHash.set(hash, { apiKeyId: document.id })
      }
    }
    const existingIndex = indexByHash.get(requestedHash)
    if (existingIndex && existingKeyIds.has(existingIndex.apiKeyId || "")) {
      throw new ApiKeyConflictError()
    }
    transaction.create(apiKeyRefValue, storedApiKey(apiKey))
    transaction.set(apiKeyIndexRef(requestedHash), { apiKeyId: apiKey.id, createdAt: apiKey.createdAt })
    return apiKey
  })
}

async function firestoreDeleteApiKey(apiKeyId: string): Promise<void> {
  return firestoreDeleteApiKeyWithInvariant(apiKeyId, true)
}

async function firestoreDeleteApiKeyWithInvariant(apiKeyId: string, enforceAtLeastOne: boolean): Promise<void> {
  const firestore = getFirestoreInstance()
  await firestore.runTransaction(async (transaction) => {
    const ref = apiKeyRef(apiKeyId)
    const target = await transaction.get(ref)
    if (!target.exists) return
    if (enforceAtLeastOne) {
      const all = await transaction.get(apiKeysRef())
      if (all.size <= 1) throw new Error("At least one gateway API key is required.")
    }
    const apiKey = apiKeyFromSnapshot(target)
    transaction.delete(ref)
    transaction.delete(apiKeyIndexRef(apiKeyValueHash(apiKey.key)))
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
  compatibilityCache = undefined
  return provider
}

function memoryDeleteProvider(providerId: string): void {
  const state = ensureMemorySeeded()
  state.providers.delete(providerId)
  state.providerApiKeys.delete(providerId)
  state.models.delete(providerId)
  compatibilityCache = undefined
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
  compatibilityCache = undefined
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
  compatibilityCache = undefined
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
  compatibilityCache = undefined
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
  compatibilityCache = undefined
}

function memoryUpsertAlias(input: Partial<ModelAlias> & { originalId?: string }): ModelAlias {
  const state = ensureMemorySeeded()
  const existing = input.originalId ? state.aliases.get(input.originalId) : undefined
  if (input.originalId && !existing) throw new Error("Alias not found.")
  const normalizedAlias = cleanId(input.alias || existing?.alias || "")
  if (!normalizedAlias) throw new Error("Alias is required.")
  for (const alias of state.aliases.values()) {
    if (alias.id !== input.originalId && (alias.alias || alias.id) === normalizedAlias) throw new Error("Alias is already in use.")
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
  compatibilityCache = undefined
  return alias
}

function memoryDeleteAlias(aliasId: string): void {
  const state = ensureMemorySeeded()
  state.aliases.delete(aliasId)
  compatibilityCache = undefined
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
  if (state.apiKeyIndexes.has(hash)) throw new ApiKeyConflictError()
  state.apiKeys.set(apiKey.id, apiKey)
  state.apiKeyIndexes.set(hash, apiKey.id)
  compatibilityCache = undefined
  return apiKey
}

function memoryDeleteApiKey(apiKeyId: string, enforceAtLeastOne = true): void {
  const state = ensureMemorySeeded()
  if (!state.apiKeys.has(apiKeyId)) return
  if (enforceAtLeastOne && state.apiKeys.size <= 1) throw new Error("At least one gateway API key is required.")
  const apiKey = state.apiKeys.get(apiKeyId)
  state.apiKeys.delete(apiKeyId)
  if (apiKey) state.apiKeyIndexes.delete(apiKeyValueHash(apiKey.key))
  compatibilityCache = undefined
}

// Test-only accessor for memory backend snapshots.
export function _memorySnapshot() {
  return memorySnapshot(memory)
}

export function _resetMemoryBackend() {
  memory.meta = undefined
  memory.providers = new Map()
  memory.providerApiKeys = new Map()
  memory.models = new Map()
  memory.aliases = new Map()
  memory.apiKeys = new Map()
  memory.apiKeyIndexes = new Map()
  memory.initialized = false
  compatibilityCache = undefined
}
