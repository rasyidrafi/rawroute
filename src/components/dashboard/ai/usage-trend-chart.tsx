import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { formatCost, formatTokenCount } from "@/lib/usage-display"
import type { DashboardPayload } from "@/lib/types"
import { formatAppDate, formatAppDateTime, formatAppTrendBucket } from "@/lib/timezone"
const { Area, AreaChart, CartesianGrid, XAxis, YAxis } = await import("recharts")

const chartConfig = { tokens: { label: "Tokens" }, cost: { label: "Cost" } }

function formatTooltipBucket(point: unknown, granularity: string) {
  return typeof point === "object" && point !== null && "bucketStart" in point && typeof point.bucketStart === "string"
    ? (granularity === "hourly" ? formatAppDateTime(point.bucketStart) : formatAppDate(point.bucketStart))
    : null
}

export function UsageTrendChart({ data, granularity }: { data: DashboardPayload["trend"]; granularity: DashboardPayload["range"]["granularity"] }) {
  const points = data.map(point => ({ ...point, time: Date.parse(point.bucketStart), cost: point.costMicros / 1_000_000 }))
  const multiDay = points.length > 1 && formatAppDate(points[0]!.time) !== formatAppDate(points.at(-1)!.time)
  return <ChartContainer config={chartConfig} className="absolute inset-0 size-full min-w-0 aspect-auto overflow-hidden"><AreaChart data={points} margin={{ top: 12, right: 24, left: 0, bottom: 0 }}>
          <CartesianGrid yAxisId="tokens" vertical={false} stroke="var(--border)" />
          <XAxis dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={value => formatAppTrendBucket(value, granularity, multiDay ? undefined : "hour")} tickLine={false} axisLine={false} minTickGap={48} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <YAxis yAxisId="tokens" width={48} tickFormatter={formatTokenCount} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <YAxis yAxisId="cost" orientation="right" width={64} tickFormatter={value => formatCost(Number(value) * 1_000_000)} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <ChartTooltip isAnimationActive={false} content={<ChartTooltipContent labelFormatter={(_label, payload) => formatTooltipBucket(payload[0]?.payload, granularity)} formatter={(value, name) => <div className="flex w-full items-center justify-between gap-4"><span>{name === "cost" ? "Cost" : "Tokens"}</span><span className="font-mono">{name === "cost" ? formatCost(Number(value ?? 0) * 1_000_000) : formatTokenCount(Number(value ?? 0))}</span></div>} />} />
          <Area yAxisId="tokens" type="monotone" dataKey="tokens" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
          <Area yAxisId="cost" type="monotone" dataKey="cost" stroke="var(--chart-2)" fill="var(--chart-2)" fillOpacity={0.05} strokeWidth={2} isAnimationActive={false} />
          <ChartLegend content={<ChartLegendContent />} />
        </AreaChart></ChartContainer>
}
