"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { ActivityIcon, BarChart3Icon, DatabaseIcon, KeyRoundIcon, WalletCardsIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { EmptyState, ModelMix, SummaryCard, TopKeys, UsageTable, DashboardTrend } from "@/components/dashboard/usage-panels"
import { UsageOverview } from "@/components/dashboard/usage-overview"
import { DEFAULT_GRANULARITY, formatCalendarSelection, formatCost, formatNumber, formatTokenCount, resolveSelectedRange } from "@/components/dashboard/usage-utils"
import type { DashboardPayload, DashboardQuery } from "@/lib/types"
import { DEFAULT_DASHBOARD_QUERY } from "@/lib/dashboard-query"
import { calendarDateFromInstant } from "@/lib/timezone"
import { apiFetch } from "@/components/dashboard/api"

export function UsageView({ initial, publicView = false, workspaceId }: { initial?: DashboardPayload; publicView?: boolean; workspaceId?: string }) {
  const endpoint = publicView ? "/api/public/dashboard" : "/api/admin/usage"
  const defaultPreset: DashboardQuery["preset"] = DEFAULT_DASHBOARD_QUERY.preset
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(initial || null)
  const [preset, setPresetState] = useState<DashboardQuery["preset"]>(defaultPreset)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [granularity, setGranularityState] = useState<NonNullable<DashboardQuery["granularity"]>>(DEFAULT_GRANULARITY)
  const [pending, startTransition] = useTransition()
  const initialized = useRef(Boolean(initial))
  const activeRequest = useRef<AbortController | null>(null)
  const selectedRange = useMemo<DateRange | undefined>(() => {
    if (preset === "budget" && dashboard) return { from: calendarDateFromInstant(dashboard.range.from), to: calendarDateFromInstant(dashboard.range.to) }
    return resolveSelectedRange(from, to)
  }, [dashboard, from, preset, to])
  const activeGranularity = granularity

  const query = useCallback((nextPreset = preset, nextFrom = from, nextTo = to, nextGranularity = activeGranularity) => {
    const params = new URLSearchParams({ preset: nextPreset })
    if (publicView && workspaceId && workspaceId !== "default") params.set("workspace", workspaceId)
    if (nextPreset === "custom") {
      if (nextFrom) params.set("from", nextFrom)
      if (nextTo) params.set("to", nextTo)
    }
    if (nextGranularity !== "auto") params.set("granularity", nextGranularity)
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    startTransition(async () => {
      try {
        const payload = await apiFetch<DashboardPayload>(`${endpoint}?${params.toString()}`, { signal: controller.signal })
        if (activeRequest.current === controller) setDashboard(payload)
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null
      }
    })
  }, [activeGranularity, endpoint, from, preset, publicView, to, workspaceId])

  useEffect(() => () => activeRequest.current?.abort(), [])

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      query(defaultPreset, "", "", DEFAULT_GRANULARITY)
    }
  }, [defaultPreset, initial, query])

  function setPreset(value: DashboardQuery["preset"]) {
    setPresetState(value)
    if (value === "custom") return
    setFrom("")
    setTo("")
    query(value, "", "", activeGranularity)
  }

  function setGranularity(value: NonNullable<DashboardQuery["granularity"]>) {
    setGranularityState(value)
    query(preset, from, to, value)
  }

  function handleRangeChange(range: DateRange | undefined) {
    const nextFrom = formatCalendarSelection(range?.from)
    const nextTo = formatCalendarSelection(range?.to)
    setFrom(nextFrom)
    setTo(nextTo)
    setPresetState("custom")
    if (nextFrom && nextTo) query("custom", nextFrom, nextTo, activeGranularity)
  }

  if (!dashboard) return <DashboardContentSkeleton variant="usage" />

  return <main className="min-h-[calc(100svh-var(--header-height))] bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex min-h-full max-w-7xl flex-col gap-4">
    <UsageOverview dashboard={dashboard} loading={pending} preset={preset} setPreset={setPreset} granularity={activeGranularity} setGranularity={setGranularity} selectedRange={selectedRange} onRangeChange={handleRangeChange} onRefresh={() => query()} />
    <section className="space-y-4"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold tracking-tight">Usage summary</h2><p className="text-sm text-muted-foreground">High-level totals for the currently selected range.</p></div>{pending ? <BadgeRefreshing /> : null}</div><div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4"><SummaryCard title="Requests" value={formatNumber(dashboard.summary.requests)} detail="Total request volume in the selected range." icon={BarChart3Icon} refreshing={pending} /><SummaryCard title="Tokens" value={formatTokenCount(dashboard.summary.tokens)} detail="Input, output, and cache tokens combined." icon={ActivityIcon} refreshing={pending} /><SummaryCard title="API-equivalent cost" value={formatCost(dashboard.summary.costMicros)} detail={dashboard.summary.unpricedRequests ? `${dashboard.summary.unpricedRequests} request(s) use unpriced models.` : "Calculated from configured model pricing."} icon={WalletCardsIcon} refreshing={pending} /><SummaryCard title="Active keys" value={formatNumber(dashboard.summary.activeKeys)} detail="Keys that handled traffic in this window." icon={KeyRoundIcon} refreshing={pending} /></div></section>
    {dashboard.trend.length || dashboard.keys.length || dashboard.models.length ? <><div className="grid gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">{dashboard.trend.length ? <DashboardTrend dashboard={dashboard} refreshing={pending} /> : <EmptyState title="No trend data" description="No usage buckets were found for this range." icon={BarChart3Icon} />}{dashboard.keys.length ? <TopKeys keys={dashboard.keys} refreshing={pending} /> : <EmptyState title="No key activity" description="No keys handled traffic in this range." icon={KeyRoundIcon} />}</div><div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">{dashboard.keys.length ? <UsageTable keys={dashboard.keys} refreshing={pending} publicView={publicView} /> : <EmptyState title="No table rows" description="There is no per-key usage to show for this filter." icon={DatabaseIcon} />}{dashboard.models.length ? <ModelMix models={dashboard.models} refreshing={pending} /> : <EmptyState title="No model mix" description="No model usage was recorded for this filter." icon={WalletCardsIcon} />}</div></> : <EmptyState title="No usage yet" description="No gateway activity was recorded for this range." icon={DatabaseIcon} />}
  </div></main>
}

function BadgeRefreshing() { return <span className="text-sm text-muted-foreground">Refreshing in place</span> }
