import { useState } from "react"
import { ActivityIcon } from "lucide-react"
import { Badge } from "@rawroute/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Progress } from "@rawroute/ui/progress"
import { Skeleton } from "@rawroute/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@rawroute/ui/tabs"
import type { DashboardPayload } from "../../contracts/domain"
import { formatCost, formatRequestCount, formatTokenCount } from "../../contracts/usage-display"
import { cn } from "@rawroute/ui/utils"

type RankMetric = "requests" | "cost" | "tokens"
const metricNoun: Record<RankMetric, string> = { requests: "requests", cost: "cost", tokens: "tokens" }

/** Shares always use the full period total of the selected metric, including rows outside the limit. */
export function MostUsedModels({ models, totalRequests = 0, totalCostMicros = 0, totalTokens = 0, error, refreshing, limit, className }: {
  models?: DashboardPayload["models"]; totalRequests?: number; totalCostMicros?: number; totalTokens?: number; error?: boolean; refreshing?: boolean; limit?: number; className?: string
}) {
  const [metric, setMetric] = useState<RankMetric>("requests")
  const total = metric === "cost" ? totalCostMicros : metric === "tokens" ? totalTokens : totalRequests
  const metricValue = (model: DashboardPayload["models"][number]) => metric === "cost" ? model.costMicros : metric === "tokens" ? model.tokens : model.requests
  let content = <>{[0, 1, 2].map(index => <Skeleton key={index} className="h-16 w-full" />)}</>
  if (error) content = <p>Model usage unavailable.</p>
  else if (models && !models.length) content = <p className="text-sm text-muted-foreground">No model usage in this period.</p>
  else if (models) content = <>{models.slice().sort((a, b) => metricValue(b) - metricValue(a) || a.model.localeCompare(b.model)).slice(0, limit).map(model => {
    const share = total > 0 ? metricValue(model) / total * 100 : 0
    return <div key={model.model} className="flex flex-col gap-2"><div className="flex items-center justify-between gap-4"><div className="min-w-0"><p className="truncate font-medium" title={model.model}>{model.model}</p><p className="text-xs text-muted-foreground">{formatRequestCount(model.requests)} requests · {formatTokenCount(model.tokens)} tokens</p></div><div className="shrink-0 text-right"><p className="font-medium">{formatCost(model.costMicros)}</p><p className="text-xs text-muted-foreground">{share.toFixed(1)}% of {metricNoun[metric]}</p></div></div><Progress value={share} aria-label={`${model.model}: ${share.toFixed(1)} percent of ${metricNoun[metric]}`} /></div>
  })}</>
  return <Card className={cn("relative min-w-0 self-start", className)} aria-busy={refreshing || undefined}>
    {refreshing && <div className="pointer-events-none absolute inset-0 flex items-start justify-end rounded-inherit bg-background/40 p-3 backdrop-blur-scrim"><Badge variant="refreshing"><ActivityIcon className="size-3.5 animate-spin" />Refreshing data...</Badge></div>}
    <Tabs value={metric} onValueChange={value => { if (value === "requests" || value === "cost" || value === "tokens") setMetric(value) }} className="w-full min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
      <CardHeader><CardTitle>Most used models</CardTitle><CardDescription>Ranked by recorded {metricNoun[metric]}</CardDescription><CardAction><TabsList aria-label="Most used models metric"><TabsTrigger value="requests">Requests</TabsTrigger><TabsTrigger value="cost">Cost</TabsTrigger><TabsTrigger value="tokens">Token</TabsTrigger></TabsList></CardAction></CardHeader>
      <TabsContent value={metric} className="mt-0 w-full min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"><CardContent spacing="stack" className="max-h-128 overflow-y-auto lg:min-h-0 lg:flex-1 xl:max-h-none">{content}</CardContent></TabsContent>
    </Tabs>
  </Card>
}
