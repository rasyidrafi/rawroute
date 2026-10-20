import { useState } from "react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@rawroute/ui/chart"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@rawroute/ui/tabs"
import type { DashboardPayload } from "../../contracts/domain"
import { formatCost, formatTokenCount } from "../../contracts/usage-display"
import { formatAppDate, formatAppTrendBucket } from "@rawroute/observability/contracts/timezone"

const { Bar, BarChart, CartesianGrid, XAxis, YAxis } = await import("recharts")
const config = { cost: { label: "Cost" }, tokens: { label: "Tokens" } }
type ChartMetric = "cost" | "tokens"

function tooltipDate(point: unknown) {
  return typeof point === "object" && point !== null && "bucketStart" in point && typeof point.bucketStart === "string" ? formatAppDate(point.bucketStart) : null
}

export function KeySpendChart({ data, unavailable }: { data: DashboardPayload; unavailable: boolean }) {
  const points = data.trend.map(point => ({ ...point, cost: point.costMicros / 1_000_000 }))
  const [metric, setMetric] = useState<ChartMetric>("cost")
  const tokensUnavailable = !!data.summary.requests && data.coverage?.tokenCoveredRequests === 0
  const hasDailyData = points.some(point => metric === "cost" ? point.cost > 0 : point.tokens > 0)
  const noDailyHistory = !points.length && data.summary.requests > 0
  const title = metric === "cost" ? "Daily spend" : "Daily token usage"

  function renderChart() {
    if (metric === "cost" && unavailable) return <p className="text-sm text-muted-foreground">Spend history unavailable: financial coverage is incomplete.</p>
    if (metric === "tokens" && tokensUnavailable) return <p className="text-sm text-muted-foreground">Token history unavailable: token coverage is incomplete.</p>
    if (noDailyHistory) return <p className="text-sm text-muted-foreground">Daily history unavailable for this window.</p>
    if (!hasDailyData) return <p className="text-sm text-muted-foreground">{metric === "cost" ? "No spend recorded in this window." : "No token usage recorded in this window."}</p>

    const dataKey = metric
    const formatValue = (value: number) => metric === "cost" ? formatCost(value * 1_000_000) : formatTokenCount(value)
    return <ChartContainer config={config} className="h-64 w-full min-w-0 aspect-auto"><BarChart data={points} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <XAxis dataKey="bucketStart" tickFormatter={value => formatAppTrendBucket(value, "daily")} tickLine={false} axisLine={false} minTickGap={24} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
      <YAxis width={64} tickFormatter={value => formatValue(Number(value))} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
      <ChartTooltip isAnimationActive={false} content={<ChartTooltipContent labelFormatter={(_label, payload) => tooltipDate(payload[0]?.payload)} formatter={value => <div className="flex w-full items-center justify-between gap-4"><span>{metric === "cost" ? "Cost" : "Tokens"}</span><span className="font-mono">{formatValue(Number(value ?? 0))}</span></div>} />} />
      <Bar dataKey={dataKey} fill="var(--primary)" radius={[5, 5, 0, 0]} maxBarSize={40} isAnimationActive={false} />
    </BarChart></ChartContainer>
  }

  return <Card><Tabs value={metric} onValueChange={value => { if (value === "cost" || value === "tokens") setMetric(value) }} className="w-full min-w-0">
    <CardHeader><div><CardTitle>{title}</CardTitle><CardDescription>{formatAppDate(data.range.from)} – {formatAppDate(data.range.to)}</CardDescription></div><CardAction><TabsList aria-label="Daily usage metric"><TabsTrigger value="cost">Cost</TabsTrigger><TabsTrigger value="tokens">Token</TabsTrigger></TabsList></CardAction></CardHeader>
    <TabsContent value="cost" className="mt-0 w-full min-w-0"><CardContent className="min-h-64">{renderChart()}</CardContent></TabsContent>
    <TabsContent value="tokens" className="mt-0 w-full min-w-0"><CardContent className="min-h-64">{renderChart()}</CardContent></TabsContent>
  </Tabs></Card>
}
