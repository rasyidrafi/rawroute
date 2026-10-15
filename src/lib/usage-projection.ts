import type { Database } from "bun:sqlite"
import { addZonedDays, getAppTimeZone, getZonedParts, startOfZonedDay, startOfZonedMonth } from "./timezone"

export const usageProjectionVersion = 1
export type UsageGranularity = "hourly" | "daily" | "monthly"
export const usageMeasures = ["requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens", "costMicros", "successfulCostMicros", "pricedRequests", "unpricedRequests", "failedRequests", "statusCoveredRequests", "durationSumMs", "durationCount", "tokenCoveredRequests", "costCoveredRequests", "financialCoveredRequests", "modelCoveredRequests", "pricingCoveredRequests"] as const
export type UsageMeasures = Record<typeof usageMeasures[number], number>
export type HistoricalUsageMeasures = UsageMeasures & { latestEventAt: string | null; latestSuccessAt: string | null }
export type UsageBucket = UsageMeasures & {
  workspaceId: string; granularity: UsageGranularity; bucketStart: string; bucketEnd: string
  gatewayKeyId: string; gatewayModelId: string; provenance: "runtime" | "historical" | "mixed"
  latestEventAt: string | null; latestSuccessAt: string | null
}
export interface UsageHistory {
  sourcePath: string; workspaceId: string; gatewayKeyId: string; gatewayModelId: string
  bucketStart: string | null; bucketEnd: string | null; granularity: UsageGranularity | null
  disposition: "included" | "duplicate" | "excluded"; reason: string
  financialState: "known" | "unknown"; sourceJson: string; sourceHash: string; measuresJson: string | null
}

export function usagePrefix() { return (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_") }

export function usageWorkspace(collection: string, kind: "usageEvents" | "usageRollups") {
  const parts = collection.split("/")
  return parts.length === 3 && parts[0] === `${usagePrefix()}_workspaces` && parts[2] === kind ? parts[1] : undefined
}

export function emptyUsageMeasures(): UsageMeasures { return Object.fromEntries(usageMeasures.map(key => [key, 0])) as UsageMeasures }
export function validUsageInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }

function hourIdentity(at: number) {
  const parts = getZonedParts(new Date(at))
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond) - at
  return `${parts.year}/${parts.month}/${parts.day}/${parts.hour}/${offset}`
}

function firstChangedInstant(from: number, to: number, changed: (at: number) => boolean) {
  while (to - from > 1) {
    const middle = Math.floor((from + to) / 2)
    if (changed(middle)) to = middle
    else from = middle
  }
  return to
}

const calendarDayCache = new Map<string, Array<{ bucketStart: string; bucketEnd: string }>>()

function calendarDaySegments(date: Date, from: Date, to: Date) {
  const parts = getZonedParts(date)
  const identity = `${parts.year}/${parts.month}/${parts.day}`
  const key = `${getAppTimeZone()}:${identity}`
  const cached = calendarDayCache.get(key)
  if (cached) return cached
  const sameDay = (at: number) => {
    const value = getZonedParts(at)
    return `${value.year}/${value.month}/${value.day}` === identity
  }
  if (date >= from && date < to && sameDay(from.getTime()) && !sameDay(from.getTime() - 1)
    && sameDay(from.getTime() + 3_600_000 - 1) && sameDay(to.getTime() - 1)
    && !sameDay(to.getTime()) && !sameDay(to.getTime() + 3_600_000 - 1)) {
    const segments = [{ bucketStart: from.toISOString(), bucketEnd: to.toISOString() }]
    if (calendarDayCache.size >= 512) calendarDayCache.clear()
    calendarDayCache.set(key, segments)
    return segments
  }
  const segments: Array<{ bucketStart: string; bucketEnd: string }> = []
  // Some historical midnight folds briefly enter tomorrow, then return to today.
  // Follow real hourly offset segments instead of assuming one contiguous civil date.
  const lower = Math.min(from.getTime(), date.getTime()) - 26 * 3_600_000
  const upper = Math.max(to.getTime(), date.getTime()) + 26 * 3_600_000
  for (let cursor = lower; cursor < upper;) {
    const hour = usageCalendarBucket(new Date(cursor).toISOString(), "hourly")
    const current = getZonedParts(cursor)
    if (`${current.year}/${current.month}/${current.day}` === identity) {
      const previous = segments.at(-1)
      if (previous?.bucketEnd === hour.bucketStart) previous.bucketEnd = hour.bucketEnd
      else segments.push({ ...hour })
    }
    cursor = Date.parse(hour.bucketEnd)
  }
  if (calendarDayCache.size >= 512) calendarDayCache.clear()
  calendarDayCache.set(key, segments)
  return segments
}

/** Preserve real instants in a repeated DST hour; days/months remain calendar intervals. */
export function usageCalendarBucket(at: string, granularity: UsageGranularity) {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) throw new Error("Usage projection requires a valid completion timestamp")
  if (granularity === "hourly") {
    const parts = getZonedParts(date)
    const at = date.getTime()
    const guess = at - parts.minute * 60_000 - parts.second * 1000 - parts.millisecond
    const identity = hourIdentity(at)
    // Offset transitions can split a wall-clock hour (including 30-minute DST).
    const from = hourIdentity(guess) === identity ? guess : firstChangedInstant(guess, at, candidate => hourIdentity(candidate) === identity)
    const upper = guess + 3_600_000
    const to = hourIdentity(upper - 1) === identity ? upper : firstChangedInstant(at, upper, candidate => hourIdentity(candidate) !== identity)
    return { bucketStart: new Date(from).toISOString(), bucketEnd: new Date(to).toISOString() }
  }
  const from = granularity === "daily" ? startOfZonedDay(date) : startOfZonedMonth(date)
  // Monthly history keeps its original resolution; no synthetic daily/hourly rows.
  const to = granularity === "daily" ? addZonedDays(from, 1) : (() => {
    const parts = getZonedParts(from)
    let next = addZonedDays(from, 28)
    while (getZonedParts(next).month === parts.month) next = addZonedDays(next, 1)
    return next
  })()
  if (granularity === "daily") {
    const segments = calendarDaySegments(date, from, to)
    const segment = segments.find(segment => segment.bucketStart <= at && at < segment.bucketEnd)
    if (!segment) throw new Error("Cannot resolve canonical calendar day")
    return { ...segment }
  }
  return { bucketStart: from.toISOString(), bucketEnd: to.toISOString() }
}

export function usageEventMeasures(event: Record<string, unknown>): UsageMeasures {
  const result = emptyUsageMeasures()
  result.requests = 1
  const tokens = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens"] as const
  for (const key of tokens) result[key] = validUsageInteger(event[key]) ? event[key] : 0
  // Older flagless records rely on numeric fields; explicit missing/partial usage wins.
  const available = event.usageAvailable === undefined || event.usageAvailable === true
  const complete = event.usageCompleteness === undefined || event.usageCompleteness === "complete"
  result.tokenCoveredRequests = available && complete && tokens.every(key => validUsageInteger(event[key])) ? 1 : 0
  const statusKnown = typeof event.status === "number" && Number.isInteger(event.status) && event.status >= 100 && event.status <= 599
  const successful = statusKnown && Number(event.status) >= 200 && Number(event.status) < 300
  result.statusCoveredRequests = statusKnown ? 1 : 0
  result.failedRequests = statusKnown && !successful ? 1 : 0
  result.costMicros = validUsageInteger(event.costMicros) ? event.costMicros : 0
  result.costCoveredRequests = validUsageInteger(event.costMicros) ? 1 : 0
  result.successfulCostMicros = successful ? result.costMicros : 0
  result.financialCoveredRequests = statusKnown && (!successful || (validUsageInteger(event.costMicros) && (event.costMicros === 0 || (typeof event.gatewayKeyId === "string" && Boolean(event.gatewayKeyId))))) ? 1 : 0
  result.pricedRequests = successful && event.pricingConfidence === "exact" ? 1 : 0
  result.unpricedRequests = successful && event.pricingConfidence !== "exact" ? 1 : 0
  result.pricingCoveredRequests = statusKnown ? 1 : 0
  result.modelCoveredRequests = typeof event.gatewayModelId === "string" && event.gatewayModelId.length ? 1 : 0
  if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0) {
    result.durationCount = 1
    result.durationSumMs = event.durationMs
  }
  return result
}

export function eventUsageBuckets(workspaceId: string, event: Record<string, unknown>): UsageBucket[] {
  if (typeof event.completedAt !== "string") throw new Error("Usage projection requires a completion timestamp")
  const completedAt = new Date(event.completedAt).toISOString()
  if (completedAt !== event.completedAt) throw new Error("Usage projection requires canonical UTC completion timestamps")
  const measures = usageEventMeasures(event)
  return (["hourly", "daily"] as const).map(granularity => ({
    workspaceId, granularity, ...usageCalendarBucket(completedAt, granularity),
    gatewayKeyId: typeof event.gatewayKeyId === "string" ? event.gatewayKeyId : "",
    gatewayModelId: typeof event.gatewayModelId === "string" ? event.gatewayModelId : "",
    provenance: "runtime", ...measures, latestEventAt: completedAt,
    latestSuccessAt: measures.statusCoveredRequests && !measures.failedRequests ? completedAt : null,
  }))
}

export function usageBucketKey(bucket: Pick<UsageBucket, "workspaceId" | "granularity" | "bucketStart" | "gatewayKeyId" | "gatewayModelId">) {
  return JSON.stringify([bucket.workspaceId, bucket.granularity, bucket.bucketStart, bucket.gatewayKeyId, bucket.gatewayModelId])
}

/** Only duration subtraction gets an eight-epsilon, operand-relative roundoff allowance. */
function adjustedDurationSum(previous: number, delta: number, count: number) {
  const sum = previous + delta
  if (!Number.isFinite(sum)) throw new Error("Invalid usage projection measure: durationSumMs")
  if (count === 0) return 0
  const tolerance = 8 * Number.EPSILON * Math.max(Math.abs(previous), Math.abs(delta))
  if (delta < 0 && sum < 0 && sum >= -tolerance) return 0
  if (sum < 0) throw new Error("Invalid usage projection measure: durationSumMs")
  return sum
}

export function addUsageBucket(previous: UsageBucket | undefined, delta: UsageBucket, sign = 1): UsageBucket {
  const result = { ...delta, provenance: previous && previous.provenance !== delta.provenance ? "mixed" as const : delta.provenance }
  for (const key of usageMeasures) {
    result[key] = key === "durationSumMs"
      ? adjustedDurationSum(previous?.durationSumMs ?? 0, sign * delta.durationSumMs, (previous?.durationCount ?? 0) + sign * delta.durationCount)
      : (previous?.[key] ?? 0) + sign * delta[key]
    if (!Number.isFinite(result[key]) || result[key] < 0 || (key !== "durationSumMs" && !Number.isSafeInteger(result[key]))) throw new Error(`Invalid usage projection measure: ${key}`)
  }
  result.latestEventAt = [previous?.latestEventAt, delta.latestEventAt].filter((at): at is string => Boolean(at)).sort().at(-1) || null
  result.latestSuccessAt = [previous?.latestSuccessAt, delta.latestSuccessAt].filter((at): at is string => Boolean(at)).sort().at(-1) || null
  return result
}

export function projectMemoryUsage(buckets: Map<string, UsageBucket>, workspaceId: string, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  const next = new Map(buckets)
  const affected = new Set<string>()
  for (const [event, sign] of [[before, -1], [after, 1]] as const) for (const bucket of event ? eventUsageBuckets(workspaceId, event) : []) {
    const key = usageBucketKey(bucket)
    next.set(key, addUsageBucket(next.get(key), bucket, sign))
    affected.add(key)
  }
  for (const key of affected) if (next.get(key)?.requests === 0) next.delete(key)
  return next
}

export function createUsageProjectionSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS usage_projection_meta (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL, timeZone TEXT NOT NULL, documentPrefix TEXT NOT NULL)`)
  db.run(`CREATE TABLE IF NOT EXISTS usage_buckets (
    workspaceId TEXT NOT NULL, granularity TEXT NOT NULL CHECK(granularity IN ('hourly','daily','monthly')),
    bucketStart TEXT NOT NULL, bucketEnd TEXT NOT NULL CHECK(bucketEnd > bucketStart), gatewayKeyId TEXT NOT NULL, gatewayModelId TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK(provenance IN ('runtime','historical','mixed')),
    ${usageMeasures.map(key => `${key} ${key === "durationSumMs" ? "REAL" : "INTEGER"} NOT NULL CHECK(${key} >= 0 AND ${key} <= ${key === "durationSumMs" ? "1.7976931348623157e308" : "9007199254740991"}${key === "durationSumMs" ? "" : ` AND typeof(${key}) = 'integer'`})`).join(",")},
    latestEventAt TEXT, latestSuccessAt TEXT,
    CHECK(successfulCostMicros <= costMicros),
    ${usageMeasures.filter(key => key.endsWith("CoveredRequests") || ["pricedRequests", "unpricedRequests", "failedRequests", "durationCount"].includes(key)).map(key => `CHECK(${key} <= requests)`).join(",")},
    PRIMARY KEY(workspaceId, granularity, bucketStart, gatewayKeyId, gatewayModelId)
  ) WITHOUT ROWID`)
  db.run(`CREATE TABLE IF NOT EXISTS usage_projection_history (
    sourcePath TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, gatewayKeyId TEXT NOT NULL, gatewayModelId TEXT NOT NULL,
    bucketStart TEXT, bucketEnd TEXT, granularity TEXT CHECK(granularity IS NULL OR granularity IN ('hourly','daily','monthly')),
    disposition TEXT NOT NULL CHECK(disposition IN ('included','duplicate','excluded')), reason TEXT NOT NULL,
    financialState TEXT NOT NULL CHECK(financialState IN ('known','unknown')), sourceJson TEXT NOT NULL CHECK(json_valid(sourceJson)), sourceHash TEXT NOT NULL,
    measuresJson TEXT CHECK(measuresJson IS NULL OR json_valid(measuresJson))
  )`)
  db.run("CREATE INDEX IF NOT EXISTS usage_history_included_range ON usage_projection_history(workspaceId, bucketStart, bucketEnd) WHERE disposition = 'included'")
  db.run("CREATE INDEX IF NOT EXISTS usage_history_coverage_range ON usage_projection_history(workspaceId, bucketStart, bucketEnd) WHERE disposition <> 'duplicate'")
  db.run(`CREATE VIEW IF NOT EXISTS usage_projection_raw_events AS SELECT d.path, d.collection_path, d.document_id, d.data FROM rawroute_documents d WHERE NOT EXISTS (SELECT 1 FROM usage_projection_history h WHERE h.sourcePath = d.path AND h.disposition = 'excluded')`)
}

export function assertUsageProjection(db: Database, initializeEmpty = false) {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_projection_meta'").get()
  if (!exists) {
    const legacy = db.query<{ collection_path: string }, []>("SELECT DISTINCT collection_path FROM rawroute_documents").all().some(row => usageWorkspace(row.collection_path, "usageEvents") !== undefined || usageWorkspace(row.collection_path, "usageRollups") !== undefined || row.collection_path === `${usagePrefix()}_usage_events` || row.collection_path === `${usagePrefix()}_usage_rollups`)
    if (!initializeEmpty || legacy) throw new Error("Usage projection migration required; stop writers and run the offline usage-projection CLI with --sqlite and --timezone (source: scripts/migrations/usage-projection.ts; image: migrations/usage-projection.js)")
    db.transaction(() => {
      createUsageProjectionSchema(db)
      db.run("INSERT INTO usage_projection_meta VALUES (1, ?, ?, ?)", [usageProjectionVersion, getAppTimeZone(), usagePrefix()])
    })()
  }
  const meta = db.query<{ version: number; timeZone: string; documentPrefix: string }, []>("SELECT version, timeZone, documentPrefix FROM usage_projection_meta WHERE id = 1").get()
  if (!meta || meta.version !== usageProjectionVersion || meta.timeZone !== getAppTimeZone() || meta.documentPrefix !== usagePrefix()) throw new Error("Usage projection version/timezone/prefix mismatch; offline rebuild required")
}

const bucketIdentity = "workspaceId = ? AND granularity = ? AND bucketStart = ? AND gatewayKeyId = ? AND gatewayModelId = ?"
function identity(bucket: UsageBucket) { return [bucket.workspaceId, bucket.granularity, bucket.bucketStart, bucket.gatewayKeyId, bucket.gatewayModelId] }
export function putUsageBucket(db: Database, bucket: UsageBucket) {
  const keys = ["workspaceId", "granularity", "bucketStart", "bucketEnd", "gatewayKeyId", "gatewayModelId", "provenance", ...usageMeasures, "latestEventAt", "latestSuccessAt"] as const
  db.query(`INSERT INTO usage_buckets (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(workspaceId,granularity,bucketStart,gatewayKeyId,gatewayModelId) DO UPDATE SET ${keys.slice(3).map(key => `${key}=excluded.${key}`).join(",")}`).run(...keys.map(key => bucket[key]))
}

export function historicalUsageBucket(history: UsageHistory): UsageBucket {
  if (!history.measuresJson || !history.granularity || !history.bucketStart || !history.bucketEnd) throw new Error("Missing canonical historical measures")
  const value = JSON.parse(history.measuresJson) as HistoricalUsageMeasures
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid canonical historical measures")
  for (const key of usageMeasures) {
    if (key === "durationSumMs" ? typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 : !validUsageInteger(value[key])) throw new Error("Invalid canonical historical measure")
    if ((key.endsWith("CoveredRequests") || ["pricedRequests", "unpricedRequests", "failedRequests", "durationCount"].includes(key)) && value[key] > value.requests) throw new Error("Invalid canonical historical coverage")
  }
  if (value.successfulCostMicros > value.costMicros) throw new Error("Invalid canonical historical spend")
  for (const at of [value.latestEventAt, value.latestSuccessAt]) if (at !== null && (typeof at !== "string" || !Number.isFinite(Date.parse(at)) || at < history.bucketStart || at >= history.bucketEnd)) throw new Error("Invalid canonical historical timestamp")
  return { ...value, workspaceId: history.workspaceId, granularity: history.granularity, bucketStart: history.bucketStart, bucketEnd: history.bucketEnd, gatewayKeyId: history.gatewayKeyId, gatewayModelId: history.gatewayModelId, provenance: "historical" }
}

/** Aggregate upward only. The manifest retains the actual source resolution/coverage. */
export function historicalUsageBuckets(history: UsageHistory) {
  const bucket = historicalUsageBucket(history)
  return bucket.granularity === "hourly" ? [bucket, { ...bucket, granularity: "daily" as const, ...usageCalendarBucket(bucket.bucketStart, "daily") }] : [bucket]
}

function refreshUsageLatest(db: Database, collection: string, bucket: UsageBucket) {
  const raw = db.query<{ latestEventAt: string | null; latestSuccessAt: string | null }, string[]>(`SELECT MAX(json_extract(data,'$.completedAt')) AS latestEventAt, MAX(CASE WHEN json_type(data,'$.status') IN ('integer','real') AND json_extract(data,'$.status') = CAST(json_extract(data,'$.status') AS INTEGER) AND json_extract(data,'$.status') >= 200 AND json_extract(data,'$.status') < 300 THEN json_extract(data,'$.completedAt') END) AS latestSuccessAt FROM usage_projection_raw_events WHERE collection_path = ? AND json_extract(data,'$.completedAt') >= ? AND json_extract(data,'$.completedAt') < ? AND COALESCE(json_extract(data,'$.gatewayKeyId'),'') = ? AND COALESCE(json_extract(data,'$.gatewayModelId'),'') = ?`).get(collection, bucket.bucketStart, bucket.bucketEnd, bucket.gatewayKeyId, bucket.gatewayModelId)
  const historical = db.query<UsageHistory, string[]>("SELECT * FROM usage_projection_history WHERE workspaceId = ? AND gatewayKeyId = ? AND gatewayModelId = ? AND disposition = 'included' AND bucketStart < ? AND bucketEnd > ?").all(bucket.workspaceId, bucket.gatewayKeyId, bucket.gatewayModelId, bucket.bucketEnd, bucket.bucketStart)
    .flatMap(historicalUsageBuckets).filter(row => usageBucketKey(row) === usageBucketKey(bucket))
  bucket.latestEventAt = [raw?.latestEventAt, ...historical.map(row => row.latestEventAt)].filter((at): at is string => Boolean(at)).sort().at(-1) || null
  bucket.latestSuccessAt = [raw?.latestSuccessAt, ...historical.map(row => row.latestSuccessAt)].filter((at): at is string => Boolean(at)).sort().at(-1) || null
}

/** Runs only inside the document writer's existing SQLite transaction, after its raw mutation. */
export function projectSqliteUsage(db: Database, collection: string, workspaceId: string, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  if (after) {
    const at = typeof after.completedAt === "string" ? new Date(after.completedAt).toISOString() : ""
    const histories = db.query<UsageHistory, string[]>(`SELECT * FROM usage_projection_history WHERE workspaceId = ? AND disposition = 'included' AND (bucketStart IS NULL OR bucketStart <= ?) AND (bucketEnd IS NULL OR bucketEnd > ?) AND (gatewayKeyId = '' OR ? = '' OR gatewayKeyId = ?) AND (gatewayModelId = '' OR ? = '' OR gatewayModelId = ?)`)
      .all(workspaceId, at, at, String(after.gatewayKeyId || ""), String(after.gatewayKeyId || ""), String(after.gatewayModelId || ""), String(after.gatewayModelId || ""))
    for (const history of histories) {
      db.run("UPDATE usage_projection_history SET disposition = 'excluded', reason = 'runtime-overlap', financialState = 'unknown' WHERE sourcePath = ?", [history.sourcePath])
      for (const contribution of historicalUsageBuckets(history)) {
        const previous = db.query<UsageBucket, string[]>(`SELECT * FROM usage_buckets WHERE ${bucketIdentity}`).get(...identity(contribution))
        if (!previous) throw new Error("Missing historical projection bucket")
        const result = addUsageBucket(previous, contribution, -1)
        refreshUsageLatest(db, collection, result)
        putUsageBucket(db, result)
        db.run(`DELETE FROM usage_buckets WHERE ${bucketIdentity} AND requests = 0`, identity(result))
      }
    }
  }
  const changes = new Map<string, { bucket: UsageBucket; delta: UsageMeasures }>()
  for (const [event, sign] of [[before, -1], [after, 1]] as const) {
    if (!event) continue
    for (const bucket of eventUsageBuckets(workspaceId, event)) {
      const key = usageBucketKey(bucket)
      const change = changes.get(key) || { bucket, delta: emptyUsageMeasures() }
      change.bucket = bucket
      for (const measure of usageMeasures) change.delta[measure] += sign * bucket[measure]
      changes.set(key, change)
    }
  }
  for (const { bucket, delta } of changes.values()) {
    const latestEventAt = after ? bucket.latestEventAt : null
    const latestSuccessAt = after ? bucket.latestSuccessAt : null
    let durationSum: number | undefined
    if (delta.durationSumMs < 0 || delta.durationCount < 0) {
      const previous = db.query<Pick<UsageBucket, "durationSumMs" | "durationCount">, string[]>(`SELECT durationSumMs, durationCount FROM usage_buckets WHERE ${bucketIdentity}`).get(...identity(bucket))
      if (!previous) throw new Error("Missing usage projection bucket")
      durationSum = adjustedDurationSum(previous.durationSumMs, delta.durationSumMs, previous.durationCount + delta.durationCount)
    }
    const changed = db.query(`UPDATE usage_buckets SET ${usageMeasures.map(key => `${key} = ${key === "durationSumMs" && durationSum !== undefined ? "?" : `${key} + ?`}`).join(",")},
      provenance = CASE WHEN provenance <> ? THEN 'mixed' ELSE provenance END,
      latestEventAt = CASE WHEN latestEventAt IS NULL OR ? > latestEventAt THEN ? ELSE latestEventAt END,
      latestSuccessAt = CASE WHEN latestSuccessAt IS NULL OR ? > latestSuccessAt THEN ? ELSE latestSuccessAt END
      WHERE ${bucketIdentity}`).run(...usageMeasures.map(key => key === "durationSumMs" && durationSum !== undefined ? durationSum : delta[key]), bucket.provenance, latestEventAt, latestEventAt, latestSuccessAt, latestSuccessAt, ...identity(bucket))
    if (!changed.changes) {
      if (delta.requests <= 0) throw new Error("Missing usage projection bucket")
      putUsageBucket(db, { ...bucket, ...delta, latestEventAt, latestSuccessAt })
    }
    // Corrections/deletions can remove a previous maximum. Recompute from indexed raw bounds.
    if (before && (before.completedAt !== after?.completedAt || before.gatewayKeyId !== after?.gatewayKeyId || before.gatewayModelId !== after?.gatewayModelId || before.status !== after?.status)) {
      const result = db.query<UsageBucket, string[]>(`SELECT * FROM usage_buckets WHERE ${bucketIdentity}`).get(...identity(bucket))!
      refreshUsageLatest(db, collection, result)
      putUsageBucket(db, result)
    }
    if (delta.requests < 0) db.run(`DELETE FROM usage_buckets WHERE ${bucketIdentity} AND requests = 0`, identity(bucket))
  }
}

/** History availability complements per-row financial coverage; unknown history is not zero. */
export const historicalFinancialUnavailableSql = "(financialState = 'unknown' OR bucketStart IS NULL OR bucketEnd IS NULL OR ((bucketStart < ? OR bucketEnd > ?) AND COALESCE(json_extract(measuresJson,'$.successfulCostMicros'),1) <> 0))"

export function usageFinancialHistoryAvailable(db: Database, workspaceId: string, from: string, to: string, gatewayKeyId: string) {
  return !db.query(`SELECT 1 FROM usage_projection_history WHERE workspaceId = ? AND disposition <> 'duplicate' AND ${historicalFinancialUnavailableSql} AND (gatewayKeyId = '' OR gatewayKeyId = ?) AND (bucketStart IS NULL OR bucketStart < ?) AND (bucketEnd IS NULL OR bucketEnd > ?) LIMIT 1`).get(workspaceId, from, to, gatewayKeyId, to, from)
}
