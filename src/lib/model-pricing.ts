import { createHash } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

import { findModelsDevCanonicalModels } from "@/lib/models-dev"
import { listModels, listProviders } from "@/lib/store"
import type { CanonicalModelSummary, Model, ModelPricingGroup, ModelPricingVersion, PricingCanonicalSource, PricingJob, PricingRates, PricingContextTier } from "@/lib/types"
import { currentWorkspaceId, usesLegacyWorkspaceStorage } from "@/lib/workspace-context"

let firestore: Firestore | undefined
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

interface PricingWorkspaceState {
  groups: Map<string, ModelPricingGroup>
  versions: Map<string, ModelPricingVersion>
  jobs: Map<string, PricingJob>
  runningJobs: Set<string>
  pricingCatalogCache?: PricingCatalog & { expiresAt: number }
  pricingCatalogPromise?: Promise<PricingCatalog>
  pricingAdminCache?: { value: PricingAdminData; expiresAt: number }
  pricingAdminPromise?: Promise<PricingAdminData>
  pricingJobsCache?: { value: PricingJob[]; expiresAt: number }
  pricingJobsPromise?: Promise<PricingJob[]>
  legacyMigrationPromise?: Promise<boolean>
  legacyMigrationComplete: boolean
  pricingCacheGeneration: number
  pricingAdminGeneration: number
  pricingJobsGeneration: number
}
declare global { var __rawroutePricingMemory: Map<string, PricingWorkspaceState> | undefined }
const configuredMaximumPricingWorkspaceEntries = Number(process.env.MAX_WORKSPACE_CACHE_ENTRIES || 256)
const maximumPricingWorkspaceEntries = Number.isSafeInteger(configuredMaximumPricingWorkspaceEntries) && configuredMaximumPricingWorkspaceEntries > 0 ? configuredMaximumPricingWorkspaceEntries : 256
function workspaceStates() { return globalThis.__rawroutePricingMemory ||= new Map<string, PricingWorkspaceState>() }
function workspaceState() {
  const workspaceId = currentWorkspaceId()
  const states = workspaceStates()
  let state = states.get(workspaceId)
  if (state && !isMemory()) {
    states.delete(workspaceId)
    states.set(workspaceId, state)
  }
  if (!state) {
    if (!isMemory()) {
      while (states.size >= maximumPricingWorkspaceEntries) {
        const evictable = [...states].find(([, candidate]) => candidate.runningJobs.size === 0
          && !candidate.pricingCatalogPromise
          && !candidate.pricingAdminPromise
          && !candidate.pricingJobsPromise
          && !candidate.legacyMigrationPromise)
        if (!evictable) break
        states.delete(evictable[0])
      }
    }
    state = { groups: new Map(), versions: new Map(), jobs: new Map(), runningJobs: new Set(), legacyMigrationComplete: false, pricingCacheGeneration: 0, pricingAdminGeneration: 0, pricingJobsGeneration: 0 }
    states.set(workspaceId, state)
  }
  return state
}

const pricingCatalogTtlMs = positiveDuration(process.env.PRICING_CATALOG_CACHE_TTL_MS, 30_000)
const pricingAdminTtlMs = positiveDuration(process.env.PRICING_ADMIN_CACHE_TTL_MS, 5_000)
const pricingJobsTtlMs = positiveDuration(process.env.PRICING_JOBS_CACHE_TTL_MS, 2_000)

export function getModelPricingGeneration() { return workspaceState().pricingCacheGeneration }

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
function workspaceRef() { return db().collection(`${prefix()}_workspaces`).doc(currentWorkspaceId()) }
function groupsRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_model_pricing_groups`) : workspaceRef().collection("modelPricingGroups") }
function versionsRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_model_pricing_versions`) : workspaceRef().collection("modelPricingVersions") }
function jobsRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_model_pricing_jobs`) : workspaceRef().collection("modelPricingJobs") }
function legacyPricingRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_model_pricing`) : workspaceRef().collection("modelPricing") }
function stableGroupId(key: string) { return `fixed-${createHash("sha1").update(key).digest("hex").slice(0, 20)}` }
function positiveDuration(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
function invalidatePricingAdmin() {
  const state = workspaceState()
  state.pricingAdminGeneration += 1
  state.pricingAdminCache = undefined
  state.pricingAdminPromise = undefined
}
function invalidatePricingJobs() {
  const state = workspaceState()
  state.pricingJobsGeneration += 1
  state.pricingJobsCache = undefined
  state.pricingJobsPromise = undefined
  invalidatePricingAdmin()
}
function invalidatePricingCatalog() {
  const state = workspaceState()
  state.pricingCacheGeneration += 1
  state.pricingCatalogCache = undefined
  state.pricingCatalogPromise = undefined
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
  if (isMemory()) return [...workspaceState().groups.values()]
  const snapshot = await groupsRef().get()
  return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id } as ModelPricingGroup))
}

async function readVersions(groupId?: string) {
  if (isMemory()) {
    const versions = [...workspaceState().versions.values()]
    return groupId ? versions.filter((version) => version.groupId === groupId) : versions
  }
  const reference = groupId ? versionsRef().where("groupId", "==", groupId) : versionsRef()
  const snapshot = await reference.get()
  return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id } as ModelPricingVersion))
}

async function writeGroupChanges(groups: ModelPricingGroup[], deleteIds: string[] = []) {
  if (!groups.length && !deleteIds.length) return
  if (isMemory()) {
    for (const group of groups) workspaceState().groups.set(group.id, group)
    for (const id of deleteIds) workspaceState().groups.delete(id)
  } else {
    const operations: Array<{ type: "set"; group: ModelPricingGroup } | { type: "delete"; id: string }> = [
      ...groups.map((group) => ({ type: "set" as const, group })),
      ...deleteIds.map((id) => ({ type: "delete" as const, id })),
    ]
    for (let offset = 0; offset < operations.length; offset += 450) {
      const batch = db().batch()
      for (const operation of operations.slice(offset, offset + 450)) {
        if (operation.type === "set") batch.set(groupsRef().doc(operation.group.id), operation.group)
        else batch.delete(groupsRef().doc(operation.id))
      }
      await batch.commit()
    }
  }
  invalidatePricingCatalog()
}

async function writeGroup(group: ModelPricingGroup) { return writeGroupChanges([group]) }
async function writeGroups(groups: ModelPricingGroup[]) { return writeGroupChanges(groups) }

async function writeVersion(version: ModelPricingVersion) {
  if (isMemory()) workspaceState().versions.set(version.id, version)
  else await versionsRef().doc(version.id).set(version)
  invalidatePricingCatalog()
}

async function writeVersions(versions: ModelPricingVersion[]) {
  if (!versions.length) return
  if (isMemory()) {
    for (const version of versions) workspaceState().versions.set(version.id, version)
  } else {
    for (let offset = 0; offset < versions.length; offset += 450) {
      const batch = db().batch()
      for (const version of versions.slice(offset, offset + 450)) batch.set(versionsRef().doc(version.id), version)
      await batch.commit()
    }
  }
  invalidatePricingCatalog()
}

function sameStringMembers(left: string[] | undefined, right: string[] | undefined) {
  const leftValues = left || []
  const rightValues = right || []
  if (leftValues.length !== rightValues.length) return false
  const members = new Set(leftValues)
  if (members.size !== leftValues.length) return false
  for (const value of rightValues) if (!members.has(value)) return false
  return true
}

function samePricingGroupDefinition(left: ModelPricingGroup, right: ModelPricingGroup) {
  return left.id === right.id
    && left.name === right.name
    && left.kind === right.kind
    && left.groupKey === right.groupKey
    && left.createdAt === right.createdAt
    && left.canonicalModelId === right.canonicalModelId
    && left.canonicalSource === right.canonicalSource
    && left.canonicalModelName === right.canonicalModelName
    && left.canonicalProvider === right.canonicalProvider
    && sameStringMembers(left.memberModelIds, right.memberModelIds)
    && sameStringMembers(left.excludedModelIds, right.excludedModelIds)
    && sameStringMembers(left.addedModelIds, right.addedModelIds)
}

async function reconcileModelPricingGroups(existing: ModelPricingGroup[], models: Model[], providers: ProviderRows) {
  const providerPrefixes = new Map(providers.map((provider) => [provider.id, provider.prefix]))
  const existingById = new Map<string, ModelPricingGroup>(existing.map((group) => [group.id, group]))
  const nextById = new Map(existingById)
  const customAssigned = new Set<string>()
  const fixedAddedOwner = new Map<string, string>()
  for (const group of existing) {
    if (group.kind === "custom") {
      for (const modelId of group.memberModelIds) customAssigned.add(modelId)
    } else {
      for (const modelId of group.addedModelIds || []) {
        if (!fixedAddedOwner.has(modelId)) fixedAddedOwner.set(modelId, group.id)
      }
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
    const candidate: ModelPricingGroup = {
      ...current,
      id,
      name: current?.name?.trim() || modelGroupLabel(groupedModels[0], providerPrefixes),
      kind: "fixed",
      groupKey: key,
      memberModelIds,
      excludedModelIds: excluded,
      addedModelIds,
      createdAt: current?.createdAt || now,
      updatedAt: current?.updatedAt || now,
    }
    if (current && samePricingGroupDefinition(current, candidate)) {
      nextById.set(id, current)
      continue
    }
    candidate.updatedAt = now
    nextById.set(id, candidate)
    writes.push(candidate)
  }
  await writeGroups(writes)
  return [...nextById.values()]
}

export async function syncModelPricingGroups() {
  const [models, providers, existing] = await Promise.all([listModels(), listProviders(), readGroups()])
  return reconcileModelPricingGroups(existing, models, providers)
}

export async function listPricingGroups() { return (await readGroups()).sort((a, b) => a.name.localeCompare(b.name)) }
export async function listPricingVersions(groupId?: string) {
  return (await readVersions(groupId)).filter((version) => !groupId || version.groupId === groupId).sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))
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
  const state = workspaceState()
  if (state.legacyMigrationComplete || isMemory()) return false
  if (!state.legacyMigrationPromise) {
    state.legacyMigrationPromise = migrateLegacyPricing(catalog).then((changed) => {
      state.legacyMigrationComplete = true
      return changed
    }).finally(() => { state.legacyMigrationPromise = undefined })
  }
  return state.legacyMigrationPromise
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
  const state = workspaceState()
  const now = Date.now()
  if (state.pricingAdminCache && state.pricingAdminCache.expiresAt > now) return state.pricingAdminCache.value
  if (state.pricingAdminPromise) return state.pricingAdminPromise

  const generation = state.pricingAdminGeneration
  const promise = buildPricingAdminData().then((value) => {
    if (generation === state.pricingAdminGeneration) state.pricingAdminCache = { value, expiresAt: Date.now() + pricingAdminTtlMs }
    return value
  }).finally(() => {
    if (state.pricingAdminPromise === promise) state.pricingAdminPromise = undefined
  })
  state.pricingAdminPromise = promise
  return promise
}

export async function createPricingGroup(name: string, modelIds: string[], canonical?: CanonicalLinkInput) {
  const models = await listModels()
  const validIds = new Set(models.map((model) => model.id))
  const normalizedIds = [...new Set(modelIds)].filter((id) => validIds.has(id))
  const groups = await listPricingGroups()
  const assigned = new Set<string>()
  for (const group of groups) for (const modelId of group.memberModelIds) assigned.add(modelId)
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
  const normalizedIdSet = new Set(normalizedIds)
  const otherAssigned = new Set<string>()
  for (const group of groups) {
    if (group.id === groupId) continue
    for (const modelId of group.memberModelIds) otherAssigned.add(modelId)
  }
  if (normalizedIds.some((id) => otherAssigned.has(id))) throw new Error("A model can belong to only one pricing group.")

  const naturalIdsByGroup = new Map<string, Set<string>>()
  for (const model of models) {
    const naturalGroupId = stableGroupId(modelGroupKey(model, providerPrefixes))
    let ids = naturalIdsByGroup.get(naturalGroupId)
    if (!ids) naturalIdsByGroup.set(naturalGroupId, ids = new Set())
    ids.add(model.id)
  }
  const now = new Date().toISOString()
  const naturalIds = current.kind === "fixed"
    ? naturalIdsByGroup.get(current.id) || new Set<string>()
    : new Set<string>()
  const addedModelIds = current.kind === "fixed" ? normalizedIds.filter((id) => !naturalIds.has(id)) : []
  const excludedModelIds = current.kind === "fixed" ? [...naturalIds].filter((id) => !normalizedIdSet.has(id)) : []
  const candidate = applyCanonicalLink({
    ...current,
    name: name?.trim() || current.name,
    memberModelIds: normalizedIds,
    excludedModelIds,
    ...(current.kind === "fixed" ? { addedModelIds } : {}),
    updatedAt: current.updatedAt,
  }, canonical)
  const next = samePricingGroupDefinition(current, candidate) ? current : { ...candidate, updatedAt: now }
  const writes: ModelPricingGroup[] = next === current ? [] : [next]

  // A removed manual assignment can return to its natural fixed group.
  const releasedIds = new Set(current.memberModelIds.filter((id) => !normalizedIdSet.has(id)))
  for (const fixed of groups) {
    if (fixed.kind !== "fixed" || fixed.id === groupId) continue
    const natural = naturalIdsByGroup.get(fixed.id)
    if (!natural) continue
    const nextExcluded = fixed.excludedModelIds.filter((id) => !(releasedIds.has(id) && natural.has(id)))
    if (nextExcluded.length !== fixed.excludedModelIds.length) writes.push({ ...fixed, excludedModelIds: nextExcluded, updatedAt: now })
  }
  await writeGroups(writes)
  return next
}

export async function deletePricingGroup(groupId: string) {
  const groups = await listPricingGroups()
  const group = groups.find((entry) => entry.id === groupId)
  if (!group) return
  if (group.kind === "fixed") throw new Error("Fixed pricing groups cannot be deleted.")
  const released = new Set(group.memberModelIds)
  const now = new Date().toISOString()
  const writes: ModelPricingGroup[] = []
  for (const fixed of groups) {
    if (fixed.kind !== "fixed") continue
    const excludedModelIds = fixed.excludedModelIds.filter((modelId) => !released.has(modelId))
    if (excludedModelIds.length !== fixed.excludedModelIds.length) writes.push({ ...fixed, excludedModelIds, updatedAt: now })
  }
  await writeGroupChanges(writes, [groupId])
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
  const state = workspaceState()
  if (state.pricingCatalogCache && state.pricingCatalogCache.expiresAt > Date.now()) return state.pricingCatalogCache
  if (!state.pricingCatalogPromise) {
    const promise = (async () => {
      let generation = state.pricingCacheGeneration
      const [initialGroups, versions, models, providers] = await Promise.all([readGroups(), readVersions(), listModels(), listProviders()])
      let groups = initialGroups
      if (!groups.length) {
        groups = await reconcileModelPricingGroups(groups, models, providers)
        generation = state.pricingCacheGeneration
      }
      return { catalog: indexPricingCatalog(groups, versions, models, providers), generation }
    })().then(({ catalog, generation }) => {
      if (generation === state.pricingCacheGeneration) state.pricingCatalogCache = { ...catalog, expiresAt: Date.now() + pricingCatalogTtlMs }
      return catalog
    }).finally(() => {
      if (state.pricingCatalogPromise === promise) state.pricingCatalogPromise = undefined
    })
    state.pricingCatalogPromise = promise
  }
  return state.pricingCatalogPromise
}

async function listPricingJobs() {
  const state = workspaceState()
  if (isMemory()) return [...state.jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50)
  const now = Date.now()
  if (state.pricingJobsCache && state.pricingJobsCache.expiresAt > now) return state.pricingJobsCache.value
  if (state.pricingJobsPromise) return state.pricingJobsPromise
  const generation = state.pricingJobsGeneration
  const promise = jobsRef().orderBy("updatedAt", "desc").limit(50).get().then((snapshot) => {
    const value = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id } as PricingJob))
    if (generation === state.pricingJobsGeneration) state.pricingJobsCache = { value, expiresAt: Date.now() + pricingJobsTtlMs }
    return value
  }).finally(() => {
    if (state.pricingJobsPromise === promise) state.pricingJobsPromise = undefined
  })
  state.pricingJobsPromise = promise
  return promise
}

export async function getPricingJob(jobId: string) {
  const state = workspaceState()
  if (isMemory()) return state.jobs.get(jobId)
  if (state.pricingJobsCache && state.pricingJobsCache.expiresAt > Date.now()) {
    const cached = state.pricingJobsCache.value.find((job) => job.id === jobId)
    if (cached) return cached
  }
  const snapshot = await jobsRef().doc(jobId).get()
  return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } as PricingJob : undefined
}

async function writeJob(job: PricingJob) {
  if (isMemory()) workspaceState().jobs.set(job.id, job)
  else await jobsRef().doc(job.id).set(job)
  invalidatePricingJobs()
}

async function createPricingJob(groupId: string, versionId: string) {
  const now = new Date().toISOString()
  const job: PricingJob = { id: crypto.randomUUID(), groupId, versionId, status: "queued", totalEvents: 0, processedEvents: 0, updatedAt: now }
  await writeJob(job)
  return job
}

export async function updatePricingJob(jobId: string, update: Partial<PricingJob>, knownCurrent?: PricingJob) {
  const current = knownCurrent?.id === jobId ? knownCurrent : await getPricingJob(jobId)
  if (!current) return
  const next = { ...current, ...update, updatedAt: new Date().toISOString() }
  await writeJob(next)
  return next
}

export async function runPricingJob(jobId: string) {
  const state = workspaceState()
  if (state.runningJobs.has(jobId)) return
  state.runningJobs.add(jobId)
  try {
    const { repriceUsageForGroup } = await import("@/lib/analytics")
    await repriceUsageForGroup(jobId)
  } catch (error) {
    await updatePricingJob(jobId, { status: "failed", error: error instanceof Error ? error.message : "Unable to reprice usage.", completedAt: new Date().toISOString() })
  } finally {
    state.runningJobs.delete(jobId)
  }
}

export function resetModelPricingForTests() {
  workspaceStates().clear()
  invalidatePricingJobs()
  invalidatePricingCatalog()
}
