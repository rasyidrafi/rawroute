import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { LoadingTable } from "@/components/loading-layout"
import { DashboardPage } from "../page-layout"
import { UsageOverview } from "./usage-overview"
import { UsageSummary } from "./usage-summary"
import { DEFAULT_DASHBOARD_QUERY } from "@/lib/dashboard-defaults"
import { MostUsedModels } from "./most-used-models"

const noop = () => undefined

export function UsageSkeleton() {
  return <DashboardPage spacing="compact" aria-busy="true" aria-label="Loading usage dashboard" data-slot="dashboard-content-skeleton">
    <UsageOverview dashboard={null} loading preset={DEFAULT_DASHBOARD_QUERY.preset} setPreset={noop} granularity="auto" setGranularity={noop} selectedRange={undefined} onRangeChange={noop} onRefresh={noop} />
    <UsageSummary />
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]"><ChartSkeleton description="Token usage over time" title="Usage Trend" /><ChartSkeleton description="Concentration" title="Top keys by cost" list /></div>
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]"><Card variant="dashboard" className="relative h-160 overflow-hidden"><CardHeader><div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div><CardTitle>Usage table</CardTitle><CardDescription>Per-key detail</CardDescription></div><div className="flex w-full flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Order rows by</span><Skeleton className="h-8 w-44" /></div></div></CardHeader><CardContent className="min-h-0 flex-1"><ScrollArea className="h-full"><div className="min-w-[1000px]"><LoadingTable columns={["No", "Name", "Requests", "Tokens", "Cost", "Models", "Budget usage", "Last used"]} rows={5} /></div></ScrollArea></CardContent></Card><MostUsedModels className="xl:self-stretch" /></div>
  </DashboardPage>
}

function ChartSkeleton({ description, title, list = false }: { description: string; title: string; list?: boolean }) {
  return <Card variant="dashboard" className="relative h-140 overflow-hidden"><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent spacing={list ? "flow" : "default"} className="flex min-h-0 flex-1 flex-col"><Skeleton className={list ? "h-[220px] w-full shrink-0" : "h-full w-full"} />{list && <ScrollArea variant="panel" className="min-h-0 flex-1"><div className="flex flex-col gap-2 pr-3">{[0, 1, 2, 3, 4].map(key => <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 p-3"><div className="flex min-w-0 flex-col gap-2"><Skeleton className="h-4 w-32 max-w-full" /><Skeleton className="h-3 w-24 max-w-full" /></div><Skeleton className="h-5 w-16" /></div>)}</div></ScrollArea>}</CardContent></Card>
}
