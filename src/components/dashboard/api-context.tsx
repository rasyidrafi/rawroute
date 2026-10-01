import { createContext, useContext, useMemo, type ReactNode } from "react"
import { createApiClient } from "./api"

const ApiContext = createContext(createApiClient())

export function DashboardApiProvider({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }) {
  const client = useMemo(() => createApiClient(workspaceId), [workspaceId])
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
}

export function useDashboardApi() {
  return useContext(ApiContext)
}
