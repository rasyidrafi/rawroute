import { z } from "zod"
import type { DashboardPayload } from "./domain"

export type OverviewPeriod = "24h" | "7d" | "30d"
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value)
const rangeSchema = z.object({ from: instant, to: instant }).refine(({ from, to }) => {
  const span = Date.parse(to) - Date.parse(from)
  return [86_400_000, 7 * 86_400_000, 30 * 86_400_000].includes(span)
})

/** Exact instants, unlike Usage's calendar date presets. End is exclusive. */
export function parseOverviewRange(params: URLSearchParams) {
  if ([...params.keys()].some(key => !["from", "to"].includes(key) || params.getAll(key).length !== 1)) throw new Error("Invalid overview range")
  return rangeSchema.parse({ from: params.get("from"), to: params.get("to") })
}

export function overviewRange(period: OverviewPeriod, now = Date.now()) {
  return { from: new Date(now - ({ "24h": 1, "7d": 7, "30d": 30 }[period]) * 86_400_000).toISOString(), to: new Date(now).toISOString() }
}

export interface OverviewDetails {
  cacheUsageInputTokens: number
  cacheUsageReadTokens: number
  cacheUsageCoveredRequests: number
  inputTokens: number
  cacheReadTokens: number
  failedRequests: number
  statusCoveredRequests: number
  durationCount: number
  durationSumMs: number
  budgets: { id: string; name: string; enabled: boolean; limitMicros: number; spentMicros: number | null; usageAvailable?: boolean }[]
  budgetWindow: { from: string; to: string; bypassLimits: boolean } | null
}
export type OverviewPayload = DashboardPayload & { overview: OverviewDetails }
