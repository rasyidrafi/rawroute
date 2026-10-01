import { Card, CardHeader, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingCard } from "@/components/loading-layout"
import { CliProxyHeader, ServiceDetailsSkeleton, ServiceHeaderFrame } from "./source-layout"
import { DashboardPage } from "@/components/dashboard/page-layout"

export function CliProxySkeleton() {
  return <DashboardPage spacing="normal" aria-busy="true" aria-label="Loading CLIProxyAPI" data-slot="dashboard-content-skeleton">
    <CliProxyHeader refreshing />
    <Card><CardHeader><ServiceHeaderFrame title={<>Managed process<Skeleton className="h-5 w-16" /></>} /></CardHeader><CardContent spacing="stack"><ServiceDetailsSkeleton /><div className="min-w-0 rounded-lg border bg-muted/30 p-3"><div className="flex flex-col gap-3"><div className="flex justify-between gap-2"><div><p className="text-sm font-medium">Release management</p><Skeleton className="h-4 w-48" /></div><Button size="sm" variant="outline" disabled>Refresh releases</Button></div><div className="grid gap-2 lg:grid-cols-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div></div></div></CardContent></Card>
    <LoadingCard title="Connection details" description="Use the dashboard's same-origin API URL with a workspace gateway key; requests are forwarded by RawRoute."><div className="grid min-w-0 gap-3 lg:grid-cols-3">{[1, 2, 3].map(item => <div key={item} className="min-w-0 rounded-lg border bg-background/70 px-3 py-2.5"><Skeleton className="h-3 w-24" /><Skeleton className="mt-2 h-4 w-full" /></div>)}</div></LoadingCard>
  </DashboardPage>
}
