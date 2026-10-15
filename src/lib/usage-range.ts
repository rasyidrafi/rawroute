import type { Database } from "bun:sqlite"
import type { AnalyticsCoverage, UsageEvent } from "./types"
import { addUsageBucket, emptyUsageMeasures, eventUsageBuckets, historicalFinancialUnavailableSql, usageBucketKey, usageCalendarBucket, usageMeasures, validUsageInteger, type UsageBucket, type UsageMeasures } from "./usage-projection"

export interface UsageRangeResult {
  rows: UsageBucket[]
  totals: UsageMeasures
  financialUnavailableKeys: Set<string>
  coverage: AnalyticsCoverage
  stages: { bucketRows: number; rawRows: number; historyRows: number }
  gaps: Array<{ from: string | null; to: string | null }>
}
type Segment = { from: string; to: string; granularity: "daily" | "hourly" | "raw" }
type Selected = { row: UsageBucket; segment: Segment }

/** A disjoint calendar partition. Only the two incomplete physical hours need raw data. */
export function usageRangeSegments(from: string, to: string, hourly = false): Segment[] {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from > to) throw new Error("Invalid canonical usage range")
  if (from === to) return []
  const segments: Segment[] = []
  const hours = (start: string, end: string) => {
    if (start >= end) return
    const first = usageCalendarBucket(start, "hourly")
    const fullFrom = start === first.bucketStart ? start : first.bucketEnd
    const fullTo = usageCalendarBucket(end, "hourly").bucketStart
    if (fullFrom >= fullTo) {
      if (start < fullFrom && fullFrom < end) segments.push({ from: start, to: fullFrom, granularity: "raw" }, { from: fullFrom, to: end, granularity: "raw" })
      else segments.push({ from: start, to: end, granularity: "raw" })
      return
    }
    if (start < fullFrom) segments.push({ from: start, to: fullFrom, granularity: "raw" })
    segments.push({ from: fullFrom, to: fullTo, granularity: "hourly" })
    if (fullTo < end) segments.push({ from: fullTo, to: end, granularity: "raw" })
  }
  if (hourly) hours(from, to)
  else {
    const first = usageCalendarBucket(from, "daily")
    const fullFrom = from === first.bucketStart ? from : first.bucketEnd
    const fullTo = usageCalendarBucket(to, "daily").bucketStart
    if (fullFrom >= fullTo) hours(from, to)
    else {
      hours(from, fullFrom)
      segments.push({ from: fullFrom, to: fullTo, granularity: "daily" })
      hours(fullTo, to)
    }
  }
  return segments
}

function integer(field: string) {
  const value = `json_extract(data,'$.${field}')`
  return `(json_type(data,'$.${field}') IN ('integer','real') AND ${value} >= 0 AND ${value} <= 9007199254740991 AND ${value} = CAST(${value} AS INTEGER))`
}
const status = "(json_type(data,'$.status') IN ('integer','real') AND json_extract(data,'$.status') = CAST(json_extract(data,'$.status') AS INTEGER) AND json_extract(data,'$.status') BETWEEN 100 AND 599)"
const successful = `(${status} AND json_extract(data,'$.status') >= 200 AND json_extract(data,'$.status') < 300)`
const duration = "(json_type(data,'$.durationMs') IN ('integer','real') AND json_extract(data,'$.durationMs') >= 0 AND json_extract(data,'$.durationMs') <= 1.7976931348623157e308)"
const tokenFields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens"] as const
const tokensKnown = `(${tokenFields.map(integer).join(" AND ")} AND (json_type(data,'$.usageAvailable') IS NULL OR json_type(data,'$.usageAvailable') = 'true') AND (json_type(data,'$.usageCompleteness') IS NULL OR json_extract(data,'$.usageCompleteness') = 'complete'))`
const rawExpressions: Record<typeof usageMeasures[number], string> = {
  requests: "1",
  ...Object.fromEntries(tokenFields.map(key => [key, `CASE WHEN ${integer(key)} THEN json_extract(data,'$.${key}') ELSE 0 END`])) as Record<typeof tokenFields[number], string>,
  costMicros: `CASE WHEN ${integer("costMicros")} THEN json_extract(data,'$.costMicros') ELSE 0 END`,
  successfulCostMicros: `CASE WHEN ${successful} AND ${integer("costMicros")} THEN json_extract(data,'$.costMicros') ELSE 0 END`,
  pricedRequests: `CASE WHEN ${successful} AND json_extract(data,'$.pricingConfidence') = 'exact' THEN 1 ELSE 0 END`,
  unpricedRequests: `CASE WHEN ${successful} AND COALESCE(json_extract(data,'$.pricingConfidence'),'') <> 'exact' THEN 1 ELSE 0 END`,
  failedRequests: `CASE WHEN ${status} AND NOT ${successful} THEN 1 ELSE 0 END`,
  statusCoveredRequests: `CASE WHEN ${status} THEN 1 ELSE 0 END`,
  durationCount: `CASE WHEN ${duration} THEN 1 ELSE 0 END`,
  durationSumMs: `CASE WHEN ${duration} THEN json_extract(data,'$.durationMs') ELSE 0 END`,
  tokenCoveredRequests: `CASE WHEN ${tokensKnown} THEN 1 ELSE 0 END`,
  costCoveredRequests: `CASE WHEN ${integer("costMicros")} THEN 1 ELSE 0 END`,
  financialCoveredRequests: `CASE WHEN ${status} AND (NOT ${successful} OR (${integer("costMicros")} AND (json_extract(data,'$.costMicros') = 0 OR (json_type(data,'$.gatewayKeyId') = 'text' AND length(json_extract(data,'$.gatewayKeyId')) > 0)))) THEN 1 ELSE 0 END`,
  modelCoveredRequests: "CASE WHEN json_type(data,'$.gatewayModelId') = 'text' AND length(json_extract(data,'$.gatewayModelId')) > 0 THEN 1 ELSE 0 END",
  pricingCoveredRequests: `CASE WHEN ${status} THEN 1 ELSE 0 END`,
}

function finish(selected: Selected[], histories: UsageBucket[], unavailable: Set<string>, gaps: UsageRangeResult["gaps"], stages: UsageRangeResult["stages"]): UsageRangeResult {
  for (const row of [...selected.map(item => item.row), ...histories]) {
    for (const key of usageMeasures) {
      if (key === "durationSumMs" ? !Number.isFinite(row[key]) || row[key] < 0 : !validUsageInteger(row[key])) throw new Error("Canonical usage measure is unavailable")
      if ((key.endsWith("CoveredRequests") || ["durationCount", "failedRequests", "pricedRequests", "unpricedRequests"].includes(key)) && row[key] > row.requests) throw new Error("Canonical usage coverage is unavailable")
    }
    if (row.successfulCostMicros > row.costMicros) throw new Error("Canonical financial measure is unavailable")
  }
  const byBucket = new Map(selected.map(item => [usageBucketKey(item.row), item]))
  // Strip the manifest's contribution from selected materializations, then add its
  // actual native interval exactly once. No legacy JSON or overlap heuristic is read.
  for (const source of histories) {
    const contributions = source.granularity === "hourly"
      ? [source, { ...source, granularity: "daily" as const, ...usageCalendarBucket(source.bucketStart, "daily") }]
      : [source]
    for (const contribution of contributions) {
      const item = byBucket.get(usageBucketKey(contribution))
      if (!item || item.segment.granularity === "raw") continue
      item.row = addUsageBucket(item.row, contribution, -1)
    }
  }
  const rows = [...selected.map(item => item.row), ...histories].filter(row => row.requests > 0)
  const totals = emptyUsageMeasures()
  for (const row of rows) {
    for (const key of usageMeasures) {
      totals[key] += row[key]
      if (key === "durationSumMs" ? !Number.isFinite(totals[key]) || totals[key] < 0 : !validUsageInteger(totals[key])) throw new Error("Canonical usage aggregate is unavailable")
    }
    if (row.financialCoveredRequests !== row.requests) unavailable.add(row.gatewayKeyId)
  }
  const coverage = {
    partial: gaps.length > 0 || unavailable.size > 0 || rows.some(row => !row.gatewayKeyId) || [totals.tokenCoveredRequests, totals.statusCoveredRequests, totals.costCoveredRequests, totals.modelCoveredRequests, totals.durationCount, totals.pricingCoveredRequests].some(count => count !== totals.requests),
    excludedSources: gaps.length, tokenCoveredRequests: totals.tokenCoveredRequests, statusCoveredRequests: totals.statusCoveredRequests,
    costCoveredRequests: totals.costCoveredRequests, modelCoveredRequests: totals.modelCoveredRequests,
    keyCoveredRequests: rows.filter(row => row.gatewayKeyId).reduce((sum,row) => sum + row.requests,0),
    durationCount: totals.durationCount, financialUnavailable: unavailable.size > 0, unsupportedTrendSources: 0,
  }
  return { rows, totals, coverage, financialUnavailableKeys: unavailable, stages, gaps }
}

export function readSqliteUsageRange(db: Database, workspaceId: string, collection: string, from: string, to: string, hourly = false): UsageRangeResult {
  const selected: Selected[] = []
  let rawRows = 0
  let bucketRows = 0
  for (const segment of usageRangeSegments(from, to, hourly)) {
    let rows: UsageBucket[]
    if (segment.granularity === "raw") {
      const bounds = usageCalendarBucket(segment.from, "hourly")
      rows = db.query<UsageBucket, string[]>(`SELECT ? AS workspaceId, 'hourly' AS granularity, ? AS bucketStart, ? AS bucketEnd,
        CASE WHEN json_type(data,'$.gatewayKeyId') = 'text' THEN json_extract(data,'$.gatewayKeyId') ELSE '' END AS gatewayKeyId,
        CASE WHEN json_type(data,'$.gatewayModelId') = 'text' THEN json_extract(data,'$.gatewayModelId') ELSE '' END AS gatewayModelId, 'runtime' AS provenance,
        ${usageMeasures.map(key => `SUM(${rawExpressions[key]}) AS ${key}`).join(",")},
        MAX(json_extract(data,'$.completedAt')) AS latestEventAt,
        MAX(CASE WHEN ${successful} THEN json_extract(data,'$.completedAt') END) AS latestSuccessAt
        FROM usage_projection_raw_events WHERE collection_path = ? AND json_extract(data,'$.completedAt') >= ? AND json_extract(data,'$.completedAt') < ?
        GROUP BY gatewayKeyId, gatewayModelId`).all(workspaceId, bounds.bucketStart, bounds.bucketEnd, collection, segment.from, segment.to)
      rawRows += rows.reduce((sum, row) => sum + row.requests, 0)
    } else {
      rows = db.query<UsageBucket, string[]>(`SELECT workspaceId, granularity, bucketStart, bucketEnd, gatewayKeyId, gatewayModelId, provenance,
        ${usageMeasures.map(key => `SUM(${key}) AS ${key}`).join(",")}, MAX(latestEventAt) AS latestEventAt, MAX(latestSuccessAt) AS latestSuccessAt
        FROM usage_buckets WHERE workspaceId = ? AND granularity = ? AND bucketStart >= ? AND bucketStart < ? AND bucketEnd <= ?
        GROUP BY bucketStart, bucketEnd, gatewayKeyId, gatewayModelId`).all(workspaceId, segment.granularity, segment.from, segment.to, segment.to)
      bucketRows += rows.length
    }
    selected.push(...rows.map(row => ({ row, segment })))
  }
  const histories = db.query<UsageBucket, string[]>(`SELECT workspaceId, granularity, bucketStart, bucketEnd, gatewayKeyId, gatewayModelId, 'historical' AS provenance,
    ${usageMeasures.map(key => `json_extract(measuresJson,'$.${key}') AS ${key}`).join(",")}, json_extract(measuresJson,'$.latestEventAt') AS latestEventAt, json_extract(measuresJson,'$.latestSuccessAt') AS latestSuccessAt
    FROM usage_projection_history WHERE workspaceId = ? AND disposition = 'included' AND bucketStart >= ? AND bucketEnd <= ?`).all(workspaceId, from, to)
  const omitted = db.query<{ gatewayKeyId: string; bucketStart: string | null; bucketEnd: string | null; omitted: number; unavailable: number }, string[]>(`SELECT gatewayKeyId, bucketStart, bucketEnd,
    CASE WHEN disposition = 'excluded' OR bucketStart IS NULL OR bucketEnd IS NULL OR ((bucketStart < ? OR bucketEnd > ?) AND COALESCE(json_extract(measuresJson,'$.requests'),1) > 0) THEN 1 ELSE 0 END AS omitted,
    CASE WHEN ${historicalFinancialUnavailableSql} THEN 1 ELSE 0 END AS unavailable
    FROM usage_projection_history WHERE workspaceId = ? AND disposition <> 'duplicate' AND (bucketStart IS NULL OR bucketStart < ?) AND (bucketEnd IS NULL OR bucketEnd > ?)`).all(from, to, from, to, workspaceId, to, from)
  return finish(selected, histories, new Set(omitted.filter(row => row.unavailable).map(row => row.gatewayKeyId)), omitted.filter(row => row.omitted).map(row => ({ from: row.bucketStart, to: row.bucketEnd })), { bucketRows, rawRows, historyRows: histories.length })
}

export function readMemoryUsageRange(workspaceId: string, buckets: ReadonlyMap<string, UsageBucket>, events: ReadonlyMap<string, UsageEvent>, eventsByHour: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string, hourly = false): UsageRangeResult {
  const selected: Selected[] = []
  let rawRows = 0
  let bucketRows = 0
  for (const segment of usageRangeSegments(from, to, hourly)) {
    if (segment.granularity !== "raw") {
      const rows = [...buckets.values()].filter(row => row.granularity === segment.granularity && row.bucketStart >= segment.from && row.bucketStart < segment.to && row.bucketEnd <= segment.to)
      selected.push(...rows.map(row => ({ row: { ...row }, segment })))
      bucketRows += rows.length
      continue
    }
    const grouped = new Map<string, UsageBucket>()
    // A short range contained within one physical hour has one indexed event set.
    const first = usageCalendarBucket(segment.from, "hourly")
    for (const id of eventsByHour.get(first.bucketStart) || []) {
      const event = events.get(id)
      if (!event || event.completedAt < segment.from || event.completedAt >= segment.to) continue
      const row = eventUsageBuckets(workspaceId, { ...event })[0]!
      grouped.set(usageBucketKey(row), addUsageBucket(grouped.get(usageBucketKey(row)), row))
      rawRows++
    }
    selected.push(...[...grouped.values()].map(row => ({ row, segment })))
  }
  return finish(selected, [], new Set(), [], { bucketRows, rawRows, historyRows: 0 })
}
