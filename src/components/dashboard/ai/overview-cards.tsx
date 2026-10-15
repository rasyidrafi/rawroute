import { Link } from "react-router"
import { ArrowUpRightIcon } from "lucide-react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { pagePaths } from "@/lib/dashboard/routes"
import type { OverviewDetails } from "@/lib/overview"
import type { RequestLogsPage } from "@/lib/request-logs"
import { formatCost } from "@/lib/usage-display"
import { formatAppDateTime, getAppTimeZone } from "@/lib/timezone"

export function BudgetUsageCard({ data, error }: { data?: OverviewDetails; error?: boolean }) {
  return <Card>
    <CardHeader><CardTitle>Budget Usage</CardTitle><CardDescription>Current budget window, independent of traffic range</CardDescription><CardAction><Button variant="link" size="sm" nativeButton={false} render={<Link to={pagePaths.budgets} />}>Budgets</Button></CardAction></CardHeader>
    <CardContent spacing="compact-stack">
      {error ? <p>Budget usage unavailable.</p> : !data ? <Skeleton className="h-20 w-full" /> : <>
        {data.budgetWindow && <p className="text-xs text-muted-foreground">{formatAppDateTime(data.budgetWindow.from)} – {formatAppDateTime(data.budgetWindow.to)}{data.budgetWindow.bypassLimits ? " · Unlimited mode" : ""}</p>}
        {!data.budgets.length ? <p className="text-sm text-muted-foreground">No configured budgets.</p> : <div className="flex max-h-56 flex-col gap-3 overflow-y-auto">{data.budgets.map(budget => {
          const limited = budget.enabled && !data.budgetWindow?.bypassLimits && budget.limitMicros > 0
          const percent = limited ? budget.spentMicros / budget.limitMicros * 100 : 0
          return <div key={budget.id} className="flex flex-col gap-2"><div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-medium">{budget.name}</span><span>{formatCost(budget.spentMicros)}{limited ? ` / ${formatCost(budget.limitMicros)}` : !budget.enabled ? " · Disabled" : " · Unlimited"}</span></div>{limited && <Progress value={Math.min(100, percent)} aria-label={`${budget.name}: ${percent.toFixed(1)} percent used`} />}</div>
        })}</div>}
      </>}
    </CardContent>
  </Card>
}

export function QuickAccessCard() {
  return <Card className="flex-1"><CardHeader><CardTitle>Quick access</CardTitle><CardDescription>Configure how your workspace runs.</CardDescription></CardHeader><CardContent spacing="compact-stack">{[{ label: "Endpoint & API key", to: pagePaths.endpoint }, { label: "Model routing", to: pagePaths.aliases }, { label: "Budgets", to: pagePaths.budgets }].map(item => <Link key={item.to} to={item.to} className="flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><div><p className="text-sm font-medium">{item.label}</p></div><ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" /></Link>)}</CardContent></Card>
}

export function RecentRequestsCard({ data, loading, error, retry }: { data?: RequestLogsPage; loading?: boolean; error?: boolean; retry?: () => void }) {
  return <Card>
    <CardHeader><CardTitle>Recent Requests</CardTitle><CardDescription>Latest saved model attempts, not all incoming requests</CardDescription><CardAction><Button variant="link" size="sm" nativeButton={false} render={<Link to={pagePaths.requestLogs} />}>View all</Button></CardAction></CardHeader>
    <CardContent>
      {error ? <Alert variant="destructive"><AlertDescription>Unable to load recent requests. <Button variant="link" size="sm" onClick={retry}>Retry recent requests</Button></AlertDescription></Alert> : <div role={loading ? "status" : undefined} aria-label={loading ? "Loading recent requests" : undefined} aria-busy={loading || undefined}><Table><TableHeader><TableRow><TableHead className="min-w-40">Request / model</TableHead><TableHead className="min-w-28">Status</TableHead><TableHead className="min-w-24">Duration</TableHead><TableHead className="min-w-48">Time ({getAppTimeZone()})</TableHead></TableRow></TableHeader><TableBody>
        {loading ? [0, 1, 2, 3].map(index => <TableRow key={index} variant="static" data-slot="overview-request-skeleton-row"><TableCell><div className="flex flex-col gap-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-36" /></div></TableCell><TableCell><Skeleton shape="pill" className="h-5 w-24" /></TableCell><TableCell><Skeleton className="h-5 w-16" /></TableCell><TableCell><Skeleton className="h-5 w-40" /></TableCell></TableRow>) : !data?.events.length ? <TableRow variant="static"><TableCell colSpan={4}>No recorded attempts in this period.</TableCell></TableRow> : data.events.slice(0, 4).map(event => <TableRow key={event.id}>
          <TableCell><div className="max-w-48 truncate font-semibold" title={event.modelName || event.gatewayModelId}>{event.modelName || event.gatewayModelId}</div><div className="max-w-48 truncate text-xs text-muted-foreground" title={`${event.id} · ${event.keyName || event.gatewayKeyId}`}>{event.id.slice(0, 8)} · {event.keyName || `Unknown key (${event.gatewayKeyId.slice(0, 8)})`}</div></TableCell>
          <TableCell><Badge variant={event.status >= 200 && event.status < 300 ? "secondary" : "destructive"}>{event.status >= 200 && event.status < 300 ? "Success" : "Failed"} · {event.status}</Badge></TableCell>
          <TableCell>{Number.isFinite(event.durationMs) && event.durationMs >= 0 ? `${event.durationMs.toLocaleString()} ms` : "Unavailable"}</TableCell><TableCell>{formatAppDateTime(event.completedAt)}</TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
    </CardContent>
  </Card>
}
