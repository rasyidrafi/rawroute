import { DashboardPage } from "@/components/dashboard/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { RequestLogsTable } from "./request-logs-table"

export function KeyUsageSkeleton() {
  return <DashboardPage spacing="normal" aria-busy="true" aria-label="Loading key usage" data-slot="dashboard-content-skeleton">
    <Skeleton className="h-8 w-32" /><div className="flex items-center gap-3"><Skeleton className="size-11 shrink-0" /><div className="flex flex-col gap-2"><Skeleton className="h-7 w-40" /><Skeleton className="h-4 w-56" /></div></div>
    <div className="flex flex-col gap-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /></div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">{["Budget balance", "Daily spend"].map(title => <Card key={title}><CardHeader><CardTitle>{title}</CardTitle><CardDescription><Skeleton className="h-4 w-44" /></CardDescription></CardHeader><CardContent><Skeleton className="h-64 w-full" /></CardContent></Card>)}</div>
    <div className="grid gap-4 lg:grid-cols-2">{["Where the spend goes", "Usage profile"].map(title => <Card key={title}><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><Skeleton className="h-56 w-full" /></CardContent></Card>)}</div>
    <Card><CardHeader><CardTitle>Recent requests</CardTitle></CardHeader><CardContent><RequestLogsTable loading /></CardContent></Card>
  </DashboardPage>
}
