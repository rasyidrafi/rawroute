import { useLocation } from "react-router"
import { useDashboardApp } from "./use-dashboard-app"
import { useWorkspace } from "./workspace-provider"
import { useShellComposition } from "./shell-composition"
import { SidebarTrigger } from "@rawroute/ui/sidebar"
import { Badge } from "@rawroute/ui/badge"

export function SiteHeader() {
  const { pathname } = useLocation()
  const app = useDashboardApp()
  const { workspace } = useWorkspace()
  const { pageForPath } = useShellComposition()
  const meta = pageForPath(pathname)?.meta
  const scopeLabel = meta?.scope === "global" ? "Global" : workspace ? `Workspace: ${workspace.name}` : "Workspace unavailable"
  return <header className="sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b bg-background/90 backdrop-blur-md"><div className="flex w-full min-w-0 items-center gap-3 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><h1 className="min-w-0 truncate font-medium">{meta?.app === app.id && app.showAppTitle ? <><span className="text-muted-foreground">{app.title}</span><span className="mx-2 text-muted-foreground">/</span>{meta.title}</> : meta?.title ?? "RawRoute"}</h1><div className="ml-auto flex min-w-0 max-w-[60%] shrink-0 items-center gap-2"><Badge variant="outline" title={scopeLabel} className="min-w-0 max-w-40 shrink sm:max-w-64"><span className="truncate">{scopeLabel}</span></Badge></div></div></header>
}
