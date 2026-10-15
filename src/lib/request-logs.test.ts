import { afterAll, expect, test } from "bun:test"
import { closeLocalDatabase, getSqliteDatabase, queryLocalRequestLogs } from "./local-db"
import { listRequestLogs, recordUsageEvent } from "./analytics"
import { parseRequestLogQuery, requestLogCursor, type RequestLogQuery } from "./request-logs"
import { runInWorkspace } from "./workspace/context"
import type { UsageEvent } from "./types"
import { GET } from "@/server/routes/api/admin/request-logs"
import type { RequestLogsPage } from "./request-logs"

process.env.SQLITE_PATH = ":memory:"
afterAll(closeLocalDatabase)
const query = { from: "2026-10-14T00:00:00.000Z", to: "2026-10-16T00:00:00.000Z", status: "all", model: "" } satisfies RequestLogQuery
const event = (id: string, changes: Partial<UsageEvent> = {}): UsageEvent => ({ id, gatewayKeyId: "key", gatewayModelId: "model", protocol: "openai-chat", startedAt: query.from, completedAt: "2026-10-15T12:00:00.000Z", status: 200, durationMs: 10, inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 5, costMicros: 10, pricingConfidence: "exact", usageAvailable: true, ...changes })

test("endpoint exposes historical model options from returned rows and filters by their ID", async () => {
  await runInWorkspace({ id: "historical-model-options", storageMode: "scoped" }, async () => {
    await recordUsageEvent(event("historical-one", { gatewayModelId: "removed/model" }), null)
    await recordUsageEvent(event("historical-two", { gatewayModelId: "removed/model" }), null)
    await recordUsageEvent(event("another-model", { gatewayModelId: "shared/model" }), null)
    const params = new URLSearchParams(query)
    const page = await (await GET(new Request(`http://localhost/api/admin/request-logs?${params}`))).json() as RequestLogsPage
    expect(page.models.filter(model => model.id === "removed/model")).toEqual([{ id: "removed/model", name: "removed/model" }])
    expect(page.events.find(row => row.gatewayModelId === "removed/model")?.modelName).toBeNull()
    params.set("model", "removed/model")
    const filtered = await (await GET(new Request(`http://localhost/api/admin/request-logs?${params}`))).json() as RequestLogsPage
    expect(filtered.events.map(row => row.id)).toEqual(["historical-one", "historical-two"])
    expect(filtered.models).toContainEqual({ id: "removed/model", name: "removed/model" })
  })
})

test("SQL keyset pages equal timestamps without gaps and filters before the hard bound", async () => {
  const collection = getSqliteDatabase().collection("history/one/usageEvents")
  for (let i = 0; i < 130; i++) await collection.doc(`id-${String(i).padStart(3, "0")}`).set(event(`id-${i}`, { status: i >= 70 ? 500 : 200, gatewayModelId: i >= 70 ? "late-model" : "model" }))
  const ids: string[] = []
  let pageQuery: RequestLogQuery = query
  for (let page = 0; page < 6; page++) {
    const rows = await queryLocalRequestLogs(collection.path, pageQuery)
    expect(rows).toHaveLength(page < 5 ? 26 : 5)
    ids.push(...rows.slice(0, 25).map(row => row.id))
    if (rows.length <= 25) break
    const last = rows[24]!
    pageQuery = { ...query, after: { at: last.completedAt, id: last.id } }
  }
  expect(ids).toEqual(Array.from({ length: 130 }, (_, i) => `id-${String(i).padStart(3, "0")}`))
  expect(new Set(ids).size).toBe(130)
  const failures = await queryLocalRequestLogs(collection.path, { ...query, status: "failed" })
  expect(failures).toHaveLength(26)
  expect(failures.every(row => row.status === 500)).toBe(true)
  expect((await queryLocalRequestLogs(collection.path, { ...query, model: "late-model" })).every(row => row.gatewayModelId === "late-model")).toBe(true)
  expect(await queryLocalRequestLogs(collection.path, { ...query, model: "late-model" })).toHaveLength(26)
  expect(await queryLocalRequestLogs(collection.path, { ...query, model: "missing" })).toEqual([])
  expect(await queryLocalRequestLogs("history/two/usageEvents", query)).toEqual([])
})

test("SQL cursor crosses timestamp boundaries and excludes the frozen upper bound", async () => {
  const collection = getSqliteDatabase().collection("history/range/usageEvents")
  for (const row of [event("a"), event("b"), event("older", { completedAt: query.from }), event("too-new", { completedAt: query.to })]) await collection.doc(row.id).set(row)
  const rows = await queryLocalRequestLogs(collection.path, { ...query, after: { at: event("b").completedAt, id: "a" } })
  expect(rows.map(row => row.id)).toEqual(["b", "older"])
})

test("invalid ranges, parameters and cursors are rejected and cursors bind workspace and filters", () => {
  const params = () => new URLSearchParams({ ...query })
  const cursor = requestLogCursor(query, "one", event("last"))
  const valid = params(); valid.set("cursor", cursor)
  expect(parseRequestLogQuery(valid, "one").after?.id).toBe("last")
  expect(() => parseRequestLogQuery(valid, "two")).toThrow()
  valid.set("model", "other")
  expect(() => parseRequestLogQuery(valid, "one")).toThrow()
  for (const [key, value] of [["cursor", "!"], ["cursor", ""], ["cursor", "a".repeat(4097)], ["from", "garbage"], ["from", query.to], ["status", "unknown"], ["status", ""], ["limit", "100000"]]) {
    const invalid = params(); invalid.set(key!, value!)
    expect(() => parseRequestLogQuery(invalid, "one")).toThrow()
  }
})

test("memory history is scoped and returns a cursor with the same frozen range", async () => {
  await runInWorkspace({ id: "history-memory", storageMode: "scoped" }, async () => {
    for (let i = 0; i < 55; i++) await recordUsageEvent(event(`memory-${String(i).padStart(3, "0")}`), null)
    const first = await listRequestLogs(query)
    expect(first.events).toHaveLength(25)
    expect(first.nextCursor).not.toBeNull()
    const params = new URLSearchParams({ ...query, cursor: first.nextCursor! })
    const second = await listRequestLogs(parseRequestLogQuery(params, "history-memory"))
    expect(second.events).toHaveLength(25)
    expect(second.nextCursor).not.toBeNull()
    params.set("cursor", second.nextCursor!)
    const third = await listRequestLogs(parseRequestLogQuery(params, "history-memory"))
    expect(third.events).toHaveLength(5)
    expect(third.nextCursor).toBeNull()
    expect([...first.events, ...second.events, ...third.events].map(row => row.id)).toEqual(Array.from({ length: 55 }, (_, i) => `memory-${String(i).padStart(3, "0")}`))
    expect(third.to).toBe(query.to)
    expect(second.to).toBe(query.to)
  })
  await runInWorkspace({ id: "history-empty", storageMode: "scoped" }, async () => { expect((await listRequestLogs(query)).events).toEqual([]) })
})
