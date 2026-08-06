import { createHash } from "node:crypto"

import { _deleteMemoryWorkspace, apiKeyValueHash, collectionPrefix, getFirestoreInstance, isMemoryBackend } from "@/lib/store"
import type { Workspace } from "@/lib/types"
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME } from "@/lib/workspace-context"

declare global {
  var __rawrouteMemoryWorkspaces: Map<string, Workspace> | undefined
}

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

export async function listWorkspaces() {
  await ensureDefaultWorkspace()
  if (isMemoryBackend()) return [...memoryWorkspaces().values()].sort(compareWorkspaces)
  const snapshot = await workspacesRef().get()
  return snapshot.docs.map((document) => ({ ...document.data(), id: document.id } as Workspace)).sort(compareWorkspaces)
}

function compareWorkspaces(left: Workspace, right: Workspace) {
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
}

export async function getWorkspace(workspaceId: string) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) await ensureDefaultWorkspace()
  if (isMemoryBackend()) return memoryWorkspaces().get(workspaceId)
  const snapshot = await workspaceRef(workspaceId).get()
  return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } as Workspace : undefined
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
  return firestore.runTransaction(async (transaction) => {
    const indexRef = workspaceNameIndexesRef().doc(nameHash(name))
    if ((await transaction.get(indexRef)).exists) throw new Error("Workspace name is already in use.")
    const ref = workspacesRef().doc()
    const now = new Date().toISOString()
    const workspace: Workspace = { id: ref.id, name, status: "active", isDefault: false, storageMode: "scoped", createdAt: now, updatedAt: now }
    const { id, ...stored } = workspace
    transaction.create(ref, stored)
    transaction.create(indexRef, { workspaceId: id, name })
    return workspace
  })
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
  return firestore.runTransaction(async (transaction) => {
    const ref = workspaceRef(workspaceId)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) throw new Error("Workspace not found.")
    const workspace = { ...snapshot.data(), id: snapshot.id } as Workspace
    if (workspace.status !== "active") throw new Error("Workspace is being deleted.")
    const nextIndex = workspaceNameIndexesRef().doc(nameHash(name))
    const index = await transaction.get(nextIndex)
    if (index.exists && (index.data() as { workspaceId?: string }).workspaceId !== workspaceId) throw new Error("Workspace name is already in use.")
    const updated = { ...workspace, name, updatedAt: new Date().toISOString() }
    transaction.update(ref, { name, updatedAt: updated.updatedAt })
    const previousNameHash = nameHash(workspace.name)
    if (previousNameHash !== nameHash(name)) transaction.delete(workspaceNameIndexesRef().doc(previousNameHash))
    transaction.set(nextIndex, { workspaceId, name })
    return updated
  })
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

  await workspaceRef(workspaceId).update({ status: "deleting", updatedAt: new Date().toISOString() })
  const apiKeys = await workspaceRef(workspaceId).collection("apiKeys").get()
  for (let offset = 0; offset < apiKeys.docs.length; offset += 400) {
    const batch = getFirestoreInstance().batch()
    for (const apiKey of apiKeys.docs.slice(offset, offset + 400)) {
      const value = apiKey.data().key
      if (typeof value === "string") batch.delete(apiKeyIndexesRef().doc(apiKeyValueHash(value)))
    }
    await batch.commit()
  }
  await getFirestoreInstance().recursiveDelete(workspaceRef(workspaceId))
  await workspaceNameIndexesRef().doc(nameHash(workspace.name)).delete()
}

export async function resetWorkspacesForTests() {
  memoryWorkspaces().clear()
  if (isMemoryBackend()) await ensureDefaultWorkspace()
}
