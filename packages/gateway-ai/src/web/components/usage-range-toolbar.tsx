import { CalendarDaysIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { Button } from "@rawroute/ui/button"
import { Calendar } from "@rawroute/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@rawroute/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@rawroute/ui/select"
import type { DashboardQuery } from "../../contracts/domain"
import { DEFAULT_GRANULARITY, getGranularityOptions, getOptionLabel, getRangeLabel, PRESET_OPTIONS } from "./usage-utils"

export function UsageRangeToolbar({ preset, setPreset, granularity, setGranularity, selectedRange, onRangeChange, disabled }: { preset: DashboardQuery["preset"]; setPreset: (value: DashboardQuery["preset"]) => void; granularity: NonNullable<DashboardQuery["granularity"]> | "auto"; setGranularity: (value: NonNullable<DashboardQuery["granularity"]> | "auto") => void; selectedRange: DateRange | undefined; onRangeChange: (range: DateRange | undefined) => void; disabled?: boolean }) {
  const granularityOptions = getGranularityOptions(preset)
  const activeGranularity = granularityOptions.some((option) => option.value === granularity) ? granularity : DEFAULT_GRANULARITY
  const presetLabel = getOptionLabel(PRESET_OPTIONS, preset)
  const granularityLabel = getOptionLabel(granularityOptions, activeGranularity)
  return <div className="border-y border-border/70 py-3"><div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between"><div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Range</span><Select disabled={disabled} value={preset} onValueChange={(value) => value && setPreset(value as DashboardQuery["preset"])}><SelectTrigger className="h-8 min-w-0 flex-1 sm:w-[220px] sm:flex-none"><span className="truncate">{presetLabel}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Preset</SelectLabel>{PRESET_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div><div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-end"><DateRangePicker disabled={disabled} range={selectedRange} label="Date" onChange={onRangeChange} fallback={preset === "budget" ? "Budget window" : undefined} /><div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Group</span><Select disabled={disabled} value={activeGranularity} onValueChange={(value) => value && setGranularity(value as typeof activeGranularity)}><SelectTrigger className="h-8 min-w-0 flex-1 sm:w-[190px] sm:flex-none"><span className="truncate">{granularityLabel}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Grouping</SelectLabel>{granularityOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div></div></div></div>
}

function DateRangePicker({ range, label, fallback, onChange, disabled }: { disabled?: boolean; range: DateRange | undefined; label: string; fallback?: string; onChange: (range: DateRange | undefined) => void }) {
  return <div className="flex min-w-0 items-center gap-2">{label ? <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span> : null}<Popover><PopoverTrigger render={<Button variant="outline" weight="normal"
              disabled={disabled} className="h-9 w-[232px] min-w-0 justify-between"><span className="truncate text-left">{getRangeLabel(range, fallback)}</span><CalendarDaysIcon /></Button>} /><PopoverContent align="start" padding="none" className="w-auto"><Calendar autoFocus mode="range" defaultMonth={range?.from} selected={range} onSelect={onChange} numberOfMonths={1} /></PopoverContent></Popover></div>
}