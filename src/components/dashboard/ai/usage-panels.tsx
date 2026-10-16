import { useMemo, useState } from "react"
import { ActivityIcon, ChevronRightIcon, DatabaseIcon } from "lucide-react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { keyUsagePagePath } from "@/lib/dashboard/routes"
import type { BarShapeProps, TooltipContentProps, TooltipValueType } from "recharts"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { DashboardKeyBudget, DashboardPayload } from "@/lib/types"
import { UsageTrendChart } from "./usage-trend-chart"
import { KEY_COLORS, formatDateTime, getOptionLabel } from "@/components/dashboard/ai/usage-utils"
import { formatCost, formatRequestCount, formatTokenCount } from "@/lib/usage-display"

// This module is reached through the lazy Usage/Public routes. Keep the chart engine in its own async chunk.
const { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } = await import("recharts")

type KeyRow = DashboardPayload["keys"][number]

type TopKeyChartRow = {
  id: string
  name: string
  cost: number
  requests: number
  fill: string
  placeholder: boolean
}

function RefreshScrim({ label = "Refreshing data..." }: { label?: string }) { return <div className="pointer-events-none absolute inset-0 z-20 flex items-start justify-end rounded-inherit bg-background/40 p-3 backdrop-blur-scrim"><Badge variant="refreshing"><ActivityIcon className="size-3.5 animate-spin" />{label}</Badge></div> }

function BudgetUsage({ budget }: { budget?: DashboardKeyBudget }) {
  if (!budget) return <span className="text-muted-foreground">—</span>
  if (budget.usageAvailable === false || budget.spentMicros === null || budget.percentUsed === null || budget.remainingMicros === null) return <span>Budget usage unavailable</span>
  return <div className="min-w-[220px] space-y-2"><div className="flex items-center justify-between gap-3"><span className="text-xs font-medium text-muted-foreground">{budget.bypassLimits ? `${formatCost(budget.spentMicros)} since ${formatDateTime(budget.usageStartAt)}` : `${formatCost(budget.spentMicros)} / ${formatCost(budget.weeklyLimitMicros)}`}</span>{budget.bypassLimits ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-caption font-semibold tabular-nums"><span className="font-mono">∞</span><span>Unlimited</span></span> : <span className="text-xs text-muted-foreground tabular-nums">{Math.round(budget.percentUsed)}%</span>}</div><Progress value={budget.bypassLimits ? 100 : Math.min(budget.percentUsed, 100)} variant={budget.bypassLimits ? "unlimited" : "default"}><ProgressLabel className="sr-only">Budget usage</ProgressLabel></Progress><div className="text-xs text-muted-foreground">{budget.bypassLimits ? "Unlimited Usage" : `${formatCost(budget.remainingMicros)} remaining`}</div></div>
}

function ModelList({ models }: { models: string[] }) {
  if (!models.length) return <span>—</span>
  const visibleModels = models.slice(0, 2)
  const hiddenCount = models.length - visibleModels.length
  return <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-muted-foreground"><span>{visibleModels.join(", ")}</span>{hiddenCount > 0 && <><span aria-hidden="true">,</span><Tooltip><TooltipTrigger render={<button type="button" aria-label={`Show all ${models.length} models`} className="rounded-sm px-1 font-medium text-foreground underline decoration-dotted underline-offset-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">+{hiddenCount}</button>} /><TooltipContent side="top" align="start" className="max-w-[calc(100vw-2rem)] text-left whitespace-normal break-words sm:max-w-[36rem]">{models.join(", ")}</TooltipContent></Tooltip></>}</div>
}

export function DashboardTrend({ dashboard, refreshing }: { dashboard: DashboardPayload; refreshing: boolean }) {
  return <Card variant="dashboard" className="relative h-140 overflow-hidden">
    {refreshing && <RefreshScrim />}
    <CardHeader><CardTitle>Usage Trend</CardTitle><CardDescription>Token usage over time</CardDescription></CardHeader>
    <CardContent className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 min-w-0 flex-1" role="img" aria-label="Token usage trend">
        <UsageTrendChart data={dashboard.trend} granularity={dashboard.range.granularity} />
      </div>
    </CardContent>
  </Card>
}

export function TopKeys({ keys, refreshing }: { keys: KeyRow[]; refreshing: boolean }) {
  const rows: TopKeyChartRow[] = keys.slice().sort((a, b) => b.costMicros - a.costMicros).slice(0, 5).map((row, index) => ({ id: `key:${row.id}`, name: row.label, cost: row.costMicros / 1_000_000, requests: row.requests, fill: KEY_COLORS[index % KEY_COLORS.length], placeholder: false }))
  // Zero-valued placeholder rows reserve the remaining categories without exposing fake activity.
  const chartRows: TopKeyChartRow[] = [...rows, ...Array.from({ length: 5 - rows.length }, (_, index) => ({ id: `placeholder:${index}`, name: "TBD", cost: 0, requests: 0, fill: "transparent", placeholder: true }))]
  const config = { cost: { label: "Cost" } } satisfies ChartConfig
  return <Card variant="dashboard" className="relative h-140 overflow-hidden">
    {refreshing && <RefreshScrim />}
    <CardHeader><CardTitle>Top keys by cost</CardTitle><CardDescription>Concentration</CardDescription></CardHeader>
    <CardContent spacing="flow" className="flex min-h-0 flex-1 flex-col">
      <ChartContainer config={config} className="h-[220px] aspect-auto w-full shrink-0">
        <BarChart data={chartRows} layout="vertical" margin={{ top: 5, bottom: 5, left: 4, right: 4 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" hide />
          <YAxis dataKey="id" type="category" allowDuplicatedCategory={false} tickFormatter={(id: string) => rows.find(row => row.id === id)?.name ?? ""} width={90} tickLine={false} axisLine={false} />
          <ChartTooltip cursor={false} content={({ active, payload, label }: TooltipContentProps<TooltipValueType, string | number>) => rows.some(row => row.id === label) ? <ChartTooltipContent active={active} payload={payload} label={label} labelFormatter={(id) => rows.find(row => row.id === id)?.name} formatter={(value) => <div className="flex w-full items-center justify-between gap-4"><span>Cost</span><span className="font-mono">{formatCost(Number(value ?? 0) * 1_000_000)}</span></div>} /> : null} />
          <Bar dataKey="cost" radius={10} maxBarSize={28} activeBar={false} shape={(props: BarShapeProps) => chartRows[props.index]?.placeholder ? <></> : <Rectangle x={props.x} y={props.y} width={props.width} height={props.height} radius={10} fill={chartRows[props.index]?.fill} />} />
        </BarChart>
      </ChartContainer>
      <ScrollArea variant="panel" className="min-h-0 flex-1"><div className="space-y-2 pr-3">{rows.map((row) => <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 p-3"><div className="min-w-0"><div className="truncate text-sm font-medium">{row.name}</div><div className="text-xs text-muted-foreground">{formatRequestCount(row.requests)} requests</div></div><div className="text-sm font-medium">{formatCost(row.cost * 1_000_000)}</div></div>)}</div></ScrollArea>
    </CardContent>
  </Card>
}


export function UsageTable({ keys, refreshing, publicView = false }: { keys: KeyRow[]; refreshing: boolean; publicView?: boolean }) { const [sortBy, setSortBy] = useState<"usage" | "recent" | "name">("usage"); const sortedKeys = useMemo(() => [...keys].sort((a, b) => sortBy === "recent" ? Date.parse(b.lastUsed || "") - Date.parse(a.lastUsed || "") : sortBy === "name" ? a.label.localeCompare(b.label) : b.costMicros - a.costMicros), [keys, sortBy]); const sortOptions = [{ value: "usage", label: "Highest usage first" }, { value: "recent", label: "Last recent usage" }, { value: "name", label: "API key name" }] as const; return <Card variant="dashboard" className="relative h-160 overflow-hidden">{refreshing && <RefreshScrim />}<CardHeader><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><CardTitle>Usage table</CardTitle><CardDescription>Per-key detail</CardDescription></div><div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Order rows by</span><Select value={sortBy} onValueChange={(value) => value && setSortBy(value as typeof sortBy)}><SelectTrigger className="h-8 min-w-0 flex-1 sm:w-44 sm:flex-none"><span className="truncate">{getOptionLabel(sortOptions, sortBy)}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Ordering</SelectLabel>{sortOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div></div></CardHeader><CardContent className="min-h-0 flex-1"><ScrollArea className="h-full"><Table className="min-w-[1000px]"><TableHeader><TableRow variant="static"><TableHead variant="sticky" className="text-center">No</TableHead><TableHead variant="sticky">Name</TableHead><TableHead variant="sticky" className="text-right">Requests</TableHead><TableHead variant="sticky" className="text-right">Tokens</TableHead><TableHead variant="sticky" className="text-right">Cost</TableHead><TableHead variant="sticky"
                  className="w-[280px] min-w-[280px] max-w-[280px]">Models</TableHead><TableHead variant="sticky">Budget usage</TableHead><TableHead variant="sticky">Last used</TableHead>{!publicView && <TableHead variant="sticky">Actions</TableHead>}</TableRow></TableHeader><TableBody>{sortedKeys.map((row, index) => <TableRow key={row.id}><TableCell text="mono" tone="muted" className="text-center">{index + 1}</TableCell><TableCell className="whitespace-normal">{(() => { const isSharedWorkspace = row.id.startsWith("shared-workspace:"); return <><span className="font-medium">{row.label}</span>{!publicView && !isSharedWorkspace && row.maskedKey !== "hidden" && <div className="mt-1 font-mono text-xs text-muted-foreground">{row.maskedKey}</div>}</> })()}</TableCell><TableCell className="text-right">{formatRequestCount(row.requests)}</TableCell><TableCell className="text-right">{formatTokenCount(row.tokens)}</TableCell><TableCell className="text-right">{formatCost(row.costMicros)}</TableCell><TableCell tone="muted" className="w-[280px] min-w-[280px] max-w-[280px] whitespace-normal"><ModelList models={row.models} /></TableCell><TableCell><BudgetUsage budget={row.budget} /></TableCell><TableCell tone="muted">{formatDateTime(row.lastUsed)}</TableCell>{!publicView && <TableCell><Button variant="ghost" size="icon-sm" nativeButton={false} role="link" aria-label={`View usage for ${row.label}`} render={<Link to={keyUsagePagePath(row.id)} state={{ keyLabel: row.label }} />}><ChevronRightIcon /></Button></TableCell>}</TableRow>)}{!sortedKeys.length && <TableRow><TableCell colSpan={publicView ? 8 : 9} tone="muted"
                    density="flush" className="whitespace-normal"><EmptyState title="No usage recorded" description="No per-key usage was recorded for this range." icon={DatabaseIcon} variant="compact" treatment="table" /></TableCell></TableRow>}</TableBody></Table><ScrollBar orientation="horizontal" /></ScrollArea></CardContent></Card> }
