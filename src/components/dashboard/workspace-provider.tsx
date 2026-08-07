"use client"

import { createContext, useContext, useEffect, useState } from "react"
import useSWR from "swr"

import { apiFetch, setApiWorkspaceId } from "@/components/dashboard/api"
import type { Workspace } from "@/lib/types"

interface WorkspaceContextValue {
  workspaces: Workspace[]
  workspace: Workspace
  selectWorkspace: (workspaceId: string) => void
  refreshWorkspaces: () => Promise<void>
}

const fallbackWorkspace: Workspace = {
  id: "default",
  name: "Default",
  status: "active",
  isDefault: true,
  storageMode: "legacy",
  createdAt: "",
  updatedAt: "",
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaceId, setWorkspaceId] = useState(() => typeof window === "undefined" ? "default" : window.localStorage.getItem("rawroute_workspace") || "default")
  const { data, mutate } = useSWR<{ workspaces: Workspace[] }>("/api/admin/workspaces", apiFetch)
  const active = data?.workspaces.filter((workspace) => workspace.status === "active") || []
  const workspaces = active.length ? active : [fallbackWorkspace]

  async function refreshWorkspaces() {
    await mutate()
  }

  function selectWorkspace(nextId: string) {
    setWorkspaceId(nextId)
    setApiWorkspaceId(nextId)
    window.localStorage.setItem("rawroute_workspace", nextId)
  }

  const workspace = workspaces.find((entry) => entry.id === workspaceId) || workspaces.find((entry) => entry.isDefault) || fallbackWorkspace
  useEffect(() => {
    if (!data) return
    const activeWorkspaces = data.workspaces.filter((entry) => entry.status === "active")
    const resolved = activeWorkspaces.find((entry) => entry.id === workspaceId) || activeWorkspaces.find((entry) => entry.isDefault) || fallbackWorkspace
    setApiWorkspaceId(resolved.id)
    if (resolved.id !== workspaceId) {
      window.localStorage.setItem("rawroute_workspace", resolved.id)
    }
  }, [data, workspaceId])

  const value = { workspaces, workspace, selectWorkspace, refreshWorkspaces }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider")
  return context
}
