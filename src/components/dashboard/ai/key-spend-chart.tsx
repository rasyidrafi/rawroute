import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import type { DashboardPayload } from "@/lib/types"
import { formatCost } from "@/lib/usage-display"
import { formatAppDate, formatAppTrendBucket } from "@/lib/timezone"

const { Bar, BarChart, CartesianGrid, XAxis, YAxis } = await import("recharts")
const config = { cost: { label: "Cost" } }

function tooltipDate(point: unknown) {
  return typeof point === "object" && point !== null && "bucketStart" in point && typeof point.bucketStart === "string" ? formatAppDate(point.bucketStart) : null
}

export function KeySpendChart({ data, unavailable }: { data: DashboardPayload; unavailable: boolean }) {
  const points = data.trend.map(point => ({ ...point, cost: point.costMicros / 1_000_000 }))
  return <Card><CardHeader><CardTitle>Daily spend</CardTitle><CardDescription>{formatAppDate(data.range.from)} – {formatAppDate(data.range.to)}</CardDescription></CardHeader><CardContent className="flex min-h-64 flex-1 flex-col">
    {unavailable ? <p className="text-sm text-muted-foreground">Spend history unavailable: financial coverage is incomplete.</p> : <ChartContainer config={config} className="h-64 w-full min-w-0 flex-1 aspect-auto"><BarChart data={points} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <XAxis dataKey="bucketStart" tickFormatter={value => formatAppTrendBucket(value, "daily")} tickLine={false} axisLine={false} minTickGap={24} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
      <YAxis width={64} tickFormatter={value => formatCost(Number(value) * 1_000_000)} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
      <ChartTooltip isAnimationActive={false} content={<ChartTooltipContent labelFormatter={(_label, payload) => tooltipDate(payload[0]?.payload)} formatter={value => <div className="flex w-full items-center justify-between gap-4"><span>Cost</span><span className="font-mono">{formatCost(Number(value ?? 0) * 1_000_000)}</span></div>} />} />
      <Bar dataKey="cost" fill="var(--primary)" radius={[5, 5, 0, 0]} maxBarSize={40} isAnimationActive={false} />
    </BarChart></ChartContainer>}
  </CardContent></Card>
}
