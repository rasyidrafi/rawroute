import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeLocalDatabase, ensureLocalDatabase, getSqliteDatabase } from "../../packages/platform/src/server/database"
import { initializeAiPersistence } from "../../packages/gateway-ai/src/server/local-db"

import { recordUsageEvent, repriceUsageForGroup, resetAnalyticsForTests } from "../../packages/gateway-ai/src/server/analytics"
import { addUsageBucket, createUsageProjectionSchema, emptyUsageMeasures, eventUsageBuckets, historicalUsageBucket, projectMemoryUsage, putUsageBucket, usageEventMeasures, usageFinancialHistoryAvailable, type UsageBucket, type UsageHistory } from "../../packages/gateway-ai/src/server/usage-projection"
import { normalizeUsageMetrics } from "../../packages/gateway-ai/src/server/usage-metrics"
import { migrateUsageProjection } from "../../scripts/migrations/usage-projection-store"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"
import { _resetMemoryBackend, upsertModel, upsertProvider } from "../../packages/gateway-ai/src/server/store"
import { savePricingVersion, syncModelPricingGroups } from "../../packages/gateway-ai/src/server/model-pricing"
import type { UsageEvent } from "../../packages/gateway-ai/src/contracts/domain"

initializeAiPersistence()
let directory = ""
let file: string
beforeEach(async () => {
  directory = ""
  await closeLocalDatabase()
  directory = mkdtempSync(join(tmpdir(), "usage-projection-"))
  file = join(directory, "test.sqlite")
  process.env.SQLITE_PATH = file
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.NODE_ENV = "test"
  process.env.TIMEZONE = "UTC"
  _resetMemoryBackend()
  resetAnalyticsForTests()
})
afterEach(async () => { await closeLocalDatabase(); if (directory) rmSync(directory, { recursive: true, force: true }) })
const scoped = <T>(id: string, fn: () => T) => runInWorkspace({ id, storageMode: "scoped" }, fn)
function event(id: string, extra: Partial<UsageEvent> = {}): UsageEvent {
  return { id, gatewayKeyId: "key", gatewayModelId: "model", protocol: "openai-chat", startedAt: "2026-10-13T12:00:00.000Z", completedAt: "2026-10-13T12:00:00.000Z", status: 200, durationMs: 100, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 1, totalTokens: 12, costMicros: 20, pricingConfidence: "exact", usageAvailable: true, ...extra }
}
function readBuckets() {
  const db = new Database(file, { readonly: true })
  try { return db.query<UsageBucket, []>("SELECT * FROM usage_buckets ORDER BY workspaceId,granularity,bucketStart,gatewayKeyId,gatewayModelId").all() } finally { db.close() }
}
function legacyDatabase() {
  const db = new Database(file)
  db.run("PRAGMA journal_mode = WAL")
  db.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY, collection_path TEXT NOT NULL, document_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
  return db
}
function source(db: Database, collection: string, id: string, data: object) {
  db.run("INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES(?,?,?,?)", [`${collection}/${id}`, collection, id, JSON.stringify(data)])
}
const root = "rawroute_workspaces/example"
const checksum = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

test("cache field provenance survives JSON normalization without changing financial or token coverage", () => {
  for (const [metrics, known] of [
    [{ input: 10, cached: 0 }, true],
    [{ input: 0, cached: 0 }, true],
    [{ input: 10, output: 2 }, false],
    [{ cached: 2, output: 2 }, false],
    [undefined, false],
  ] as const) {
    const normalized = normalizeUsageMetrics(metrics)
    const serialized = JSON.stringify(event("presence", normalized))
    const stored = JSON.parse(serialized) as Record<string, unknown>
    expect(stored.cacheUsageKnown).toBe(known)
    expect(usageEventMeasures(stored).cacheUsageCoveredRequests).toBe(known ? 1 : 0)
  }
  expect(usageEventMeasures({ ...event("old-complete") }).cacheUsageCoveredRequests).toBe(1)
  expect(usageEventMeasures({ ...event("old-partial", { usageCompleteness: "partial" }) }).cacheUsageCoveredRequests).toBe(0)
})

test("offline v1 conversion preserves raw/history sources, excludes unproven historical cache zeros and is idempotent", () => {
  const db = legacyDatabase()
  source(db, `${root}/usageEvents`, "partial", event("partial", normalizeUsageMetrics({ input: 100, cached: 25 })))
  source(db, `${root}/usageRollups`, "history", { ...aggregate(), granularity: "daily", bucketStart: "2026-10-01T00:00:00.000Z", requests: 1, inputTokens: 500, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 501, costMicros: 20, pricedRequests: 1 })
  source(db, `${root}/usageRollups`, "known-history", { ...aggregate(), granularity: "daily", bucketStart: "2026-10-02T00:00:00.000Z", requests: 1, inputTokens: 500, outputTokens: 1, cacheReadTokens: 100, cacheCreationTokens: 0, totalTokens: 501, costMicros: 20, pricedRequests: 1, usageAvailable: true, usageCompleteness: "complete" })
  db.close()
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  const old = new Database(file)
  const originalSources = old.query("SELECT * FROM rawroute_documents ORDER BY path").all()
  const originalHistory = old.query<{ sourceJson: string }, []>("SELECT sourceJson FROM usage_projection_history ORDER BY sourcePath").all()
  old.run("UPDATE usage_projection_meta SET version = 1")
  const oldColumns = old.query<{ name: string }, []>("PRAGMA table_info(usage_buckets)").all().map(column => column.name).filter(name => !name.startsWith("cacheUsage"))
  old.run(`CREATE TABLE v1_buckets AS SELECT ${oldColumns.join(",")} FROM usage_buckets`)
  old.run("DROP TABLE usage_buckets")
  old.run("ALTER TABLE v1_buckets RENAME TO usage_buckets")
  old.run("CREATE UNIQUE INDEX v1_bucket_identity ON usage_buckets(workspaceId,granularity,bucketStart,gatewayKeyId,gatewayModelId)")
  old.run("UPDATE usage_projection_history SET measuresJson = json_remove(measuresJson, '$.cacheUsageInputTokens', '$.cacheUsageReadTokens', '$.cacheUsageCoveredRequests') WHERE measuresJson IS NOT NULL")
  old.close()
  const options = { timeZone: "UTC", apply: true, writersStopped: true, backup: `${file}.v1-backup` }
  const converted = migrateUsageProjection(file, options)
  expect(converted.applied).toBe(true)
  expect(converted.workspaceTotals.example).toMatchObject({ cacheUsageInputTokens: 600, cacheUsageReadTokens: 125, cacheUsageCoveredRequests: 2 })
  expect(migrateUsageProjection(file, options).unchanged).toBe(true)
  const check = new Database(file)
  expect(check.query("SELECT * FROM rawroute_documents ORDER BY path").all()).toEqual(originalSources)
  expect(check.query("SELECT sourceJson FROM usage_projection_history ORDER BY sourcePath").all()).toEqual(originalHistory)
  check.close()
})
function aggregate(extra: Record<string, unknown> = {}) {
  return { granularity: "hourly", bucketStart: "2026-10-01T12:00:00.000Z", gatewayKeyId: "key", gatewayModelId: "model", requests: 2, inputTokens: 20, outputTokens: 4, cacheReadTokens: 6, cacheCreationTokens: 2, totalTokens: 24, costMicros: 40, pricedRequests: 2, unpricedRequests: 0, backfillSource: "ccs-usage-v2", ...extra }
}

test("atomic raw writes project both granularities, duplicate/late events and workspace billing independently", async () => {
  const context = { usageStartAt: "2026-10-14T00:00:00.000Z", windowEnd: "2026-10-15T00:00:00.000Z" }
  await scoped("owner", async () => {
    await Promise.all(Array.from({ length: 6 }, () => recordUsageEvent(event("duplicate", { durationMs: 0 }), context)))
    await recordUsageEvent(event("failed", { status: 500, costMicros: 90, durationMs: 50 }), null)
    const missing = event("missing", { completedAt: "2026-10-13T11:30:00.000Z", gatewayModelId: "second" })
    Reflect.deleteProperty(missing, "durationMs")
    await recordUsageEvent(missing, context)
    await recordUsageEvent(event("invalid-duration", { durationMs: -1 }), null)
  })
  await scoped("consumer", () => recordUsageEvent(event("duplicate", { costMicros: 0 }), null))
  const daily = readBuckets().filter(row => row.granularity === "daily")
  expect(daily.find(row => row.workspaceId === "owner" && row.gatewayModelId === "model")).toMatchObject({ requests: 3, costMicros: 130, successfulCostMicros: 40, failedRequests: 1, durationCount: 2, durationSumMs: 50, statusCoveredRequests: 3 })
  expect(daily.find(row => row.workspaceId === "owner" && row.gatewayModelId === "second")).toMatchObject({ requests: 1, durationCount: 0, successfulCostMicros: 20 })
  expect(daily.find(row => row.workspaceId === "consumer")).toMatchObject({ requests: 1, successfulCostMicros: 0 })
  expect((await getSqliteDatabase().collection("rawroute_workspaces/owner/budgetCounters").get()).size).toBe(0)
})

test("projection failure and later batch failure roll back raw, legacy rollups, counters and projections together", async () => {
  await scoped("atomic", () => recordUsageEvent(event("first"), null))
  const before = readBuckets()
  const events = getSqliteDatabase().collection("rawroute_workspaces/atomic/usageEvents")
  const batch = getSqliteDatabase().batch()
  batch.set(events.doc("first"), { ...event("first"), costMicros: 999, pricingConfidence: "assumed" })
  batch.create(events.doc("first"), event("first"))
  await expect(batch.commit()).rejects.toThrow("already exists")
  expect((await events.doc("first").get()).data()?.costMicros).toBe(20)
  expect(readBuckets()).toEqual(before)
  await scoped("overflow", async () => {
    await recordUsageEvent(event("max", { costMicros: Number.MAX_SAFE_INTEGER }), null)
    await expect(recordUsageEvent(event("excess"), { usageStartAt: "2026-10-01T00:00:00.000Z", windowEnd: "2026-11-01T00:00:00.000Z" })).rejects.toThrow()
    expect((await getSqliteDatabase().collection("rawroute_workspaces/overflow/usageEvents").get()).size).toBe(1)
    expect((await getSqliteDatabase().collection("rawroute_workspaces/overflow/budgetCounters").get()).size).toBe(0)
  })
})

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: actual repricing keeps successful/failed spend, confidence and normalized token measures in parity`, async () => {
  process.env.STORAGE_BACKEND = backend
  await scoped("reprice", async () => {
    const provider = await upsertProvider({ name: "Synthetic", prefix: "synthetic", baseUrl: "https://offline.invalid", protocol: "openai-chat", authType: "none", headers: {}, enabled: true })
    const model = await upsertModel(provider.id, { id: "model", name: "Model", gatewayModelId: "synthetic/model", upstreamModel: "model" })
    const group = (await syncModelPricingGroups()).find(entry => entry.memberModelIds.includes(model.id))!
    await savePricingVersion({ groupId: group.id, mode: "new", rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
    for (const status of [200, 500]) await recordUsageEvent(event(`event-${status}`, { gatewayModelId: model.gatewayModelId, providerModelId: model.id, status, costMicros: 0, pricingConfidence: "unpriced", usageCompleteness: "complete", cacheUsageKnown: status === 500 }), null)
    const replacement = await savePricingVersion({ groupId: group.id, mode: "replace", rates: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
    await repriceUsageForGroup(replacement.job!.id)
    await repriceUsageForGroup(replacement.job!.id)
    const buckets = backend === "sqlite" ? readBuckets() : [...globalThis.__rawrouteAnalyticsMemory!.get("reprice")!.projection.values()]
    for (const bucket of buckets) expect(bucket).toMatchObject({ requests: 2, successfulCostMicros: 14, costMicros: 28, failedRequests: 1, pricedRequests: 1, unpricedRequests: 0, durationCount: 2, durationSumMs: 200, cacheReadTokens: 6, cacheCreationTokens: 2, cacheUsageInputTokens: 10, cacheUsageReadTokens: 3, cacheUsageCoveredRequests: 1 })
  })
})

test("calendar projection distinguishes DST folds, 23/25-hour days and non-UTC fractional offsets", () => {
  for (const [timeZone, at, hours] of [["UTC", "2026-03-08T07:30:00.000Z", 24], ["Asia/Kathmandu", "2026-03-08T07:30:00.000Z", 24], ["America/New_York", "2026-03-08T07:30:00.000Z", 23], ["America/New_York", "2026-11-01T06:30:00.000Z", 25], ["Australia/Lord_Howe", "2026-04-04T15:15:00.000Z", 24.5], ["Australia/Lord_Howe", "2026-10-03T15:45:00.000Z", 23.5]] as const) {
    process.env.TIMEZONE = timeZone
    const [hourly, daily] = eventUsageBuckets("calendar", { ...event("calendar"), completedAt: at })
    expect(Date.parse(daily!.bucketEnd) - Date.parse(daily!.bucketStart)).toBe(hours * 3_600_000)
    expect(hourly!.bucketStart <= at && at < hourly!.bucketEnd).toBe(true)
  }
  process.env.TIMEZONE = "America/New_York"
  const first = eventUsageBuckets("calendar", { ...event("first"), completedAt: "2026-11-01T05:30:00.000Z" })[0]!
  const second = eventUsageBuckets("calendar", { ...event("second"), completedAt: "2026-11-01T06:30:00.000Z" })[0]!
  expect(first.bucketEnd).toBe(second.bucketStart)
  expect(first.bucketStart).not.toBe(second.bucketStart)
})

test("startup rejects old data and stale projection timezone/version instead of converting at request time", async () => {
  const legacy = legacyDatabase()
  source(legacy, `${root}/usageEvents`, "old", event("old"))
  legacy.close()
  await expect(ensureLocalDatabase()).rejects.toThrow("migration required")
  await closeLocalDatabase()
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  await ensureLocalDatabase()
  process.env.TIMEZONE = "America/New_York"
  await expect(getSqliteDatabase().collection("settings").get()).rejects.toThrow("mismatch")
  await closeLocalDatabase()
  process.env.TIMEZONE = "UTC"
  const db = new Database(file)
  db.run("UPDATE usage_projection_meta SET version = 99")
  db.close()
  await expect(ensureLocalDatabase()).rejects.toThrow("mismatch")
})

test("offline conversion is readonly by default, backed up, source-preserving and idempotent, including flat raw copies", () => {
  const db = legacyDatabase()
  source(db, "rawroute_usage_events", "old", event("old"))
  const rollup = aggregate({ bucketStart: "2026-10-13T12:00:00.000Z", requests: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 1, totalTokens: 12, costMicros: 20, pricedRequests: 1, failedRequests: 0, backfillSource: undefined })
  const id = `hourly:${rollup.bucketStart}:${createHash("sha256").update("key:model").digest("hex").slice(0,24)}`
  source(db, "rawroute_usage_rollups", id, rollup)
  const originals = db.query("SELECT * FROM rawroute_documents ORDER BY path").all()
  db.close()
  const before = checksum(file)
  const dry = migrateUsageProjection(file, { timeZone: "UTC" })
  expect(dry.applied).toBe(false)
  expect(checksum(file)).toBe(before)
  expect(dry.classifications.some(entry => entry.reason === "verified-runtime-derived")).toBe(true)
  expect(() => migrateUsageProjection(file, { timeZone: "UTC", apply: true })).toThrow("Stop all writers")
  const applied = migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  expect(applied.applied).toBe(true)
  expect(existsSync(`${file}.before-usage-projection-v2`)).toBe(true)
  expect(statSync(`${file}.before-usage-projection-v2`).mode & 0o777).toBe(0o600)
  const converted = new Database(file)
  for (const row of originals) expect(converted.query("SELECT * FROM rawroute_documents WHERE path = ?").get((row as { path: string }).path)).toEqual(row)
  expect(converted.query<{ count: number }, []>("SELECT count(*) AS count FROM rawroute_documents").get()?.count).toBe(3)
  converted.close()
  expect(migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true }).unchanged).toBe(true)
  expect(readBuckets().filter(row => row.granularity === "daily").reduce((sum,row) => sum + row.requests, 0)).toBe(1)
})

test("historical classification preserves independent sources and excludes ambiguous equal-count overlaps without inventing status/durations", () => {
  const db = legacyDatabase()
  source(db, `${root}/usageEvents`, "raw", event("raw"))
  source(db, `${root}/usageRollups`, "hourly-history", aggregate())
  source(db, `${root}/usageRollups`, "copied-daily", aggregate({ granularity: "daily", bucketStart: "2026-10-01T00:00:00.000Z", reconciledFrom: "ccs-usage-v2-hourly" }))
  source(db, `${root}/usageRollups`, "ambiguous-daily", aggregate({ granularity: "daily", bucketStart: "2026-10-01T00:00:00.000Z", costMicros: 999 }))
  source(db, `${root}/usageRollups`, "raw-overlap", aggregate({ bucketStart: "2026-10-13T12:00:00.000Z", requests: 1 }))
  source(db, `${root}/usageRollups`, "daily-only", aggregate({ granularity: "daily", bucketStart: "2026-09-01T00:00:00.000Z", gatewayModelId: undefined }))
  source(db, `${root}/usageRollups`, "Z-unknown-source", aggregate({ bucketStart: "2026-08-01T12:00:00.000Z", backfillSource: "unknown" }))
  db.close()
  const report = migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  const reason = (suffix: string) => report.classifications.find(entry => entry.sourcePath.endsWith(suffix))!
  expect(reason("hourly-history")).toMatchObject({ disposition: "included", financialState: "unknown" })
  expect(reason("copied-daily")).toMatchObject({ disposition: "duplicate", reason: "verified-declared-hourly-copy" })
  expect(reason("ambiguous-daily")).toMatchObject({ disposition: "excluded", reason: "ambiguous-aggregate-overlap" })
  expect(reason("raw-overlap").reason).toBe("ambiguous-raw-overlap")
  expect(reason("unknown-source").reason).toBe("unproven-aggregate-provenance")
  const dailyOnly = readBuckets().find(row => row.bucketStart === "2026-09-01T00:00:00.000Z")!
  expect(dailyOnly).toMatchObject({ granularity: "daily", requests: 2, costMicros: 40, modelCoveredRequests: 0, statusCoveredRequests: 0, durationCount: 0, successfulCostMicros: 0, financialCoveredRequests: 0 })
  expect(readBuckets().some(row => row.granularity === "hourly" && row.bucketStart.startsWith("2026-09-01"))).toBe(false)
  const verified = new Database(file)
  expect(usageFinancialHistoryAvailable(verified, "example", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", "key")).toBe(false)
  expect(usageFinancialHistoryAvailable(verified, "other", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", "key")).toBe(true)
  verified.close()
})

test("late runtime overlap excludes historical contribution atomically, retaining its snapshot and blocking financial credit", async () => {
  const db = legacyDatabase()
  source(db, `${root}/usageRollups`, "history", aggregate({ failedRequests: 0, statusCoveredRequests: 2, lastEventAt: "2026-10-01T12:59:00.000Z" }))
  db.close()
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  const original = readBuckets()
  const verified = new Database(file)
  const canonicalHistory = verified.query<UsageHistory, []>("SELECT * FROM usage_projection_history WHERE disposition = 'included'").get()!
  expect(historicalUsageBucket({ ...canonicalHistory, sourceJson: "opaque archive, not a runtime input" }).costMicros).toBe(40)
  expect(usageFinancialHistoryAvailable(verified, "example", "2026-10-01T12:00:00.000Z", "2026-10-01T13:00:00.000Z", "key")).toBe(true)
  expect(usageFinancialHistoryAvailable(verified, "example", "2026-10-01T12:30:00.000Z", "2026-10-01T13:00:00.000Z", "key")).toBe(false)
  verified.close()
  await scoped("example", () => recordUsageEvent(event("late", { completedAt: "2026-10-01T12:30:00.000Z" }), null))
  expect(readBuckets()).not.toEqual(original)
  for (const bucket of readBuckets()) expect(bucket).toMatchObject({ requests: 1, costMicros: 20, latestEventAt: "2026-10-01T12:30:00.000Z" })
  const after = new Database(file)
  expect(after.query<UsageHistory, []>("SELECT * FROM usage_projection_history").get()).toMatchObject({ disposition: "excluded", reason: "runtime-overlap", financialState: "unknown" })
  expect(usageFinancialHistoryAvailable(after, "example", "2026-10-01T12:00:00.000Z", "2026-10-01T13:00:00.000Z", "key")).toBe(false)
  after.close()
})

test("converter fails closed on active SQLite ownership and rolls back all projection replacement on SQL failure", () => {
  const db = legacyDatabase()
  source(db, "rawroute_workspaces/blocked/usageEvents", "raw", event("raw"))
  db.run("BEGIN IMMEDIATE")
  expect(() => migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })).toThrow()
  db.run("ROLLBACK")
  createUsageProjectionSchema(db)
  db.run("INSERT INTO usage_projection_meta VALUES(1,1,'UTC','rawroute')")
  const sentinel = { ...eventUsageBuckets("sentinel", { ...event("sentinel") })[0]!, ...emptyUsageMeasures() }
  putUsageBucket(db, sentinel)
  db.run("CREATE TRIGGER reject_projection BEFORE INSERT ON usage_buckets WHEN NEW.workspaceId = 'blocked' BEGIN SELECT RAISE(ABORT, 'projection failure'); END")
  db.close()
  expect(() => migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })).toThrow("projection failure")
  expect(readBuckets()).toEqual([sentinel])
  expect(existsSync(`${file}.before-usage-projection-v2`)).toBe(true)
})

test("maintenance rollup batches cannot silently stale canonical history, and workspace deletion removes projection data", async () => {
  await scoped("example", () => recordUsageEvent(event("raw"), null))
  const batch = getSqliteDatabase().batch()
  batch.set(getSqliteDatabase().collection(`${root}/usageEvents`).doc("raw"), event("raw", { costMicros: 999 }))
  batch.set(getSqliteDatabase().collection(`${root}/usageRollups`).doc("legacy"), aggregate())
  await expect(batch.commit()).rejects.toThrow("offline projection rebuild")
  expect(readBuckets().every(row => row.costMicros === 20)).toBe(true)
  await getSqliteDatabase().recursiveDelete(getSqliteDatabase().collection("rawroute_workspaces").doc("example"))
  expect(readBuckets()).toEqual([])
})

test("real SQLite folds and subsequent corrections preserve exact maxima and successful financial sums", async () => {
  process.env.TIMEZONE = "America/New_York"
  await scoped("fold", async () => {
    await recordUsageEvent(event("first", { completedAt: "2026-11-01T05:30:00.000Z" }), null)
    await recordUsageEvent(event("second", { completedAt: "2026-11-01T06:30:00.000Z", gatewayModelId: "second" }), null)
  })
  expect(readBuckets().filter(row => row.granularity === "hourly").map(row => row.bucketStart)).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z"])
  const raw = getSqliteDatabase().collection("rawroute_workspaces/fold/usageEvents")
  await raw.doc("second").set(event("second", { completedAt: "2026-11-01T06:45:00.000Z", status: 500, costMicros: 90 }))
  const daily = readBuckets().find(row => row.granularity === "daily")!
  expect(daily).toMatchObject({ requests: 2, failedRequests: 1, costMicros: 110, successfulCostMicros: 20, latestEventAt: "2026-11-01T06:45:00.000Z", latestSuccessAt: "2026-11-01T05:30:00.000Z" })
  await raw.doc("second").delete()
  expect(readBuckets().find(row => row.granularity === "daily")).toMatchObject({ requests: 1, latestEventAt: "2026-11-01T05:30:00.000Z", latestSuccessAt: "2026-11-01T05:30:00.000Z" })
})

test("missing raw measures stay partial; unsupported timestamps retain source snapshots and cannot prove financial completeness", () => {
  const db = legacyDatabase()
  source(db, `${root}/usageEvents`, "partial", { completedAt: "2026-10-13T12:00:00.000Z", gatewayKeyId: "key", inputTokens: 7, cacheReadTokens: 2, costMicros: 33, durationMs: "100" })
  source(db, `${root}/usageEvents`, "offset", event("offset", { completedAt: "2026-10-13T12:00:00+00:00" }))
  source(db, `${root}/usageEvents`, "invalid", event("invalid", { completedAt: "invalid" }))
  db.close()
  const report = migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  expect(report.classifications.map(entry => entry.reason).sort()).toEqual(["invalid-raw-completion", "noncanonical-raw-completion"])
  for (const bucket of readBuckets()) expect(bucket).toMatchObject({ requests: 1, inputTokens: 7, cacheReadTokens: 2, costMicros: 33, durationCount: 0, statusCoveredRequests: 0, modelCoveredRequests: 0, financialCoveredRequests: 0, tokenCoveredRequests: 0 })
  const converted = new Database(file)
  expect(converted.query<{ count: number }, []>("SELECT count(*) AS count FROM rawroute_documents").get()?.count).toBe(3)
  expect(converted.query<{ count: number }, []>("SELECT count(*) AS count FROM usage_projection_raw_events").get()?.count).toBe(1)
  expect(usageFinancialHistoryAvailable(converted, "example", "2026-10-13T00:00:00.000Z", "2026-10-14T00:00:00.000Z", "key")).toBe(false)
  converted.close()
})

test("canonical rebuild uses immutable history snapshots, not changed legacy rollups, and preserves actual monthly resolution", () => {
  const db = legacyDatabase()
  source(db, `${root}/usageRollups`, "month", aggregate({ granularity: "monthly", bucketStart: "2026-07-01T00:00:00.000Z", failedRequests: 0, statusCoveredRequests: 2, durationCount: 2, durationSumMs: 12.5 }))
  db.close()
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  const converted = new Database(file)
  converted.run("UPDATE rawroute_documents SET data = json_set(data, '$.costMicros', 999)")
  converted.close()
  expect(migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true }).unchanged).toBe(true)
  expect(readBuckets()).toHaveLength(1)
  expect(readBuckets()[0]).toMatchObject({ granularity: "monthly", costMicros: 40, successfulCostMicros: 40, durationCount: 2, durationSumMs: 12.5 })
  const rebuilt = migrateUsageProjection(file, { timeZone: "America/New_York", apply: true, writersStopped: true, backup: join(directory, "timezone-backup.sqlite") })
  expect(rebuilt.classifications[0]).toMatchObject({ disposition: "excluded", reason: "timezone-incompatible-history", financialState: "unknown", bucketStart: "2026-07-01T00:00:00.000Z" })
})

test("imported raw repricing does not resurrect legacy values on rebuild; backup overwrite and snapshot tampering fail closed", async () => {
  const db = legacyDatabase()
  source(db, "rawroute_usage_events", "old", event("old"))
  source(db, "rawroute_workspaces/default/usageEvents", "old", Object.fromEntries(Object.entries(event("old")).reverse()))
  db.close()
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  await getSqliteDatabase().collection("rawroute_workspaces/default/usageEvents").doc("old").set(event("old", { costMicros: 99, pricingConfidence: "assumed" }))
  await closeLocalDatabase()
  expect(migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true }).unchanged).toBe(true)
  expect(readBuckets().every(row => row.costMicros === 99)).toBe(true)
  const converted = new Database(file)
  converted.run("UPDATE usage_buckets SET costMicros = 1, successfulCostMicros = 1")
  converted.close()
  const originalBackup = checksum(`${file}.before-usage-projection-v2`)
  expect(() => migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })).toThrow("Refusing to overwrite")
  expect(checksum(`${file}.before-usage-projection-v2`)).toBe(originalBackup)
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true, backup: join(directory, "repair-backup.sqlite") })
  const corrupt = new Database(file)
  corrupt.run("UPDATE usage_projection_history SET sourceJson = json_set(sourceJson, '$.costMicros', 999)")
  corrupt.close()
  expect(() => migrateUsageProjection(file, { timeZone: "UTC" })).toThrow("snapshot checksum mismatch")
})

test("historical DST wall hours retain their actual intervals and partial financial windows stay unavailable", () => {
  process.env.TIMEZONE = "America/New_York"
  const db = legacyDatabase()
  source(db, `${root}/usageRollups`, "spring", aggregate({ bucketStart: "2026-03-08T06:00:00.000Z", failedRequests: 0, statusCoveredRequests: 2 }))
  source(db, `${root}/usageRollups`, "fall", aggregate({ bucketStart: "2026-11-01T05:00:00.000Z", failedRequests: 0, statusCoveredRequests: 2 }))
  db.close()
  migrateUsageProjection(file, { timeZone: "America/New_York", apply: true, writersStopped: true })
  expect(readBuckets().filter(row => row.granularity === "hourly").map(row => [row.bucketStart, row.bucketEnd])).toEqual([
    ["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z"],
    ["2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z"],
  ])
  const converted = new Database(file)
  expect(usageFinancialHistoryAvailable(converted, "example", "2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z", "key")).toBe(true)
  expect(usageFinancialHistoryAvailable(converted, "example", "2026-11-01T06:00:00.000Z", "2026-11-01T07:00:00.000Z", "key")).toBe(false)
  converted.close()
  expect(migrateUsageProjection(file, { timeZone: "America/New_York", apply: true, writersStopped: true }).unchanged).toBe(true)
})

test("memory projection rejects consecutive writes under a changed timezone rather than mixing calendar versions", async () => {
  process.env.STORAGE_BACKEND = "memory"
  await scoped("memory-zone", () => recordUsageEvent(event("first"), null))
  process.env.TIMEZONE = "America/New_York"
  await expect(scoped("memory-zone", () => recordUsageEvent(event("second"), null))).rejects.toThrow("timezone mismatch")
  expect(globalThis.__rawrouteAnalyticsMemory!.get("memory-zone")!.events.size).toBe(1)
})

test("known failed-only history contributes exact zero successful spend even inside partial financial windows", () => {
  const db = legacyDatabase()
  source(db, `${root}/usageRollups`, "failed-only", aggregate({ failedRequests: 2, pricedRequests: 0, gatewayKeyId: undefined }))
  db.close()
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  expect(readBuckets().every(row => row.successfulCostMicros === 0 && row.financialCoveredRequests === 2)).toBe(true)
  const converted = new Database(file)
  expect(usageFinancialHistoryAvailable(converted, "example", "2026-10-01T12:15:00.000Z", "2026-10-01T12:30:00.000Z", "any-key")).toBe(true)
  converted.close()
})

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: token coverage distinguishes normalized missing/partial usage from complete zero`, async () => {
  process.env.STORAGE_BACKEND = backend
  const cases = [
    ["missing", normalizeUsageMetrics(undefined), 0],
    ["partial", normalizeUsageMetrics({ input: 7 }), 0],
    ["complete-zero", normalizeUsageMetrics({ input: 0, output: 0 }), 1],
  ] as const
  await scoped("coverage", async () => {
    for (const [id, usage] of cases) await recordUsageEvent(event(id, { ...usage, gatewayModelId: id }), null)
  })
  const rows = backend === "sqlite" ? readBuckets() : [...globalThis.__rawrouteAnalyticsMemory!.get("coverage")!.projection.values()]
  expect(rows).toHaveLength(6)
  for (const [id, usage, covered] of cases) for (const row of rows.filter(bucket => bucket.gatewayModelId === id)) {
    expect(row).toMatchObject({ tokenCoveredRequests: covered, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, costMicros: 20, successfulCostMicros: 20 })
  }
  const old = { ...event("flagless", normalizeUsageMetrics({ input: 0, output: 0 })) }
  Reflect.deleteProperty(old, "usageAvailable")
  Reflect.deleteProperty(old, "usageCompleteness")
  expect(usageEventMeasures(old).tokenCoveredRequests).toBe(1)
  expect(usageEventMeasures({ ...old, usageAvailable: false }).tokenCoveredRequests).toBe(0)
})

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: fractional duration deletion and correction normalize roundoff without relaxing financial underflow`, async () => {
  process.env.STORAGE_BACKEND = backend
  let memory = new Map<string, UsageBucket>()
  const raw = getSqliteDatabase().collection(`${root}/usageEvents`)
  const write = async (before: UsageEvent | undefined, after: UsageEvent | undefined) => {
    if (backend === "memory") memory = projectMemoryUsage(memory, "example", before ? { ...before } : undefined, after ? { ...after } : undefined)
    else if (after) await raw.doc(after.id).set(after)
    else await raw.doc(before!.id).delete()
  }
  const rows = () => backend === "memory" ? [...memory.values()] : readBuckets()
  const a = event("a", { durationMs: 0.3 })
  const b = event("b", { durationMs: 0.6 })
  await write(undefined, a)
  await write(undefined, b)
  await write(a, undefined)
  await write(b, undefined)
  expect(rows()).toEqual([])

  const zero = event("zero", { durationMs: 0 })
  await write(undefined, a)
  await write(undefined, b)
  await write(undefined, zero)
  await write(a, undefined)
  const corrected = { ...b, durationMs: 0 }
  await write(b, corrected)
  for (const row of rows()) expect(row).toMatchObject({ requests: 2, durationCount: 2, durationSumMs: 0, costMicros: 40, successfulCostMicros: 40 })
  await write(corrected, undefined)
  await write(zero, undefined)
  expect(rows()).toEqual([])

  const bucket = eventUsageBuckets("strict", { ...event("strict", { durationMs: 0.3 }) })[0]!
  expect(() => addUsageBucket(bucket, { ...bucket, costMicros: 21 }, -1)).toThrow("costMicros")
  expect(() => addUsageBucket({ ...bucket, requests: 2, durationCount: 2 }, { ...bucket, durationSumMs: 0.31 }, -1)).toThrow("durationSumMs")
  if (backend === "sqlite") {
    await write(undefined, a)
    const corrupt = new Database(file)
    corrupt.run("UPDATE usage_buckets SET costMicros = 19, successfulCostMicros = 19")
    corrupt.close()
    await expect(write(a, undefined)).rejects.toThrow("CHECK constraint failed")
    expect((await raw.doc(a.id).get()).exists).toBe(true)
  }
})

test("intentional imported raw deletion records an atomic tombstone and rebuild never resurrects its archive", async () => {
  const db = legacyDatabase()
  source(db, "rawroute_usage_events", "deleted", event("deleted"))
  source(db, "rawroute_usage_events", "remaining", event("remaining", { costMicros: 30 }))
  db.close()
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  const raw = getSqliteDatabase().collection("rawroute_workspaces/default/usageEvents")
  const failed = getSqliteDatabase().batch()
  failed.delete(raw.doc("deleted"))
  failed.create(raw.doc("remaining"), event("remaining"))
  await expect(failed.commit()).rejects.toThrow("already exists")
  const check = new Database(file)
  expect(check.query<UsageHistory, []>("SELECT * FROM usage_projection_history WHERE sourcePath LIKE '%/deleted'").get()?.reason).toBe("canonical-copy:rawroute_workspaces/default/usageEvents/deleted")
  check.close()
  await raw.doc("deleted").delete()
  await closeLocalDatabase()
  for (let trial = 0; trial < 2; trial++) expect(migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true }).unchanged).toBe(true)
  const converted = new Database(file)
  const tombstone = converted.query<UsageHistory, []>("SELECT * FROM usage_projection_history WHERE sourcePath LIKE '%/deleted'").get()!
  expect(tombstone).toMatchObject({ disposition: "duplicate", reason: "canonical-copy-deleted:rawroute_workspaces/default/usageEvents/deleted" })
  expect(JSON.parse(tombstone.sourceJson)).toEqual(event("deleted"))
  expect(converted.query("SELECT 1 FROM rawroute_documents WHERE path = ?").get("rawroute_workspaces/default/usageEvents/deleted")).toBeNull()
  expect(converted.query("SELECT 1 FROM rawroute_documents WHERE path = ?").get("rawroute_usage_events/deleted")).not.toBeNull()
  for (const row of readBuckets()) expect(row).toMatchObject({ requests: 1, costMicros: 30, successfulCostMicros: 30 })
  converted.run("DELETE FROM rawroute_documents WHERE path = 'rawroute_workspaces/default/usageEvents/remaining'")
  converted.close()
  expect(() => migrateUsageProjection(file, { timeZone: "UTC" })).toThrow("Imported canonical raw event missing")
})

for (const [kind, usage] of [["missing", normalizeUsageMetrics(undefined)], ["partial", normalizeUsageMetrics({ input: 7 })]] as const) test(`migration deduplicates exact runtime hourly/daily rollups for normalized ${kind} usage without inventing financial uncertainty`, () => {
  const db = legacyDatabase()
  const raw = event(kind, { ...usage })
  source(db, `${root}/usageEvents`, raw.id, raw)
  for (const granularity of ["hourly", "daily"] as const) {
    const bucketStart = granularity === "hourly" ? raw.completedAt : "2026-10-13T00:00:00.000Z"
    const id = `${granularity}:${bucketStart}:${createHash("sha256").update("key:model").digest("hex").slice(0,24)}`
    source(db, `${root}/usageRollups`, id, aggregate({ ...usage, granularity, bucketStart, requests: 1, costMicros: 20, pricedRequests: 1, unpricedRequests: 0, failedRequests: 0, backfillSource: undefined }))
  }
  db.close()
  const dry = migrateUsageProjection(file, { timeZone: "UTC" })
  expect(dry.classifications).toHaveLength(2)
  for (const entry of dry.classifications) expect(entry).toMatchObject({ disposition: "duplicate", reason: "verified-runtime-derived", financialState: "known" })
  migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true })
  expect(readBuckets()).toHaveLength(2)
  for (const row of readBuckets()) expect(row).toMatchObject({ requests: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, tokenCoveredRequests: 0, costMicros: 20, successfulCostMicros: 20, financialCoveredRequests: 1 })
  const converted = new Database(file)
  expect(usageFinancialHistoryAvailable(converted, "example", "2026-10-13T00:00:00.000Z", "2026-10-14T00:00:00.000Z", "key")).toBe(true)
  converted.close()
  expect(migrateUsageProjection(file, { timeZone: "UTC", apply: true, writersStopped: true }).unchanged).toBe(true)
})

test("runtime rollup dedup still rejects absent stored numbers even when their normalized zero sums match", () => {
  const db = legacyDatabase()
  const usage = normalizeUsageMetrics(undefined)
  const raw = event("invalid-number", { ...usage })
  source(db, `${root}/usageEvents`, raw.id, { ...raw, inputTokens: undefined })
  const id = `hourly:${raw.completedAt}:${createHash("sha256").update("key:model").digest("hex").slice(0,24)}`
  source(db, `${root}/usageRollups`, id, aggregate({ ...usage, bucketStart: raw.completedAt, requests: 1, costMicros: 20, pricedRequests: 1, unpricedRequests: 0, failedRequests: 0, backfillSource: undefined }))
  db.close()
  const report = migrateUsageProjection(file, { timeZone: "UTC" })
  expect(report.classifications).toHaveLength(1)
  expect(report.classifications[0]).toMatchObject({ disposition: "excluded", reason: "unproven-aggregate-provenance", financialState: "unknown" })
})
