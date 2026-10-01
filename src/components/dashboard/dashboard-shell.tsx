import { useLocation } from "react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { DashboardPasswordGate } from "./password-gate"
import { DashboardSWRProvider } from "./swr-provider"
import { DashboardApiProvider } from "./api-context"
import { DashboardEvents } from "./dashboard-events"
import { useWorkspace, WorkspaceProvider } from "./workspace-provider"
import { SiteHeader } from "@/components/site-header"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { dashboardPageForPath, dashboardPages } from "@/lib/dashboard/routes"

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return <DashboardApiProvider workspaceId={null}><DashboardSWRProvider><WorkspaceProvider>
    <SidebarProvider style={{ "--sidebar-width": "17rem", "--header-height": "3rem" } as React.CSSProperties}>
      <AppSidebar variant="inset" />
      <SidebarInset><SiteHeader /><DashboardPasswordGate><DashboardEvents /><ScopedContent>{children}</ScopedContent></DashboardPasswordGate></SidebarInset>
    </SidebarProvider>
  </WorkspaceProvider></DashboardSWRProvider></DashboardApiProvider>
}

function ScopedContent({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  const { workspace, isLoading, error, refreshWorkspaces } = useWorkspace()
  const page = dashboardPageForPath(pathname)
  if (page && dashboardPages[page].scope === "global") return children
  if (isLoading && !workspace) return <DashboardContentSkeleton />
  if (!workspace || error) return <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6" role="alert">
    <p>Workspace unavailable. Global pages remain available from the sidebar.</p>
    <Button onClick={() => void refreshWorkspaces()}>Retry loading workspaces</Button>
  </main>
  return <DashboardApiProvider key={workspace.id} workspaceId={workspace.id}><DashboardSWRProvider>{children}</DashboardSWRProvider></DashboardApiProvider>
}
