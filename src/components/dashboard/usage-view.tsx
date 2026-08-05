"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { ActivityIcon, BarChart3Icon, CalendarDaysIcon, CoinsIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import type { DateRange } from "react-day-picker"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { EmptyRow } from "@/components/dashboard/shared"
import type { DashboardPayload } from "@/lib/types"

const presets = [{ value: "today", label: "Today" }, { value: "yesterday", label: "Yesterday" }, { value: "week", label: "This week" }, { value: "month", label: "This month" }, { value: "year", label: "This year" }, { value: "all", label: "All time" }, { value: "custom", label: "Custom range" }] as const
const chartConfig = { requests: { label: "Requests", color: "var(--chart-1)" }, cost: { label: "Cost", color: "var(--chart-2)" } } satisfies ChartConfig
const formatNumber = (value: number) => new Intl.NumberFormat().format(value)
const formatCost = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Never"

export function UsageView({ initial, publicView = false }: { initial?: DashboardPayload; publicView?: boolean }) {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(initial || null)
  const [preset, setPreset] = useState<(typeof presets)[number]["value"]>("today")
  const [range, setRange] = useState<DateRange>()
  const [pending, startTransition] = useTransition()
  const endpoint = publicView ? "/api/public/dashboard" : "/api/admin/usage"

  const query = useCallback((nextPreset = preset, nextRange = range) => {
    const params = new URLSearchParams({ preset: nextPreset })
    if (nextPreset === "custom" && nextRange?.from) {
      params.set("from", nextRange.from.toISOString().slice(0, 10))
      params.set("to", (nextRange.to || nextRange.from).toISOString().slice(0, 10))
    }
    startTransition(async () => {
      const response = await fetch(`${endpoint}?${params}`, { cache: "no-store" })
      if (response.ok) setDashboard(await response.json() as DashboardPayload)
    })
  }, [endpoint, preset, range])
  useEffect(() => { if (!initial) query("today") }, [initial, query])
  useEffect(() => { if (preset !== "today") query() }, [preset, query])

  if (!dashboard) return <DashboardContentSkeleton variant="usage" />

  const summary = dashboard.summary
  return <main className="min-h-[calc(100svh-var(--header-height))] bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex max-w-7xl flex-col gap-6">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">Usage dashboard</h1>{pending && <Badge variant="outline">Refreshing</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">Requests, tokens, cost, and key activity for the selected range.</p></div><div className="flex flex-wrap items-center gap-2"><Select value={preset} onValueChange={(value) => { if (value) { setPreset(value as typeof preset); if (value === "today") query("today") } }}><SelectTrigger className="w-36"><SelectValue placeholder="Range" /></SelectTrigger><SelectContent>{presets.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select><Popover><PopoverTrigger render={<Button variant="outline"><CalendarDaysIcon />{range?.from ? `${range.from.toLocaleDateString()} - ${(range.to || range.from).toLocaleDateString()}` : "Dates"}</Button>} /><PopoverContent className="w-auto p-0"><Calendar mode="range" selected={range} onSelect={(next) => { setRange(next); setPreset("custom"); if (next?.from) query("custom", next) }} /></PopoverContent></Popover><Button variant="outline" onClick={() => query()} disabled={pending}><RefreshCwIcon className={pending ? "animate-spin" : ""} />Refresh</Button></div></div>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"><Summary title="Requests" value={formatNumber(summary.requests)} detail="Successful and failed gateway events." icon={<BarChart3Icon />} /><Summary title="Tokens" value={formatNumber(summary.tokens)} detail="Normalized input and output usage." icon={<ActivityIcon />} /><Summary title="Estimated cost" value={formatCost(summary.costMicros)} detail={`${summary.unpricedRequests} unpriced request(s).`} icon={<CoinsIcon />} /><Summary title="Active keys" value={formatNumber(summary.activeKeys)} detail="Keys with recorded activity." icon={<KeyRoundIcon />} /></div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]"><Card><CardHeader><CardTitle>Request and cost trend</CardTitle><CardDescription>{dashboard.range.label} · {dashboard.range.granularity}</CardDescription></CardHeader><CardContent><ChartContainer config={chartConfig} className="h-[280px] w-full"><AreaChart data={dashboard.trend}><CartesianGrid vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Area type="monotone" dataKey="requests" stroke="var(--color-requests)" fill="var(--color-requests)" fillOpacity={0.16} /><Area type="monotone" dataKey="costMicros" stroke="var(--color-cost)" fill="var(--color-cost)" fillOpacity={0.08} /></AreaChart></ChartContainer></CardContent><CardFooter className="text-xs text-muted-foreground">Last event: {formatDate(dashboard.freshness.lastEventAt)}</CardFooter></Card><Card><CardHeader><CardTitle>Top keys</CardTitle><CardDescription>Requests by key name.</CardDescription></CardHeader><CardContent><ChartContainer config={chartConfig} className="h-[280px] w-full"><BarChart data={dashboard.keys.slice(0, 8)} layout="vertical" margin={{ left: 12, right: 12 }}><CartesianGrid horizontal={false} /><XAxis type="number" hide /><YAxis dataKey="label" type="category" width={82} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="requests" fill="var(--color-requests)" radius={6} /></BarChart></ChartContainer></CardContent></Card></div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]"><Card><CardHeader><CardTitle>Per-key usage</CardTitle><CardDescription>Usage by key name.</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Identifier</TableHead><TableHead>Requests</TableHead><TableHead>Tokens</TableHead><TableHead>Cost</TableHead><TableHead>Last used</TableHead></TableRow></TableHeader><TableBody>{dashboard.keys.length ? dashboard.keys.map((key) => <TableRow key={key.id}><TableCell><div className="font-medium">{key.label}</div><div className="text-xs text-muted-foreground">{key.models.join(", ") || "No model"}</div></TableCell><TableCell className="font-mono text-xs">{key.maskedKey}</TableCell><TableCell>{formatNumber(key.requests)}</TableCell><TableCell>{formatNumber(key.tokens)}</TableCell><TableCell>{formatCost(key.costMicros)}</TableCell><TableCell className="text-xs text-muted-foreground">{formatDate(key.lastUsed)}</TableCell></TableRow>) : <EmptyRow label="No usage recorded for this range." colSpan={6} />}</TableBody></Table></CardContent></Card><Card><CardHeader><CardTitle>Model usage</CardTitle><CardDescription>Canonical gateway model totals.</CardDescription></CardHeader><CardContent className="space-y-3">{dashboard.models.length ? dashboard.models.map((model) => <div key={model.model} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3"><div className="min-w-0"><div className="truncate text-sm font-medium">{model.model}</div><div className="text-xs text-muted-foreground">{formatNumber(model.tokens)} tokens</div></div><div className="text-right text-sm"><div>{formatNumber(model.requests)} req</div><div className="text-xs text-muted-foreground">{formatCost(model.costMicros)}</div></div></div>) : <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed text-center text-sm text-muted-foreground">No model usage recorded for this range.</div>}</CardContent></Card></div>
    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><Badge variant="outline">Pricing: {summary.pricedRequests} exact</Badge><Badge variant="outline">{summary.unpricedRequests} unpriced</Badge><span className="self-center">Generated {formatDate(dashboard.generatedAt)}</span></div>
  </div></main>
}

function Summary({ title, value, detail, icon }: { title: string; value: string; detail: string; icon: React.ReactNode }) { return <Card><CardHeader><CardDescription>{title}</CardDescription><div className="flex items-center justify-between gap-4"><CardTitle className="text-3xl tracking-tight">{value}</CardTitle><div className="rounded-md border bg-muted/40 p-2 text-muted-foreground">{icon}</div></div></CardHeader><CardFooter className="border-t text-xs text-muted-foreground">{detail}</CardFooter></Card> }
