import { createHash } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

import { findModelsDevCanonicalModels } from "@/lib/models-dev"
import { listModels, listProviders } from "@/lib/store"
import type { CanonicalModelSummary, Model, ModelPricingGroup, ModelPricingVersion, PricingCanonicalSource, PricingJob, PricingRates, PricingContextTier } from "@/lib/types"

let firestore: Firestore | undefined
const memoryGroups = new Map<string, ModelPricingGroup>()
const memoryVersions = new Map<string, ModelPricingVersion>()
const memoryJobs = new Map<string, PricingJob>()
const runningJobs = new Set<string>()
type ProviderRows = Awaited<ReturnType<typeof listProviders>>
type PricingCatalog = {
  groups: ModelPricingGroup[]
  versions: ModelPricingVersion[]
  models: Model[]
  providers: ProviderRows
  modelById: Map<string, Model>
  modelByGatewayId: Map<string, Model>
  groupByModelId: Map<string, ModelPricingGroup>
  versionsByGroup: Map<string, ModelPricingVersion[]>
}
type PricingAdminData = Awaited<ReturnType<typeof buildPricingAdminData>>

let pricingCatalogCache: (PricingCatalog & { expiresAt: number }) | undefined
let pricingCatalogPromise: Promise<PricingCatalog> | undefined
let pricingAdminCache: { value: PricingAdminData; expiresAt: number } | undefined
let pricingAdminPromise: Promise<PricingAdminData> | undefined
let pricingJobsCache: { value: PricingJob[]; expiresAt: number } | undefined
let pricingJobsPromise: Promise<PricingJob[]> | undefined
let legacyMigrationPromise: Promise<boolean> | undefined
let legacyMigrationComplete = false
let pricingCacheGeneration = 0
let pricingAdminGeneration = 0
let pricingJobsGeneration = 0

const pricingCatalogTtlMs = positiveDuration(process.env.PRICING_CATALOG_CACHE_TTL_MS, 30_000)
const pricingAdminTtlMs = positiveDuration(process.env.PRICING_ADMIN_CACHE_TTL_MS, 5_000)
const pricingJobsTtlMs = positiveDuration(process.env.PRICING_JOBS_CACHE_TTL_MS, 2_000)

export function getModelPricingGeneration() { return pricingCacheGeneration }

function isMemory() { return process.env.STORAGE_BACKEND === "memory" || process.env.NODE_ENV === "test" }
function prefix() { return (process.env.FIRESTORE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_") }
function db() {
  if (firestore) return firestore
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replaceAll("\\n", "\n")
  const app = getApps().length ? getApp() : initializeApp({ credential: projectId && clientEmail && privateKey ? cert({ projectId, clientEmail, privateKey }) : applicationDefault(), projectId })
  firestore = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || "(default)")
  return firestore
}
function groupsRef() { return db().collection(`${prefix()}_model_pricing_groups`) }
function versionsRef() { return db().collection(`${prefix()}_model_pricing_versions`) }
function jobsRef() { return db().collection(`${prefix()}_model_pricing_jobs`) }
function legacyPricingRef() { return db().collection(`${prefix()}_model_pricing`) }
function stableGroupId(key: string) { return `fixed-${createHash("sha1").update(key).digest("hex").slice(0, 20)}` }
function positiveDuration(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
function invalidatePricingAdmin() {
  pricingAdminGeneration += 1
  pricingAdminCache = undefined
  pricingAdminPromise = undefined
}
function invalidatePricingJobs() {
  pricingJobsGeneration += 1
  pricingJobsCache = undefined
  pricingJobsPromise = undefined
  invalidatePricingAdmin()
}
function invalidatePricingCatalog() {
  pricingCacheGeneration += 1
  pricingCatalogCache = undefined
  pricingCatalogPromise = undefined
  invalidatePricingAdmin()
}

function modelGroupKey(model: Model, providerPrefixes: Map<string, string>) {
  const prefix = providerPrefixes.get(model.providerId)?.trim()
  if (!prefix) return model.gatewayModelId.trim()
  const prefixPath = `${prefix}/`
  return model.gatewayModelId.startsWith(prefixPath) ? model.gatewayModelId.slice(prefixPath.length).trim() : model.gatewayModelId.trim()
}

function modelGroupLabel(model: Model, providerPrefixes: Map<string, string>) {
  return model.name.trim() || modelGroupKey(model, providerPrefixes)
}

type CanonicalLinkInput = { id: string; source: PricingCanonicalSource; name?: string; provider?: string } | null

function applyCanonicalLink(group: ModelPricingGroup, canonical: CanonicalLinkInput | undefined) {
  if (canonical === undefined) return group
  const next = { ...group }
  delete next.canonicalModelId
  delete next.canonicalSource
  delete next.canonicalModelName
  delete next.canonicalProvider
  if (canonical?.id.trim()) {
    next.canonicalModelId = canonical.id.trim()
    next.canonicalSource = canonical.source
    if (canonical.name?.trim()) next.canonicalModelName = canonical.name.trim()
    if (canonical.provider?.trim()) next.canonicalProvider = canonical.provider.trim()
  }
  return next
}

function validateRates(rates: PricingRates) {
  for (const value of Object.values(rates)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Pricing rates must be non-negative integers in micros per million tokens.")
  }
}

function validateTiers(tiers: PricingContextTier[]) {
  const seen = new Set<number>()
  for (const tier of tiers) {
    if (!Number.isSafeInteger(tier.thresholdTokens) || tier.thresholdTokens <= 0 || seen.has(tier.thresholdTokens)) throw new Error("Context thresholds must be unique positive integers.")
    validateRates({ inputMicrosPerMillion: tier.inputMicrosPerMillion, outputMicrosPerMillion: tier.outputMicrosPerMillion, cacheReadMicrosPerMillion: tier.cacheReadMicrosPerMillion, cacheCreationMicrosPerMillion: tier.cacheCreationMicrosPerMillion })
    seen.add(tier.thresholdTokens)
  }
  return [...tiers].sort((a, b) => a.thresholdTokens - b.thresholdTokens)
}

async function readGroups() {
  if (isMemory()) return [...memoryGroups.values()]
  const snapshot = await groupsRef().get()
  return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id } as ModelPricingGroup))
}

async function readVersions() {
  if (isMemory()) return [...memoryVersions.values()]
  const snapshot = await versionsRef().get()
  return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id } as ModelPricingVersion))
}

async function writeGroup(group: ModelPricingGroup) {
  if (isMemory()) memoryGroups.set(group.id, group)
  else await groupsRef().doc(group.id).set(group)
  invalidatePricingCatalog()
}

async function writeGroups(groups: ModelPricingGroup[]) {
  if (!groups.length) return
  if (isMemory()) {
    for (const group of groups) memoryGroups.set(group.id, group)
  } else {
    for (let offset = 0; offset < groups.length; offset += 450) {
      const batch = db().batch()
      for (const group of groups.slice(offset, offset + 450)) batch.set(groupsRef().doc(group.id), group)
      await batch.commit()
    }
  }
  invalidatePricingCatalog()
}

async function writeVersion(version: ModelPricingVersion) {
  if (isMemory()) memoryVersions.set(version.id, version)
  else await versionsRef().doc(version.id).set(version)
  invalidatePricingCatalog()
}

async function writeVersions(versions: ModelPricingVersion[]) {
  if (!versions.length) return
  if (isMemory()) {
    for (const version of versions) memoryVersions.set(version.id, version)
  } else {
    for (let offset = 0; offset < versions.length; offset += 450) {
      const batch = db().batch()
      for (const version of versions.slice(offset, offset + 450)) batch.set(versionsRef().doc(version.id), version)
      await batch.commit()
    }
  }
  invalidatePricingCatalog()
}

export async function syncModelPricingGroups() {
  const [models, providers] = await Promise.all([listModels(), listProviders()])
  const providerPrefixes = new Map(providers.map((provider) => [provider.id, provider.prefix]))
  const existing = await readGroups()
  const existingById = new Map<string, ModelPricingGroup>(existing.map((group) => [group.id, group]))
  const customAssigned = new Set(existing.filter((group) => group.kind === "custom").flatMap((group) => group.memberModelIds))
  const fixedAddedOwner = new Map<string, string>()
  for (const group of existing.filter((entry) => entry.kind === "fixed")) {
    for (const modelId of group.addedModelIds || []) {
      if (!fixedAddedOwner.has(modelId)) fixedAddedOwner.set(modelId, group.id)
    }
  }
  const grouped = new Map<string, Model[]>()
  for (const model of models) {
    const key = modelGroupKey(model, providerPrefixes)
    const entries = grouped.get(key)
    if (entries) entries.push(model)
    else grouped.set(key, [model])
  }
  const validModelIds = new Set(models.map((model) => model.id))
  const now = new Date().toISOString()
  const writes: ModelPricingGroup[] = []
  for (const [key, groupedModels] of grouped) {
    const id = stableGroupId(key)
    const current = existingById.get(id)
    const availableIds = new Set(groupedModels.map((model) => model.id))
    const addedModelIds = [...new Set(current?.addedModelIds || [])].filter((modelId) => validModelIds.has(modelId) && !availableIds.has(modelId) && !customAssigned.has(modelId) && (!fixedAddedOwner.has(modelId) || fixedAddedOwner.get(modelId) === id))
    const excluded = [...new Set([
      ...(current?.excludedModelIds || []),
      ...groupedModels.map((model) => model.id).filter((modelId) => customAssigned.has(modelId)),
      ...groupedModels.map((model) => model.id).filter((modelId) => fixedAddedOwner.has(modelId) && fixedAddedOwner.get(modelId) !== id),
    ])].filter((modelId) => availableIds.has(modelId))
    const excludedIds = new Set(excluded)
    const memberModelIds = [...groupedModels.map((model) => model.id).filter((modelId) => !excludedIds.has(modelId)), ...addedModelIds]
    writes.push({
      ...current,
      id,
      name: current?.name?.trim() || modelGroupLabel(groupedModels[0], providerPrefixes),
      kind: "fixed",
      groupKey: key,
      memberModelIds,
      excludedModelIds: excluded,
      addedModelIds,
      createdAt: current?.createdAt || now,
      updatedAt: now,
    })
  }
  await writeGroups(writes)
  return readGroups()
}

export async function listPricingGroups() { return (await readGroups()).sort((a, b) => a.name.localeCompare(b.name)) }
export async function listPricingVersions(groupId?: string) {
  return (await readVersions()).filter((version) => !groupId || version.groupId === groupId).sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))
}

export function activePricingVersion(versions: ModelPricingVersion[], at = new Date()) {
  const atMs = at.getTime()
  let selected: ModelPricingVersion | undefined
  let selectedAt = -Infinity
  for (const version of versions) {
    const effectiveAt = Date.parse(version.effectiveAt)
    if (effectiveAt <= atMs && (effectiveAt > selectedAt || (effectiveAt === selectedAt && version.version > (selected?.version || 0)))) {
      selected = version
      selectedAt = effectiveAt
    }
  }
  return selected
}

async function migrateLegacyPricing(catalog: PricingCatalog) {
  if (isMemory()) return false
  const legacy = await legacyPricingRef().get()
  if (legacy.empty) return false

  const groupsWithVersions = new Set(catalog.versions.map((version) => version.groupId))
  const writes: ModelPricingVersion[] = []
  for (const document of legacy.docs) {
    const entry = document.data() as Record<string, unknown>
    const modelId = typeof entry.modelId === "string" ? entry.modelId : undefined
    const gatewayModelId = typeof entry.gatewayModelId === "string" ? entry.gatewayModelId : undefined
    const target = (modelId ? catalog.modelById.get(modelId) : undefined) || (gatewayModelId ? catalog.modelByGatewayId.get(gatewayModelId) : undefined)
    if (!target) continue
    const group = catalog.groupByModelId.get(target.id)
    if (!group || groupsWithVersions.has(group.id)) continue
    const updatedAt = typeof entry.updatedAt === "string" && Number.isFinite(Date.parse(entry.updatedAt)) ? entry.updatedAt : new Date().toISOString()
    writes.push({ id: crypto.randomUUID(), groupId: group.id, version: 1, effectiveAt: updatedAt, createdAt: updatedAt, updatedAt, inputMicrosPerMillion: Number(entry.inputMicrosPerMillion) || 0, outputMicrosPerMillion: Number(entry.outputMicrosPerMillion) || 0, cacheReadMicrosPerMillion: Number(entry.cacheReadMicrosPerMillion) || 0, cacheCreationMicrosPerMillion: Number(entry.cacheCreationMicrosPerMillion) || 0, contextTiers: [] })
    groupsWithVersions.add(group.id)
  }
  await writeVersions(writes)
  return writes.length > 0
}

async function ensureLegacyPricingMigrated(catalog: PricingCatalog) {
  if (legacyMigrationComplete || isMemory()) return false
  if (!legacyMigrationPromise) {
    legacyMigrationPromise = migrateLegacyPricing(catalog).then((changed) => {
      legacyMigrationComplete = true
      return changed
    }).finally(() => { legacyMigrationPromise = undefined })
  }
  return legacyMigrationPromise
}

async function buildPricingAdminData() {
  let catalog = await loadPricingCatalog()
  if (await ensureLegacyPricingMigrated(catalog)) catalog = await loadPricingCatalog()

  const providerPrefixes = new Map(catalog.providers.map((provider) => [provider.id, provider.prefix]))
  const canonicalIds = new Set(catalog.groups
    .filter((group) => group.canonicalSource !== "custom")
    .map((group) => group.canonicalModelId)
    .filter((id): id is string => Boolean(id)))
  const [jobs, canonicalModels] = await Promise.all([
    listPricingJobs(),
    canonicalIds.size ? findModelsDevCanonicalModels(canonicalIds).catch(() => []) : Promise.resolve([]),
  ])
  const canonicalById = new Map<string, CanonicalModelSummary>()
  for (const model of canonicalModels) {
    if (canonicalIds.has(model.id)) canonicalById.set(model.id, model)
  }

  const modelRows = catalog.models.map((model) => ({ id: model.id, name: model.name, groupKey: modelGroupKey(model, providerPrefixes), gatewayModelId: model.gatewayModelId, upstreamModel: model.upstreamModel, providerId: model.providerId, enabled: model.enabled }))
  return {
    groups: catalog.groups.map((group) => {
      const versions = catalog.versionsByGroup.get(group.id) || []
      return {
        ...group,
        canonicalModel: group.canonicalModelId ? canonicalById.get(group.canonicalModelId) || null : null,
        versions: [...versions].sort((a, b) => b.version - a.version),
        currentVersion: activePricingVersion(versions) || null,
      }
    }),
    models: modelRows,
    ungroupedModels: modelRows.filter((model) => !catalog.groupByModelId.has(model.id)),
    jobs,
  }
}

export async function getPricingAdminData() {
  const now = Date.now()
  if (pricingAdminCache && pricingAdminCache.expiresAt > now) return pricingAdminCache.value
  if (pricingAdminPromise) return pricingAdminPromise

  const generation = pricingAdminGeneration
  const promise = buildPricingAdminData().then((value) => {
    if (generation === pricingAdminGeneration) pricingAdminCache = { value, expiresAt: Date.now() + pricingAdminTtlMs }
    return value
  }).finally(() => {
    if (pricingAdminPromise === promise) pricingAdminPromise = undefined
  })
  pricingAdminPromise = promise
  return promise
}

export async function createPricingGroup(name: string, modelIds: string[], canonical?: CanonicalLinkInput) {
  const models = await listModels()
  const validIds = new Set(models.map((model) => model.id))
  const normalizedIds = [...new Set(modelIds)].filter((id) => validIds.has(id))
  const groups = await listPricingGroups()
  const assigned = new Set(groups.flatMap((group) => group.memberModelIds))
  if (normalizedIds.some((id) => assigned.has(id))) throw new Error("A model can belong to only one pricing group.")
  const now = new Date().toISOString()
  const group = applyCanonicalLink({ id: crypto.randomUUID(), name: name.trim() || models.find((model) => model.id === normalizedIds[0])?.name || "", kind: "custom", memberModelIds: normalizedIds, excludedModelIds: [], createdAt: now, updatedAt: now }, canonical)
  if (!group.name) throw new Error("Pricing group name is required.")
  await writeGroup(group)
  return group
}

export async function updatePricingGroup(groupId: string, modelIds: string[], canonical?: CanonicalLinkInput, name?: string) {
  const groups = await listPricingGroups()
  const current = groups.find((group) => group.id === groupId)
  if (!current) throw new Error("Pricing group not found.")
  const [models, providers] = await Promise.all([listModels(), listProviders()])
  const providerPrefixes = new Map(providers.map((provider) => [provider.id, provider.prefix]))
  const validIds = new Set(models.map((model) => model.id))
  const normalizedIds = [...new Set(modelIds)].filter((id) => validIds.has(id))
  const otherAssigned = new Set(groups.filter((group) => group.id !== groupId).flatMap((group) => group.memberModelIds))
  if (normalizedIds.some((id) => otherAssigned.has(id))) throw new Error("A model can belong to only one pricing group.")
  const now = new Date().toISOString()
  const naturalIds = current.kind === "fixed"
    ? new Set(models.filter((model) => modelGroupKey(model, providerPrefixes) === current.groupKey).map((model) => model.id))
    : new Set<string>()
  const addedModelIds = current.kind === "fixed" ? normalizedIds.filter((id) => !naturalIds.has(id)) : []
  const excludedModelIds = current.kind === "fixed" ? [...naturalIds].filter((id) => !normalizedIds.includes(id)) : []
  const next = applyCanonicalLink({
    ...current,
    name: name?.trim() || current.name,
    memberModelIds: normalizedIds,
    excludedModelIds,
    ...(current.kind === "fixed" ? { addedModelIds } : {}),
    updatedAt: now,
  }, canonical)

  // A removed manual assignment can return to its natural fixed group.
  const releasedIds = new Set(current.memberModelIds.filter((id) => !normalizedIds.includes(id)))
  for (const fixed of groups.filter((entry) => entry.kind === "fixed" && entry.id !== groupId)) {
    const natural = new Set(models.filter((model) => modelGroupKey(model, providerPrefixes) === fixed.groupKey).map((model) => model.id))
    const nextExcluded = fixed.excludedModelIds.filter((id) => !(releasedIds.has(id) && natural.has(id)))
    if (nextExcluded.length !== fixed.excludedModelIds.length) await writeGroup({ ...fixed, excludedModelIds: nextExcluded, updatedAt: now })
  }
  await writeGroup(next)
  return next
}

export async function deletePricingGroup(groupId: string) {
  const groups = await listPricingGroups()
  const group = groups.find((entry) => entry.id === groupId)
  if (!group) return
  if (group.kind === "fixed") throw new Error("Fixed pricing groups cannot be deleted.")
  if (isMemory()) memoryGroups.delete(groupId)
  else await groupsRef().doc(groupId).delete()
  invalidatePricingCatalog()
  const released = new Set(group.memberModelIds)
  for (const fixed of groups.filter((entry) => entry.kind === "fixed")) {
    const excludedModelIds = fixed.excludedModelIds.filter((modelId) => released.has(modelId) ? false : true)
    if (excludedModelIds.length !== fixed.excludedModelIds.length) await writeGroup({ ...fixed, excludedModelIds, updatedAt: new Date().toISOString() })
  }
}

export async function savePricingVersion(input: { groupId: string; rates: PricingRates; contextTiers: PricingContextTier[]; mode: "new" | "replace" }) {
  const group = (await listPricingGroups()).find((entry) => entry.id === input.groupId)
  if (!group) throw new Error("Pricing group not found.")
  validateRates(input.rates)
  const contextTiers = validateTiers(input.contextTiers)
  const versions = await listPricingVersions(group.id)
  const current = activePricingVersion(versions)
  const now = new Date().toISOString()
  if (input.mode === "replace" && current) {
    const replaced = { ...current, ...input.rates, contextTiers, updatedAt: now }
    await writeVersion(replaced)
    const job = await createPricingJob(group.id, replaced.id)
    return { version: replaced, job }
  }
  const version: ModelPricingVersion = { id: crypto.randomUUID(), groupId: group.id, version: (versions.reduce((max, entry) => Math.max(max, entry.version), 0) || 0) + 1, effectiveAt: now, createdAt: now, updatedAt: now, ...input.rates, contextTiers }
  await writeVersion(version)
  return { version, job: null }
}

export async function getPricingForModelAt(model: { gatewayModelId: string; providerModelId?: string }, at = new Date()) {
  const catalog = await loadPricingCatalog()
  const target = (model.providerModelId ? catalog.modelById.get(model.providerModelId) : undefined) || catalog.modelByGatewayId.get(model.gatewayModelId)
  if (!target) return undefined
  const group = catalog.groupByModelId.get(target.id)
  if (!group) return undefined
  const version = activePricingVersion(catalog.versionsByGroup.get(group.id) || [], at)
  if (!version) return undefined
  return { ...version, groupId: group.id, pricingGroupId: group.id, pricingVersionId: version.id }
}

function indexPricingCatalog(groups: ModelPricingGroup[], versions: ModelPricingVersion[], models: Model[], providers: ProviderRows): PricingCatalog {
  const modelById = new Map(models.map((model) => [model.id, model]))
  const modelByGatewayId = new Map(models.map((model) => [model.gatewayModelId, model]))
  const groupByModelId = new Map<string, ModelPricingGroup>()
  for (const group of groups) {
    for (const modelId of group.memberModelIds) groupByModelId.set(modelId, group)
  }
  const versionsByGroup = new Map<string, ModelPricingVersion[]>()
  for (const version of versions) {
    const entries = versionsByGroup.get(version.groupId)
    if (entries) entries.push(version)
    else versionsByGroup.set(version.groupId, [version])
  }
  return { groups, versions, models, providers, modelById, modelByGatewayId, groupByModelId, versionsByGroup }
}

async function loadPricingCatalog() {
  if (pricingCatalogCache && pricingCatalogCache.expiresAt > Date.now()) return pricingCatalogCache
  if (!pricingCatalogPromise) {
    const promise = (async () => {
      let generation = pricingCacheGeneration
      let groups = await readGroups()
      if (!groups.length) {
        groups = await syncModelPricingGroups()
        generation = pricingCacheGeneration
      }
      const [versions, models, providers] = await Promise.all([readVersions(), listModels(), listProviders()])
      return { catalog: indexPricingCatalog(groups, versions, models, providers), generation }
    })().then(({ catalog, generation }) => {
      if (generation === pricingCacheGeneration) pricingCatalogCache = { ...catalog, expiresAt: Date.now() + pricingCatalogTtlMs }
      return catalog
    }).finally(() => {
      if (pricingCatalogPromise === promise) pricingCatalogPromise = undefined
    })
    pricingCatalogPromise = promise
  }
  return pricingCatalogPromise
}

async function listPricingJobs() {
  if (isMemory()) return [...memoryJobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50)
  const now = Date.now()
  if (pricingJobsCache && pricingJobsCache.expiresAt > now) return pricingJobsCache.value
  if (pricingJobsPromise) return pricingJobsPromise
  const generation = pricingJobsGeneration
  const promise = jobsRef().orderBy("updatedAt", "desc").limit(50).get().then((snapshot) => {
    const value = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id } as PricingJob))
    if (generation === pricingJobsGeneration) pricingJobsCache = { value, expiresAt: Date.now() + pricingJobsTtlMs }
    return value
  }).finally(() => {
    if (pricingJobsPromise === promise) pricingJobsPromise = undefined
  })
  pricingJobsPromise = promise
  return promise
}

export async function getPricingJob(jobId: string) {
  if (isMemory()) return memoryJobs.get(jobId)
  const snapshot = await jobsRef().doc(jobId).get()
  return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } as PricingJob : undefined
}

async function writeJob(job: PricingJob) {
  if (isMemory()) memoryJobs.set(job.id, job)
  else await jobsRef().doc(job.id).set(job)
  invalidatePricingJobs()
}

async function createPricingJob(groupId: string, versionId: string) {
  const now = new Date().toISOString()
  const job: PricingJob = { id: crypto.randomUUID(), groupId, versionId, status: "queued", totalEvents: 0, processedEvents: 0, updatedAt: now }
  await writeJob(job)
  return job
}

export async function updatePricingJob(jobId: string, update: Partial<PricingJob>) {
  const current = await getPricingJob(jobId)
  if (!current) return
  const next = { ...current, ...update, updatedAt: new Date().toISOString() }
  await writeJob(next)
  return next
}

export async function runPricingJob(jobId: string) {
  if (runningJobs.has(jobId)) return
  runningJobs.add(jobId)
  try {
    const { repriceUsageForGroup } = await import("@/lib/analytics")
    await repriceUsageForGroup(jobId)
  } catch (error) {
    await updatePricingJob(jobId, { status: "failed", error: error instanceof Error ? error.message : "Unable to reprice usage.", completedAt: new Date().toISOString() })
  } finally {
    runningJobs.delete(jobId)
  }
}

export function resetModelPricingForTests() {
  memoryGroups.clear()
  memoryVersions.clear()
  memoryJobs.clear()
  runningJobs.clear()
  legacyMigrationComplete = false
  legacyMigrationPromise = undefined
  invalidatePricingJobs()
  invalidatePricingCatalog()
}
