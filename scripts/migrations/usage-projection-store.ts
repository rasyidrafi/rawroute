import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { addUsageBucket, assertUsageProjection, createUsageProjectionSchema, emptyUsageMeasures, eventUsageBuckets, historicalUsageBucket, historicalUsageBuckets, putUsageBucket, usageBucketKey, usageCalendarBucket, usageMeasures, usagePrefix, usageProjectionVersion, usageWorkspace, validUsageInteger, type UsageBucket, type UsageHistory } from "../../src/lib/usage-projection"
import { getAppTimeZone, startOfZonedDay, startOfZonedHour, startOfZonedMonth } from "../../src/lib/timezone"

type Source = { path: string; collection_path: string; document_id: string; data: string }
type Options = { timeZone: string; apply?: boolean; writersStopped?: boolean; backup?: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const canonicalJson = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compareText(a, b))) : item)
const baseMeasures = ["requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens", "costMicros"] as const
const confidenceMeasures = ["pricedRequests", "unpricedRequests", "failedRequests"] as const

function sourceData(row: Source): Record<string, unknown> {
  const value: unknown = JSON.parse(row.data)
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function overlap(a: UsageHistory, b: UsageHistory) {
  return a.workspaceId === b.workspaceId && (!a.gatewayKeyId || !b.gatewayKeyId || a.gatewayKeyId === b.gatewayKeyId)
    && (!a.gatewayModelId || !b.gatewayModelId || a.gatewayModelId === b.gatewayModelId)
    && (!a.bucketStart || !b.bucketEnd || a.bucketStart < b.bucketEnd) && (!a.bucketEnd || !b.bucketStart || a.bucketEnd > b.bucketStart)
}

/** Recover the actual legacy calendar-hour segment, including a repeated DST hour. */
function legacyHourEnd(start: string) {
  const from = Date.parse(start)
  const belongs = (at: number) => startOfZonedHour(new Date(at)).toISOString() === start
  let to = from + 3_600_000
  while (belongs(to) && to - from < 2 * 86_400_000) to += 3_600_000
  if (belongs(to)) throw new Error("Unbounded historical calendar hour")
  if (belongs(to - 1)) return new Date(to).toISOString()
  let lower = from
  while (to - lower > 1) {
    const middle = Math.floor((lower + to) / 2)
    if (belongs(middle)) lower = middle
    else to = middle
  }
  return new Date(to).toISOString()
}

function compatibleHistoryBounds(entry: UsageHistory) {
  if (!entry.bucketStart || !entry.bucketEnd || !entry.granularity) return false
  const bounds = usageCalendarBucket(entry.bucketStart, entry.granularity)
  if (bounds.bucketStart !== entry.bucketStart) return false
  if (entry.granularity !== "hourly") return bounds.bucketEnd === entry.bucketEnd
  // A legacy repeated wall-clock hour may span two current physical-hour buckets.
  return usageCalendarBucket(entry.bucketEnd, "hourly").bucketStart === entry.bucketEnd
    && entry.bucketEnd <= usageCalendarBucket(entry.bucketStart, "daily").bucketEnd
}

/** Legacy interpretation happens once, offline. Runtime only reads these canonical measures. */
function canonicalHistoricalMeasures(history: UsageHistory, source: Record<string, unknown>) {
  const requests = validUsageInteger(source.requests) ? source.requests : 0
  const measures = emptyUsageMeasures()
  measures.requests = requests
  for (const key of [...baseMeasures, ...confidenceMeasures]) measures[key] = validUsageInteger(source[key]) ? source[key] : 0
  measures.tokenCoveredRequests = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens"].every(key => validUsageInteger(source[key])) ? requests : 0
  // Numeric rollup zeros alone do not establish provider field presence.
  if (source.usageAvailable === true && source.usageCompleteness === "complete" && source.cacheUsageKnown !== false && measures.tokenCoveredRequests === requests) {
    measures.cacheUsageCoveredRequests = requests
    measures.cacheUsageInputTokens = measures.inputTokens
    measures.cacheUsageReadTokens = measures.cacheReadTokens
  }
  measures.costCoveredRequests = validUsageInteger(source.costMicros) ? requests : 0
  const failuresKnown = validUsageInteger(source.failedRequests) && source.failedRequests <= requests
  measures.statusCoveredRequests = failuresKnown ? measures.failedRequests : 0
  if (failuresKnown && validUsageInteger(source.statusCoveredRequests) && source.statusCoveredRequests <= requests && source.statusCoveredRequests >= measures.failedRequests) measures.statusCoveredRequests = source.statusCoveredRequests
  for (const key of confidenceMeasures) if (measures[key] > requests) measures[key] = 0
  measures.pricingCoveredRequests = validUsageInteger(source.pricedRequests) && source.pricedRequests <= requests && validUsageInteger(source.unpricedRequests) && source.unpricedRequests <= requests && measures.statusCoveredRequests === requests && measures.pricedRequests + measures.unpricedRequests + measures.failedRequests === requests ? requests : 0
  measures.modelCoveredRequests = history.gatewayModelId ? requests : 0
  if (validUsageInteger(source.durationCount) && source.durationCount <= requests && typeof source.durationSumMs === "number" && Number.isFinite(source.durationSumMs) && source.durationSumMs >= 0 && (source.durationCount > 0 || source.durationSumMs === 0)) {
    measures.durationCount = source.durationCount
    measures.durationSumMs = source.durationSumMs
  }
  if (measures.statusCoveredRequests === requests && measures.failedRequests === requests) measures.financialCoveredRequests = requests
  else if (validUsageInteger(source.successfulCostMicros) && measures.costCoveredRequests === requests && source.successfulCostMicros <= measures.costMicros) {
    measures.successfulCostMicros = source.successfulCostMicros
    measures.financialCoveredRequests = source.financialCoveredRequests === requests || measures.statusCoveredRequests === requests ? requests : 0
  } else if (measures.statusCoveredRequests === requests && measures.failedRequests === 0 && measures.costCoveredRequests === requests) {
    measures.successfulCostMicros = measures.costMicros
    measures.financialCoveredRequests = requests
  }
  const latest = requests > 0 && typeof source.lastEventAt === "string" && Number.isFinite(Date.parse(source.lastEventAt)) ? new Date(source.lastEventAt).toISOString() : null
  const latestEventAt = latest && latest >= history.bucketStart! && latest < history.bucketEnd! ? latest : null
  return JSON.stringify({ ...measures, latestEventAt, latestSuccessAt: measures.statusCoveredRequests === requests && !measures.failedRequests ? latestEventAt : null })
}

function history(row: Source, workspaceId: string, data: Record<string, unknown>): UsageHistory {
  const granularity = data.granularity === "hourly" || data.granularity === "daily" || data.granularity === "monthly" ? data.granularity : null
  const validAt = typeof data.bucketStart === "string" && Number.isFinite(Date.parse(data.bucketStart))
  const bounds = granularity && validAt ? usageCalendarBucket(String(data.bucketStart), granularity) : null
  if (bounds && granularity === "hourly" && startOfZonedHour(new Date(String(data.bucketStart))).toISOString() === bounds.bucketStart) bounds.bucketEnd = legacyHourEnd(bounds.bucketStart)
  return { sourcePath: row.path, sourceHash: digest(row.data), sourceJson: row.data, workspaceId,
    gatewayKeyId: typeof data.gatewayKeyId === "string" ? data.gatewayKeyId : "", gatewayModelId: typeof data.gatewayModelId === "string" ? data.gatewayModelId : "",
    granularity, bucketStart: bounds?.bucketStart || null, bucketEnd: bounds?.bucketEnd || null,
    disposition: "excluded", reason: "unsupported-source", financialState: "unknown", measuresJson: null }
}

/** Pure planning: neither source documents nor the SQLite schema are changed. */
function planProjection(rows: Source[], previousHistory?: UsageHistory[]) {
  const buckets = new Map<string, UsageBucket>()
  const rawDerived = new Map<string, UsageBucket>()
  const rawNumericRequests = new Map<string, number>()
  const rawBounds: UsageHistory[] = []
  const histories: UsageHistory[] = (previousHistory || []).map(entry => {
    if (digest(entry.sourceJson) !== entry.sourceHash) throw new Error(`Historical snapshot checksum mismatch: ${entry.sourcePath}`)
    return { ...entry }
  })
  const copies: Source[] = []
  const canonicalRows = rows.filter(row => usageWorkspace(row.collection_path, "usageEvents") !== undefined)
  const byPath = new Map(rows.map(row => [row.path, row]))
  // Preserve flat legacy source documents and copy into the sole canonical raw namespace offline.
  // canonical-copy-deleted tombstones intentionally have no required target. In rebuild
  // mode archives are never imported again; only active canonical-copy links must exist.
  for (const entry of histories.filter(entry => entry.reason.startsWith("canonical-copy:"))) {
    if (!byPath.has(entry.reason.slice("canonical-copy:".length))) throw new Error(`Imported canonical raw event missing: ${entry.sourcePath}`)
  }
  for (const row of previousHistory ? [] : rows.filter(row => row.collection_path === `${usagePrefix()}_usage_events`)) {
    const collection = `${usagePrefix()}_workspaces/default/usageEvents`
    const path = `${collection}/${row.document_id}`
    const existing = byPath.get(path)
    if (existing && canonicalJson(JSON.parse(existing.data)) !== canonicalJson(JSON.parse(row.data))) throw new Error(`Conflicting legacy/canonical event identity: ${path}`)
    if (!existing) { const copy = { ...row, path, collection_path: collection }; copies.push(copy); canonicalRows.push(copy) }
    histories.push({ ...history(row, "default", {}), disposition: "duplicate", reason: `canonical-copy:${path}`, financialState: "known" })
  }
  for (const row of canonicalRows) {
    const workspaceId = usageWorkspace(row.collection_path, "usageEvents")!
    const data = sourceData(row)
    if (typeof data.completedAt !== "string" || !Number.isFinite(Date.parse(data.completedAt))) {
      const entry = { ...history(row, workspaceId, data), reason: "invalid-raw-completion" }
      const existing = histories.find(candidate => candidate.sourcePath === row.path)
      if (existing && existing.sourceHash !== entry.sourceHash) throw new Error(`Unresolved raw history changed: ${row.path}`)
      if (!existing) histories.push(entry)
      continue
    }
    if (new Date(data.completedAt).toISOString() !== data.completedAt) {
      const at = new Date(data.completedAt).toISOString()
      const entry = { ...history(row, workspaceId, data), bucketStart: at, bucketEnd: new Date(Date.parse(at) + 1).toISOString(), reason: "noncanonical-raw-completion" }
      const existing = histories.find(candidate => candidate.sourcePath === row.path)
      if (existing && existing.sourceHash !== entry.sourceHash) throw new Error(`Unresolved raw history changed: ${row.path}`)
      if (!existing) histories.push(entry)
      continue
    }
    const eventBuckets = eventUsageBuckets(workspaceId, data)
    for (const bucket of eventBuckets) buckets.set(usageBucketKey(bucket), addUsageBucket(buckets.get(usageBucketKey(bucket)), bucket))
    const completedAt = new Date(data.completedAt).toISOString()
    // A point interval proves possible overlap, not that an aggregate is a duplicate.
    rawBounds.push({ ...history(row, workspaceId, data), bucketStart: completedAt, bucketEnd: new Date(Date.parse(completedAt) + 1).toISOString() })
    // Stored normalization can be numerically exact even when provider token usage
    // is missing/partial. Deduplication verifies stored sums, not provider coverage.
    const storedNumbersValid = baseMeasures.every(field => field === "requests" || validUsageInteger(data[field]))
    for (const granularity of previousHistory ? [] : ["hourly", "daily", "monthly"] as const) {
      const start = ({ hourly: startOfZonedHour, daily: startOfZonedDay, monthly: startOfZonedMonth }[granularity])(new Date(completedAt)).toISOString()
      const bucket = { ...eventBuckets[0]!, granularity, bucketStart: start }
      const key = usageBucketKey(bucket)
      rawDerived.set(key, addUsageBucket(rawDerived.get(key), bucket))
      rawNumericRequests.set(key, (rawNumericRequests.get(key) || 0) + (storedNumbersValid ? 1 : 0))
    }
  }
  if (previousHistory) {
    // After conversion the canonical manifest, not mutable legacy rollups, owns history.
    const accepted: UsageHistory[] = []
    for (const entry of histories.filter(candidate => candidate.disposition === "included")) {
      if (accepted.some(other => overlap(entry, other))) throw new Error(`Overlapping canonical history: ${entry.sourcePath}`)
      if (!compatibleHistoryBounds(entry)) {
        entry.disposition = "excluded"; entry.reason = "timezone-incompatible-history"; entry.financialState = "unknown"
      } else if (rawBounds.some(other => overlap(entry, other))) {
        entry.disposition = "excluded"; entry.reason = "runtime-overlap"; entry.financialState = "unknown"
      } else {
        const measure = historicalUsageBucket(entry)
        if (entry.financialState === "known" && ((!entry.gatewayKeyId && measure.successfulCostMicros !== 0) || measure.financialCoveredRequests !== measure.requests)) throw new Error(`Invalid financial coverage: ${entry.sourcePath}`)
        accepted.push(entry)
        for (const bucket of historicalUsageBuckets(entry)) buckets.set(usageBucketKey(bucket), addUsageBucket(buckets.get(usageBucketKey(bucket)), bucket))
      }
    }
    return { buckets: [...buckets.values()].sort((a,b) => compareText(usageBucketKey(a), usageBucketKey(b))), histories: histories.sort((a,b) => compareText(a.sourcePath, b.sourcePath)), copies, rawDocuments: canonicalRows.length }
  }
  const candidates = rows.flatMap(row => {
    const workspaceId = usageWorkspace(row.collection_path, "usageRollups") ?? (row.collection_path === `${usagePrefix()}_usage_rollups` ? "default" : undefined)
    if (workspaceId === undefined) return []
    const data = sourceData(row)
    return [{ row, data, entry: history(row, workspaceId, data) }]
  }).sort((a, b) => (["hourly", "daily", "monthly"].indexOf(a.entry.granularity || "monthly") - ["hourly", "daily", "monthly"].indexOf(b.entry.granularity || "monthly")) || compareText(a.row.path, b.row.path))
  const included: UsageHistory[] = []
  for (const { row, data, entry } of candidates) {
    histories.push(entry)
    if (!entry.granularity || !entry.bucketStart || entry.bucketStart !== data.bucketStart || !validUsageInteger(data.requests)) {
      if (!entry.granularity || !entry.bucketStart || entry.bucketStart !== data.bucketStart) { entry.bucketStart = null; entry.bucketEnd = null }
      entry.reason = "invalid-or-unaligned-aggregate"; continue
    }
    if (entry.granularity === "hourly" && startOfZonedHour(new Date(entry.bucketStart)).toISOString() !== entry.bucketStart) {
      entry.reason = "ambiguous-historical-hour"; entry.bucketStart = null; entry.bucketEnd = null; continue
    }
    if ((data.requests === 0 && baseMeasures.some(field => field !== "requests" && typeof data[field] === "number" && data[field] !== 0)) || (validUsageInteger(data.failedRequests) && data.failedRequests > data.requests)) { entry.reason = "inconsistent-aggregate-measures"; continue }
    const key = { workspaceId: entry.workspaceId, granularity: entry.granularity, bucketStart: entry.bucketStart, gatewayKeyId: entry.gatewayKeyId, gatewayModelId: entry.gatewayModelId }
    const derived = rawDerived.get(usageBucketKey(key))
    const expectedId = `${entry.granularity}:${entry.bucketStart}:${digest(`${entry.gatewayKeyId}:${entry.gatewayModelId}`).slice(0, 24)}`
    if (!data.backfillSource && row.document_id === expectedId && derived && rawNumericRequests.get(usageBucketKey(key)) === derived.requests && derived.costCoveredRequests === derived.requests
      && baseMeasures.every(field => data[field] === derived[field])
      && confidenceMeasures.every(field => data[field] === undefined || (derived.statusCoveredRequests === derived.requests && data[field] === derived[field]))) {
      entry.disposition = "duplicate"; entry.reason = "verified-runtime-derived"; entry.financialState = "known"; continue
    }
    entry.measuresJson = canonicalHistoricalMeasures(entry, data)
    if (data.backfillSource !== "ccs-usage-v2") { entry.reason = "unproven-aggregate-provenance"; continue }
    const matches = included.filter(other => overlap(entry, other))
    if (data.reconciledFrom === "ccs-usage-v2-hourly" && entry.granularity === "daily" && matches.length && matches.every(other => other.granularity === "hourly" && other.gatewayKeyId === entry.gatewayKeyId && other.gatewayModelId === entry.gatewayModelId)) {
      const sum = matches.map(historicalUsageBucket).reduce((total, bucket) => addUsageBucket(total, bucket), undefined as UsageBucket | undefined)!
      if (baseMeasures.every(field => data[field] === sum[field]) && confidenceMeasures.every(field => data[field] === undefined || data[field] === sum[field])) {
        entry.disposition = "duplicate"; entry.reason = "verified-declared-hourly-copy"; entry.financialState = "known"; continue
      }
    }
    if (rawBounds.some(other => overlap(entry, other))) { entry.reason = "ambiguous-raw-overlap"; continue }
    if (matches.length) { entry.reason = "ambiguous-aggregate-overlap"; continue }
    const bucket = historicalUsageBucket(entry)
    entry.disposition = "included"; entry.reason = "independent-ccs-history"
    entry.financialState = bucket.financialCoveredRequests === bucket.requests && (Boolean(entry.gatewayKeyId) || bucket.successfulCostMicros === 0) ? "known" : "unknown"
    included.push(entry)
    for (const contribution of historicalUsageBuckets(entry)) buckets.set(usageBucketKey(contribution), addUsageBucket(buckets.get(usageBucketKey(contribution)), contribution))
  }
  return { buckets: [...buckets.values()].sort((a, b) => compareText(usageBucketKey(a), usageBucketKey(b))), histories: histories.sort((a, b) => compareText(a.sourcePath, b.sourcePath)), copies, rawDocuments: canonicalRows.length }
}

function projectionDigest(buckets: UsageBucket[], histories: UsageHistory[]) {
  return digest(canonicalJson({ buckets: [...buckets].sort((a,b) => compareText(usageBucketKey(a), usageBucketKey(b))), histories: [...histories].sort((a,b) => compareText(a.sourcePath, b.sourcePath)) }))
}

function applyProjectionPlan(db: Database, plan: ReturnType<typeof planProjection>, rows: Source[]) {
  if (!db.inTransaction) throw new Error("Projection replacement requires an existing exclusive transaction")
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(usage_buckets)").all()
  if (columns.length) for (const key of ["cacheUsageInputTokens", "cacheUsageReadTokens", "cacheUsageCoveredRequests"] as const) {
    if (!columns.some(column => column.name === key)) db.run(`ALTER TABLE usage_buckets ADD COLUMN ${key} INTEGER NOT NULL DEFAULT 0 CHECK(typeof(${key}) = 'integer' AND ${key} >= 0 AND ${key} <= ${key.endsWith("CoveredRequests") ? "requests" : "9007199254740991"})`)
  }
  createUsageProjectionSchema(db)
  db.run("DELETE FROM usage_buckets")
  db.run("DELETE FROM usage_projection_history")
  db.run("DELETE FROM usage_projection_meta")
  db.run("INSERT INTO usage_projection_meta VALUES (1, ?, ?, ?)", [usageProjectionVersion, getAppTimeZone(), usagePrefix()])
  for (const row of plan.copies) db.run("INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES(?,?,?,?)", [row.path, row.collection_path, row.document_id, row.data])
  for (const bucket of plan.buckets) putUsageBucket(db, bucket)
  for (const entry of plan.histories) db.run("INSERT INTO usage_projection_history VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [entry.sourcePath, entry.workspaceId, entry.gatewayKeyId, entry.gatewayModelId, entry.bucketStart, entry.bucketEnd, entry.granularity, entry.disposition, entry.reason, entry.financialState, entry.sourceJson, entry.sourceHash, entry.measuresJson])
  assertUsageProjection(db)
  if (projectionDigest(db.query<UsageBucket, []>("SELECT * FROM usage_buckets").all(), db.query<UsageHistory, []>("SELECT * FROM usage_projection_history ORDER BY sourcePath").all()) !== projectionDigest(plan.buckets, plan.histories)) throw new Error("Projection validation failed")
  for (const row of rows) if (JSON.stringify(db.query<Source, [string]>("SELECT * FROM rawroute_documents WHERE path = ?").get(row.path)) !== JSON.stringify(row)) throw new Error("Source preservation failed")
}

/** Offline repairs call this inside their raw-update transaction, never from request handlers. */
export function rebuildCanonicalUsageProjection(db: Database) {
  assertUsageProjection(db)
  const rows = db.query<Source, []>("SELECT * FROM rawroute_documents ORDER BY path").all()
  const histories = db.query<UsageHistory, []>("SELECT * FROM usage_projection_history ORDER BY sourcePath").all()
  const plan = planProjection(rows, histories)
  applyProjectionPlan(db, plan, rows)
  return { rawDocuments: plan.rawDocuments, buckets: plan.buckets.length, histories: plan.histories.length }
}

/** Explicit stopped-writer conversion. Planning defaults to a readonly SQLite connection. */
export function migrateUsageProjection(file: string, options: Options) {
  if (!file || !existsSync(file)) throw new Error("An explicit existing SQLite path is required")
  if (options.apply && !options.writersStopped) throw new Error("Stop all writers and pass --writers-stopped before --apply")
  if (!options.timeZone) throw new Error("An explicit IANA timezone is required")
  new Intl.DateTimeFormat("en", { timeZone: options.timeZone }).format()
  const previousTimeZone = process.env.TIMEZONE
  const db = new Database(file, options.apply ? { readwrite: true } : { readonly: true })
  process.env.TIMEZONE = options.timeZone
  try {
    if (options.apply) {
      db.run("PRAGMA busy_timeout = 0")
      db.run("PRAGMA locking_mode = EXCLUSIVE")
      db.run("BEGIN EXCLUSIVE")
      db.run("COMMIT")
      // Exclusive connection locking remains held through backup, planning and commit.
    }
    const rows = db.query<Source, []>("SELECT * FROM rawroute_documents ORDER BY path").all()
    const table = db.query("SELECT 1 FROM sqlite_master WHERE name = 'usage_projection_meta'").get()
    const meta = table ? db.query<{ version: number; timeZone: string; documentPrefix: string }, []>("SELECT * FROM usage_projection_meta WHERE id = 1").get() : null
    if (table && (!meta || ![1, usageProjectionVersion].includes(meta.version) || meta.documentPrefix !== usagePrefix())) throw new Error("Unsupported projection version/prefix; use an explicit versioned conversion")
    const previousHistory = table ? db.query<UsageHistory, []>("SELECT * FROM usage_projection_history ORDER BY sourcePath").all() : undefined
    if (meta?.version === 1) for (const entry of previousHistory || []) {
      if (!entry.measuresJson) continue
      const measures = JSON.parse(entry.measuresJson) as Record<string, unknown>
      // V1 canonical token coverage was inferred from normalized numeric sums,
      // not per-field presence. Recover only explicit source provenance.
      const recovered = JSON.parse(canonicalHistoricalMeasures(entry, JSON.parse(entry.sourceJson) as Record<string, unknown>)) as Record<string, unknown>
      for (const key of ["cacheUsageInputTokens", "cacheUsageReadTokens", "cacheUsageCoveredRequests"] as const) measures[key] = recovered[key]
      entry.measuresJson = JSON.stringify(measures)
    }
    const plan = planProjection(rows, previousHistory)
    const sourceDigest = digest(JSON.stringify(rows))
    const plannedDigest = projectionDigest(plan.buckets, plan.histories)
    let unchanged = false
    if (table && !plan.copies.length) {
      const buckets = db.query<UsageBucket, []>("SELECT * FROM usage_buckets").all()
      const histories = db.query<UsageHistory, []>("SELECT * FROM usage_projection_history ORDER BY sourcePath").all()
      unchanged = meta?.version === usageProjectionVersion && meta.timeZone === getAppTimeZone() && meta.documentPrefix === usagePrefix() && projectionDigest(buckets, histories) === plannedDigest
    }
    const workspaceSums = Object.fromEntries([...new Set(plan.buckets.map(bucket => bucket.workspaceId))].map(workspace => [workspace, Object.fromEntries(usageMeasures.map(measure => [measure, plan.buckets.filter(bucket => bucket.workspaceId === workspace && bucket.granularity === "daily").reduce((sum, bucket) => sum + bucket[measure], 0)]))]))
    const workspaceTotals = Object.fromEntries([...new Set(plan.buckets.map(bucket => bucket.workspaceId))].map(workspace => {
      const sum = plan.buckets.filter(bucket => bucket.workspaceId === workspace && bucket.granularity !== "hourly").reduce((total, bucket) => addUsageBucket(total, bucket), undefined as UsageBucket | undefined)!
      return [workspace, Object.fromEntries(usageMeasures.map(measure => [measure, sum[measure]]))]
    }))
    const report = { version: usageProjectionVersion, timeZone: getAppTimeZone(), sourceDigest, plannedDigest, sourceDocuments: rows.length, rawDocuments: plan.rawDocuments, copiedRawDocuments: plan.copies.length, buckets: plan.buckets.length, workspaceDailySums: workspaceSums, workspaceTotals, classifications: plan.histories.map(({ sourceJson: _sourceJson, ...entry }) => { void _sourceJson; return entry }), applied: Boolean(options.apply && !unchanged), unchanged }
    if (!options.apply || unchanged) return report
    const backup = resolve(options.backup || `${file}.before-usage-projection-v${usageProjectionVersion}`)
    if (backup === resolve(file) || existsSync(backup)) throw new Error("Refusing to overwrite a backup or the source; choose a new --backup path")
    db.run("VACUUM INTO ?", [backup])
    chmodSync(backup, 0o600)
    const backupDb = new Database(backup, { readonly: true })
    try {
      if (backupDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok"
        || digest(JSON.stringify(backupDb.query<Source, []>("SELECT * FROM rawroute_documents ORDER BY path").all())) !== sourceDigest) throw new Error("Backup validation failed")
    } finally { backupDb.close() }
    db.transaction(() => applyProjectionPlan(db, plan, rows)).exclusive()
    return { ...report, backup }
  } finally {
    db.close()
    if (previousTimeZone === undefined) delete process.env.TIMEZONE
    else process.env.TIMEZONE = previousTimeZone
  }
}
