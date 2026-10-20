import type { ReactNode } from "react"
import { ShellCompositionProvider, useShellComposition, type ShellComposition } from "@rawroute/platform/web/shell-composition"
import { dashboardApps } from "./browser-modules"
import { dashboardPageForPath, dashboardPages, isDashboardPage, pagePaths } from "./contracts/dashboard/routes"
import { DashboardContentSkeleton, dashboardSkeletonForPath } from "./route-skeleton"
import { DashboardEvents } from "./dashboard-events"
import { aiWorkspaceChanged } from "@rawroute/gateway-ai/web"
import { useToolsAvailability } from "@rawroute/gateway-tools/web"
import { reportEvent } from "@rawroute/observability/web/client"

const composition: ShellComposition = {
  apps: dashboardApps,
  defaultLanding: pagePaths.overview,
  pageForPath(pathname) {
    const id = dashboardPageForPath(pathname)
    return id ? { id, meta: dashboardPages[id] } : undefined
  },
  renderSkeleton: pathname => <DashboardContentSkeleton variant={dashboardSkeletonForPath(pathname)} />,
  events: <DashboardEvents />,
  wrapDashboard: children => <ConsoleDashboardAvailability>{children}</ConsoleDashboardAvailability>,
  workspaceChanged: aiWorkspaceChanged,
  availability: { "tool-gateway": { available: false, statusLabel: "Checking" } },
  reportCopy(page, success, workspaceId) {
    if (!isDashboardPage(page)) return
    reportEvent({ event: success ? "dashboard.copy" : "dashboard.copy-failed", page }, workspaceId ? { kind: "workspace", workspaceId } : { kind: "global" })
  },
}

export function ConsoleWebComposition({ children }: { children: ReactNode }) {
  return <ShellCompositionProvider value={composition}>{children}</ShellCompositionProvider>
}

// Availability polling belongs to the authenticated dashboard, not public/login routes.
function ConsoleDashboardAvailability({ children }: { children: ReactNode }) {
  const composition = useShellComposition()
  const tools = useToolsAvailability()
  return <ShellCompositionProvider value={{ ...composition, availability: { "tool-gateway": tools } }}>{children}</ShellCompositionProvider>
}
