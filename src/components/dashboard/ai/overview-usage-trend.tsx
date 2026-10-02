import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
const { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } = await import("recharts")

type Period = "24h" | "7d" | "30d"
const totals: Record<Period, number> = { "24h": 6_420_000, "7d": 42_600_000, "30d": 182_400_000 }
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

const hourAxis = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const dayAxis = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
const hourTooltip = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const dayTooltip = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" })

function sampleTrend(period: Period, now: Date) {
  const hourly = period === "24h"
  const count = hourly ? 24 : period === "7d" ? 7 : 30
  const end = new Date(now)
  if (hourly) end.setMinutes(0, 0, 0)
  else end.setHours(0, 0, 0, 0)
  const weights = Array.from({ length: count }, (_, i) => 0.15 + Math.pow(Math.sin(i * 0.63 + 0.4), 2) * (1 + i / count))
  const sum = weights.reduce((total, value) => total + value, 0)
  let allocated = 0
  return weights.map((weight, i) => {
    const date = new Date(end)
    if (hourly) date.setTime(end.getTime() - (count - 1 - i) * 3_600_000)
    else date.setDate(end.getDate() - (count - 1 - i))
    const tokens = i === count - 1 ? totals[period] - allocated : Math.round(weight / sum * totals[period])
    allocated += tokens
    return { time: date.getTime(), tokens }
  })
}

export function OverviewUsageTrend({ period }: { period: Period }) {
  const [now] = useState(() => new Date())
  const hourly = period === "24h"
  const data = sampleTrend(period, now)
  const ticks = [data[0]!.time, data[Math.floor(data.length / 2)]!.time, data[data.length - 1]!.time]
  const axisFormat = hourly ? hourAxis : dayAxis
  const tooltipFormat = hourly ? hourTooltip : dayTooltip
  return <Card>
    <CardHeader><CardTitle>Usage Trend</CardTitle><CardDescription>Token usage over time</CardDescription></CardHeader>
    <CardContent className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-72 min-w-0 flex-1 sm:min-h-80" role="img" aria-label={`Sample token usage: ${hourly ? "24 hourly" : `${data.length} daily`} buckets, in your local timezone`}>
        <div className="absolute inset-0 overflow-hidden">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={data} margin={{ top: 12, right: 24, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={ticks} interval={0} tickFormatter={value => axisFormat.format(new Date(value)).toUpperCase()} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
            <YAxis width={48} tickFormatter={value => compact.format(value)} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
            <Tooltip isAnimationActive={false} allowEscapeViewBox={{ x: false, y: false }} labelFormatter={value => tooltipFormat.format(new Date(Number(value)))} formatter={value => [Number(value).toLocaleString("en-US"), "Tokens"]} contentStyle={{ background: "var(--popover)", borderColor: "var(--border)", borderRadius: 8, color: "var(--popover-foreground)" }} />
            <Area type="monotone" dataKey="tokens" name="Tokens" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
        </div>
      </div>
    </CardContent>
  </Card>
}
