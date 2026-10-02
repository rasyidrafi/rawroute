import { OverviewView } from "./ai/overview-view"
import { RequestLogsView } from "./ai/request-logs-view"
import { lazy, type ReactElement } from "react"
import { useParams } from "react-router"
import type { DashboardPage } from "@/lib/dashboard/routes"

const EndpointKeyView = lazy(() => import("@/components/dashboard/ai/endpoint-key-view").then((module) => ({ default: module.EndpointKeyView })))
const ProvidersView = lazy(() => import("@/components/dashboard/ai/providers-view").then((module) => ({ default: module.ProvidersView })))
const ProviderDetailView = lazy(() => import("@/components/dashboard/ai/provider-detail-view").then((module) => ({ default: module.ProviderDetailView })))
const AliasesView = lazy(() => import("@/components/dashboard/ai/aliases-view").then((module) => ({ default: module.AliasesView })))
const AdminUsageView = lazy(() => import("@/components/dashboard/ai/admin-usage-view").then((module) => ({ default: module.AdminUsageView })))
const OverviewUsageView = lazy(() => import("@/components/dashboard/ai/overview-usage-view").then((module) => ({ default: module.OverviewUsageView })))
const BudgetsView = lazy(() => import("@/components/dashboard/ai/budgets-view").then((module) => ({ default: module.BudgetsView })))
const ModelPricingView = lazy(() => import("@/components/dashboard/ai/model-pricing-view").then((module) => ({ default: module.ModelPricingView })))
const SystemLogs = lazy(() => import("@/components/console-log").then((module) => ({ default: module.SystemLogs })))
const ConsoleLog = lazy(() => import("@/components/console-log").then((module) => ({ default: module.ConsoleLog })))
const CliproxyView = lazy(() => import("@/components/dashboard/global/cliproxy/cliproxy-view").then((module) => ({ default: module.CliproxyView })))
const SettingsView = lazy(() => import("@/components/dashboard/global/settings-view").then((module) => ({ default: module.SettingsView })))
const CodingAgentView = lazy(() => import("@/components/dashboard/ai/coding-agent-view").then((module) => ({ default: module.CodingAgentView })))
const ToolGatewayView = lazy(() => import("@/components/dashboard/tools/tool-gateway-view").then((module) => ({ default: module.ToolGatewayView })))

function ProviderPage() {
  const { providerId } = useParams()
  return <ProviderDetailView key={providerId} providerId={providerId || ""} />
}

export const dashboardViews: Record<DashboardPage, ReactElement> = {
  overview: <OverviewView />,
  overviewUsage: <OverviewUsageView />,
  requestLogs: <RequestLogsView />,
  dashboard: <EndpointKeyView />,
  providers: <ProvidersView />,
  codex: <ProviderDetailView providerId="codex" />,
  provider: <ProviderPage />,
  aliases: <AliasesView />,
  usage: <AdminUsageView />,
  budgets: <BudgetsView />,
  pricing: <ModelPricingView />,
  logs: <ConsoleLog />,
  systemLogs: <SystemLogs />,
  cliproxy: <CliproxyView />,
  settings: <SettingsView />,
  codexAgent: <CodingAgentView agent="Codex" />,
  opencodeAgent: <CodingAgentView agent="Opencode" />,
  claudeAgent: <CodingAgentView agent="Claude Code" />,
  tools: <ToolGatewayView page="overview" />,
  toolCatalog: <ToolGatewayView page="tools" />,
  toolConnections: <ToolGatewayView page="connections" />,
  toolActivity: <ToolGatewayView page="activity" />,
  toolPolicies: <ToolGatewayView page="policies" />,
  toolSettings: <ToolGatewayView page="settings" />,
}
