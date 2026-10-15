import type { ReactNode } from "react"
import { ActivityIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import type { DashboardPayload } from "@/lib/types"
import { formatCost, formatRequestCount, formatTokenCount } from "@/lib/usage-display"

/** Request shares always use the full period total, including rows outside the limit. */
export function MostUsedModels({ models, totalRequests = 0, error, refreshing, limit, action }: {
  models?: DashboardPayload["models"]; totalRequests?: number; error?: boolean; refreshing?: boolean; limit?: number; action?: ReactNode
}) {
  let content = <>{[0, 1, 2].map(index => <Skeleton key={index} className="h-16 w-full" />)}</>
  if (error) content = <p>Model usage unavailable.</p>
  else if (models && !models.length) content = <p className="text-sm text-muted-foreground">No model usage in this period.</p>
  else if (models) content = <>{models.slice().sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)).slice(0, limit).map(model => {
    const share = totalRequests > 0 ? model.requests / totalRequests * 100 : 0
    return <div key={model.model} className="flex flex-col gap-2"><div className="flex items-center justify-between gap-4"><div className="min-w-0"><p className="truncate font-medium" title={model.model}>{model.model}</p><p className="text-xs text-muted-foreground">{formatRequestCount(model.requests)} requests · {formatTokenCount(model.tokens)} tokens</p></div><div className="shrink-0 text-right"><p className="font-medium">{formatCost(model.costMicros)}</p><p className="text-xs text-muted-foreground">{share.toFixed(1)}% of requests</p></div></div><Progress value={share} aria-label={`${model.model}: ${share.toFixed(1)} percent of requests`} /></div>
  })}</>
  return <Card className="relative min-w-0 self-start" aria-busy={refreshing || undefined}>
    {refreshing && <div className="pointer-events-none absolute inset-0 flex items-start justify-end rounded-inherit bg-background/40 p-3 backdrop-blur-scrim"><Badge variant="refreshing"><ActivityIcon className="size-3.5 animate-spin" />Refreshing data...</Badge></div>}
    <CardHeader><CardTitle>Most used models</CardTitle><CardDescription>Ranked by recorded requests</CardDescription>{action && <CardAction>{action}</CardAction>}</CardHeader>
    <CardContent spacing="stack" className="max-h-128 overflow-y-auto">{content}</CardContent>
  </Card>
}
