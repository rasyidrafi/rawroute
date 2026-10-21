import { createHash } from "node:crypto"

import { collectionPrefix, isMemoryBackend } from "./storage-config"
import { getSqliteDatabase as getLocalDatabase } from "./database"
import { localCacheDelete, localCacheGet, localCacheSet } from "./local-cache"
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, type Workspace } from "../contracts/workspace"
import { appendAudit, appendMemoryAudit, stageAudit, type AuditInput } from "./audit"
import { assertOutsideWorkspaceActivity, closeWorkspaceAdmission, drainWorkspaceActivity, reopenWorkspaceAdmission } from "./workspace-activity"
import { mapConcurrent } from "./concurrency"

declare global {
  var __rawrouteMemoryWorkspaces: Map<string, Workspace> | undefined
  var __rawrouteMemoryWorkspaceDeletions: Map<string, DeletionProgress> | undefined
  var __rawrouteWorkspaceDeletionInflight: Map<string, Promise<void>> | undefined
}

export interface WorkspaceCleanupParticipant { id: string; cleanup(workspaceId: string): Promise<void> }
interface DeletionProgress { completed: string[]; state: "pending" | "failed" | "complete"; failedParticipant?: string; updatedAt: string }

/** Includes coordinators whose HTTP caller disconnected before cleanup ended. */
export async function drainWorkspaceDeletions() {
  while (globalThis.__rawrouteWorkspaceDeletionInflight?.size) await Promise.allSettled([...globalThis.__rawrouteWorkspaceDeletionInflight.values()])
}

export function createWorkspaceRepository(dependencies: {
  participants: readonly WorkspaceCleanupParticipant[]
}) {
const participantIds = dependencies.participants.map(participant => participant.id)
if (new Set(participantIds).size !== participantIds.length || participantIds.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id))) throw new Error("Cleanup participant IDs must be unique stable identifiers.")
const deletionInflight = globalThis.__rawrouteWorkspaceDeletionInflight ||= new Map<string, Promise<void>>()
const memoryDeletions = () => globalThis.__rawrouteMemoryWorkspaceDeletions ||= new Map<string, DeletionProgress>()
const deletionRef = (id: string) => getLocalDatabase().collection(`${collectionPrefix()}_workspace_deletions`).doc(id)
const audit = (workspaceId: string, action: AuditInput["action"], result: AuditInput["result"] = "success"): AuditInput => ({ action, resource: "workspace", workspaceId, result })
interface WorkspaceCacheEntry {
  value: Workspace | null
  expiresAt: number
}

const workspaceCacheTtlMs = 60_000
const workspaceNegativeCacheTtlMs = 10_000
const maximumWorkspaceCacheEntries = 256
const workspaceCachePrefix = "rawroute:workspace:v1:"
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
  return { id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, status: "active", isDefault: true, storageMode: "scoped", createdAt: now, updatedAt: now }
}

function workspacesRef() {
  return getLocalDatabase().collection(`${collectionPrefix()}_workspaces`)
}

function workspaceRef(workspaceId: string) {
  return workspacesRef().doc(workspaceId)
}

function workspaceNameIndexesRef() {
  return getLocalDatabase().collection(`${collectionPrefix()}_workspace_name_indexes`)
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

function workspaceCacheKey(workspaceId: string) {
  return `${workspaceCachePrefix}${encodeURIComponent(workspaceId)}`
}

async function readWorkspaceFromCache(workspaceId: string) {
  const raw = await localCacheGet(workspaceCacheKey(workspaceId))
  if (!raw) return undefined
  try {
    const workspace = JSON.parse(raw) as Workspace
    return workspace.id === workspaceId ? workspace : undefined
  } catch {
    return undefined
  }
}

function publishWorkspace(workspace: Workspace) {
  workspaceCacheGeneration += 1
  workspaceReadInflight.delete(workspace.id)
  workspaceListCache = undefined
  workspaceListInflight = undefined
  cacheWorkspace(workspace.id, workspace)
  if (!isMemoryBackend()) void localCacheSet(workspaceCacheKey(workspace.id), JSON.stringify(workspace), workspaceCacheTtlMs)
}

function evictWorkspace(workspaceId: string) {
  workspaceCacheGeneration += 1
  workspaceCache.delete(workspaceId)
  workspaceReadInflight.delete(workspaceId)
  workspaceListCache = undefined
  workspaceListInflight = undefined
  if (!isMemoryBackend()) void localCacheDelete(workspaceCacheKey(workspaceId))
}

async function ensureDefaultWorkspace() {
  if (isMemoryBackend()) {
    if (!memoryWorkspaces().has(DEFAULT_WORKSPACE_ID)) {
      appendMemoryAudit(audit(DEFAULT_WORKSPACE_ID, "workspace.create"))
      memoryWorkspaces().set(DEFAULT_WORKSPACE_ID, defaultWorkspace())
    }
    return memoryWorkspaces().get(DEFAULT_WORKSPACE_ID)!
  }
  const sqlite = getLocalDatabase()
  return sqlite.runTransaction(async (transaction) => {
    const ref = workspaceRef(DEFAULT_WORKSPACE_ID)
    const snapshot = await transaction.get(ref)
    if (snapshot.exists) return { ...snapshot.data(), id: snapshot.id } as Workspace
    const workspace = defaultWorkspace()
    transaction.create(ref, { name: workspace.name, status: workspace.status, isDefault: workspace.isDefault, storageMode: workspace.storageMode, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt })
    transaction.set(workspaceNameIndexesRef().doc(nameHash(workspace.name)), { workspaceId: workspace.id, name: workspace.name })
    stageAudit(transaction, audit(workspace.id, "workspace.create"))
    return workspace
  })
}

async function readDefaultWorkspace() {
  const snapshot = await workspaceRef(DEFAULT_WORKSPACE_ID).get()
  return snapshot.exists
    ? { ...snapshot.data(), id: snapshot.id } as Workspace
    : ensureDefaultWorkspace()
}

async function listWorkspaces() {
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

const publicWorkspaceIdPattern = /^[A-Za-z0-9_-]{1,64}$/

function cachedWorkspace(workspaceId: string) {
  const cached = workspaceCache.get(workspaceId)
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  workspaceCache.delete(workspaceId)
  workspaceCache.set(workspaceId, cached)
  return { hit: true as const, workspace: cached.value || undefined }
}

/**
 * Resolve a workspace from the same bounded list exposed by the public UI.
 * Random public IDs therefore share one list refresh instead of causing one
 * Database document read per distinct miss.
 */
async function getPublicWorkspace(workspaceId: string) {
  if (!publicWorkspaceIdPattern.test(workspaceId)) return undefined
  const cached = cachedWorkspace(workspaceId)
  if (cached) return cached.workspace
  if (workspaceId === DEFAULT_WORKSPACE_ID) return getWorkspace(workspaceId)
  return (await listWorkspaces()).find((workspace) => workspace.id === workspaceId)
}

async function getWorkspace(workspaceId: string) {
  if (isMemoryBackend()) {
    if (workspaceId === DEFAULT_WORKSPACE_ID) await ensureDefaultWorkspace()
    return memoryWorkspaces().get(workspaceId)
  }

  const cached = cachedWorkspace(workspaceId)
  if (cached) return cached.workspace
  const existing = workspaceReadInflight.get(workspaceId)
  if (existing) return existing

  const generation = workspaceCacheGeneration
  const promise = (async () => {
    const cacheWorkspace = await readWorkspaceFromCache(workspaceId)
    if (cacheWorkspace) return cacheWorkspace
    return workspaceId === DEFAULT_WORKSPACE_ID
      ? readDefaultWorkspace()
      : workspaceRef(workspaceId).get().then((snapshot) => snapshot.exists ? { ...snapshot.data(), id: snapshot.id } as Workspace : undefined)
  })().then((workspace) => {
    if (generation === workspaceCacheGeneration) cacheWorkspace(workspaceId, workspace)
    if (workspace && generation === workspaceCacheGeneration && !isMemoryBackend()) void localCacheSet(workspaceCacheKey(workspace.id), JSON.stringify(workspace), workspaceCacheTtlMs)
    return workspace
  }).finally(() => {
    if (workspaceReadInflight.get(workspaceId) === promise) workspaceReadInflight.delete(workspaceId)
  })
  workspaceReadInflight.set(workspaceId, promise)
  return promise
}

async function createWorkspace(nameInput: unknown) {
  try { return await createWorkspaceRecord(nameInput) }
  catch (error) {
    await appendAudit({ action: "workspace.create", resource: "workspace", result: "failure" })
    throw error
  }
}

async function createWorkspaceRecord(nameInput: unknown) {
  const name = validateName(nameInput)
  if (isMemoryBackend()) {
    await ensureDefaultWorkspace()
    if ([...memoryWorkspaces().values()].some((workspace) => normalizedName(workspace.name) === normalizedName(name))) throw new Error("Workspace name is already in use.")
    const now = new Date().toISOString()
    const workspace: Workspace = { id: crypto.randomUUID(), name, status: "active", isDefault: false, storageMode: "scoped", createdAt: now, updatedAt: now }
    memoryWorkspaces().set(workspace.id, workspace)
    appendMemoryAudit(audit(workspace.id, "workspace.create"))
    return workspace
  }
  const sqlite = getLocalDatabase()
  const workspace = await sqlite.runTransaction(async (transaction) => {
    const indexRef = workspaceNameIndexesRef().doc(nameHash(name))
    if ((await transaction.get(indexRef)).exists) throw new Error("Workspace name is already in use.")
    const ref = workspacesRef().doc()
    const now = new Date().toISOString()
    const created: Workspace = { id: ref.id, name, status: "active", isDefault: false, storageMode: "scoped", createdAt: now, updatedAt: now }
    const { id, ...stored } = created
    transaction.create(ref, stored)
    transaction.create(indexRef, { workspaceId: id, name })
    stageAudit(transaction, audit(id, "workspace.create"))
    return created
  })
  publishWorkspace(workspace)
  return workspace
}

async function renameWorkspace(workspaceId: string, nameInput: unknown) {
  try { return await renameWorkspaceRecord(workspaceId, nameInput) }
  catch (error) {
    // Do not copy an unverified URL identifier or supplied name into audit.
    await appendAudit({ action: "workspace.rename", resource: "workspace", result: "failure" })
    throw error
  }
}

async function renameWorkspaceRecord(workspaceId: string, nameInput: unknown) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) throw new Error("Default workspace cannot be renamed.")
  const name = validateName(nameInput)
  if (isMemoryBackend()) {
    const workspace = memoryWorkspaces().get(workspaceId)
    if (!workspace) throw new Error("Workspace not found.")
    if (workspace.status !== "active") throw new Error("Workspace is being deleted.")
    if ([...memoryWorkspaces().values()].some((entry) => entry.id !== workspaceId && normalizedName(entry.name) === normalizedName(name))) throw new Error("Workspace name is already in use.")
    const updated = { ...workspace, name, updatedAt: new Date().toISOString() }
    memoryWorkspaces().set(workspaceId, updated)
    appendMemoryAudit(audit(workspaceId, "workspace.rename"))
    return updated
  }
  const sqlite = getLocalDatabase()
  const updated = await sqlite.runTransaction(async (transaction) => {
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
    stageAudit(transaction, audit(workspaceId, "workspace.rename"))
    return renamed
  })
  publishWorkspace(updated)
  return updated
}

async function deleteWorkspace(workspaceId: string, confirmation: unknown) {
  try {
    if (workspaceId === DEFAULT_WORKSPACE_ID) throw new Error("Default workspace cannot be deleted.")
    assertOutsideWorkspaceActivity(workspaceId)
  } catch (error) {
    await appendAudit({ action: "workspace.delete.failure", resource: "workspace", result: "failure" })
    throw error
  }
  const key = `${collectionPrefix()}:${isMemoryBackend() ? "memory" : "sqlite"}:${workspaceId}`
  const existing = deletionInflight.get(key)
  if (existing) {
    const workspace = await getWorkspace(workspaceId)
    if (workspace && confirmation !== workspace.name) {
      await appendAudit(audit(workspaceId, "workspace.delete.failure", "failure"))
      throw new Error("Workspace name confirmation does not match.")
    }
    return existing
  }
  const task = deleteWorkspaceOnce(workspaceId, confirmation).finally(() => deletionInflight.delete(key))
  deletionInflight.set(key, task)
  return task
}

async function saveDeletion(workspaceId: string, progress: DeletionProgress, action: AuditInput["action"], result: AuditInput["result"] = "success") {
  if (isMemoryBackend()) {
    appendMemoryAudit(audit(workspaceId, action, result))
    memoryDeletions().set(workspaceId, structuredClone(progress))
  } else await getLocalDatabase().runTransaction(async transaction => {
    transaction.set(deletionRef(workspaceId), progress)
    stageAudit(transaction, audit(workspaceId, action, result))
  })
}

async function deleteWorkspaceOnce(workspaceId: string, confirmation: unknown) {
  const workspace = await getWorkspace(workspaceId)
  if (!workspace) return
  if (confirmation !== workspace.name) {
    await appendAudit(audit(workspaceId, "workspace.delete.failure", "failure"))
    throw new Error("Workspace name confirmation does not match.")
  }
  closeWorkspaceAdmission(workspaceId)
  const deleting = { ...workspace, status: "deleting" as const, updatedAt: new Date().toISOString() }
  let marked = workspace.status === "deleting"
  let failedParticipant: string | undefined
  try {
    if (!marked) {
      if (isMemoryBackend()) {
        const current = memoryWorkspaces().get(workspaceId)
        if (!current || current.name !== confirmation) throw new Error("Workspace name confirmation does not match.")
        appendMemoryAudit(audit(workspaceId, "workspace.delete.request", "started"))
        memoryWorkspaces().set(workspaceId, deleting)
        memoryDeletions().set(workspaceId, { completed: [], state: "pending", updatedAt: deleting.updatedAt })
      } else await getLocalDatabase().runTransaction(async transaction => {
        const current = await transaction.get(workspaceRef(workspaceId))
        if (!current.exists || current.data()?.name !== confirmation) throw new Error("Workspace name confirmation does not match.")
        transaction.update(workspaceRef(workspaceId), { status: deleting.status, updatedAt: deleting.updatedAt })
        transaction.set(deletionRef(workspaceId), { completed: [], state: "pending", updatedAt: deleting.updatedAt })
        stageAudit(transaction, audit(workspaceId, "workspace.delete.request", "started"))
      })
      marked = true
      publishWorkspace(deleting)
    }
    await drainWorkspaceActivity(workspaceId)
    const storedProgress = isMemoryBackend()
      ? memoryDeletions().get(workspaceId)
      : (await deletionRef(workspaceId).get()).data() as unknown as DeletionProgress | undefined
    const progress: DeletionProgress = storedProgress ? structuredClone(storedProgress) : { completed: [], state: "pending", updatedAt: deleting.updatedAt }
    // Starting a coordinator job is not a data conversion. Even an existing
    // deleting workspace needs durable intent before any participant runs.
    if (!storedProgress) await saveDeletion(workspaceId, progress, "workspace.delete.request", "started")
    const completed = new Set(progress.completed)
    await mapConcurrent(dependencies.participants, 1, async participant => {
      if (completed.has(participant.id)) return
      failedParticipant = participant.id
      // Participants must be idempotent: a crash may occur after side effects
      // but before this durable checkpoint. Never persist exception text.
      await participant.cleanup(workspaceId)
      progress.completed.push(participant.id)
      progress.state = "pending"
      delete progress.failedParticipant
      progress.updatedAt = new Date().toISOString()
      await saveDeletion(workspaceId, progress, "workspace.delete.participant")
      failedParticipant = undefined
    })
    progress.state = "complete"
    progress.updatedAt = new Date().toISOString()
    if (isMemoryBackend()) {
      appendMemoryAudit(audit(workspaceId, "workspace.delete.complete"))
      memoryDeletions().set(workspaceId, progress)
      memoryWorkspaces().delete(workspaceId)
    } else await getLocalDatabase().runTransaction(async transaction => {
      transaction.delete(workspaceRef(workspaceId))
      transaction.delete(workspaceNameIndexesRef().doc(nameHash(workspace.name)))
      transaction.set(deletionRef(workspaceId), progress)
      stageAudit(transaction, audit(workspaceId, "workspace.delete.complete"))
    })
    evictWorkspace(workspaceId)
  } catch (error) {
    if (!marked) {
      reopenWorkspaceAdmission(workspaceId)
      await appendAudit(audit(workspaceId, "workspace.delete.failure", "failure"))
    }
    else {
      const previous = isMemoryBackend() ? memoryDeletions().get(workspaceId) : (await deletionRef(workspaceId).get()).data() as unknown as DeletionProgress | undefined
      await saveDeletion(workspaceId, { completed: previous?.completed || [], state: "failed", ...(failedParticipant ? { failedParticipant } : {}), updatedAt: new Date().toISOString() }, "workspace.delete.failure", "failure")
    }
    throw error
  }
}

/** Called before serving. Failed domains remain deleting and can be retried. */
async function recoverWorkspaceDeletions() {
  const recordedIds = isMemoryBackend()
    ? [...memoryDeletions().keys()]
    : (await getLocalDatabase().collection(`${collectionPrefix()}_workspace_deletions`).get()).docs.map(document => document.id)
  for (const id of recordedIds) closeWorkspaceAdmission(id)
  const deleting = (await listWorkspaces()).filter(workspace => workspace.status === "deleting")
  for (const workspace of deleting) closeWorkspaceAdmission(workspace.id)
  return Promise.allSettled(deleting.map(workspace => deleteWorkspace(workspace.id, workspace.name)))
}

async function resetWorkspacesForTests() {
  workspaceCacheGeneration += 1
  workspaceCache.clear()
  workspaceReadInflight.clear()
  workspaceListCache = undefined
  workspaceListInflight = undefined
  for (const id of memoryWorkspaces().keys()) reopenWorkspaceAdmission(id)
  for (const id of memoryDeletions().keys()) reopenWorkspaceAdmission(id)
  memoryWorkspaces().clear()
  memoryDeletions().clear()
  if (isMemoryBackend()) await ensureDefaultWorkspace()
}

return { listWorkspaces, getPublicWorkspace, getWorkspace, createWorkspace, renameWorkspace, deleteWorkspace, recoverWorkspaceDeletions, resetWorkspacesForTests }
}
