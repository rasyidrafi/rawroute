import { useLocation } from "react-router"
import { toast } from "sonner"
import { useDashboardApi } from "./api-context"
import { useShellComposition } from "./shell-composition"

export function useDashboardClipboard() {
  const { pathname } = useLocation()
  const { workspaceId } = useDashboardApi()
  const { pageForPath, reportCopy } = useShellComposition()
  const page = pageForPath(pathname)
  return async (value: string, message = "Copied") => {
    const canReport = page && (page.meta.scope === "global" || workspaceId)
    try {
      await navigator.clipboard.writeText(value)
      if (canReport) reportCopy(page.id, true, workspaceId)
      toast.success(message)
    } catch {
      if (canReport) reportCopy(page.id, false, workspaceId)
      toast.error("Unable to copy to clipboard")
    }
  }
}
