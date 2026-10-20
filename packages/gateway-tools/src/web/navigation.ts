import { ActivityIcon, PlugIcon, SettingsIcon, ShieldCheckIcon, WrenchIcon } from "lucide-react"
import type { DashboardApp } from "@rawroute/platform/web/navigation"
import { navigationFor } from "@rawroute/ui/navigation"
import { toolPages, toolPagePaths } from "../contracts/pages"

const nav = navigationFor(toolPages)
export const toolsApp: DashboardApp = {
  id: "tool-gateway",
  showAppTitle: true,
  title: "Tool Gateway",
  description: "Use shared tools through the API proxy",
  icon: WrenchIcon,
  href: toolPagePaths.tools,
  navigation: [{ label: "Tool Gateway", items: [nav("tools", WrenchIcon), nav("toolCatalog", WrenchIcon), nav("toolConnections", PlugIcon), nav("toolPolicies", ShieldCheckIcon), nav("toolActivity", ActivityIcon), nav("toolSettings", SettingsIcon)] }],
}
