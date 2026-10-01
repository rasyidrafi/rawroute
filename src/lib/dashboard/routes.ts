export const pagePaths = {
  home: "/",
  login: "/login",
  dashboard: "/dashboard",
  providers: "/dashboard/providers",
  provider: "/dashboard/providers/:providerId",
  codex: "/dashboard/providers/codex",
  aliases: "/dashboard/aliases",
  usage: "/dashboard/usage",
  budgets: "/dashboard/budgets",
  pricing: "/dashboard/model-pricing",
  logs: "/dashboard/logs",
  systemLogs: "/dashboard/system-logs",
  settings: "/dashboard/settings",
  codexAgent: "/dashboard/coding-agents/codex",
  opencodeAgent: "/dashboard/coding-agents/opencode",
  claudeAgent: "/dashboard/coding-agents/claude-code",
  tools: "/dashboard/tool-gateway",
  toolCatalog: "/dashboard/tool-gateway/tools",
  toolConnections: "/dashboard/tool-gateway/connections",
  toolActivity: "/dashboard/tool-gateway/activity",
  toolPolicies: "/dashboard/tool-gateway/policies",
  toolSettings: "/dashboard/tool-gateway/settings",
} as const

export const pageRedirects: Record<string, string> = {
  "/dashboard/models": pagePaths.providers,
  "/dashboard/oauth-providers": pagePaths.codex,
}

export function isPagePath(pathname: string) {
  return Object.values(pagePaths).some((path) => path === pathname)
    || /^\/dashboard\/providers\/[^/]+$/.test(pathname)
}

export type DashboardPage = Exclude<keyof typeof pagePaths, "home" | "login">
export type DashboardAppId = "ai-gateway" | "tool-gateway"
export type DashboardPageMeta = { title: string; scope: "workspace" | "global"; app: DashboardAppId | "shared" }
export const dashboardPages: Record<DashboardPage, DashboardPageMeta> = {
  dashboard: { title: "Endpoint & Key", scope: "workspace", app: "ai-gateway" },
  providers: { title: "Providers", scope: "workspace", app: "ai-gateway" },
  provider: { title: "Provider", scope: "workspace", app: "ai-gateway" },
  codex: { title: "Codex Providers", scope: "workspace", app: "ai-gateway" },
  aliases: { title: "Model routing", scope: "workspace", app: "ai-gateway" },
  usage: { title: "Usage", scope: "workspace", app: "ai-gateway" },
  budgets: { title: "Budgets", scope: "workspace", app: "ai-gateway" },
  pricing: { title: "Model Pricing", scope: "workspace", app: "ai-gateway" },
  logs: { title: "Console Log", scope: "workspace", app: "shared" },
  systemLogs: { title: "System Logs", scope: "global", app: "shared" },
  settings: { title: "Settings", scope: "global", app: "shared" },
  codexAgent: { title: "Codex", scope: "workspace", app: "ai-gateway" },
  opencodeAgent: { title: "Opencode", scope: "workspace", app: "ai-gateway" },
  claudeAgent: { title: "Claude Code", scope: "workspace", app: "ai-gateway" },
  tools: { title: "Overview", scope: "global", app: "tool-gateway" },
  toolCatalog: { title: "Tools", scope: "global", app: "tool-gateway" },
  toolConnections: { title: "Connections", scope: "global", app: "tool-gateway" },
  toolActivity: { title: "Activity", scope: "global", app: "tool-gateway" },
  toolPolicies: { title: "Policies", scope: "global", app: "tool-gateway" },
  toolSettings: { title: "Settings", scope: "global", app: "tool-gateway" },
}

export function dashboardPageForPath(pathname: string): DashboardPage | undefined {
  const exact = (Object.keys(dashboardPages) as DashboardPage[]).find(key => pagePaths[key] === pathname)
  return exact ?? (/^\/dashboard\/providers\/[^/]+$/.test(pathname) ? "provider" : undefined)
}

export function isDashboardPage(value: unknown): value is DashboardPage {
  return typeof value === "string" && Object.hasOwn(dashboardPages, value)
}
