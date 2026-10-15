import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { formatCost, formatTokenCount } from "@/lib/usage-display"
import type { DashboardPayload } from "@/lib/types"
import { formatAppDate, formatAppDateTime, formatAppTrendBucket } from "@/lib/timezone"
const { Area, AreaChart, CartesianGrid, XAxis, YAxis } = await import("recharts")

const chartConfig = { tokens: { label: "Tokens", color: "var(--chart-1)" }, cost: { label: "Cost", color: "var(--chart-2)" } }

function formatTooltipBucket(point: unknown, period: string) {
  return typeof point === "object" && point !== null && "bucketStart" in point && typeof point.bucketStart === "string"
    ? (period === "7d" || period === "30d" ? formatAppDate(point.bucketStart) : formatAppDateTime(point.bucketStart))
    : null
}

export function OverviewUsageTrend({ data, period, error }: { data?: DashboardPayload["trend"]; period: string; error?: boolean }) {
  const points = data?.map(point => ({ ...point, time: Date.parse(point.bucketStart), cost: point.costMicros / 1_000_000 }))
  return <Card>
    <CardHeader><CardTitle>Usage Trend</CardTitle><CardDescription>Token usage over time</CardDescription></CardHeader>
    <CardContent className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-72 min-w-0 flex-1 sm:min-h-80" role="img" aria-label="Token usage trend">
        {error ? <p>Usage trend unavailable.</p> : !points ? <Skeleton className="absolute inset-0" /> : <ChartContainer config={chartConfig} className="absolute inset-0 size-full min-w-0 aspect-auto overflow-hidden"><AreaChart data={points} margin={{ top: 12, right: 24, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={value => formatAppTrendBucket(value, period === "24h" ? "hourly" : "daily", "hour")} tickLine={false} axisLine={false} minTickGap={48} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <YAxis yAxisId="tokens" width={48} tickFormatter={formatTokenCount} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <YAxis yAxisId="cost" orientation="right" width={64} tickFormatter={value => formatCost(Number(value) * 1_000_000)} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <ChartTooltip isAnimationActive={false} content={<ChartTooltipContent labelFormatter={(_label, payload) => formatTooltipBucket(payload[0]?.payload, period)} formatter={(value, name) => <div className="flex w-full items-center justify-between gap-4"><span>{name === "cost" ? "Cost" : "Tokens"}</span><span className="font-mono">{name === "cost" ? formatCost(Number(value ?? 0) * 1_000_000) : formatTokenCount(Number(value ?? 0))}</span></div>} />} />
          <Area yAxisId="tokens" type="monotone" dataKey="tokens" stroke="var(--color-tokens)" fill="var(--color-tokens)" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
          <Area yAxisId="cost" type="monotone" dataKey="cost" stroke="var(--color-cost)" fill="var(--color-cost)" fillOpacity={0.05} strokeWidth={2} isAnimationActive={false} />
          <ChartLegend content={<ChartLegendContent />} />
        </AreaChart></ChartContainer>}
      </div>
    </CardContent>
  </Card>
}
