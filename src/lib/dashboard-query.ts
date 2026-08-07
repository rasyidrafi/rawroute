import type { DashboardQuery } from "@/lib/types"

export const DEFAULT_DASHBOARD_QUERY = { preset: "budget", granularity: "auto" } satisfies DashboardQuery

const allowedPresets = new Set<DashboardQuery["preset"]>(["today", "yesterday", "week", "lastWeek", "month", "lastMonth", "year", "all", "custom", "budget"])
const allowedGranularities = new Set<NonNullable<DashboardQuery["granularity"]>>(["auto", "hourly", "daily", "weekly", "monthly"])
const calendarDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const millisecondsPerDay = 86_400_000

export interface DashboardQueryOptions {
  maxCustomRangeDays?: number
}

function configuredPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const defaultMaximumCustomRangeDays = configuredPositiveInteger(process.env.DASHBOARD_MAX_CUSTOM_RANGE_DAYS, 3_650)

function parseCalendarDate(value: string | null) {
  const match = value?.match(calendarDatePattern)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const milliseconds = Date.UTC(year, month - 1, day)
  const parsed = new Date(milliseconds)
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return undefined
  return { value: `${match[1]}-${match[2]}-${match[3]}`, dayNumber: Math.floor(milliseconds / millisecondsPerDay) }
}

export function parseDashboardQuery(params: URLSearchParams, options: DashboardQueryOptions = {}): DashboardQuery {
  const requestedPreset = params.get("preset")
  const preset = allowedPresets.has(requestedPreset as DashboardQuery["preset"])
    ? requestedPreset as DashboardQuery["preset"]
    : DEFAULT_DASHBOARD_QUERY.preset
  const requestedGranularity = params.get("granularity")
  const granularity = allowedGranularities.has(requestedGranularity as NonNullable<DashboardQuery["granularity"]>)
    ? requestedGranularity as NonNullable<DashboardQuery["granularity"]>
    : DEFAULT_DASHBOARD_QUERY.granularity

  if (preset !== "custom") return { preset, granularity }

  const from = parseCalendarDate(params.get("from"))
  const to = parseCalendarDate(params.get("to"))
  const maximumDays = Number.isSafeInteger(options.maxCustomRangeDays) && options.maxCustomRangeDays! > 0
    ? options.maxCustomRangeDays!
    : defaultMaximumCustomRangeDays
  if (!from || !to || to.dayNumber < from.dayNumber || to.dayNumber - from.dayNumber + 1 > maximumDays) {
    return DEFAULT_DASHBOARD_QUERY
  }
  return { preset, from: from.value, to: to.value, granularity }
}
