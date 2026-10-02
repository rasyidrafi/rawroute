import { addDays, startOfMonth, startOfWeek, startOfYear, subMonths } from "date-fns"
import type { DateRange } from "react-day-picker"

import type { DashboardPayload, DashboardQuery } from "@/lib/types"
import { addZonedDays, addZonedMonths, calendarDateFromInstant, formatAppTrendBucket, startOfZonedMonth, zonedDateTimeToDate } from "@/lib/timezone"
import { getGranularityOptions, getOptionLabel, getRangeLabel, PRESET_OPTIONS } from "./usage-utils"

const sampleModels = [
  { model: "GPT-5", requests: 7_820, tokens: 3_820_000, costMicros: 18_420_000 },
  { model: "Claude Sonnet", requests: 3_910, tokens: 1_860_000, costMicros: 12_680_000 },
  { model: "Gemini Flash", requests: 1_760, tokens: 740_000, costMicros: 1_540_000 },
]
const sampleKeys = [
  { label: "Production", maskedKey: "sk-demo-••••4a2f", share: 0.48, limit: 250_000_000 },
  { label: "Customer support", maskedKey: "sk-demo-••••8b3c", share: 0.24, limit: 125_000_000 },
  { label: "Development", maskedKey: "sk-demo-••••2d9e", share: 0.14, limit: 75_000_000 },
  { label: "Internal tools", maskedKey: "sk-demo-••••6f1a", share: 0.09, limit: 30_000_000 },
  { label: "Playground", maskedKey: "sk-demo-••••3c7b", share: 0.05, limit: 20_000_000 },
]

function previewRange(preset: DashboardQuery["preset"], selected: DateRange | undefined, now: Date) {
  const today = calendarDateFromInstant(now)
  const week = startOfWeek(today, { weekStartsOn: 1 })
  const month = startOfMonth(today)
  switch (preset) {
    case "today": return { from: today, to: today }
    case "yesterday": return { from: addDays(today, -1), to: addDays(today, -1) }
    case "budget":
    case "week": return { from: week, to: addDays(week, 6) }
    case "lastWeek": return { from: addDays(week, -7), to: addDays(week, -1) }
    case "month": return { from: month, to: today }
    case "lastMonth": return { from: subMonths(month, 1), to: addDays(month, -1) }
    case "year": return { from: startOfYear(today), to: today }
    case "all": return { from: subMonths(month, 12), to: today }
    case "custom": return { from: selected?.from ?? week, to: selected?.to ?? selected?.from ?? addDays(week, 6) }
  }
}

function allocate(total: number, weights: number[]) {
  const weightSum = weights.reduce((sum, value) => sum + value, 0)
  let cumulative = 0
  let allocated = 0
  return weights.map(weight => {
    cumulative += weight
    const next = Math.round(total * cumulative / weightSum)
    const value = next - allocated
    allocated = next
    return value
  })
}

/** Browser-only sample payload. No workspace data or credentials are read. */
export function createOverviewUsageData(query: DashboardQuery, selectedRange: DateRange | undefined, now: Date): DashboardPayload {
  const dates = previewRange(query.preset, selectedRange, now)
  const from = zonedDateTimeToDate(dates.from)
  const to = addZonedDays(zonedDateTimeToDate(dates.to), 1)
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000))
  const options = getGranularityOptions(query.preset)
  const requested = options.some(option => option.value === query.granularity) ? query.granularity : "auto"
  const granularity = requested && requested !== "auto" ? requested
    : query.preset === "today" || query.preset === "yesterday" ? "hourly"
    : query.preset === "year" || query.preset === "all" || days > 90 ? "monthly" : "daily"
  const models = sampleModels.map(model => ({ ...model, requests: model.requests * days, tokens: model.tokens * days, costMicros: model.costMicros * days }))
  const summary = models.reduce((total, model) => ({ ...total, requests: total.requests + model.requests, tokens: total.tokens + model.tokens, costMicros: total.costMicros + model.costMicros }), {
    requests: 0, tokens: 0, costMicros: 0, activeKeys: sampleKeys.length, pricedRequests: 0, unpricedRequests: 0,
  })
  summary.pricedRequests = summary.requests

  const buckets: Date[] = []
  for (let bucket = from; bucket < to;) {
    buckets.push(bucket)
    bucket = granularity === "hourly" ? new Date(bucket.getTime() + 3_600_000)
      : granularity === "monthly" ? addZonedMonths(startOfZonedMonth(bucket), 1)
      : addZonedDays(bucket, granularity === "weekly" ? 7 : 1)
  }
  const weights = buckets.map((_, index) => 0.4 + Math.sin(index * 0.63 + 0.4) ** 2)
  const requests = allocate(summary.requests, weights)
  const tokens = allocate(summary.tokens, weights)
  const costs = allocate(summary.costMicros, weights)
  const trend = buckets.map((bucket, index) => ({
    bucketStart: bucket.toISOString(), label: formatAppTrendBucket(bucket, granularity),
    requests: requests[index]!, tokens: tokens[index]!, costMicros: costs[index]!,
  }))

  const shares = sampleKeys.map(key => key.share)
  const keyRequests = allocate(summary.requests, shares)
  const keyTokens = allocate(summary.tokens, shares)
  const keyCosts = allocate(summary.costMicros, shares)
  const lastUsed = Math.min(now.getTime(), to.getTime() - 1)
  const windowStart = zonedDateTimeToDate(startOfWeek(calendarDateFromInstant(now), { weekStartsOn: 1 }))
  const keys = sampleKeys.map((key, index) => {
    const spentMicros = Math.round(214_800_000 * key.share)
    return {
      id: `demo-key-${index + 1}`, label: key.label, maskedKey: key.maskedKey,
      requests: keyRequests[index]!, tokens: keyTokens[index]!, costMicros: keyCosts[index]!,
      models: sampleModels.map(model => model.model),
      lastUsed: new Date(Math.max(from.getTime(), lastUsed - index * 900_000)).toISOString(),
      budget: {
        weeklyLimitMicros: key.limit, spentMicros, remainingMicros: key.limit - spentMicros,
        percentUsed: spentMicros / key.limit * 100, bypassLimits: false,
        usageStartAt: windowStart.toISOString(), windowStart: windowStart.toISOString(), windowEnd: addZonedDays(windowStart, 7).toISOString(),
      },
    }
  })
  return {
    generatedAt: now.toISOString(),
    range: { label: query.preset === "custom" ? getRangeLabel(dates) : getOptionLabel(PRESET_OPTIONS, query.preset), from: from.toISOString(), to: new Date(to.getTime() - 1).toISOString(), granularity },
    summary, trend, keys, models,
    freshness: { source: "memory", lastEventAt: new Date(lastUsed).toISOString() },
    pricingConfidence: { pricedRequests: summary.requests, unpricedRequests: 0 },
  }
}
