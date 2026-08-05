import { beforeEach, describe, expect, test } from "bun:test"

import { checkBudget, getBudgetWindow, listBudgetBypassSessions, getDashboardPayload, listUsageRollups, recordGatewayUsage, resetAnalyticsForTests, setBudgetBypassEnabled, updateBudgetWindow, upsertBudget, upsertModelPricing } from "@/lib/analytics"
import { createApiKey, _resetMemoryBackend } from "@/lib/store"

beforeEach(() => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
})

describe("usage analytics", () => {
  test("normalizes cache buckets and calculates integer micros", async () => {
    const key = await createApiKey("Analytics")
    await upsertModelPricing({ modelId: "model-doc", provider: "test", gatewayModelId: "test/model", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 100_000, cacheCreationMicrosPerMillion: 200_000, enabled: true })
    await recordGatewayUsage({ gatewayKeyId: key.id, providerModelId: "model-doc", gatewayModelId: "test/model", protocol: "openai-chat", startedAt: "2026-08-05T00:00:00.000Z", status: 200, durationMs: 10, metrics: { input: 100, cached: 20, cacheCreation: 10, output: 5 } })
    const payload = await getDashboardPayload({ preset: "all" })
    expect(payload.summary.requests).toBe(1)
    expect(payload.summary.tokens).toBe(105)
    expect(payload.summary.costMicros).toBe(84)
    expect(payload.summary.pricedRequests).toBe(1)
    expect((await listUsageRollups()).map((rollup) => rollup.granularity).sort()).toEqual(["daily", "hourly", "monthly"])
  })

  test("is idempotent and blocks configured budgets", async () => {
    const key = await createApiKey("Budgeted")
    await upsertModelPricing({ modelId: "model-doc", provider: "test", gatewayModelId: "test/model", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1, enabled: true })
    const input = { id: "event-1", gatewayKeyId: key.id, providerModelId: "model-doc", gatewayModelId: "test/model", protocol: "openai-chat" as const, startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 2 } }
    await recordGatewayUsage(input)
    await recordGatewayUsage(input)
    const payload = await getDashboardPayload({ preset: "all" })
    expect(payload.summary.requests).toBe(1)
    await expect(checkBudget(key.id, "test/model", "model-doc")).rejects.toThrow("budget")
  })

  test("records each Unlimited Mode activation as a separate session", async () => {
    const first = await setBudgetBypassEnabled(true)
    expect(first.window.bypassLimits).toBe(true)
    expect(first.session?.endedAt).toBeNull()
    await setBudgetBypassEnabled(false)
    await setBudgetBypassEnabled(true)
    await setBudgetBypassEnabled(false)

    const sessions = await listBudgetBypassSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions.every((session) => session.startedAt && session.endedAt)).toBe(true)
    expect((await getBudgetWindow()).bypassLimits).toBe(false)
  })

  test("persists a custom shared budget window", async () => {
    const window = await updateBudgetWindow({ anchor: "custom", start: "2026-08-06T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z" })
    expect(window).toMatchObject({ anchor: "custom", start: "2026-08-06T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z", codexAccountId: null })
    expect((await getBudgetWindow()).anchor).toBe("custom")
  })

  test("rejects an invalid shared budget window", async () => {
    await expect(updateBudgetWindow({ anchor: "custom", start: "2026-08-13T00:00:00.000Z", end: "2026-08-06T00:00:00.000Z" })).rejects.toThrow("Invalid budget window")
  })
})
