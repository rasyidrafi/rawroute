import { Skeleton } from "@/components/ui/skeleton"
import { CalendarDaysIcon, RefreshCwIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select"
import type { DashboardPayload, DashboardQuery } from "@/lib/types"
import { formatAppDateTime } from "@/lib/timezone"
import { DEFAULT_GRANULARITY, getGranularityOptions, getOptionLabel, getRangeLabel, PRESET_OPTIONS } from "@/components/dashboard/ai/usage-utils"

export function UsageOverview({ dashboard, loading, preset, setPreset, granularity, setGranularity, selectedRange, onRangeChange, onRefresh }: { dashboard: DashboardPayload | null; loading: boolean; preset: DashboardQuery["preset"]; setPreset: (value: DashboardQuery["preset"]) => void; granularity: NonNullable<DashboardQuery["granularity"]> | "auto"; setGranularity: (value: NonNullable<DashboardQuery["granularity"]> | "auto") => void; selectedRange: DateRange | undefined; onRangeChange: (range: DateRange | undefined) => void; onRefresh: () => void }) {
  const initialLoading = loading && !dashboard
  const granularityOptions = getGranularityOptions(preset)
  const activeGranularity = granularityOptions.some((option) => option.value === granularity) ? granularity : DEFAULT_GRANULARITY
  const presetOptions = PRESET_OPTIONS
  const presetLabel = getOptionLabel(presetOptions, preset)
  const granularityLabel = getOptionLabel(granularityOptions, activeGranularity)

  return <section className="space-y-4">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0 space-y-2"><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold sm:text-3xl">Usage dashboard</h1></div><div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground"><span>{dashboard?.range.label ?? presetLabel}</span><span>{dashboard?.range.granularity ?? granularityLabel}</span><span className="inline-flex min-h-5 basis-full items-center sm:basis-auto">{dashboard ? formatAppDateTime(dashboard.generatedAt) : <Skeleton className="h-4 w-44" />}</span></div></div>
      <div className="flex items-center justify-end"><Button variant="outline" className="h-9 w-32" onClick={onRefresh} disabled={loading}><RefreshCwIcon className={loading ? "animate-spin" : ""} />{loading && dashboard ? "Refreshing" : "Refresh"}</Button></div>
    </div>
    <div className="border-y border-border/70 py-3"><div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between"><div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Range</span><Select disabled={initialLoading} value={preset} onValueChange={(value) => value && setPreset(value as DashboardQuery["preset"])}><SelectTrigger className="h-8 min-w-0 flex-1 sm:w-[220px] sm:flex-none"><span className="truncate">{presetLabel}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Preset</SelectLabel>{presetOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div><div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-end"><DateRangePicker disabled={initialLoading} range={selectedRange} label="Date" onChange={onRangeChange} fallback={preset === "budget" ? "Budget window" : undefined} /><div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Group</span><Select disabled={initialLoading} value={activeGranularity} onValueChange={(value) => value && setGranularity(value as typeof activeGranularity)}><SelectTrigger className="h-8 min-w-0 flex-1 sm:w-[190px] sm:flex-none"><span className="truncate">{granularityLabel}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Grouping</SelectLabel>{granularityOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div></div></div></div>
  </section>
}

function DateRangePicker({ range, label, fallback, onChange, disabled }: { disabled: boolean; range: DateRange | undefined; label: string; fallback?: string; onChange: (range: DateRange | undefined) => void }) {
  return <div className="flex min-w-0 items-center gap-2">{label ? <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span> : null}<Popover><PopoverTrigger render={<Button variant="outline" weight="normal"
              disabled={disabled} className="h-9 w-[232px] min-w-0 justify-between"><span className="truncate text-left">{getRangeLabel(range, fallback)}</span><CalendarDaysIcon /></Button>} /><PopoverContent align="start" padding="none" className="w-auto"><Calendar autoFocus mode="range" defaultMonth={range?.from} selected={range} onSelect={onChange} numberOfMonths={1} /></PopoverContent></Popover></div>
}
