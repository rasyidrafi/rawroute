import { useUsageDashboard } from "@/hooks/use-usage-dashboard"
import { UsageSummary } from "./usage-summary"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { BarChart3Icon, DatabaseIcon, KeyRoundIcon, WalletCardsIcon } from "lucide-react"

import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { EmptyState, ModelMix, TopKeys, UsageTable, DashboardTrend } from "@/components/dashboard/ai/usage-panels"
import { UsageOverview } from "@/components/dashboard/ai/usage-overview"

export function UsageView({ publicView = false, workspaceId }: { publicView?: boolean; workspaceId?: string }) {
  const { dashboard, pending, preset, setPreset, activeGranularity, setGranularity, selectedRange, handleRangeChange, refresh } = useUsageDashboard({ publicView, workspaceId })

  if (!dashboard) return <DashboardContentSkeleton variant="usage" />

  return <DashboardPage spacing="compact">
    <UsageOverview dashboard={dashboard} loading={pending} preset={preset} setPreset={setPreset} granularity={activeGranularity} setGranularity={setGranularity} selectedRange={selectedRange} onRangeChange={handleRangeChange} onRefresh={refresh} />
    <UsageSummary dashboard={dashboard} refreshing={pending} />
    {dashboard.trend.length || dashboard.keys.length || dashboard.models.length ? <><div className="grid gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">{dashboard.trend.length ? <DashboardTrend dashboard={dashboard} refreshing={pending} /> : <EmptyState title="No trend data" description="No usage buckets were found for this range." icon={BarChart3Icon} />}{dashboard.keys.length ? <TopKeys keys={dashboard.keys} refreshing={pending} /> : <EmptyState title="No key activity" description="No keys handled traffic in this range." icon={KeyRoundIcon} />}</div><div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">{dashboard.keys.length ? <UsageTable keys={dashboard.keys} refreshing={pending} publicView={publicView} /> : <EmptyState title="No table rows" description="There is no per-key usage to show for this filter." icon={DatabaseIcon} />}{dashboard.models.length ? <ModelMix models={dashboard.models} refreshing={pending} /> : <EmptyState title="No model mix" description="No model usage was recorded for this filter." icon={WalletCardsIcon} />}</div></> : <EmptyState title="No usage yet" description="No gateway activity was recorded for this range." icon={DatabaseIcon} />}
  </DashboardPage>
}
