import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DashboardPayload } from "@/lib/types"
import { UsageTrendChart } from "./usage-trend-chart"

export function OverviewUsageTrend({ data, period, error }: { data?: DashboardPayload["trend"]; period: string; error?: boolean }) {
  return <Card>
    <CardHeader><CardTitle>Usage Trend</CardTitle><CardDescription>Token usage over time</CardDescription></CardHeader>
    <CardContent className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-72 min-w-0 flex-1 sm:min-h-80" role="img" aria-label="Token usage trend">
        {error ? <p>Usage trend unavailable.</p> : !data ? <Skeleton className="absolute inset-0" /> : <UsageTrendChart data={data} granularity={period === "24h" ? "hourly" : "daily"} />}
      </div>
    </CardContent>
  </Card>
}
