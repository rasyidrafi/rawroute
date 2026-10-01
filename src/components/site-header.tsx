import { useLocation } from "react-router"

import { dashboardAppForPathname, toolGatewayTitleForPathname } from "@/components/dashboard/dashboard-apps"
import { ThemeToggle } from "@/components/theme-toggle"
import { SidebarTrigger } from "@/components/ui/sidebar"

const pageTitles = [
  ["/dashboard/providers/codex", "Codex Providers"],
  ["/dashboard/providers", "Providers"],
  ["/dashboard/oauth-providers", "Codex Providers"],
  ["/dashboard/logs", "Console Log"],
  ["/dashboard/settings", "Settings"],
  ["/dashboard/usage", "Usage"],
  ["/dashboard/budgets", "Budgets"],
  ["/dashboard/model-pricing", "Model Pricing"],
] as const

export function SiteHeader() {
  const { pathname } = useLocation()
  const activeApp = dashboardAppForPathname(pathname)
  const navigationTitle = activeApp.navigation.flatMap((group) => group.items).find((item) => item.href === pathname)?.title
  const title = navigationTitle ?? (activeApp.id === "tool-gateway" ? toolGatewayTitleForPathname(pathname) : pageTitles.find(([path]) => pathname === path || pathname.startsWith(`${path}/`))?.[1] ?? "Endpoint & Key")

  return <header className="sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b bg-background/90 backdrop-blur-md"><div className="flex w-full items-center gap-3 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><h1 className="font-medium">{activeApp.id === "tool-gateway" ? <><span className="text-muted-foreground">{activeApp.title}</span><span className="mx-2 text-muted-foreground">/</span>{title}</> : title}</h1><div className="ml-auto"><ThemeToggle /></div></div></header>
}
