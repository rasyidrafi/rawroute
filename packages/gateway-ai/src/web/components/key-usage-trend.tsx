import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { RefreshScrim } from "@rawroute/ui/loading-layout"
import type { DashboardPayload } from "../../contracts/domain"
import { UsageTrendChart } from "./usage-trend-chart"

export function KeyUsageTrend({ data, unavailable, refreshing }: { data: DashboardPayload; unavailable: boolean; refreshing?: boolean }) {
  return <Card className="relative min-w-0" aria-busy={refreshing || undefined}>
    {refreshing && <RefreshScrim />}
    <CardHeader><CardTitle>Usage Trend</CardTitle><CardDescription>Token usage over time</CardDescription></CardHeader>
    <CardContent className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-72 min-w-0 flex-1 sm:min-h-80" role="img" aria-label="Token usage trend">
        {unavailable ? <p className="text-sm text-muted-foreground">Usage trend unavailable: recorded coverage is incomplete.</p> : !data.trend.length ? <p className="text-sm text-muted-foreground">No usage recorded in this window.</p> : <UsageTrendChart data={data.trend} granularity={data.range.granularity} />}
      </div>
    </CardContent>
  </Card>
}
