import { pagePathsFor, type DashboardPageMeta } from "@rawroute/platform/contracts/dashboard"

export const aiPages = {
  overview: { path: "/dashboard/ai/overview", skeleton: "overview", title: "Overview", scope: "workspace", owner: "ai", app: "ai-gateway" },
  overviewUsage: { path: "/dashboard/ai/overview/usage", skeleton: "usage", title: "Usage", scope: "workspace", owner: "ai", app: "ai-gateway" },
  keyUsage: { path: "/dashboard/ai/overview/usage/keys/:keyId", skeleton: "key-usage", title: "Key usage", scope: "workspace", owner: "ai", app: "ai-gateway" },
  requestLogs: { path: "/dashboard/ai/overview/request-logs", skeleton: "request-logs", title: "Request Logs", scope: "workspace", owner: "ai", app: "ai-gateway" },
  endpoint: { path: "/dashboard/ai/endpoint", skeleton: "endpoint-key", title: "Endpoint & Key", scope: "workspace", owner: "ai", app: "ai-gateway" },
  providers: { path: "/dashboard/ai/providers", skeleton: "providers", title: "Providers", scope: "workspace", owner: "ai", app: "ai-gateway" },
  provider: { path: "/dashboard/ai/providers/:providerId", skeleton: "provider-detail", title: "Provider", scope: "workspace", owner: "ai", app: "ai-gateway" },
  codex: { path: "/dashboard/ai/codex-providers", skeleton: "codex-detail", title: "Codex Providers", scope: "workspace", owner: "ai", app: "ai-gateway" },
  aliases: { path: "/dashboard/ai/routing", skeleton: "aliases", title: "Model routing", scope: "workspace", owner: "ai", app: "ai-gateway" },
  integrations: { path: "/dashboard/ai/integrations", skeleton: "integrations", title: "Integrations", scope: "workspace", owner: "ai", app: "ai-gateway" },
  integrationOpencode: { path: "/dashboard/ai/integrations/opencode", skeleton: "integration-opencode", title: "OpenCode integration", scope: "workspace", owner: "ai", app: "ai-gateway" },
  integrationCodex: { path: "/dashboard/ai/integrations/codex", skeleton: "integration-codex", title: "Codex integration", scope: "workspace", owner: "ai", app: "ai-gateway" },
  budgets: { path: "/dashboard/ai/budgets", skeleton: "budgets", title: "Budgets", scope: "workspace", owner: "ai", app: "ai-gateway" },
  pricing: { path: "/dashboard/ai/pricing", skeleton: "model-pricing", title: "Model Pricing", scope: "workspace", owner: "ai", app: "ai-gateway" },
} as const satisfies Record<string, DashboardPageMeta>

export const publicUsageRoutes = { keyUsage: "/usage/keys/:keyId" } as const
export const aiPagePaths = { ...pagePathsFor(aiPages), publicKeyUsage: publicUsageRoutes.keyUsage, home: "/" } as const

export function providerPagePath(providerId: string) {
  return providerId === "codex" ? aiPagePaths.codex : aiPagePaths.provider.replace(":providerId", encodeURIComponent(providerId))
}

export function keyUsagePagePath(keyId: string) {
  return aiPagePaths.keyUsage.replace(":keyId", encodeURIComponent(keyId))
}

export function publicKeyUsagePagePath(keyId: string, workspaceId: string) {
  const path = publicUsageRoutes.keyUsage.replace(":keyId", encodeURIComponent(keyId))
  return workspaceId === "default" ? path : `${path}?workspace=${encodeURIComponent(workspaceId)}`
}

export function publicWorkspacePagePath(workspaceId: string) {
  return workspaceId === "default" ? aiPagePaths.home : `${aiPagePaths.home}?workspace=${encodeURIComponent(workspaceId)}`
}
