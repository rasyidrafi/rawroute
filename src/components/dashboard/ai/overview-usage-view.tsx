import { calendarDateFromInstant } from "@/lib/timezone"
import { useUsageDashboard } from "@/hooks/use-usage-dashboard"
import { useWorkspace } from "@/components/dashboard/workspace-provider"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"

import { DashboardPage } from "@/components/dashboard/page-layout"
import { UsageOverview } from "./usage-overview"
import { BarChart3Icon, DatabaseIcon, KeyRoundIcon, WalletCardsIcon } from "lucide-react"
import { DashboardTrend, TopKeys, UsageTable } from "./usage-panels"
import { MostUsedModels } from "./most-used-models"
import { EmptyState } from "@/components/ui/empty-state"
import { UsageSummary } from "./usage-summary"
import { UsageEmptyState } from "./usage-coverage-notice"

export function OverviewUsageView() {
  const { workspace } = useWorkspace()
  if (!workspace) return null
  return <OverviewUsageContent key={workspace.id} />
}

function OverviewUsageContent() {
  const { dashboard, pending, preset, setPreset, activeGranularity, setGranularity, selectedRange, handleRangeChange, refresh } = useUsageDashboard()
  if (!dashboard) return <DashboardContentSkeleton variant="usage" />

  return <DashboardPage spacing="compact">
    <UsageOverview dashboard={dashboard} loading={pending} preset={preset} setPreset={setPreset} granularity={activeGranularity} setGranularity={setGranularity} selectedRange={preset === "custom" ? selectedRange : { from: calendarDateFromInstant(dashboard.range.from), to: calendarDateFromInstant(dashboard.range.to) }} onRangeChange={handleRangeChange} onRefresh={refresh} />
    <UsageSummary dashboard={dashboard} refreshing={pending} />
    {dashboard.trend.length || dashboard.keys.length || dashboard.models.length ? <>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
        {dashboard.trend.length ? <DashboardTrend dashboard={dashboard} refreshing={pending} /> : <EmptyState title="No trend data" description="No usage buckets were found for this range." icon={BarChart3Icon} />}
        {dashboard.keys.length ? <TopKeys keys={dashboard.keys} refreshing={pending} /> : <EmptyState title="No key activity" description="No keys handled traffic in this range." icon={KeyRoundIcon} />}
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        {dashboard.keys.length ? <UsageTable keys={dashboard.keys} refreshing={pending} /> : <EmptyState title="No table rows" description="There is no per-key usage to show for this filter." icon={DatabaseIcon} />}
        {dashboard.models.length ? <MostUsedModels className="xl:self-stretch" models={dashboard.models} totalRequests={dashboard.summary.requests} refreshing={pending} /> : <EmptyState title="No model usage" description="No model usage was recorded for this filter." icon={WalletCardsIcon} />}
      </div>
    </> : <UsageEmptyState partial={dashboard.coverage?.partial} />}
  </DashboardPage>
}
