import { Link } from "react-router"
import { ArrowUpRightIcon } from "lucide-react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Button } from "@rawroute/ui/button"
import { Progress } from "@rawroute/ui/progress"
import { Skeleton } from "@rawroute/ui/skeleton"
import { Badge } from "@rawroute/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@rawroute/ui/table"
import { Alert, AlertDescription } from "@rawroute/ui/alert"
import { aiPagePaths as pagePaths } from "../../contracts/pages"
import type { OverviewDetails } from "../../contracts/overview"
import type { RequestLogsPage } from "../../contracts/request-logs"
import { formatCost, formatDuration } from "../../contracts/usage-display"
import { formatAppDateTime } from "@rawroute/observability/contracts/timezone"
import { RequestLogMetadata, RequestLogMetadataSkeleton, requestLogMetadataDescription } from "./request-logs-table"

export function BudgetUsageCard({ data, error }: { data?: OverviewDetails; error?: boolean }) {
  return <Card>
    <CardHeader><CardTitle>Budget Usage</CardTitle><CardDescription>Current budget window, independent of traffic range</CardDescription><CardAction><Button variant="link" size="sm" nativeButton={false} render={<Link to={pagePaths.budgets} />}>Budgets</Button></CardAction></CardHeader>
    <CardContent spacing="compact-stack">
      {error ? <p>Budget usage unavailable.</p> : !data ? <Skeleton className="h-20 w-full" /> : <>
        {data.budgetWindow && <p className="text-xs text-muted-foreground">{formatAppDateTime(data.budgetWindow.from)} – {formatAppDateTime(data.budgetWindow.to)}{data.budgetWindow.bypassLimits ? " · Unlimited mode" : ""}</p>}
        <GlobalBudgetSummary data={data} />
      </>}
    </CardContent>
  </Card>
}

function GlobalBudgetSummary({ data }: { data: OverviewDetails }) {
  const allocated = data.budgets.reduce((total, budget) => total + budget.limitMicros, 0)
  const spent = data.budgets.reduce((total, budget) => total + (budget.spentMicros ?? 0), 0)
  const unavailable = data.budgets.some(budget => budget.usageAvailable === false || budget.spentMicros === null)
  const percent = allocated > 0 ? spent / allocated * 100 : 0
  if (!data.budgets.length) return <p className="text-sm text-muted-foreground">No configured budgets.</p>
  const unlimited = data.budgetWindow?.bypassLimits === true
  const hasLimit = allocated > 0
  const status = globalBudgetStatus({ unavailable, unlimited, hasLimit, percent })
  const usageMessage = unavailable
    ? "Unavailable · Some historical financial coverage is unavailable"
    : hasLimit
      ? `${Math.round(percent)}% used · ${formatCost(spent)} spent${status ? ` · ${status}` : ""}`
      : status
  return <>
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm"><span className="text-muted-foreground">Configured budget</span><span className="font-medium tabular-nums">{formatCost(allocated)}</span></div>
          {!unavailable && hasLimit && <Progress value={Math.max(0, Math.min(100, percent))} variant={budgetProgressVariant(percent)} aria-label={`Total budget: ${percent.toFixed(1)} percent used`} />}
          <p className="text-xs text-muted-foreground">{usageMessage}</p>
          <p className="text-xs text-muted-foreground">Across {data.budgets.length} configured {data.budgets.length === 1 ? "budget" : "budgets"} in this window</p>
  </>
}

function globalBudgetStatus({ unavailable, unlimited, hasLimit, percent }: { unavailable: boolean; unlimited: boolean; hasLimit: boolean; percent: number }) {
  if (unavailable) return "Some historical financial coverage is unavailable"
  if (unlimited) return "Unlimited Mode active"
  if (!hasLimit) return "No budget limits configured"
  if (percent > 100) return "Exceeded"
  if (percent === 100) return "Limit reached"
  if (percent >= 90) return "Near limit"
  if (percent >= 80) return "Approaching limit"
  return undefined
}

function budgetProgressVariant(percent: number): "default" | "warning" | "destructive" {
  if (percent >= 90) return "destructive"
  if (percent >= 80) return "warning"
  return "default"
}

export function QuickAccessCard() {
  return <Card className="flex-1"><CardHeader><CardTitle>Quick access</CardTitle><CardDescription>Configure how your workspace runs.</CardDescription></CardHeader><CardContent spacing="compact-stack">{[{ label: "Endpoint & API key", to: pagePaths.endpoint }, { label: "Model routing", to: pagePaths.aliases }, { label: "Budgets", to: pagePaths.budgets }].map(item => <Link key={item.to} to={item.to} className="flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><div><p className="text-sm font-medium">{item.label}</p></div><ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" /></Link>)}</CardContent></Card>
}

export function RecentRequestsCard({ data, loading, error, retry }: { data?: RequestLogsPage; loading?: boolean; error?: boolean; retry?: () => void }) {
  return <Card className="min-w-0">
    <CardHeader><CardTitle>Recent Requests</CardTitle><CardDescription>Latest saved model attempts</CardDescription><CardAction><Button variant="link" size="sm" nativeButton={false} render={<Link to={pagePaths.requestLogs} />}>View all</Button></CardAction></CardHeader>
    <CardContent className="min-w-0">
      {error ? <Alert variant="destructive"><AlertDescription>Unable to load recent requests. <Button variant="link" size="sm" onClick={retry}>Retry recent requests</Button></AlertDescription></Alert> : <div className="min-w-0 max-w-full" role={loading ? "status" : undefined} aria-label={loading ? "Loading recent requests" : undefined} aria-busy={loading || undefined}><Table className="min-w-max"><TableHeader><TableRow><TableHead className="min-w-40">Request / model</TableHead><TableHead className="min-w-36" title={requestLogMetadataDescription}>Reasoning / tools</TableHead><TableHead className="min-w-32">Key</TableHead><TableHead className="min-w-28">Status</TableHead><TableHead className="min-w-24">Duration</TableHead><TableHead className="min-w-48">Time</TableHead></TableRow></TableHeader><TableBody>
        {loading ? [0, 1, 2, 3].map(index => <TableRow key={index} variant="static" data-slot="overview-request-skeleton-row"><TableCell><div className="flex flex-col gap-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-36" /></div></TableCell><TableCell><RequestLogMetadataSkeleton /></TableCell><TableCell><Skeleton className="h-4 w-24" /></TableCell><TableCell><Skeleton shape="pill" className="h-5 w-24" /></TableCell><TableCell><Skeleton className="h-5 w-16" /></TableCell><TableCell><Skeleton className="h-5 w-40" /></TableCell></TableRow>) : !data?.events.length ? <TableRow variant="static"><TableCell colSpan={6}>No recorded attempts in this period.</TableCell></TableRow> : data.events.slice(0, 4).map(event => <TableRow key={event.id}>
          <TableCell><div className="max-w-48 truncate font-semibold" title={event.modelName || event.gatewayModelId}>{event.modelName || event.gatewayModelId}</div><div className="max-w-48 truncate text-xs text-muted-foreground" title={event.id}>{event.id.slice(0, 8)}</div></TableCell>
          <TableCell><RequestLogMetadata event={event} /></TableCell>
          <TableCell><div className="max-w-40 truncate" title={event.keyName || event.gatewayKeyId}>{event.keyName || `Unknown key (${event.gatewayKeyId.slice(0, 8)})`}</div></TableCell>
          <TableCell><Badge variant={event.status >= 200 && event.status < 300 ? "secondary" : "destructive"}>{event.status >= 200 && event.status < 300 ? "Success" : "Failed"} · {event.status}</Badge></TableCell>
          <TableCell>{formatDuration(event.durationMs)}</TableCell><TableCell>{formatAppDateTime(event.completedAt)}</TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
    </CardContent>
  </Card>
}
