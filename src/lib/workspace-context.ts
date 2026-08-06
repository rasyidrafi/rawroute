import { AsyncLocalStorage } from "node:async_hooks"

import type { Workspace, WorkspaceStorageMode } from "@/lib/types"

export const DEFAULT_WORKSPACE_ID = "default"
export const DEFAULT_WORKSPACE_NAME = "Default"

export interface WorkspaceContext {
  id: string
  storageMode: WorkspaceStorageMode
}

const storage = new AsyncLocalStorage<WorkspaceContext>()

export function workspaceContext(): WorkspaceContext {
  return storage.getStore() || { id: DEFAULT_WORKSPACE_ID, storageMode: "legacy" }
}

export function currentWorkspaceId() {
  return workspaceContext().id
}

export function usesLegacyWorkspaceStorage() {
  const mode = workspaceContext().storageMode
  return currentWorkspaceId() === DEFAULT_WORKSPACE_ID && (mode === "legacy" || mode === "dual")
}

export function enterWorkspace(workspace: Pick<Workspace, "id" | "storageMode">) {
  storage.enterWith({ id: workspace.id, storageMode: workspace.storageMode || (workspace.id === DEFAULT_WORKSPACE_ID ? "legacy" : "scoped") })
}

export function runInWorkspace<T>(workspace: Pick<Workspace, "id" | "storageMode">, callback: () => T): T {
  return storage.run({ id: workspace.id, storageMode: workspace.storageMode || (workspace.id === DEFAULT_WORKSPACE_ID ? "legacy" : "scoped") }, callback)
}
