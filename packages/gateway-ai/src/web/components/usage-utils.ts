import { format } from "date-fns"
import type { DateRange } from "react-day-picker"

import type { DashboardQuery } from "../../contracts/domain"
import { formatAppDateTime } from "@rawroute/observability/contracts/timezone"

const integerFormatter = new Intl.NumberFormat("en-US")

export const DEFAULT_GRANULARITY: NonNullable<DashboardQuery["granularity"]> = "auto"
export const KEY_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export const PRESET_OPTIONS: Array<{ value: DashboardQuery["preset"]; label: string }> = [
  { value: "budget", label: "Budget window" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "This week" },
  { value: "lastWeek", label: "Last week" },
  { value: "month", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "year", label: "This year" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom" },
]

export const DESKTOP_PRESET_OPTIONS = PRESET_OPTIONS.filter((option) => option.value !== "custom")

export function formatNumber(value: number) {
  return integerFormatter.format(Math.round(value))
}

export function formatDateTime(value: string | null) {
  return formatAppDateTime(value)
}

export function formatCalendarSelection(date: Date | undefined) {
  if (!date) return ""
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`
}

export function parseDateInputValue(value: string) {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function getRangeLabel(range: DateRange | undefined, fallback = "Pick a date range") {
  if (!range?.from) return fallback
  if (!range.to) return format(range.from, "MMM dd, yyyy")
  return `${format(range.from, "MMM dd, yyyy")} - ${format(range.to, "MMM dd, yyyy")}`
}

export function resolveSelectedRange(from: string, to: string): DateRange | undefined {
  const fromDate = parseDateInputValue(from)
  const toDate = parseDateInputValue(to)
  if (!fromDate && !toDate) return undefined
  return { from: fromDate, to: toDate }
}

export function getOptionLabel<T extends string>(options: ReadonlyArray<{ value: T; label: string }>, value: T) {
  return options.find((option) => option.value === value)?.label ?? value
}

export function getGranularityOptions(preset: DashboardQuery["preset"]): Array<{ value: NonNullable<DashboardQuery["granularity"]> | "auto"; label: string }> {
  if (preset === "today" || preset === "yesterday") return [{ value: "auto", label: "Auto (hourly)" }, { value: "hourly", label: "Hourly" }]
  if (preset === "month" || preset === "lastMonth" || preset === "week" || preset === "lastWeek" || preset === "budget") return [{ value: "auto", label: "Auto (daily)" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]
  if (preset === "custom") return [{ value: "auto", label: "Automatic" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]
  if (preset === "year" || preset === "all") return [{ value: "auto", label: "Automatic" }, { value: "monthly", label: "Monthly" }]
  return [{ value: "auto", label: "Auto (daily)" }, { value: "daily", label: "Daily" }]
}
