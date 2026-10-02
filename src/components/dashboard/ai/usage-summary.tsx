import { ActivityIcon, CoinsIcon, KeyRoundIcon, LayersIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DashboardPayload } from "@/lib/types"
import { formatCost, formatNumber, formatTokenCount } from "./usage-utils"

export function UsageSummary({ dashboard, refreshing = false }: { dashboard?: DashboardPayload; refreshing?: boolean }) {
  const summary = dashboard?.summary
  const metrics = [
    { title: "Tokens processed", value: summary && formatTokenCount(summary.tokens), detail: "Input + cached input + output tokens", icon: LayersIcon },
    { title: "Requests", value: summary && formatNumber(summary.requests), detail: "Total request volume in the selected range.", icon: ActivityIcon },
    { title: "Estimated spend", value: summary && formatCost(summary.costMicros), detail: "Based on configured model rates", icon: CoinsIcon },
    { title: "Active keys", value: summary && formatNumber(summary.activeKeys), detail: "Keys that handled traffic in this window.", icon: KeyRoundIcon },
  ]
  return <section className="space-y-4" aria-busy={!dashboard || refreshing} data-slot="usage-summary">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold tracking-tight">Usage summary</h2><p className="text-sm text-muted-foreground">High-level totals for the currently selected range.</p></div></div>
    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">{metrics.map(({ title, value, detail, icon: Icon }) => <Card key={title}>
      <CardHeader><div className="flex items-center justify-between gap-2"><CardDescription>{title}</CardDescription><Icon className="size-4 text-muted-foreground" /></div><CardTitle variant="metric">{value ?? <Skeleton className="h-lh w-28" />}</CardTitle></CardHeader>
      <CardContent><p className="text-xs text-muted-foreground">{detail}</p></CardContent>
    </Card>)}</div>
  </section>
}
