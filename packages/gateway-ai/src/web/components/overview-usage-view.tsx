import { calendarDateFromInstant } from "@rawroute/observability/contracts/timezone"
import { useUsageDashboard } from "../use-usage-dashboard"
import { useWorkspace } from "@rawroute/platform/web/workspace-provider"
import { AiContentSkeleton as DashboardContentSkeleton } from "../skeletons"

import { DashboardPage } from "@rawroute/ui/page-layout"
import { UsageOverview } from "./usage-overview"
import { BarChart3Icon, DatabaseIcon, KeyRoundIcon, WalletCardsIcon } from "lucide-react"
import { DashboardTrend, TopKeys, UsageTable } from "./usage-panels"
import { MostUsedModels } from "./most-used-models"
import { EmptyState } from "@rawroute/ui/empty-state"
import { UsageSummary } from "./usage-summary"
import { UsageEmptyState } from "./usage-coverage-notice"

export function OverviewUsageView() {
  const { workspace } = useWorkspace()
  if (!workspace) return null
  return <OverviewUsageContent key={workspace.id} />
}

function OverviewUsageContent() {
  const { dashboard, refreshing, preset, setPreset, activeGranularity, setGranularity, selectedRange, handleRangeChange, refresh } = useUsageDashboard()
  if (!dashboard) return <DashboardContentSkeleton variant="usage" />

  return <DashboardPage spacing="compact">
    <UsageOverview dashboard={dashboard} loading={refreshing} preset={preset} setPreset={setPreset} granularity={activeGranularity} setGranularity={setGranularity} selectedRange={preset === "custom" ? selectedRange : { from: calendarDateFromInstant(dashboard.range.from), to: calendarDateFromInstant(dashboard.range.to) }} onRangeChange={handleRangeChange} onRefresh={refresh} />
    <UsageSummary dashboard={dashboard} refreshing={refreshing} />
    {dashboard.trend.length || dashboard.keys.length || dashboard.models.length ? <>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
        {dashboard.trend.length ? <DashboardTrend dashboard={dashboard} refreshing={refreshing} /> : <EmptyState title="No trend data" description="No usage buckets were found for this range." icon={BarChart3Icon} refreshing={refreshing} />}
        {dashboard.keys.length ? <TopKeys keys={dashboard.keys} refreshing={refreshing} /> : <EmptyState title="No key activity" description="No keys handled traffic in this range." icon={KeyRoundIcon} refreshing={refreshing} />}
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        {dashboard.keys.length ? <UsageTable keys={dashboard.keys} refreshing={refreshing} /> : <EmptyState title="No table rows" description="There is no per-key usage to show for this filter." icon={DatabaseIcon} refreshing={refreshing} />}
        {dashboard.models.length ? <MostUsedModels className="xl:self-stretch xl:max-h-160" models={dashboard.models} totalRequests={dashboard.summary.requests} totalCostMicros={dashboard.summary.costMicros} totalTokens={dashboard.summary.tokens} refreshing={refreshing} /> : <EmptyState title="No model usage" description="No model usage was recorded for this filter." icon={WalletCardsIcon} refreshing={refreshing} />}
      </div>
    </> : <UsageEmptyState partial={dashboard.coverage?.partial} refreshing={refreshing} />}
  </DashboardPage>
}
