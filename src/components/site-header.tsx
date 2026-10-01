import { useLocation } from "react-router"
import { useDashboardApp } from "@/hooks/use-dashboard-app"
import { useWorkspace } from "@/components/dashboard/workspace-provider"
import { dashboardPageForPath, dashboardPages } from "@/lib/dashboard/routes"
import { ThemeToggle } from "@/components/theme-toggle"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"

export function SiteHeader() {
  const { pathname } = useLocation()
  const app = useDashboardApp()
  const { workspace } = useWorkspace()
  const page = dashboardPageForPath(pathname)
  const meta = page ? dashboardPages[page] : undefined
  return <header className="sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b bg-background/90 backdrop-blur-md"><div className="flex w-full items-center gap-3 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><h1 className="font-medium">{meta?.app === "tool-gateway" ? <><span className="text-muted-foreground">{app.title}</span><span className="mx-2 text-muted-foreground">/</span>{meta.title}</> : meta?.title ?? "RawRoute"}</h1><Badge variant="outline">{meta?.scope === "global" ? "Global" : workspace ? `Workspace: ${workspace.name}` : "Workspace unavailable"}</Badge><div className="ml-auto"><ThemeToggle /></div></div></header>
}
