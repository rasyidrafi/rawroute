import { pagePathsFor, type DashboardPageMeta } from "@rawroute/platform/contracts/dashboard"

export const toolPages = {
  tools: { path: "/dashboard/tools/overview", skeleton: "tool-gateway", title: "Overview", scope: "global", owner: "tools", app: "tool-gateway" },
  toolCatalog: { path: "/dashboard/tools/catalog", skeleton: "tool-gateway", title: "Tools", scope: "global", owner: "tools", app: "tool-gateway" },
  toolConnections: { path: "/dashboard/tools/connections", skeleton: "tool-gateway", title: "Connections", scope: "global", owner: "tools", app: "tool-gateway" },
  toolActivity: { path: "/dashboard/tools/activity", skeleton: "tool-gateway", title: "Activity", scope: "global", owner: "tools", app: "tool-gateway" },
  toolPolicies: { path: "/dashboard/tools/policies", skeleton: "tool-gateway", title: "Policies", scope: "global", owner: "tools", app: "tool-gateway" },
  toolSettings: { path: "/dashboard/tools/settings", skeleton: "tool-gateway", title: "Settings", scope: "global", owner: "tools", app: "tool-gateway" },
} as const satisfies Record<string, DashboardPageMeta>

export const toolPagePaths = pagePathsFor(toolPages)
