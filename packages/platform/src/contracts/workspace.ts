export type WorkspaceStatus = "active" | "deleting"
export type WorkspaceStorageMode = "scoped"

export interface Workspace {
  id: string
  name: string
  status: WorkspaceStatus
  isDefault: boolean
  createdAt: string
  updatedAt: string
  storageMode?: WorkspaceStorageMode
}

export const DEFAULT_WORKSPACE_ID = "default"
export const DEFAULT_WORKSPACE_NAME = "Default"
