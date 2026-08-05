import { beforeEach, describe, expect, test } from "vitest"

import { checkBudget, getBudgetAdmission, getBudgetRows, getBudgetWindow, listBudgetBypassSessions, getDashboardPayload, listUsageRollups, recordGatewayUsage, resetAnalyticsForTests, setBudgetBypassEnabled, updateBudgetWindow, upsertBudget, upsertModelPricing } from "@/lib/analytics"
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

  test("tracks Unlimited Mode usage from the active session in budgets and usage payloads", async () => {
    const key = await createApiKey("Unlimited usage")
    await upsertModelPricing({ modelId: "unlimited-model", provider: "test", gatewayModelId: "test/unlimited", upstreamModel: "unlimited", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 100, enabled: true })
    const activation = await setBudgetBypassEnabled(true)
    await recordGatewayUsage({ gatewayKeyId: key.id, providerModelId: "unlimited-model", gatewayModelId: "test/unlimited", protocol: "openai-chat", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 20 } })

    const budget = (await getBudgetRows()).find((row) => row.apiKeyId === key.id)
    expect(budget?.usageStartAt).toBe(activation.session?.startedAt)
    expect(budget?.spentMicros).toBe(20)

    const payload = await getDashboardPayload({ preset: "all" })
    expect(payload.keys[0].budget).toMatchObject({ bypassLimits: true, spentMicros: 20, usageStartAt: activation.session?.startedAt })
  })

  test("persists a custom shared budget window", async () => {
    const window = await updateBudgetWindow({ anchor: "custom", start: "2026-08-06T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z" })
    expect(window).toMatchObject({ anchor: "custom", start: "2026-08-06T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z", codexAccountId: null })
    expect((await getBudgetWindow()).anchor).toBe("custom")
  })

  test("uses the budget window as an analytics range and preserves custom hours", async () => {
    await updateBudgetWindow({ anchor: "custom", start: "2026-08-06T09:30:00.000Z", end: "2026-08-13T17:45:00.000Z" })
    const payload = await getDashboardPayload({ preset: "budget" })
    expect(payload.range.label).toBe("Budget window")
    expect(payload.range.from).toBe("2026-08-06T09:30:00.000Z")
    expect(payload.range.to).toBe("2026-08-13T17:45:00.000Z")
  })

  test("rejects an invalid shared budget window", async () => {
    await expect(updateBudgetWindow({ anchor: "custom", start: "2026-08-13T00:00:00.000Z", end: "2026-08-06T00:00:00.000Z" })).rejects.toThrow("Invalid budget window")
  })

  test("advances an expired budget window before it is used", async () => {
    await updateBudgetWindow({ anchor: "custom", start: "2026-07-01T09:30:00.000Z", end: "2026-07-08T17:45:00.000Z" })
    const window = await getBudgetWindow()
    expect(Date.parse(window.end)).toBeGreaterThan(Date.now())
    expect(window.start).not.toBe("2026-07-01T09:30:00.000Z")
  })

  test("uses a bounded request reservation when output is capped", async () => {
    const key = await createApiKey("Admission")
    await upsertModelPricing({ modelId: "model-doc", provider: "test", gatewayModelId: "test/model", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 10_000, enabled: true })
    const admission = await getBudgetAdmission(key.id, "test/model", "model-doc", { model: "test/model", input: "hello", max_output_tokens: 2 })
    expect(admission?.reservationMicros).toBeLessThan(10_000)
  })

  test("uses a conservative bounded reservation for uncapped requests", async () => {
    const key = await createApiKey("Uncapped admission")
    await upsertModelPricing({ modelId: "uncapped-model", provider: "test", gatewayModelId: "test/uncapped", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1_000_000, enabled: true })
    const admission = await getBudgetAdmission(key.id, "test/uncapped", "uncapped-model", { model: "test/uncapped", input: "hello" }, 48)
    expect(admission?.reservationMicros).toBeGreaterThan(0)
    expect(admission?.reservationMicros).toBeLessThan(10_000)
  })

  test("recognizes the chat-completions max_completion_tokens cap", async () => {
    const key = await createApiKey("Completion cap")
    await upsertModelPricing({ modelId: "completion-model", provider: "test", gatewayModelId: "test/completion", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1_000_000, enabled: true })
    const admission = await getBudgetAdmission(key.id, "test/completion", "completion-model", { model: "test/completion", messages: [], max_completion_tokens: 3 }, 64)
    expect(admission?.reservationMicros).toBeLessThan(100)
  })

  test("retains the conservative reservation when successful usage metadata is missing", async () => {
    const key = await createApiKey("Missing usage")
    await upsertModelPricing({ modelId: "missing-usage-model", provider: "test", gatewayModelId: "test/missing-usage", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1_000_000, enabled: true })
    const admission = await getBudgetAdmission(key.id, "test/missing-usage", "missing-usage-model", { model: "test/missing-usage", input: "hello", max_output_tokens: 4 }, 64)
    expect(admission?.reservationMicros).toBeGreaterThan(0)

    await recordGatewayUsage({
      gatewayKeyId: key.id,
      providerModelId: "missing-usage-model",
      gatewayModelId: "test/missing-usage",
      protocol: "openai-chat",
      startedAt: new Date().toISOString(),
      status: 200,
      durationMs: 1,
      assumedCostMicros: admission?.reservationMicros,
    })

    const budget = (await getBudgetRows()).find((row) => row.apiKeyId === key.id)
    expect(budget?.spentMicros).toBe(admission?.reservationMicros)
    const payload = await getDashboardPayload({ preset: "all" })
    expect(payload.summary.costMicros).toBe(admission?.reservationMicros)
    expect(payload.summary.unpricedRequests).toBe(1)
  })
})
