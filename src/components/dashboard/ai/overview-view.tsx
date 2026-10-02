import { BudgetUsageCard, QuickAccessCard, RecentRequestsCard } from "./overview-cards"
import { useState } from "react"
import { Link } from "react-router"
import { ActivityIcon, CheckCircle2Icon, Clock3Icon, CoinsIcon, DatabaseZapIcon, LayersIcon } from "lucide-react"
import { OverviewUsageTrend } from "./overview-usage-trend"
import { DashboardPage } from "../page-layout"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { pagePaths } from "@/lib/dashboard/routes"

const models = [
  { name: "GPT-5", provider: "Codex", requests: "7,820", share: 58, cost: "$18.42" },
  { name: "Claude Sonnet", provider: "Anthropic", requests: "3,910", share: 29, cost: "$12.68" },
  { name: "Gemini Flash", provider: "Google", requests: "1,760", share: 13, cost: "$1.54" },
]

function metricValue(period: string, day: string, week: string, month: string) {
  return ({ "24h": day, "7d": week, "30d": month })[period] || day
}

/** Product preview only: no live metrics or workspace credentials are read. */
export function OverviewView() {
  const [period, setPeriod] = useState<"24h" | "7d" | "30d">("24h")
  return <DashboardPage spacing="normal">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="text-2xl font-semibold tracking-tight">Your gateway at a glance</h2><p className="mt-1 text-sm text-muted-foreground">A snapshot of traffic, reliability, and spend for this workspace.</p></div>
      <div className="flex gap-1 rounded-lg border p-1" role="group" aria-label="Preview time range">{(["24h", "7d", "30d"] as const).map(value => <Button key={value} size="sm" variant={period === value ? "secondary" : "ghost"} aria-pressed={period === value} onClick={() => setPeriod(value)}>{value === "24h" ? "Past 24h" : value === "7d" ? "7 days" : "30 days"}</Button>)}</div>
    </div>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[
        { label: "Tokens processed", value: metricValue(period, "6.42M", "42.6M", "182.4M"), note: "Input + cached input + output tokens", icon: LayersIcon },
        { label: "Requests", value: metricValue(period, "13,490", "89,420", "384,210"), note: "+12.8% vs previous period", icon: ActivityIcon },
        { label: "Success rate", value: metricValue(period, "99.8%", "99.7%", "99.6%"), note: "Successful requests / total requests", icon: CheckCircle2Icon },
        { label: "Estimated spend", value: metricValue(period, "$32.64", "$214.80", "$924.60"), note: "Based on configured model rates", icon: CoinsIcon },
        { label: "Avg Latency", value: metricValue(period, "1.4s", "1.6s", "1.5s"), note: "Average response time per request", icon: Clock3Icon },
        { label: "Cache hit rate", value: metricValue(period, "68.4%", "67.1%", "65.2%"), note: "Cached input / total input tokens", icon: DatabaseZapIcon },
      ].map(metric => <Card key={metric.label}><CardHeader><div className="flex items-center justify-between gap-2"><CardDescription>{metric.label}</CardDescription><metric.icon className="size-4 text-muted-foreground" /></div><CardTitle variant="metric">{metric.value}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{metric.note}</p></CardContent></Card>)}
    </div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <OverviewUsageTrend period={period} />
      <div className="flex min-w-0 flex-col gap-4"><BudgetUsageCard /><QuickAccessCard /></div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Most used models</CardTitle><CardDescription>Requests and tokens by model</CardDescription><CardAction><Button variant="link" size="sm" nativeButton={false} render={<Link to={pagePaths.overviewUsage} />}>View All</Button></CardAction></CardHeader><CardContent spacing="stack">{models.map(model => <div key={model.name} className="space-y-2"><div className="flex items-center justify-between gap-4"><div><p className="font-medium">{model.name}</p><p className="text-xs text-muted-foreground">{model.provider} · {model.requests} requests</p></div><div className="text-right"><p className="font-medium">{model.cost}</p><p className="text-xs text-muted-foreground">{model.share}% of requests</p></div></div><Progress value={model.share} aria-label={`${model.name}: ${model.share} percent of sample requests`} /></div>)}</CardContent></Card>
      <RecentRequestsCard />
    </div>
  </DashboardPage>
}
