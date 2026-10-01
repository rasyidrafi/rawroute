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
