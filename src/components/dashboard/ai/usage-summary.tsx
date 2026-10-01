import { ActivityIcon, BarChart3Icon, KeyRoundIcon, WalletCardsIcon } from "lucide-react"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DashboardPayload } from "@/lib/types"
import { formatCost, formatNumber, formatTokenCount } from "./usage-utils"

export function UsageSummary({ dashboard, refreshing = false }: { dashboard?: DashboardPayload; refreshing?: boolean }) {
  const summary = dashboard?.summary
  const metrics = [
    { title: "Requests", value: summary && formatNumber(summary.requests), detail: "Total request volume in the selected range.", icon: BarChart3Icon },
    { title: "Tokens", value: summary && formatTokenCount(summary.tokens), detail: "Input, output, and cache tokens combined.", icon: ActivityIcon },
    { title: "API-equivalent cost", value: summary && formatCost(summary.costMicros), detail: summary?.unpricedRequests ? `${summary.unpricedRequests} request(s) are estimated or lack complete pricing data.` : "Calculated from configured model pricing.", icon: WalletCardsIcon },
    { title: "Active keys", value: summary && formatNumber(summary.activeKeys), detail: "Keys that handled traffic in this window.", icon: KeyRoundIcon },
  ]
  return <section className="space-y-4" aria-busy={!dashboard || refreshing} data-slot="usage-summary">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold tracking-tight">Usage summary</h2><p className="text-sm text-muted-foreground">High-level totals for the currently selected range.</p></div></div>
    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">{metrics.map(({ title, value, detail, icon: Icon }) => <Card key={title} variant="summary">
      <CardHeader><CardDescription>{title}</CardDescription><div className="flex items-start justify-between gap-4"><CardTitle variant="metric">{value ?? <Skeleton className="h-lh w-28" />}</CardTitle><div className="rounded-md border border-border/70 bg-muted/40 p-2 text-muted-foreground"><Icon className="size-5" /></div></div></CardHeader>
      <CardFooter variant="detail" className="min-h-16">{detail}</CardFooter>
    </Card>)}</div>
  </section>
}
