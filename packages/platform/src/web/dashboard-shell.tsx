import { useLocation } from "react-router"
import { AppSidebar } from "./app-sidebar"
import { DashboardPasswordGate } from "./password-gate"
import { DashboardSWRProvider } from "./swr-provider"
import { DashboardApiProvider } from "./api-context"
import { useWorkspace, WorkspaceProvider } from "./workspace-provider"
import { SiteHeader } from "./site-header"
import { DashboardRouteSkeleton, useShellComposition } from "./shell-composition"
import { Button } from "@rawroute/ui/button"
import { SidebarInset, SidebarProvider } from "@rawroute/ui/sidebar"

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { events, wrapDashboard } = useShellComposition()
  return <DashboardApiProvider workspaceId={null}><DashboardSWRProvider><WorkspaceProvider>
    {wrapDashboard(<SidebarProvider style={{ "--sidebar-width": "17rem", "--header-height": "3rem" } as React.CSSProperties}>
      <AppSidebar variant="inset" />
      <SidebarInset><SiteHeader /><DashboardPasswordGate>{events}<ScopedContent>{children}</ScopedContent></DashboardPasswordGate></SidebarInset>
    </SidebarProvider>)}
  </WorkspaceProvider></DashboardSWRProvider></DashboardApiProvider>
}

function ScopedContent({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  const { workspace, isLoading, error, refreshWorkspaces } = useWorkspace()
  const { pageForPath } = useShellComposition()
  if (pageForPath(pathname)?.meta.scope === "global") return children
  if (isLoading && !workspace) return <DashboardRouteSkeleton />
  if (!workspace || error) return <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6" role="alert">
    <p>Workspace unavailable. Global pages remain available from the sidebar.</p>
    <Button onClick={() => void refreshWorkspaces()}>Retry loading workspaces</Button>
  </main>
  return <DashboardApiProvider key={workspace.id} workspaceId={workspace.id}><DashboardSWRProvider>{children}</DashboardSWRProvider></DashboardApiProvider>
}
