// Shared by the server, router, navigation, page header, event scope, and loading UI.
export type DashboardAppId = "ai-gateway" | "tool-gateway"
export type DashboardPageMeta = { path: string; title: string; scope: "workspace" | "global"; app: DashboardAppId | "shared"; skeleton: string }
export const dashboardPages = {
  overview: { path: "/dashboard/ai/overview", skeleton: "overview", title: "Overview", scope: "workspace", app: "ai-gateway" },
  overviewUsage: { path: "/dashboard/ai/overview/usage", skeleton: "usage", title: "Usage", scope: "workspace", app: "ai-gateway" },
  requestLogs: { path: "/dashboard/ai/overview/request-logs", skeleton: "request-logs", title: "Request Logs", scope: "workspace", app: "ai-gateway" },
  dashboard: { path: "/dashboard/ai/endpoint", skeleton: "endpoint-key", title: "Endpoint & Key", scope: "workspace", app: "ai-gateway" },
  providers: { path: "/dashboard/ai/providers", skeleton: "providers", title: "Providers", scope: "workspace", app: "ai-gateway" },
  provider: { path: "/dashboard/ai/providers/:providerId", skeleton: "provider-detail", title: "Provider", scope: "workspace", app: "ai-gateway" },
  codex: { path: "/dashboard/ai/codex-providers", skeleton: "codex-detail", title: "Codex Providers", scope: "workspace", app: "ai-gateway" },
  aliases: { path: "/dashboard/ai/routing", skeleton: "aliases", title: "Model routing", scope: "workspace", app: "ai-gateway" },
  usage: { path: "/dashboard/ai/usage", skeleton: "usage", title: "Usage", scope: "workspace", app: "ai-gateway" },
  budgets: { path: "/dashboard/ai/budgets", skeleton: "budgets", title: "Budgets", scope: "workspace", app: "ai-gateway" },
  pricing: { path: "/dashboard/ai/pricing", skeleton: "model-pricing", title: "Model Pricing", scope: "workspace", app: "ai-gateway" },
  logs: { path: "/dashboard/logs", skeleton: "console-log", title: "Console Log", scope: "workspace", app: "shared" },
  cliproxy: { path: "/dashboard/cliproxy", skeleton: "cliproxy", title: "CLIProxyAPI", scope: "global", app: "shared" },
  systemLogs: { path: "/dashboard/system-logs", skeleton: "system-logs", title: "System Logs", scope: "global", app: "shared" },
  settings: { path: "/dashboard/settings", skeleton: "settings", title: "Settings", scope: "global", app: "shared" },
  codexAgent: { path: "/dashboard/ai/coding-agents/codex", skeleton: "coding-agent", title: "Codex", scope: "workspace", app: "ai-gateway" },
  opencodeAgent: { path: "/dashboard/ai/coding-agents/opencode", skeleton: "opencode-agent", title: "Opencode", scope: "workspace", app: "ai-gateway" },
  claudeAgent: { path: "/dashboard/ai/coding-agents/claude-code", skeleton: "claude-agent", title: "Claude Code", scope: "workspace", app: "ai-gateway" },
  tools: { path: "/dashboard/tools/overview", skeleton: "tool-gateway", title: "Overview", scope: "global", app: "tool-gateway" },
  toolCatalog: { path: "/dashboard/tools/catalog", skeleton: "tool-gateway", title: "Tools", scope: "global", app: "tool-gateway" },
  toolConnections: { path: "/dashboard/tools/connections", skeleton: "tool-gateway", title: "Connections", scope: "global", app: "tool-gateway" },
  toolActivity: { path: "/dashboard/tools/activity", skeleton: "tool-gateway", title: "Activity", scope: "global", app: "tool-gateway" },
  toolPolicies: { path: "/dashboard/tools/policies", skeleton: "tool-gateway", title: "Policies", scope: "global", app: "tool-gateway" },
  toolSettings: { path: "/dashboard/tools/settings", skeleton: "tool-gateway", title: "Settings", scope: "global", app: "tool-gateway" },
} as const satisfies Record<string, DashboardPageMeta>

export type DashboardPage = keyof typeof dashboardPages
export type DashboardSkeletonVariant = typeof dashboardPages[DashboardPage]["skeleton"]

export const pagePaths = {
  home: "/",
  login: "/login",
  ...Object.fromEntries(Object.entries(dashboardPages).map(([key, page]) => [key, page.path])) as { [K in DashboardPage]: typeof dashboardPages[K]["path"] },
}

export function providerPagePath(providerId: string) {
  return providerId === "codex" ? pagePaths.codex : `${pagePaths.providers}/${encodeURIComponent(providerId)}`
}

export function dashboardPageForPath(pathname: string): DashboardPage | undefined {
  const exact = (Object.keys(dashboardPages) as DashboardPage[]).find(key => pagePaths[key] === pathname)
  return exact ?? (/^\/dashboard\/ai\/providers\/[^/]+$/.test(pathname) ? "provider" : undefined)
}

export function isPagePath(pathname: string) {
  return pathname === pagePaths.home || pathname === pagePaths.login || dashboardPageForPath(pathname) !== undefined
}

export function isDashboardPage(value: unknown): value is DashboardPage {
  return typeof value === "string" && Object.hasOwn(dashboardPages, value)
}
