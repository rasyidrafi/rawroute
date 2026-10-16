import { BudgetUsageCard, QuickAccessCard, RecentRequestsCard } from "./overview-cards"
import { Link } from "react-router"
import { ActivityIcon, CheckCircle2Icon, Clock3Icon, CoinsIcon, DatabaseZapIcon, LayersIcon, RefreshCwIcon } from "lucide-react"
import { OverviewUsageTrend } from "./overview-usage-trend"
import { DashboardPage } from "../page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { MostUsedModels } from "./most-used-models"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { pagePaths } from "@/lib/dashboard/routes"
import { useOverview } from "@/hooks/use-overview"
import type { OverviewPayload, OverviewPeriod } from "@/lib/overview"
import type { RequestLogsPage } from "@/lib/request-logs"
import { formatCost, formatDuration, formatRequestCount, formatTokenCount } from "@/lib/usage-display"
import { useDashboardApi } from "@/components/dashboard/api-context"

export function OverviewView() {
  const { workspaceId } = useDashboardApi()
  return <OverviewWorkspace key={workspaceId} />
}

function OverviewWorkspace() {
  const state = useOverview()
  return <OverviewLayout data={state.aggregate.error ? undefined : state.aggregate.data} period={state.period} onPeriod={state.setPeriod} refresh={state.refresh} busy={!state.workspaceId || state.aggregate.isValidating || state.recent.isValidating} error={!!state.aggregate.error} recent={state.recent.data} recentError={!!state.recent.error} recentLoading={!state.workspaceId || state.recent.isLoading} retryRecent={() => { void state.recent.mutate() }} />
}

/** The route fallback shares the actual layout but never mounts data hooks. */
export function OverviewSkeleton() {
  return <OverviewLayout period="24h" busy recentLoading />
}

function overviewMetrics(data?: OverviewPayload) {
  const overview = data?.overview
  const summary = data?.summary
  const unavailable = "Unavailable"
  const coverage = data?.coverage
  const omitted = (coverage?.excludedSources || 0) > 0
  return [
    { label: "Tokens processed", value: summary && (summary.tokens === 0 && (omitted || (coverage && coverage.tokenCoveredRequests < summary.requests)) ? unavailable : formatTokenCount(summary.tokens)), note: "Input + cached input + output tokens", icon: LayersIcon },
    { label: "Requests", value: summary && (summary.requests === 0 && omitted ? unavailable : formatRequestCount(summary.requests)), note: "Recorded model attempts in this period", icon: ActivityIcon },
    { label: "Success rate", value: !omitted && overview && summary && summary.requests > 0 && overview.statusCoveredRequests === summary.requests ? `${((summary.requests - overview.failedRequests) / summary.requests * 100).toFixed(1)}%` : unavailable, note: omitted || (overview && summary && overview.statusCoveredRequests < summary.requests) ? "Historical status coverage is incomplete" : "Successful attempts / all recorded attempts", icon: CheckCircle2Icon },
    { label: "Estimated spend", value: summary && (summary.costMicros === 0 && (omitted || (coverage && coverage.costCoveredRequests < summary.requests)) ? unavailable : formatCost(summary.costMicros)), note: "Based on configured model rates", icon: CoinsIcon },
    { label: "Avg latency", value: overview?.durationCount ? formatDuration(overview.durationSumMs / overview.durationCount) : unavailable, note: "Average time completion", icon: Clock3Icon },
    { label: "Cache ratio", value: overview?.cacheUsageInputTokens ? `${(overview.cacheUsageReadTokens / overview.cacheUsageInputTokens * 100).toFixed(1)}%` : unavailable, note: "Share of input tokens served from cache.", icon: DatabaseZapIcon },
  ]
}

function OverviewLayout({ data, period, onPeriod, refresh, busy, error, recent, recentError, recentLoading, retryRecent }: {
  data?: OverviewPayload; period: OverviewPeriod; onPeriod?: (value: OverviewPeriod) => void; refresh?: () => void; busy?: boolean; error?: boolean;
  recent?: RequestLogsPage; recentError?: boolean; recentLoading?: boolean; retryRecent?: () => void
}) {
  const metrics = overviewMetrics(data)
  return <DashboardPage spacing="normal" aria-busy={busy || undefined}>
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="text-2xl font-semibold tracking-tight">Your gateway at a glance</h2><p className="mt-1 text-sm text-muted-foreground">Recorded traffic, reliability, and spend for this workspace.</p></div>
      <div className="flex flex-wrap items-center gap-2"><ToggleGroup aria-label="Overview time range" value={[period]} onValueChange={values => { const value = values[0]; if (value === "24h" || value === "7d" || value === "30d") onPeriod?.(value) }} size="sm" variant="outline">{(["24h", "7d", "30d"] as const).map(value => <ToggleGroupItem disabled={!onPeriod} key={value} value={value}>{value === "24h" ? "Past 24h" : value === "7d" ? "7 days" : "30 days"}</ToggleGroupItem>)}</ToggleGroup><Button variant="outline" size="sm" disabled={busy || !refresh} onClick={refresh}><RefreshCwIcon data-icon="inline-start" />{busy && refresh ? "Refreshing…" : "Refresh"}</Button></div>
    </div>
    {error && <Alert variant="destructive"><AlertDescription>Unable to load overview. <Button variant="link" size="sm" onClick={refresh} disabled={busy}>Retry overview</Button></AlertDescription></Alert>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {metrics.map(metric => <Card key={metric.label}><CardHeader><div className="flex items-center justify-between gap-2"><CardDescription>{metric.label}</CardDescription><metric.icon className="size-4 text-muted-foreground" /></div><CardTitle variant="metric">{data ? metric.value : error ? "Unavailable" : <Skeleton className="h-9 w-32" />}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{metric.note}</p></CardContent></Card>)}
    </div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <OverviewUsageTrend data={data?.trend} period={period} error={error} />
      <div className="flex min-w-0 flex-col gap-4"><BudgetUsageCard data={data?.overview} error={error} /><QuickAccessCard /></div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <MostUsedModels className="lg:self-stretch" models={data?.models} totalRequests={data?.summary.requests} error={error} limit={3} action={<Button variant="link" size="sm" nativeButton={false} render={<Link to={pagePaths.overviewUsage} />}>View all</Button>} />
      <RecentRequestsCard data={recent} loading={recentLoading} error={recentError} retry={retryRecent} />
    </div>
  </DashboardPage>
}
