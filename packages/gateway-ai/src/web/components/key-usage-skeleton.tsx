import { DashboardPage } from "@rawroute/ui/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Skeleton } from "@rawroute/ui/skeleton"
import { RequestLogsTable } from "./request-logs-table"

export function KeyUsageSkeleton({ rangeControls = true }: { rangeControls?: boolean }) {
  return <DashboardPage spacing="normal" aria-busy="true" aria-label="Loading key usage" data-slot="dashboard-content-skeleton">
    <Skeleton className="h-8 w-32" /><div className="flex items-center gap-3"><Skeleton className="size-11 shrink-0" /><div className="flex flex-col gap-2"><Skeleton className="h-7 w-40" /><Skeleton className="h-4 w-56" /></div></div>
    {rangeControls ? <>
      <div className="border-y border-border/70 py-3"><div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between"><div className="flex items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Range</span><Skeleton className="h-8 w-[220px]" /></div><div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-end"><div className="flex items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Date</span><Skeleton className="h-9 w-[232px]" /></div><div className="flex items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Group</span><Skeleton className="h-8 w-[190px]" /></div></div></div></div>
      <div className="flex flex-wrap gap-x-8 gap-y-2"><div className="flex flex-col gap-2"><Skeleton className="h-6 w-16" /><Skeleton className="h-3 w-14" /></div><div className="flex flex-col gap-2"><Skeleton className="h-6 w-20" /><Skeleton className="h-3 w-14" /></div><div className="flex flex-col gap-2"><Skeleton className="h-6 w-14" /><Skeleton className="h-3 w-14" /></div></div>
    </> : <div className="flex flex-col gap-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /></div>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <Card><CardHeader><CardTitle>Budget balance</CardTitle><CardDescription><Skeleton className="h-4 w-44" /></CardDescription></CardHeader><CardContent spacing="stack"><Skeleton className="h-4 w-36" /><Skeleton className="h-10 w-32" /><Skeleton className="h-2 w-full" /><Skeleton className="h-px w-full" /><div className="grid grid-cols-2 gap-4"><div className="flex flex-col gap-2"><span className="text-xs text-muted-foreground">Average daily spend so far</span><Skeleton className="h-5 w-24" /></div><div className="flex flex-col gap-2"><span className="text-xs text-muted-foreground">Average daily tokens so far</span><Skeleton className="h-5 w-24" /></div></div><div className="flex flex-col gap-2"><span className="text-xs text-muted-foreground">Budget reset</span><Skeleton className="h-5 w-32" /></div></CardContent></Card>
      <Card><CardHeader><CardTitle>Usage Trend</CardTitle><CardDescription><Skeleton className="h-4 w-44" /></CardDescription></CardHeader><CardContent className="flex min-h-0 flex-1 flex-col"><div className="relative min-h-72 min-w-0 flex-1 sm:min-h-80"><Skeleton className="absolute inset-0" /></div></CardContent></Card>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">{["Spending by model", "Usage profile"].map(title => <Card key={title}><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><Skeleton className="h-56 w-full" /></CardContent></Card>)}</div>
    <Card><CardHeader><CardTitle>Recent requests</CardTitle></CardHeader><CardContent><RequestLogsTable loading /></CardContent></Card>
  </DashboardPage>
}