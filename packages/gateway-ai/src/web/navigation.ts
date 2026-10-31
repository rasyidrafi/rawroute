import { LayoutGridIcon, ArrowLeftRightIcon, ChartNoAxesCombinedIcon, DollarSignIcon, KeyRoundIcon, ListChecksIcon, RouteIcon, ServerIcon, ShieldCheckIcon, WalletCardsIcon, WrenchIcon } from "lucide-react"
import type { DashboardApp } from "@rawroute/platform/web/navigation"
import { navigationFor } from "@rawroute/ui/navigation"
import { aiPages, aiPagePaths } from "../contracts/pages"

const nav = navigationFor(aiPages)
export const aiGlobalNavigation = []
export const aiApp: DashboardApp = {
  id: "ai-gateway",
  title: "AI Gateway",
  description: "Route AI requests across your providers",
  icon: RouteIcon,
  href: aiPagePaths.overview,
  navigation: [
    { label: "Overview", items: [nav("overview", LayoutGridIcon), nav("overviewUsage", ChartNoAxesCombinedIcon), nav("requestLogs", ListChecksIcon)] },
    { label: "Gateway", items: [nav("endpoint", KeyRoundIcon), nav("providers", ServerIcon), nav("codex", ShieldCheckIcon), nav("aliases", ArrowLeftRightIcon), nav("integrations", WrenchIcon)] },
    { label: "Analytics", items: [nav("budgets", WalletCardsIcon), nav("pricing", DollarSignIcon)] },
  ],
}
