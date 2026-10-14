import type { LucideIcon } from "lucide-react"
import { ActivityIcon, LayoutGridIcon, ArrowLeftRightIcon, ChartNoAxesCombinedIcon, DollarSignIcon, KeyRoundIcon, ListChecksIcon, LogsIcon, PlugIcon, RouteIcon, ServerIcon, SettingsIcon, ShieldCheckIcon, WalletCardsIcon, WrenchIcon } from "lucide-react"

import { dashboardPages, pagePaths, type DashboardPage, type DashboardAppId } from "@/lib/dashboard/routes"
export type { DashboardAppId } from "@/lib/dashboard/routes"

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
  description: string
  icon: LucideIcon
  href: string
  navigation: DashboardNavigationGroup[]
}

function nav(page: DashboardPage, icon: LucideIcon): DashboardNavigationItem {
  return { title: dashboardPages[page].title, icon, href: pagePaths[page] }
}

const sharedNavigation: DashboardNavigationGroup[] = [
  { label: "System", items: [nav("logs", LogsIcon)] },
  { label: "Global", items: [nav("cliproxy", ServerIcon), nav("systemLogs", LogsIcon), nav("settings", SettingsIcon)] },
]

export const dashboardApps: DashboardApp[] = [
  {
    id: "ai-gateway",
    title: "AI Gateway",
    description: "Route AI requests across your providers",
    icon: RouteIcon,
    href: pagePaths.overview,
    navigation: [
      { label: "Overview", items: [nav("overview", LayoutGridIcon), nav("overviewUsage", ChartNoAxesCombinedIcon), nav("requestLogs", ListChecksIcon)] },
      {
        label: "Gateway",
        items: [
          nav("endpoint", KeyRoundIcon),
          nav("providers", ServerIcon),
          nav("codex", ShieldCheckIcon),
          nav("aliases", ArrowLeftRightIcon),
          nav("integrations", WrenchIcon),
        ],
      },
      {
        label: "Analytics",
        items: [
          nav("budgets", WalletCardsIcon),
          nav("pricing", DollarSignIcon),
        ],
      },
      ...sharedNavigation,
    ],
  },
  {
    id: "tool-gateway",
    title: "Tool Gateway",
    description: "Use shared tools through the API proxy",
    icon: WrenchIcon,
    href: pagePaths.tools,
    navigation: [
      {
        label: "Tool Gateway",
        items: [
          nav("tools", WrenchIcon),
          nav("toolCatalog", WrenchIcon),
          nav("toolConnections", PlugIcon),
          nav("toolPolicies", ShieldCheckIcon),
          nav("toolActivity", ActivityIcon),
          nav("toolSettings", SettingsIcon),
        ],
      },
      ...sharedNavigation,
    ],
  },
]

export function isDashboardNavigationItemActive(pathname: string, item: DashboardNavigationItem) {
  return pathname === item.href || (item.href !== pagePaths.overview && !dashboardApps.some((app) => app.href === item.href) && pathname.startsWith(`${item.href}/`))
}
