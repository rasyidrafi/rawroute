import { AsyncLocalStorage } from "node:async_hooks"

import { type Workspace, type WorkspaceStorageMode } from "../contracts/workspace"
import { assertWorkspaceActivity, runWorkspaceActivity, runWithoutWorkspaceActivity } from "./workspace-activity"
import { runWithWorkspaceLogScope } from "@rawroute/observability/server/request-context"

export interface WorkspaceContext {
  id: string
  storageMode: WorkspaceStorageMode
}

declare global { var __rawrouteWorkspaceContext: AsyncLocalStorage<WorkspaceContext | undefined> | undefined }
const storage = globalThis.__rawrouteWorkspaceContext ||= new AsyncLocalStorage<WorkspaceContext | undefined>()

export function runWithoutWorkspace<T>(callback: () => T): T {
  return runWithoutWorkspaceActivity(() => storage.run(undefined, callback))
}

export function workspaceContext(): WorkspaceContext {
  const context = storage.getStore()
  if (!context) throw new Error("Workspace scope is required.")
  assertWorkspaceActivity(context.id)
  return context
}

export function currentWorkspaceId() {
  return workspaceContext().id
}

export function runInWorkspace<T>(workspace: Pick<Workspace, "id" | "storageMode">, callback: () => T): T {
  return runWorkspaceActivity(workspace.id, () => storage.run({ id: workspace.id, storageMode: workspace.storageMode || "scoped" }, () => runWithWorkspaceLogScope(workspace.id, callback)))
}
