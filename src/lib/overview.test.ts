import { afterAll, beforeEach, expect, test } from "bun:test"
import { getDashboardPayload, getOverviewPayload, recordUsageEvent, resetAnalyticsForTests, setBudgetBypassEnabled, updateBudgetWindow, upsertBudget } from "./analytics"
import { overviewRange, parseOverviewRange } from "./overview"
import { _resetMemoryBackend, createApiKey } from "@/server/store"
import { runInWorkspace } from "./workspace/context"
import { closeLocalDatabase, getSqliteDatabase, queryLocalUsageDurations } from "./local-db"
import type { UsageEvent } from "./types"
import { startOfZonedDay, startOfZonedHour } from "./timezone"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

const originalNodeEnv = process.env.NODE_ENV
process.env.SQLITE_PATH = ":memory:"
beforeEach(() => {
  process.env.NODE_ENV = "test"
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
})
afterAll(async () => { process.env.NODE_ENV = originalNodeEnv; await closeLocalDatabase() })

const range = { from: "2026-10-13T12:30:00.000Z", to: "2026-10-14T12:30:00.000Z" }
function event(id: string, at: string, extra: Partial<UsageEvent> = {}): UsageEvent {
  return { id, gatewayKeyId: "key", gatewayModelId: "frequent", protocol: "openai-chat", startedAt: at, completedAt: at, status: 200, durationMs: 100, inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 10, totalTokens: 120, costMicros: 10, pricingConfidence: "exact", usageAvailable: true, ...extra }
}

test("only exact rolling ranges are accepted", () => {
  for (const period of ["24h", "7d", "30d"] as const) {
    const selected = overviewRange(period, Date.parse(range.to))
    expect(parseOverviewRange(new URLSearchParams(selected))).toEqual(selected)
    expect(Date.parse(selected.to) - Date.parse(selected.from)).toBe(({ "24h": 1, "7d": 7, "30d": 30 }[period]) * 86_400_000)
  }
  for (const params of ["from=bad&to=bad", `${new URLSearchParams(range)}&from=bad`, `${new URLSearchParams(range)}&preset=today`, new URLSearchParams({ from: range.from, to: "2026-10-13T13:30:00.000Z" }).toString()]) expect(() => parseOverviewRange(new URLSearchParams(params))).toThrow()
})

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: rolling trends include quiet leading buckets and empty ranges without changing totals or all-time Usage`, async () => {
    process.env.STORAGE_BACKEND = backend
    if (backend === "sqlite") process.env.NODE_ENV = "development"
    for (const period of ["24h", "7d", "30d"] as const) {
      await runInWorkspace({ id: `bounded-${backend}-${period}`, storageMode: "scoped" }, async () => {
        const selected = overviewRange(period, Date.parse(range.to))
        const bucketStart = period === "24h" ? startOfZonedHour : startOfZonedDay
        const firstBucket = bucketStart(new Date(selected.from)).toISOString()
        const lastBucket = bucketStart(new Date(Date.parse(selected.to) - 1)).toISOString()
        const expectedBuckets = { "24h": 25, "7d": 8, "30d": 31 }[period]
        const empty = await getOverviewPayload(selected)
        expect(empty.trend).toHaveLength(expectedBuckets)
        expect(empty.trend[0]?.bucketStart).toBe(firstBucket)
        expect(empty.trend.at(-1)?.bucketStart).toBe(lastBucket)
        expect(empty.trend.every(point => point.requests === 0 && point.tokens === 0 && point.costMicros === 0)).toBe(true)
        expect(empty.summary).toMatchObject({ requests: 0, tokens: 0, costMicros: 0 })
        expect((await getDashboardPayload({ preset: "all" })).trend).toEqual([])

        const completedAt = new Date(Date.parse(selected.to) - 3_600_000).toISOString()
        await recordUsageEvent(event("late-first-activity", completedAt), null)
        const populated = await getOverviewPayload(selected)
        expect(populated.trend).toHaveLength(expectedBuckets)
        expect(populated.trend[0]?.bucketStart).toBe(firstBucket)
        expect(populated.trend.at(-1)?.bucketStart).toBe(lastBucket)
        expect(populated.trend[0]).toMatchObject({ requests: 0, tokens: 0, costMicros: 0 })
        expect(populated.summary).toMatchObject({ requests: 1, tokens: 120, costMicros: 10 })
        expect(populated.trend.reduce((totals, point) => ({ requests: totals.requests + point.requests, tokens: totals.tokens + point.tokens, costMicros: totals.costMicros + point.costMicros }), { requests: 0, tokens: 0, costMicros: 0 })).toEqual({ requests: 1, tokens: 120, costMicros: 10 })
        const allTime = await getDashboardPayload({ preset: "all" })
        expect(allTime.trend[0]).toMatchObject({ requests: 1, tokens: 120, costMicros: 10 })
      })
    }
  })

  test(`${backend}: reconciled boundaries, model ranking, cache and weighted durations across more than 25 attempts`, async () => {
    process.env.STORAGE_BACKEND = backend
    if (backend === "sqlite") process.env.NODE_ENV = "development"
    await runInWorkspace({ id: `overview-${backend}`, storageMode: "scoped" }, async () => {
      await recordUsageEvent(event("before", "2026-10-13T12:29:59.999Z"), null)
      await recordUsageEvent(event("start", range.from, { gatewayModelId: "expensive", costMicros: 1_000_000, durationMs: 1000 }), null)
      for (let index = 0; index < 40; index++) await recordUsageEvent(event(`middle-${index}`, "2026-10-14T03:00:00.000Z", { durationMs: index < 30 ? 100 : 2000, status: index < 30 ? 200 : 500 }), null)
      await recordUsageEvent(event("last", "2026-10-14T12:29:59.999Z", { durationMs: 0 }), null)
      await recordUsageEvent(event("end-excluded", range.to), null)
      const payload = await getOverviewPayload(range)
      expect(payload.range.from).toBe(range.from)
      expect(payload.range.to).toBe(range.to)
      expect(payload.summary.requests).toBe(42)
      expect(payload.summary.tokens).toBe(42 * 120)
      expect(payload.summary.costMicros).toBe(1_000_410)
      expect(payload.trend.reduce((sum, point) => sum + point.tokens, 0)).toBe(payload.summary.tokens)
      expect(payload.models.map(model => model.model)).toEqual(["frequent", "expensive"])
      expect(payload.models.map(model => model.requests)).toEqual([41, 1])
      expect(payload.overview).toMatchObject({ inputTokens: 4200, cacheReadTokens: 1680, failedRequests: 10, statusCoveredRequests: 42, durationCount: 42, durationSumMs: 24000 })
      const ordinary = await getDashboardPayload({ preset: "all" })
      expect(ordinary).not.toHaveProperty("overview")
    })
    await runInWorkspace({ id: `other-${backend}`, storageMode: "scoped" }, async () => {
      const empty = await getOverviewPayload(range)
      expect(empty.summary.requests).toBe(0)
      expect(empty.overview.durationCount).toBe(0)
      expect(empty.overview.inputTokens).toBe(0)
    })
  })
}

test("legacy rollups without failure counts do not claim complete success coverage", async () => {
  await recordUsageEvent(event("old", "2026-10-14T03:00:00.000Z"), null)
  for (const row of globalThis.__rawrouteAnalyticsMemory!.get("default")!.rollups.values()) delete row.failedRequests
  const payload = await getOverviewPayload(range)
  expect(payload.summary.requests).toBe(1)
  expect(payload.overview.statusCoveredRequests).toBe(0)
})

test("budgets use their own window and include configured keys with no selected traffic", async () => {
  const key = await createApiKey("Quiet key")
  await updateBudgetWindow({ anchor: "custom", start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" })
  await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1000, enabled: true })
  await recordUsageEvent(event("budget-only", "2026-10-02T03:00:00.000Z", { gatewayKeyId: key.id, costMicros: 300 }), null)
  const payload = await getOverviewPayload(range)
  expect(payload.summary.requests).toBe(0)
  expect(payload.overview.budgets).toEqual([{ id: key.id, name: "Quiet key", enabled: true, limitMicros: 1000, spentMicros: 300 }])
  expect(payload.overview.budgetWindow?.from).toBe("2026-10-01T00:00:00.000Z")
  await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1000, enabled: false })
  expect((await getOverviewPayload(range)).overview.budgets[0]?.enabled).toBe(false)
  await setBudgetBypassEnabled(true)
  expect((await getOverviewPayload(range)).overview.budgetWindow?.bypassLimits).toBe(true)
})

test("SQLite duration aggregate ignores missing, string and negative durations and includes failed attempts", async () => {
  const path = "duration-test/usageEvents"
  const collection = getSqliteDatabase().collection(path)
  for (const [index, durationMs] of [100, 500, null, "100", -1, 0].entries()) await collection.doc(String(index)).set({ completedAt: range.from, status: 500, ...(durationMs === null ? {} : { durationMs }) })
  await collection.doc("end").set({ completedAt: range.to, durationMs: 999 })
  expect(await queryLocalUsageDurations(path, range.from, range.to)).toEqual({ durationCount: 3, durationSumMs: 600 })
})

test("SQLite duration scan uses the collection/time index; required read failures reject Overview", async () => {
  await closeLocalDatabase()
  const directory = mkdtempSync("/tmp/opencode/overview-sql-")
  process.env.SQLITE_PATH = join(directory, "test.sqlite")
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.NODE_ENV = "development"
  try {
    const collection = getSqliteDatabase().collection("plan/usageEvents")
    for (let index = 0; index < 100; index++) await collection.doc(String(index)).set({ completedAt: range.from, durationMs: index })
    const connection = new Database(process.env.SQLITE_PATH)
    try {
      const statement = connection.query<{ detail: string }, [string, string, string]>(`EXPLAIN QUERY PLAN SELECT COUNT(*), SUM(json_extract(data, '$.durationMs')) FROM rawroute_documents
        WHERE collection_path = ?1 AND json_extract(data, '$.completedAt') >= ?2 AND json_extract(data, '$.completedAt') < ?3
        AND json_type(data, '$.durationMs') IN ('integer', 'real') AND json_extract(data, '$.durationMs') >= 0`)
      const plan = statement.all("plan/usageEvents", range.from, range.to)
      statement.finalize()
      expect(plan.map(row => row.detail).join(" ")).toMatch(/SEARCH rawroute_documents USING INDEX rawroute_documents_(collection_completed|request_logs)_idx/)
      expect(await queryLocalUsageDurations("plan/usageEvents", range.from, range.to)).toEqual({ durationCount: 100, durationSumMs: 4950 })
      connection.run("DROP TABLE rawroute_documents")
      await expect(runInWorkspace({ id: "read-failure", storageMode: "scoped" }, () => getOverviewPayload(range))).rejects.toThrow("Overview data unavailable")
    } finally { connection.close() }
  } finally {
    await closeLocalDatabase()
    process.env.SQLITE_PATH = ":memory:"
    rmSync(directory, { recursive: true, force: true })
  }
})
