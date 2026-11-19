import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import type { DashboardPayload } from "../../contracts/domain"
import { UsageTrendChart } from "./usage-trend-chart"

export function KeyUsageTrend({ data, unavailable }: { data: DashboardPayload; unavailable: boolean }) {
  return <Card className="min-w-0">
    <CardHeader><CardTitle>Usage Trend</CardTitle><CardDescription>Token usage over time</CardDescription></CardHeader>
    <CardContent className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-72 min-w-0 flex-1 sm:min-h-80" role="img" aria-label="Token usage trend">
        {unavailable ? <p className="text-sm text-muted-foreground">Usage trend unavailable: recorded coverage is incomplete.</p> : !data.trend.length ? <p className="text-sm text-muted-foreground">No usage recorded in this window.</p> : <UsageTrendChart data={data.trend} granularity={data.range.granularity} />}
      </div>
    </CardContent>
  </Card>
}
