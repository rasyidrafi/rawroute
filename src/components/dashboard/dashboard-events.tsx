import { useEffect } from "react"
import { useLocation } from "react-router"
import { dashboardPageForPath, dashboardPages } from "@/lib/dashboard/routes"
import { reportEvent } from "@/lib/logging/client"
import { useWorkspace } from "./workspace-provider"

export function DashboardEvents() {
  const { pathname } = useLocation()
  const { workspace } = useWorkspace()
  const page = dashboardPageForPath(pathname)
  const workspaceId = page && dashboardPages[page].scope === "workspace" ? workspace?.id : undefined
  useEffect(() => {
    if (!page || (dashboardPages[page].scope === "workspace" && !workspaceId)) return
    reportEvent({ event: "dashboard.navigation", page }, workspaceId ? { kind: "workspace", workspaceId } : { kind: "global" })
  }, [page, workspaceId])
  useEffect(() => {
    // A late browser error cannot reliably be attributed to the currently selected workspace.
    const error = () => reportEvent({ event: "dashboard.error" }, { kind: "global" })
    const rejection = () => reportEvent({ event: "dashboard.rejection" }, { kind: "global" })
    window.addEventListener("error", error)
    window.addEventListener("unhandledrejection", rejection)
    return () => { window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection) }
  }, [])
  return null
}
