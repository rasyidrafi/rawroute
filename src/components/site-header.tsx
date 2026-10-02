import { useLocation } from "react-router"
import { useDashboardApp } from "@/hooks/use-dashboard-app"
import { useWorkspace } from "@/components/dashboard/workspace-provider"
import { dashboardPageForPath, dashboardPages } from "@/lib/dashboard/routes"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"

export function SiteHeader() {
  const { pathname } = useLocation()
  const app = useDashboardApp()
  const { workspace } = useWorkspace()
  const page = dashboardPageForPath(pathname)
  const meta = page ? dashboardPages[page] : undefined
  const scopeLabel = meta?.scope === "global" ? "Global" : workspace ? `Workspace: ${workspace.name}` : "Workspace unavailable"
  return <header className="sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b bg-background/90 backdrop-blur-md"><div className="flex w-full min-w-0 items-center gap-3 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><h1 className="min-w-0 truncate font-medium">{meta?.app === "tool-gateway" ? <><span className="text-muted-foreground">{app.title}</span><span className="mx-2 text-muted-foreground">/</span>{meta.title}</> : meta?.title ?? "RawRoute"}</h1><div className="ml-auto flex min-w-0 max-w-[60%] shrink-0 items-center gap-2"><Badge variant="outline" title={scopeLabel} className="min-w-0 max-w-40 shrink sm:max-w-64"><span className="truncate">{scopeLabel}</span></Badge></div></div></header>
}
