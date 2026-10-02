import { calendarDateFromInstant } from "@/lib/timezone"
import { useUsageDashboard } from "@/hooks/use-usage-dashboard"
import { useWorkspace } from "@/components/dashboard/workspace-provider"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"

import { DashboardPage } from "@/components/dashboard/page-layout"
import { UsageOverview } from "./usage-overview"
import { DashboardTrend, ModelMix, TopKeys, UsageTable } from "./usage-panels"
import { UsageSummary } from "./usage-summary"

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
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
      <DashboardTrend dashboard={dashboard} refreshing={pending} />
      <TopKeys keys={dashboard.keys} refreshing={pending} />
    </div>
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
      <UsageTable keys={dashboard.keys} refreshing={pending} />
      <ModelMix models={dashboard.models} refreshing={pending} />
    </div>
  </DashboardPage>
}
