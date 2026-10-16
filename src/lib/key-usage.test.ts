import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { getKeyUsagePayload, recordUsageEvent, resetAnalyticsForTests, setBudgetBypassEnabled, updateBudgetWindow, upsertBudget } from "./analytics"
import { closeLocalDatabase } from "./local-db"
import { runInWorkspace } from "./workspace/context"
import { _resetMemoryBackend, createApiKey } from "@/server/store"
import type { UsageEvent } from "./types"
import { GET } from "@/server/routes/api/admin/usage/keys/by-key"

beforeEach(async () => {
  await closeLocalDatabase()
  Object.assign(process.env, { SQLITE_PATH: ":memory:", STORAGE_BACKEND: "memory", NODE_ENV: "test", TIMEZONE: "UTC" })
  _resetMemoryBackend(); resetAnalyticsForTests()
  jest.useFakeTimers(); jest.setSystemTime(new Date("2026-10-16T12:00:00.000Z"))
})
afterEach(async () => { jest.useRealTimers(); await closeLocalDatabase() })

function attempt(id: string, keyId: string, completedAt: string, costMicros: number): UsageEvent {
  return { id, gatewayKeyId: keyId, gatewayModelId: "model", protocol: "openai-chat", startedAt: completedAt, completedAt, status: 200, durationMs: 100, inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 0, totalTokens: 120, costMicros, pricingConfidence: "exact", usageAvailable: true }
}

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: key detail filters all aggregates, coverage and budgets inside its workspace`, async () => {
  process.env.STORAGE_BACKEND = backend
  if (backend === "sqlite") process.env.NODE_ENV = "development"
  let selectedId = ""
  await runInWorkspace({ id: `key-detail-${backend}`, storageMode: "scoped" }, async () => {
    const selected = await createApiKey("Selected user")
    const other = await createApiKey("Other user")
    const quiet = await createApiKey("Quiet user")
    selectedId = selected.id
    await updateBudgetWindow({ anchor: "custom", start: "2026-10-13T12:15:00.000Z", end: "2026-10-20T12:15:00.000Z" })
    await upsertBudget({ apiKeyId: selected.id, weeklyLimitMicros: 1000, enabled: true })
    await upsertBudget({ apiKeyId: other.id, weeklyLimitMicros: 2000, enabled: true })
    for (const [index, at] of ["2026-10-13T12:30:00.000Z", "2026-10-14T10:00:00.000Z", "2026-10-16T11:00:00.000Z"].entries()) {
      await recordUsageEvent(attempt(`selected-${index}`, selected.id, at, (index + 1) * 100), null)
      await recordUsageEvent({ ...attempt(`other-${index}`, other.id, at, 9999), usageAvailable: false, usageCompleteness: "partial", status: 0 }, null)
    }
    const data = await getKeyUsagePayload(selected.id)
    expect(data.summary).toMatchObject({ requests: 3, tokens: 360, costMicros: 600, activeKeys: 1 })
    expect(data.keys).toHaveLength(1)
    expect(data.keys[0]).toMatchObject({ id: selected.id, label: selected.name, maskedKey: "hidden", budget: { enabled: true, spentMicros: 600, remainingMicros: 400, percentUsed: 60 } })
    expect(data.models).toEqual([{ model: "model", requests: 3, tokens: 360, costMicros: 600 }])
    expect(data.trend.reduce((sum, point) => sum + point.costMicros, 0)).toBe(600)
    expect(data.coverage).toMatchObject({ financialUnavailable: false, partial: false, costCoveredRequests: 3, excludedSources: 0 })
    expect(JSON.stringify(data)).not.toContain(selected.key)
    const empty = await getKeyUsagePayload(quiet.id)
    expect(empty.keys[0]).toMatchObject({ id: quiet.id, label: quiet.name, requests: 0 })
    expect(empty.keys[0]?.budget).toBeUndefined()
    expect(empty.summary.costMicros).toBe(0)
    await upsertBudget({ apiKeyId: quiet.id, weeklyLimitMicros: 1000, enabled: false })
    expect((await getKeyUsagePayload(quiet.id)).keys[0]?.budget).toMatchObject({ enabled: false, spentMicros: 0 })
    await setBudgetBypassEnabled(true)
    expect((await getKeyUsagePayload(selected.id)).keys[0]?.budget?.bypassLimits).toBe(true)
    expect((await GET(new Request("http://localhost"), { keyId: selected.id })).status).toBe(200)
    expect((await GET(new Request("http://localhost"), { keyId: "" })).status).toBe(400)
  })
  await runInWorkspace({ id: `other-detail-${backend}`, storageMode: "scoped" }, async () => {
    const data = await getKeyUsagePayload(selectedId)
    expect(data.summary.requests).toBe(0)
    expect(data.keys[0]?.label).toBe(selectedId)
    expect(data.keys[0]?.budget).toBeUndefined()
  })
})
