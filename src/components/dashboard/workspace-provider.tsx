import { createContext, useCallback, useContext, useMemo, useState } from "react"
import useSWR from "swr"
import { apiFetch } from "./api"
import type { Workspace } from "@/lib/types"

interface WorkspaceContextValue {
  workspaces: Workspace[]
  workspace: Workspace | undefined
  isLoading: boolean
  error: Error | undefined
  selectWorkspace: (workspaceId: string) => void
  refreshWorkspaces: () => Promise<void>
}
const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaceId, setWorkspaceId] = useState(() => window.localStorage.getItem("rawroute_workspace") || "default")
  const { data, error, isLoading, mutate } = useSWR<{ workspaces: Workspace[] }>("/api/admin/workspaces", apiFetch)
  const workspaces = useMemo(() => data?.workspaces.filter(workspace => workspace.status === "active") ?? [], [data])
  const workspace = workspaces.find(entry => entry.id === workspaceId) ?? workspaces.find(entry => entry.isDefault)
  const refreshWorkspaces = useCallback(async () => { await mutate() }, [mutate])
  const selectWorkspace = useCallback((nextId: string) => {
    setWorkspaceId(nextId)
    window.localStorage.setItem("rawroute_workspace", nextId)
  }, [])
  const value = useMemo(() => ({ workspaces, workspace, isLoading, error, selectWorkspace, refreshWorkspaces }), [workspaces, workspace, isLoading, error, selectWorkspace, refreshWorkspaces])
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider")
  return context
}
