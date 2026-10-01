import { useLocation } from "react-router"
import { toast } from "sonner"
import { useDashboardApi } from "@/components/dashboard/api-context"
import { dashboardPageForPath, dashboardPages } from "@/lib/dashboard/routes"
import { reportEvent } from "@/lib/logging/client"

export function useDashboardClipboard() {
  const { pathname } = useLocation()
  const { workspaceId } = useDashboardApi()
  const page = dashboardPageForPath(pathname)
  return async (value: string, message = "Copied") => {
    const scope = workspaceId ? { kind: "workspace" as const, workspaceId } : { kind: "global" as const }
    const canReport = page && (dashboardPages[page].scope === "global" || workspaceId)
    try {
      await navigator.clipboard.writeText(value)
      if (canReport) reportEvent({ event: "dashboard.copy", page }, scope)
      toast.success(message)
    } catch {
      if (canReport) reportEvent({ event: "dashboard.copy-failed", page }, scope)
      toast.error("Unable to copy to clipboard")
    }
  }
}
