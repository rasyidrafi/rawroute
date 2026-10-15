import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatTokenCount } from "@/lib/usage-display"
import type { DashboardPayload } from "@/lib/types"
import { formatAppDateTime, formatAppTrendBucket } from "@/lib/timezone"
const { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } = await import("recharts")

export function OverviewUsageTrend({ data, period, error }: { data?: DashboardPayload["trend"]; period: string; error?: boolean }) {
  const points = data?.map(point => ({ ...point, time: Date.parse(point.bucketStart) }))
  return <Card>
    <CardHeader><CardTitle>Usage Trend</CardTitle><CardDescription>Token usage over time</CardDescription></CardHeader>
    <CardContent className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-72 min-w-0 flex-1 sm:min-h-80" role="img" aria-label="Token usage trend">
        {error ? <p>Usage trend unavailable.</p> : !points ? <Skeleton className="absolute inset-0" /> : <div className="absolute inset-0 overflow-hidden"><ResponsiveContainer width="100%" height="100%" minWidth={0}><AreaChart data={points} margin={{ top: 12, right: 24, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={value => formatAppTrendBucket(value, period === "24h" ? "hourly" : "daily", "hour")} tickLine={false} axisLine={false} minTickGap={48} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <YAxis width={48} tickFormatter={formatTokenCount} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <Tooltip isAnimationActive={false} labelFormatter={value => formatAppDateTime(new Date(Number(value)).toISOString())} formatter={value => [formatTokenCount(Number(value)), "Tokens"]} contentStyle={{ background: "var(--popover)", borderColor: "var(--border)", borderRadius: 8, color: "var(--popover-foreground)" }} />
          <Area type="monotone" dataKey="tokens" name="Tokens" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
        </AreaChart></ResponsiveContainer></div>}
      </div>
    </CardContent>
  </Card>
}
