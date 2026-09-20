import type { LucideIcon } from "lucide-react"
import { ActivityIcon, ArrowLeftRightIcon, ChartNoAxesCombinedIcon, DollarSignIcon, KeyRoundIcon, LogsIcon, PlugIcon, RouteIcon, ServerIcon, SettingsIcon, ShieldCheckIcon, WalletCardsIcon, WrenchIcon } from "lucide-react"

export type DashboardAppId = "ai-gateway" | "tool-gateway"

export type DashboardNavigationItem = {
  title: string
  icon: LucideIcon
  href: string
}

export type DashboardNavigationGroup = {
  label: string
  items: DashboardNavigationItem[]
}

export type DashboardApp = {
  id: DashboardAppId
  title: string
  icon: LucideIcon
  href: string
  navigation: DashboardNavigationGroup[]
}

export const dashboardApps: DashboardApp[] = [
  {
    id: "ai-gateway",
    title: "AI Gateway",
    icon: RouteIcon,
    href: "/dashboard",
    navigation: [
      {
        label: "Gateway",
        items: [
          { title: "Endpoint & Key", icon: KeyRoundIcon, href: "/dashboard" },
          { title: "Providers", icon: ServerIcon, href: "/dashboard/providers" },
          { title: "Codex Providers", icon: ShieldCheckIcon, href: "/dashboard/providers/codex" },
          { title: "Model routing", icon: ArrowLeftRightIcon, href: "/dashboard/aliases" },
        ],
      },
      {
        label: "Analytics",
        items: [
          { title: "Usage", icon: ChartNoAxesCombinedIcon, href: "/dashboard/usage" },
          { title: "Budgets", icon: WalletCardsIcon, href: "/dashboard/budgets" },
          { title: "Model Pricing", icon: DollarSignIcon, href: "/dashboard/model-pricing" },
        ],
      },
      {
        label: "System",
        items: [
          { title: "Console Log", icon: LogsIcon, href: "/dashboard/logs" },
          { title: "Settings", icon: SettingsIcon, href: "/dashboard/settings" },
        ],
      },
    ],
  },
  {
    id: "tool-gateway",
    title: "Tool Gateway",
    icon: WrenchIcon,
    href: "/dashboard/tool-gateway",
    navigation: [
      {
        label: "Tool Gateway",
        items: [
          { title: "Overview", icon: WrenchIcon, href: "/dashboard/tool-gateway" },
          { title: "Tools", icon: WrenchIcon, href: "/dashboard/tool-gateway/tools" },
          { title: "Connections", icon: PlugIcon, href: "/dashboard/tool-gateway/connections" },
          { title: "Policies", icon: ShieldCheckIcon, href: "/dashboard/tool-gateway/policies" },
          { title: "Activity", icon: ActivityIcon, href: "/dashboard/tool-gateway/activity" },
          { title: "Settings", icon: SettingsIcon, href: "/dashboard/tool-gateway/settings" },
        ],
      },
    ],
  },
]

export function dashboardAppForPathname(pathname: string): DashboardApp {
  return pathname === "/dashboard/tool-gateway" || pathname.startsWith("/dashboard/tool-gateway/")
    ? dashboardApps[1]
    : dashboardApps[0]
}

export function isDashboardNavigationItemActive(pathname: string, item: DashboardNavigationItem) {
  return pathname === item.href || (!dashboardApps.some((app) => app.href === item.href) && pathname.startsWith(`${item.href}/`))
}

export function toolGatewayTitleForPathname(pathname: string) {
  return dashboardApps[1].navigation[0].items.find((item) => item.href === pathname)?.title ?? "Overview"
}
