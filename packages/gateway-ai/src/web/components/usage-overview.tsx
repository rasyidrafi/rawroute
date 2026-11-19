import { Skeleton } from "@rawroute/ui/skeleton"
import { RefreshCwIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { Button } from "@rawroute/ui/button"
import { LoadingSpinner } from "@rawroute/ui/loading-spinner"
import type { DashboardPayload, DashboardQuery } from "../../contracts/domain"
import { formatAppDateTime } from "@rawroute/observability/contracts/timezone"
import { getOptionLabel, PRESET_OPTIONS } from "./usage-utils"
import { UsageRangeToolbar } from "./usage-range-toolbar"

export function UsageOverview({ dashboard, loading, preset, setPreset, granularity, setGranularity, selectedRange, onRangeChange, onRefresh }: { dashboard: DashboardPayload | null; loading: boolean; preset: DashboardQuery["preset"]; setPreset: (value: DashboardQuery["preset"]) => void; granularity: NonNullable<DashboardQuery["granularity"]> | "auto"; setGranularity: (value: NonNullable<DashboardQuery["granularity"]> | "auto") => void; selectedRange: DateRange | undefined; onRangeChange: (range: DateRange | undefined) => void; onRefresh: () => void }) {
  const initialLoading = loading && !dashboard
  const presetLabel = getOptionLabel(PRESET_OPTIONS, preset)

  return <section className="space-y-4">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex min-w-0 flex-col gap-1"><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">Usage dashboard</h1></div><div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground"><span>{dashboard?.range.label ?? presetLabel}</span><span className="inline-flex min-h-5 basis-full items-center sm:basis-auto">{dashboard ? formatAppDateTime(dashboard.generatedAt) : <Skeleton className="h-4 w-44" />}</span></div></div>
      <div className="flex items-center justify-end"><Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>{loading ? <LoadingSpinner /> : <RefreshCwIcon data-icon="inline-start" />}Refresh</Button></div>
    </div>
    <UsageRangeToolbar preset={preset} setPreset={setPreset} granularity={granularity} setGranularity={setGranularity} selectedRange={selectedRange} onRangeChange={onRangeChange} disabled={initialLoading} />
  </section>
}