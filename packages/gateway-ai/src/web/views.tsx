import { lazy, type ReactElement } from "react"
import { useParams } from "react-router"
import type { aiPages } from "../contracts/pages"
import { OverviewView } from "./components/overview-view"
import { RequestLogsView } from "./components/request-logs-view"
import { IntegrationsView } from "./components/integrations-view"
import { IntegrationDetailView } from "./components/integrations/detail-view"

const EndpointKeyView = lazy(() => import("./components/endpoint-key-view").then(module => ({ default: module.EndpointKeyView })))
const ProvidersView = lazy(() => import("./components/providers-view").then(module => ({ default: module.ProvidersView })))
const ProviderDetailView = lazy(() => import("./components/provider-detail-view").then(module => ({ default: module.ProviderDetailView })))
const AliasesView = lazy(() => import("./components/aliases-view").then(module => ({ default: module.AliasesView })))
const OverviewUsageView = lazy(() => import("./components/overview-usage-view").then(module => ({ default: module.OverviewUsageView })))
const KeyUsageView = lazy(() => import("./components/key-usage-view").then(module => ({ default: module.KeyUsageView })))
const BudgetsView = lazy(() => import("./components/budgets-view").then(module => ({ default: module.BudgetsView })))
const ModelPricingView = lazy(() => import("./components/model-pricing-view").then(module => ({ default: module.ModelPricingView })))

function ProviderPage() {
  const { providerId } = useParams()
  return <ProviderDetailView key={providerId} providerId={providerId || ""} />
}

export const aiViews = {
  overview: <OverviewView />,
  overviewUsage: <OverviewUsageView />,
  keyUsage: <KeyUsageView />,
  requestLogs: <RequestLogsView />,
  endpoint: <EndpointKeyView />,
  providers: <ProvidersView />,
  codex: <ProviderDetailView providerId="codex" />,
  provider: <ProviderPage />,
  aliases: <AliasesView />,
  integrations: <IntegrationsView />,
  integrationOpencode: <IntegrationDetailView integration="opencode" />,
  integrationCodex: <IntegrationDetailView integration="codex" />,
  budgets: <BudgetsView />,
  pricing: <ModelPricingView />,
} satisfies Record<keyof typeof aiPages, ReactElement>

export const PublicPage = lazy(() => import("./pages/public").then(module => ({ default: module.PublicPage })))
export const PublicKeyUsagePage = lazy(() => import("./pages/public-key-usage").then(module => ({ default: module.PublicKeyUsagePage })))
