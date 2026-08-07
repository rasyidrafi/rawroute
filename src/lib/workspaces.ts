import { createHash } from "node:crypto"

import { _deleteMemoryWorkspace, _invalidateApiKeyLookupCache, apiKeyValueHash, collectionPrefix, getFirestoreInstance, isMemoryBackend } from "@/lib/store"
import type { Workspace } from "@/lib/types"
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME } from "@/lib/workspace-context"

declare global {
  var __rawrouteMemoryWorkspaces: Map<string, Workspace> | undefined
}

interface WorkspaceCacheEntry {
  value: Workspace | null
  expiresAt: number
}

function configuredDuration(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const workspaceCacheTtlMs = configuredDuration(process.env.WORKSPACE_CACHE_TTL_MS, 30_000)
const workspaceNegativeCacheTtlMs = configuredDuration(process.env.WORKSPACE_NEGATIVE_CACHE_TTL_MS, 2_000)
const configuredMaximumWorkspaceCacheEntries = Number(process.env.MAX_WORKSPACE_CACHE_ENTRIES || 256)
const maximumWorkspaceCacheEntries = Number.isSafeInteger(configuredMaximumWorkspaceCacheEntries) && configuredMaximumWorkspaceCacheEntries > 0 ? configuredMaximumWorkspaceCacheEntries : 256
const workspaceCache = new Map<string, WorkspaceCacheEntry>()
const workspaceReadInflight = new Map<string, Promise<Workspace | undefined>>()
let workspaceListCache: { value: Workspace[]; expiresAt: number } | undefined
let workspaceListInflight: Promise<Workspace[]> | undefined
let workspaceCacheGeneration = 0

function memoryWorkspaces() {
  return globalThis.__rawrouteMemoryWorkspaces ||= new Map<string, Workspace>()
}

function normalizedName(name: string) {
  return name.trim().toLocaleLowerCase("en-US")
}

function validateName(name: unknown) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Workspace name is required.")
  const value = name.trim()
  if (value.length > 80) throw new Error("Workspace name must be 80 characters or fewer.")
  return value
}

function nameHash(name: string) {
  return createHash("sha256").update(normalizedName(name), "utf8").digest("hex")
}

function defaultWorkspace(): Workspace {
  const now = new Date().toISOString()
  return { id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, status: "active", isDefault: true, storageMode: "legacy", createdAt: now, updatedAt: now }
}

function workspacesRef() {
  return getFirestoreInstance().collection(`${collectionPrefix()}_workspaces`)
}

function workspaceRef(workspaceId: string) {
  return workspacesRef().doc(workspaceId)
}

function workspaceNameIndexesRef() {
  return getFirestoreInstance().collection(`${collectionPrefix()}_workspace_name_indexes`)
}

function apiKeyIndexesRef() {
  return getFirestoreInstance().collection(`${collectionPrefix()}_api_key_indexes`)
}

function cacheWorkspace(workspaceId: string, workspace: Workspace | undefined, expiresAt = Date.now() + (workspace ? workspaceCacheTtlMs : workspaceNegativeCacheTtlMs)) {
  workspaceCache.delete(workspaceId)
  while (workspaceCache.size >= maximumWorkspaceCacheEntries) {
    const oldest = workspaceCache.keys().next().value
    if (oldest === undefined) break
    workspaceCache.delete(oldest)
  }
  workspaceCache.set(workspaceId, { value: workspace || null, expiresAt })
}

function publishWorkspace(workspace: Workspace) {
  workspaceCacheGeneration += 1
  workspaceReadInflight.delete(workspace.id)
  workspaceListCache = undefined
  workspaceListInflight = undefined
  cacheWorkspace(workspace.id, workspace)
}

function evictWorkspace(workspaceId: string) {
  workspaceCacheGeneration += 1
  workspaceCache.delete(workspaceId)
  workspaceReadInflight.delete(workspaceId)
  workspaceListCache = undefined
  workspaceListInflight = undefined
}

async function ensureDefaultWorkspace() {
  if (isMemoryBackend()) {
    if (!memoryWorkspaces().has(DEFAULT_WORKSPACE_ID)) memoryWorkspaces().set(DEFAULT_WORKSPACE_ID, defaultWorkspace())
    return memoryWorkspaces().get(DEFAULT_WORKSPACE_ID)!
  }
  const firestore = getFirestoreInstance()
  return firestore.runTransaction(async (transaction) => {
    const ref = workspaceRef(DEFAULT_WORKSPACE_ID)
    const snapshot = await transaction.get(ref)
    if (snapshot.exists) return { ...snapshot.data(), id: snapshot.id } as Workspace
    const workspace = defaultWorkspace()
    transaction.create(ref, { name: workspace.name, status: workspace.status, isDefault: workspace.isDefault, storageMode: workspace.storageMode, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt })
    transaction.set(workspaceNameIndexesRef().doc(nameHash(workspace.name)), { workspaceId: workspace.id, name: workspace.name })
    return workspace
  })
}

async function readDefaultWorkspace() {
  const snapshot = await workspaceRef(DEFAULT_WORKSPACE_ID).get()
  return snapshot.exists
    ? { ...snapshot.data(), id: snapshot.id } as Workspace
    : ensureDefaultWorkspace()
}

export async function listWorkspaces() {
  if (isMemoryBackend()) {
    await ensureDefaultWorkspace()
    return [...memoryWorkspaces().values()].sort(compareWorkspaces)
  }

  const now = Date.now()
  if (workspaceListCache && workspaceListCache.expiresAt > now) return workspaceListCache.value
  if (workspaceListInflight) return workspaceListInflight

  const generation = workspaceCacheGeneration
  const promise = (async () => {
    const snapshot = await workspacesRef().get()
    const workspaces = snapshot.docs.map((document) => ({ ...document.data(), id: document.id } as Workspace))
    if (!workspaces.some((workspace) => workspace.id === DEFAULT_WORKSPACE_ID)) workspaces.push(await ensureDefaultWorkspace())
    return workspaces.sort(compareWorkspaces)
  })().then((workspaces) => {
    if (generation === workspaceCacheGeneration) {
      const expiresAt = Date.now() + workspaceCacheTtlMs
      workspaceListCache = { value: workspaces, expiresAt }
      for (const workspace of workspaces) cacheWorkspace(workspace.id, workspace, expiresAt)
    }
    return workspaces
  }).finally(() => {
    if (workspaceListInflight === promise) workspaceListInflight = undefined
  })
  workspaceListInflight = promise
  return promise
}

function compareWorkspaces(left: Workspace, right: Workspace) {
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
}

export async function getWorkspace(workspaceId: string) {
  if (isMemoryBackend()) {
    if (workspaceId === DEFAULT_WORKSPACE_ID) await ensureDefaultWorkspace()
    return memoryWorkspaces().get(workspaceId)
  }

  const cached = workspaceCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) {
    workspaceCache.delete(workspaceId)
    workspaceCache.set(workspaceId, cached)
    return cached.value || undefined
  }
  const existing = workspaceReadInflight.get(workspaceId)
  if (existing) return existing

  const generation = workspaceCacheGeneration
  const promise = (workspaceId === DEFAULT_WORKSPACE_ID
    ? readDefaultWorkspace()
    : workspaceRef(workspaceId).get().then((snapshot) => snapshot.exists ? { ...snapshot.data(), id: snapshot.id } as Workspace : undefined)
  ).then((workspace) => {
    if (generation === workspaceCacheGeneration) cacheWorkspace(workspaceId, workspace)
    return workspace
  }).finally(() => {
    if (workspaceReadInflight.get(workspaceId) === promise) workspaceReadInflight.delete(workspaceId)
  })
  workspaceReadInflight.set(workspaceId, promise)
  return promise
}

export async function createWorkspace(nameInput: unknown) {
  const name = validateName(nameInput)
  if (isMemoryBackend()) {
    await ensureDefaultWorkspace()
    if ([...memoryWorkspaces().values()].some((workspace) => normalizedName(workspace.name) === normalizedName(name))) throw new Error("Workspace name is already in use.")
    const now = new Date().toISOString()
    const workspace: Workspace = { id: crypto.randomUUID(), name, status: "active", isDefault: false, storageMode: "scoped", createdAt: now, updatedAt: now }
    memoryWorkspaces().set(workspace.id, workspace)
    return workspace
  }
  const firestore = getFirestoreInstance()
  const workspace = await firestore.runTransaction(async (transaction) => {
    const indexRef = workspaceNameIndexesRef().doc(nameHash(name))
    if ((await transaction.get(indexRef)).exists) throw new Error("Workspace name is already in use.")
    const ref = workspacesRef().doc()
    const now = new Date().toISOString()
    const created: Workspace = { id: ref.id, name, status: "active", isDefault: false, storageMode: "scoped", createdAt: now, updatedAt: now }
    const { id, ...stored } = created
    transaction.create(ref, stored)
    transaction.create(indexRef, { workspaceId: id, name })
    return created
  })
  publishWorkspace(workspace)
  return workspace
}

export async function renameWorkspace(workspaceId: string, nameInput: unknown) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) throw new Error("Default workspace cannot be renamed.")
  const name = validateName(nameInput)
  if (isMemoryBackend()) {
    const workspace = memoryWorkspaces().get(workspaceId)
    if (!workspace) throw new Error("Workspace not found.")
    if (workspace.status !== "active") throw new Error("Workspace is being deleted.")
    if ([...memoryWorkspaces().values()].some((entry) => entry.id !== workspaceId && normalizedName(entry.name) === normalizedName(name))) throw new Error("Workspace name is already in use.")
    const updated = { ...workspace, name, updatedAt: new Date().toISOString() }
    memoryWorkspaces().set(workspaceId, updated)
    return updated
  }
  const firestore = getFirestoreInstance()
  const updated = await firestore.runTransaction(async (transaction) => {
    const ref = workspaceRef(workspaceId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) throw new Error("Workspace not found.")
    const workspace = { ...snapshot.data(), id: snapshot.id } as Workspace
    if (workspace.status !== "active") throw new Error("Workspace is being deleted.")
    const nextIndex = workspaceNameIndexesRef().doc(nameHash(name))
    const index = await transaction.get(nextIndex)
    if (index.exists && (index.data() as { workspaceId?: string }).workspaceId !== workspaceId) throw new Error("Workspace name is already in use.")
    const renamed = { ...workspace, name, updatedAt: new Date().toISOString() }
    transaction.update(ref, { name, updatedAt: renamed.updatedAt })
    const previousNameHash = nameHash(workspace.name)
    if (previousNameHash !== nameHash(name)) transaction.delete(workspaceNameIndexesRef().doc(previousNameHash))
    transaction.set(nextIndex, { workspaceId, name })
    return renamed
  })
  publishWorkspace(updated)
  return updated
}

export async function deleteWorkspace(workspaceId: string, confirmation: unknown) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) throw new Error("Default workspace cannot be deleted.")
  const workspace = await getWorkspace(workspaceId)
  if (!workspace) return
  if (confirmation !== workspace.name) throw new Error("Workspace name confirmation does not match.")

  if (isMemoryBackend()) {
    memoryWorkspaces().set(workspaceId, { ...workspace, status: "deleting", updatedAt: new Date().toISOString() })
    _deleteMemoryWorkspace(workspaceId)
    memoryWorkspaces().delete(workspaceId)
    return
  }

  const deleting = { ...workspace, status: "deleting" as const, updatedAt: new Date().toISOString() }
  await workspaceRef(workspaceId).update({ status: deleting.status, updatedAt: deleting.updatedAt })
  publishWorkspace(deleting)
  const apiKeys = await workspaceRef(workspaceId).collection("apiKeys").get()
  const hashes: string[] = []
  for (let offset = 0; offset < apiKeys.docs.length; offset += 400) {
    const batch = getFirestoreInstance().batch()
    let operations = 0
    for (const apiKey of apiKeys.docs.slice(offset, offset + 400)) {
      const value = apiKey.data().key
      if (typeof value !== "string") continue
      const hash = apiKeyValueHash(value)
      hashes.push(hash)
      batch.delete(apiKeyIndexesRef().doc(hash))
      operations += 1
    }
    if (operations > 0) await batch.commit()
  }
  await getFirestoreInstance().recursiveDelete(workspaceRef(workspaceId))
  await workspaceNameIndexesRef().doc(nameHash(workspace.name)).delete()
  evictWorkspace(workspaceId)
  _invalidateApiKeyLookupCache(hashes)
}

export async function resetWorkspacesForTests() {
  workspaceCacheGeneration += 1
  workspaceCache.clear()
  workspaceReadInflight.clear()
  workspaceListCache = undefined
  workspaceListInflight = undefined
  memoryWorkspaces().clear()
  if (isMemoryBackend()) await ensureDefaultWorkspace()
}
