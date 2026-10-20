import { ActivityIcon, CoinsIcon, KeyRoundIcon, LayersIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Skeleton } from "@rawroute/ui/skeleton"
import type { DashboardPayload } from "../../contracts/domain"
import { formatNumber } from "./usage-utils"
import { formatCost, formatRequestCount, formatTokenCount } from "../../contracts/usage-display"

function summaryMetrics(dashboard?: DashboardPayload) {
  const summary = dashboard?.summary
  const coverage = dashboard?.coverage
  const omitted = (coverage?.excludedSources || 0) > 0
  return [
    { title: "Tokens processed", value: summary && (summary.tokens === 0 && (omitted || (coverage && coverage.tokenCoveredRequests < summary.requests)) ? "Unavailable" : formatTokenCount(summary.tokens)), detail: "Input + cached input + output tokens", icon: LayersIcon },
    { title: "Requests", value: summary && (summary.requests === 0 && omitted ? "Unavailable" : formatRequestCount(summary.requests)), detail: "Recorded model attempts in this period", icon: ActivityIcon },
    { title: "Estimated spend", value: summary && (summary.costMicros === 0 && (omitted || (coverage && coverage.costCoveredRequests < summary.requests)) ? "Unavailable" : formatCost(summary.costMicros)), detail: "Based on configured model rates", icon: CoinsIcon },
    { title: "Active keys", value: summary && (summary.activeKeys === 0 && (omitted || summary.requests > 0) ? "Unavailable" : formatNumber(summary.activeKeys)), detail: "Keys that handled traffic in this window.", icon: KeyRoundIcon },
  ]
}

export function UsageSummary({ dashboard, refreshing = false }: { dashboard?: DashboardPayload; refreshing?: boolean }) {
  const metrics = summaryMetrics(dashboard)
  return <section className="space-y-4" aria-busy={!dashboard || refreshing} data-slot="usage-summary">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold tracking-tight">Usage summary</h2><p className="text-sm text-muted-foreground">High-level totals for the currently selected range.</p></div></div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(({ title, value, detail, icon: Icon }) => <Card key={title}>
      <CardHeader><div className="flex items-center justify-between gap-2"><CardDescription>{title}</CardDescription><Icon className="size-4 text-muted-foreground" /></div><CardTitle variant="metric">{value ?? <Skeleton className="h-lh w-28" />}</CardTitle></CardHeader>
      <CardContent><p className="text-xs text-muted-foreground">{detail}</p></CardContent>
    </Card>)}</div>
  </section>
}
