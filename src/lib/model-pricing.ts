import { createHash } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

import { findModelsDevCanonicalModel } from "@/lib/models-dev"
import { listModels, listProviders } from "@/lib/store"
import type { CanonicalModelSummary, Model, ModelPricingGroup, ModelPricingVersion, PricingCanonicalSource, PricingJob, PricingRates, PricingContextTier } from "@/lib/types"

let firestore: Firestore | undefined
const memoryGroups = new Map<string, ModelPricingGroup>()
const memoryVersions = new Map<string, ModelPricingVersion>()
const memoryJobs = new Map<string, PricingJob>()
const runningJobs = new Set<string>()
let pricingCatalogCache: { groups: ModelPricingGroup[]; versions: ModelPricingVersion[]; models: Model[]; providers: Awaited<ReturnType<typeof listProviders>>; expiresAt: number } | undefined
let pricingCatalogPromise: Promise<{ groups: ModelPricingGroup[]; versions: ModelPricingVersion[]; models: Model[]; providers: Awaited<ReturnType<typeof listProviders>> }> | undefined

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
function invalidatePricingCatalog() { pricingCatalogCache = undefined }

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

async function writeVersion(version: ModelPricingVersion) {
  if (isMemory()) memoryVersions.set(version.id, version)
  else await versionsRef().doc(version.id).set(version)
  invalidatePricingCatalog()
}

export async function syncModelPricingGroups() {
  const [models, providers] = await Promise.all([listModels(), listProviders()])
  const providerPrefixes = new Map(providers.map((provider) => [provider.id, provider.prefix]))
  const existing = await readGroups()
  const existingById = new Map(existing.map((group) => [group.id, group]))
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
    grouped.set(key, [...(grouped.get(key) || []), model])
  }
  const validModelIds = new Set(models.map((model) => model.id))
  const now = new Date().toISOString()
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
    const memberModelIds = [...groupedModels.map((model) => model.id).filter((modelId) => !excluded.includes(modelId)), ...addedModelIds]
    await writeGroup({
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
  return readGroups()
}

export async function listPricingGroups() { return (await readGroups()).sort((a, b) => a.name.localeCompare(b.name)) }
export async function listPricingVersions(groupId?: string) {
  return (await readVersions()).filter((version) => !groupId || version.groupId === groupId).sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))
}

async function ensurePricingGroups() {
  const groups = await readGroups()
  return groups.length ? groups : syncModelPricingGroups()
}

export function activePricingVersion(versions: ModelPricingVersion[], at = new Date()) {
  return versions.filter((version) => Date.parse(version.effectiveAt) <= at.getTime()).sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0]
}

export async function getPricingAdminData() {
  await ensurePricingGroups()
  const [models, providers] = await Promise.all([listModels(), listProviders()])
  const providerPrefixes = new Map(providers.map((provider) => [provider.id, provider.prefix]))
  await migrateLegacyPricing(models)
  const [groups, versions, jobs] = await Promise.all([listPricingGroups(), readVersions(), listPricingJobs()])
  const assigned = new Set(groups.flatMap((group) => group.memberModelIds))
  const versionsByGroup = new Map<string, ModelPricingVersion[]>()
  for (const version of versions) versionsByGroup.set(version.groupId, [...(versionsByGroup.get(version.groupId) || []), version])
  const modelRows = models.map((model) => ({ id: model.id, name: model.name, groupKey: modelGroupKey(model, providerPrefixes), gatewayModelId: model.gatewayModelId, upstreamModel: model.upstreamModel, providerId: model.providerId, enabled: model.enabled }))
  const canonicalById = new Map<string, CanonicalModelSummary>()
  await Promise.all([...new Set(groups.filter((group) => group.canonicalSource !== "custom").map((group) => group.canonicalModelId).filter((id): id is string => Boolean(id)))].map(async (id) => {
    const model = await findModelsDevCanonicalModel(id).catch(() => undefined)
    if (model) canonicalById.set(id, model)
  }))
  return {
    groups: groups.map((group) => ({
      ...group,
      canonicalModel: group.canonicalModelId ? canonicalById.get(group.canonicalModelId) || null : null,
      versions: (versionsByGroup.get(group.id) || []).sort((a, b) => b.version - a.version),
      currentVersion: activePricingVersion(versionsByGroup.get(group.id) || []) || null,
    })),
    models: modelRows,
    ungroupedModels: modelRows.filter((model) => !assigned.has(model.id)),
    jobs,
  }
}

async function migrateLegacyPricing(models: Model[]) {
  if (isMemory()) return
  const legacy = await legacyPricingRef().get()
  if (legacy.empty) return
  const groups = await listPricingGroups()
  const versions = await readVersions()
  for (const document of legacy.docs) {
    const entry = document.data() as Record<string, unknown>
    const target = models.find((model) => model.id === entry.modelId || model.gatewayModelId === entry.gatewayModelId)
    if (!target) continue
    const group = groups.find((candidate) => candidate.memberModelIds.includes(target.id))
    if (!group || versions.some((version) => version.groupId === group.id)) continue
    const updatedAt = typeof entry.updatedAt === "string" && Number.isFinite(Date.parse(entry.updatedAt)) ? entry.updatedAt : new Date().toISOString()
    await writeVersion({ id: crypto.randomUUID(), groupId: group.id, version: 1, effectiveAt: updatedAt, createdAt: updatedAt, updatedAt, inputMicrosPerMillion: Number(entry.inputMicrosPerMillion) || 0, outputMicrosPerMillion: Number(entry.outputMicrosPerMillion) || 0, cacheReadMicrosPerMillion: Number(entry.cacheReadMicrosPerMillion) || 0, cacheCreationMicrosPerMillion: Number(entry.cacheCreationMicrosPerMillion) || 0, contextTiers: [] })
  }
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
    schedulePricingJob(job.id)
    return { version: replaced, job }
  }
  const version: ModelPricingVersion = { id: crypto.randomUUID(), groupId: group.id, version: (versions.reduce((max, entry) => Math.max(max, entry.version), 0) || 0) + 1, effectiveAt: now, createdAt: now, updatedAt: now, ...input.rates, contextTiers }
  await writeVersion(version)
  return { version, job: null }
}

export async function getPricingForModelAt(model: { gatewayModelId: string; providerModelId?: string }, at = new Date()) {
  const catalog = await loadPricingCatalog()
  const target = catalog.models.find((entry) => entry.id === model.providerModelId || entry.gatewayModelId === model.gatewayModelId)
  if (!target) return undefined
  const group = catalog.groups.find((entry) => entry.memberModelIds.includes(target.id))
  if (!group) return undefined
  const version = activePricingVersion(catalog.versions.filter((entry) => entry.groupId === group.id), at)
  if (!version) return undefined
  return { ...version, groupId: group.id, pricingGroupId: group.id, pricingVersionId: version.id }
}

async function loadPricingCatalog() {
  if (pricingCatalogCache && pricingCatalogCache.expiresAt > Date.now()) return pricingCatalogCache
  if (!pricingCatalogPromise) {
    pricingCatalogPromise = (async () => {
      let groups = await readGroups()
      if (!groups.length) groups = await syncModelPricingGroups()
      const [versions, models, providers] = await Promise.all([readVersions(), listModels(), listProviders()])
      return { groups, versions, models, providers }
    })().then((catalog) => {
      pricingCatalogCache = { ...catalog, expiresAt: Date.now() + 2_000 }
      return catalog
    }).finally(() => { pricingCatalogPromise = undefined })
  }
  return pricingCatalogPromise
}

async function listPricingJobs() {
  if (isMemory()) return [...memoryJobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const snapshot = await jobsRef().get()
  return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id } as PricingJob)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getPricingJob(jobId: string) {
  if (isMemory()) return memoryJobs.get(jobId)
  const snapshot = await jobsRef().doc(jobId).get()
  return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } as PricingJob : undefined
}

async function writeJob(job: PricingJob) {
  if (isMemory()) memoryJobs.set(job.id, job)
  else await jobsRef().doc(job.id).set(job)
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

export function schedulePricingJob(jobId: string) {
  if (runningJobs.has(jobId)) return
  runningJobs.add(jobId)
  setTimeout(() => {
    void import("@/lib/analytics").then(({ repriceUsageForGroup }) => repriceUsageForGroup(jobId)).catch(async (error) => {
      await updatePricingJob(jobId, { status: "failed", error: error instanceof Error ? error.message : "Unable to reprice usage.", completedAt: new Date().toISOString() })
    }).finally(() => runningJobs.delete(jobId))
  }, 0)
}

export function resetModelPricingForTests() {
  memoryGroups.clear()
  memoryVersions.clear()
  memoryJobs.clear()
  runningJobs.clear()
  invalidatePricingCatalog()
}
