import { lazy, Suspense, type ComponentProps } from "react"
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router"

import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { Button } from "@/components/ui/button"
import { useSession } from "@/hooks/use-session"
import { pagePaths, pageRedirects } from "@/lib/page-routes"
import { LoginPage } from "@/pages/login"

const PublicPage = lazy(() => import("@/pages/public").then((module) => ({ default: module.PublicPage })))
const EndpointKeyView = lazy(() => import("@/components/dashboard/endpoint-key-view").then((module) => ({ default: module.EndpointKeyView })))
const ProvidersView = lazy(() => import("@/components/dashboard/providers-view").then((module) => ({ default: module.ProvidersView })))
const ProviderDetailView = lazy(() => import("@/components/dashboard/provider-detail-view").then((module) => ({ default: module.ProviderDetailView })))
const AliasesView = lazy(() => import("@/components/dashboard/aliases-view").then((module) => ({ default: module.AliasesView })))
const AdminUsageView = lazy(() => import("@/components/dashboard/admin-usage-view").then((module) => ({ default: module.AdminUsageView })))
const BudgetsView = lazy(() => import("@/components/dashboard/budgets-view").then((module) => ({ default: module.BudgetsView })))
const ModelPricingView = lazy(() => import("@/components/dashboard/model-pricing-view").then((module) => ({ default: module.ModelPricingView })))
const ConsoleLog = lazy(() => import("@/components/console-log").then((module) => ({ default: module.ConsoleLog })))
const SettingsView = lazy(() => import("@/components/dashboard/settings-view").then((module) => ({ default: module.SettingsView })))
const CodingAgentView = lazy(() => import("@/components/dashboard/coding-agent-view").then((module) => ({ default: module.CodingAgentView })))
const ToolGatewayView = lazy(() => import("@/components/dashboard/tool-gateway-view").then((module) => ({ default: module.ToolGatewayView })))

const dashboardSkeletons: Record<string, NonNullable<ComponentProps<typeof DashboardContentSkeleton>>["variant"]> = {
  [pagePaths.providers]: "providers",
  [pagePaths.aliases]: "aliases",
  [pagePaths.usage]: "usage",
  [pagePaths.budgets]: "budgets",
  [pagePaths.pricing]: "model-pricing",
  [pagePaths.logs]: "console-log",
  [pagePaths.settings]: "settings",
}

function SessionGate({ login = false }: { login?: boolean }) {
  const { data, error, mutate } = useSession()
  if (error) return <main className="p-6" role="alert"><p>Unable to check your session.</p><Button onClick={() => void mutate()}>Retry</Button></main>
  if (!data) return <DashboardContentSkeleton />
  if (login) return data.authenticated ? <Navigate to={pagePaths.dashboard} replace /> : <LoginPage />
  return data.authenticated ? <DashboardLayout /> : <Navigate to={pagePaths.login} replace />
}

function DashboardLayout() {
  const { pathname } = useLocation()
  const variant = pathname.startsWith(`${pagePaths.providers}/`) ? "provider-detail" : dashboardSkeletons[pathname] ?? "endpoint-key"
  return <DashboardShell><Suspense fallback={<DashboardContentSkeleton variant={variant} />}><Outlet /></Suspense></DashboardShell>
}

function ProviderPage() {
  const { providerId } = useParams()
  return <ProviderDetailView key={providerId} providerId={providerId || ""} />
}

export function App() {
  return <BrowserRouter><Suspense fallback={<DashboardContentSkeleton />}><Routes>
    <Route path={pagePaths.home} element={<PublicPage />} />
    <Route path={pagePaths.login} element={<SessionGate login />} />
    <Route element={<SessionGate />}>
      <Route path={pagePaths.dashboard} element={<EndpointKeyView />} />
      <Route path={pagePaths.providers} element={<ProvidersView />} />
      <Route path={pagePaths.codex} element={<ProviderDetailView providerId="codex" />} />
      <Route path={pagePaths.provider} element={<ProviderPage />} />
      <Route path={pagePaths.aliases} element={<AliasesView />} />
      <Route path={pagePaths.usage} element={<AdminUsageView />} />
      <Route path={pagePaths.budgets} element={<BudgetsView />} />
      <Route path={pagePaths.pricing} element={<ModelPricingView />} />
      <Route path={pagePaths.logs} element={<ConsoleLog />} />
      <Route path={pagePaths.settings} element={<SettingsView />} />
      <Route path={pagePaths.codexAgent} element={<CodingAgentView agent="Codex" />} />
      <Route path={pagePaths.opencodeAgent} element={<CodingAgentView agent="Opencode" />} />
      <Route path={pagePaths.claudeAgent} element={<CodingAgentView agent="Claude Code" />} />
      <Route path={pagePaths.tools} element={<ToolGatewayView page="overview" />} />
      <Route path={pagePaths.toolCatalog} element={<ToolGatewayView page="tools" />} />
      <Route path={pagePaths.toolConnections} element={<ToolGatewayView page="connections" />} />
      <Route path={pagePaths.toolActivity} element={<ToolGatewayView page="activity" />} />
      <Route path={pagePaths.toolPolicies} element={<ToolGatewayView page="policies" />} />
      <Route path={pagePaths.toolSettings} element={<ToolGatewayView page="settings" />} />
      {Object.entries(pageRedirects).map(([path, to]) => <Route key={path} path={path} element={<Navigate to={to} replace />} />)}
    </Route>
    <Route path="*" element={<main className="p-6"><h1>Page not found</h1><Link to="/">Return to RawRoute</Link></main>} />
  </Routes></Suspense></BrowserRouter>
}
