import { useUsageDashboard } from "../use-usage-dashboard"
import { UsageSummary } from "./usage-summary"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { BarChart3Icon, DatabaseIcon, KeyRoundIcon, WalletCardsIcon } from "lucide-react"

import { AiContentSkeleton as DashboardContentSkeleton } from "../skeletons"
import { TopKeys, UsageTable, DashboardTrend } from "./usage-panels"
import { MostUsedModels } from "./most-used-models"
import { EmptyState } from "@rawroute/ui/empty-state"
import { UsageOverview } from "./usage-overview"
import { calendarDateFromInstant } from "@rawroute/observability/contracts/timezone"
import { UsageEmptyState } from "./usage-coverage-notice"

export function UsageView({ publicView = false, workspaceId }: { publicView?: boolean; workspaceId?: string }) {
  const { dashboard, refreshing, preset, setPreset, activeGranularity, setGranularity, selectedRange, handleRangeChange, refresh } = useUsageDashboard({ publicView, workspaceId })

  if (!dashboard) return <DashboardContentSkeleton variant="usage" />

  return <DashboardPage spacing="compact">
    <UsageOverview dashboard={dashboard} loading={refreshing} preset={preset} setPreset={setPreset} granularity={activeGranularity} setGranularity={setGranularity} selectedRange={preset === "custom" ? selectedRange : { from: calendarDateFromInstant(dashboard.range.from), to: calendarDateFromInstant(dashboard.range.to) }} onRangeChange={handleRangeChange} onRefresh={refresh} />
    <UsageSummary dashboard={dashboard} refreshing={refreshing} />
    {dashboard.trend.length || dashboard.keys.length || dashboard.models.length ? <><div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">{dashboard.trend.length ? <DashboardTrend dashboard={dashboard} refreshing={refreshing} /> : <EmptyState title="No trend data" description="No usage buckets were found for this range." icon={BarChart3Icon} refreshing={refreshing} />}{dashboard.keys.length ? <TopKeys keys={dashboard.keys} refreshing={refreshing} /> : <EmptyState title="No key activity" description="No keys handled traffic in this range." icon={KeyRoundIcon} refreshing={refreshing} />}</div><div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">{dashboard.keys.length ? <UsageTable keys={dashboard.keys} refreshing={refreshing} publicView={publicView} workspaceId={workspaceId} /> : <EmptyState title="No table rows" description="There is no per-key usage to show for this filter." icon={DatabaseIcon} refreshing={refreshing} />}{dashboard.models.length ? <MostUsedModels className="xl:self-stretch xl:max-h-160" models={dashboard.models} totalRequests={dashboard.summary.requests} totalCostMicros={dashboard.summary.costMicros} totalTokens={dashboard.summary.tokens} refreshing={refreshing} /> : <EmptyState title="No model usage" description="No model usage was recorded for this filter." icon={WalletCardsIcon} refreshing={refreshing} />}</div></> : <UsageEmptyState partial={dashboard.coverage?.partial} refreshing={refreshing} />}
  </DashboardPage>
}
