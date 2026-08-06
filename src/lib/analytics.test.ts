import { beforeEach, describe, expect, test, vi } from "vitest"

import { checkBudget, getBudgetAdmission, getBudgetRows, getBudgetWindow, listBudgetBypassSessions, getDashboardPayload, listUsageRollups, recordGatewayUsage, recordUsageEvent, resetAnalyticsForTests, setBudgetBypassEnabled, updateBudgetWindow, upsertBudget, upsertModelPricing } from "@/lib/analytics"
import { createApiKey, _resetMemoryBackend } from "@/lib/store"
import type { UsageEvent } from "@/lib/types"

beforeEach(() => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
})

describe.sequential("usage analytics", () => {
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

  test("public dashboard shows key names without exposing credentials", async () => {
    const key = await createApiKey("Public traffic")
    await recordGatewayUsage({ gatewayKeyId: key.id, providerModelId: "public-model", gatewayModelId: "public/model", protocol: "openai-chat", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 1 } })

    const payload = await getDashboardPayload({ preset: "all" }, true)

    expect(payload.keys[0]).toMatchObject({ label: "Public traffic", maskedKey: "hidden" })
    expect(payload.keys[0].id).not.toBe(key.id)
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

  test("recalculates budget usage from historical rollups for custom boundaries", async () => {
    const key = await createApiKey("Historical budget")
    const event = (id: string, completedAt: string, costMicros: number): UsageEvent => ({
      id,
      gatewayKeyId: key.id,
      gatewayModelId: "historical/model",
      protocol: "openai-chat",
      startedAt: completedAt,
      completedAt,
      status: 200,
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1,
      costMicros,
      pricingConfidence: "exact",
      usageAvailable: true,
    })

    await recordUsageEvent(event("old-day", "2026-08-07T12:00:00.000Z", 400), null)
    await recordUsageEvent(event("before-start", "2026-08-08T09:00:00.000Z", 50), null)
    await recordUsageEvent(event("inside-start-hour", "2026-08-08T09:45:00.000Z", 100), null)
    await recordUsageEvent(event("inside-complete-hour", "2026-08-08T10:00:00.000Z", 100), null)
    await recordUsageEvent(event("inside-end-hour", "2026-08-08T17:30:00.000Z", 100), null)
    await recordUsageEvent(event("after-end", "2026-08-08T18:00:00.000Z", 50), null)

    await updateBudgetWindow({ anchor: "custom", start: "2026-08-07T09:30:00.000Z", end: "2026-08-09T17:45:00.000Z" })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 10_000, enabled: true })
    expect((await getBudgetRows()).find((budget) => budget.apiKeyId === key.id)?.spentMicros).toBe(800)

    await upsertModelPricing({ modelId: "historical-model", provider: "test", gatewayModelId: "historical/model", upstreamModel: "historical", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 700, enabled: true })
    await expect(checkBudget(key.id, "historical/model")).rejects.toThrow("budget")

    await updateBudgetWindow({ anchor: "custom", start: "2026-08-08T10:00:00.000Z", end: "2026-08-08T18:00:00.000Z" })
    expect((await getBudgetRows()).find((budget) => budget.apiKeyId === key.id)?.spentMicros).toBe(200)
  })

  test("uses the budget window as an analytics range and preserves custom hours", async () => {
    await updateBudgetWindow({ anchor: "custom", start: "2026-08-06T09:30:00.000Z", end: "2026-08-13T17:45:00.000Z" })
    const payload = await getDashboardPayload({ preset: "budget" })
    expect(payload.range.label).toBe("Budget window")
    expect(payload.range.from).toBe("2026-08-06T09:30:00.000Z")
    expect(payload.range.to).toBe("2026-08-13T17:45:00.000Z")
  })

  test("keeps complete preset trend axes and supports weekly grouping", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-06T04:00:00.000Z"))
    try {
      const event = (id: string, completedAt: string): UsageEvent => ({
        id,
        gatewayKeyId: "trend-key",
        gatewayModelId: "trend-model",
        protocol: "openai-chat",
        startedAt: completedAt,
        completedAt,
        status: 200,
        durationMs: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 15,
        costMicros: 100,
        pricingConfidence: "exact",
        usageAvailable: true,
      })
      await recordUsageEvent(event("jan", "2026-01-15T03:00:00.000Z"))
      await recordUsageEvent(event("july", "2026-07-15T03:00:00.000Z"))
      await recordUsageEvent(event("last-week", "2026-07-27T03:00:00.000Z"))
      await recordUsageEvent(event("this-week", "2026-08-03T03:00:00.000Z"))
      await recordUsageEvent(event("today", "2026-08-06T02:00:00.000Z"))

      const today = await getDashboardPayload({ preset: "today" })
      expect(today.trend).toHaveLength(12)
      expect(today.trend[0]).toMatchObject({ label: "00:00", requests: 0 })
      expect(today.trend.at(-1)?.label).toBe("11:00")

      expect((await getDashboardPayload({ preset: "yesterday" })).trend).toHaveLength(24)
      expect((await getDashboardPayload({ preset: "week" })).trend).toHaveLength(4)
      expect((await getDashboardPayload({ preset: "lastWeek" })).trend).toHaveLength(7)
      expect((await getDashboardPayload({ preset: "month" })).trend).toHaveLength(6)
      expect((await getDashboardPayload({ preset: "lastMonth" })).trend).toHaveLength(31)
      expect((await getDashboardPayload({ preset: "year" })).trend).toHaveLength(8)

      const allTime = await getDashboardPayload({ preset: "all" })
      expect(allTime.trend).toHaveLength(8)
      expect(allTime.trend[0]?.label).toContain("Jan")

      const weekly = await getDashboardPayload({ preset: "month", granularity: "weekly" })
      expect(weekly.range.granularity).toBe("weekly")
      expect(weekly.trend).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("calculates keys and models exactly inside partial budget-window buckets", async () => {
    const firstKey = await createApiKey("First key")
    const secondKey = await createApiKey("Second key")
    await updateBudgetWindow({ anchor: "custom", start: "2026-08-04T09:30:00.000Z", end: "2026-08-06T17:45:00.000Z" })

    const event = (id: string, completedAt: string, gatewayKeyId: string, gatewayModelId: string): UsageEvent => ({
      id,
      gatewayKeyId,
      gatewayModelId,
      protocol: "openai-chat",
      startedAt: completedAt,
      completedAt,
      status: 200,
      durationMs: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 15,
      costMicros: 100,
      pricingConfidence: "exact",
      usageAvailable: true,
    })

    await recordUsageEvent(event("before", "2026-08-04T09:00:00.000Z", secondKey.id, "before-model"))
    await recordUsageEvent(event("inside-start", "2026-08-04T10:00:00.000Z", firstKey.id, "start-model"))
    await recordUsageEvent(event("inside-end", "2026-08-06T17:00:00.000Z", secondKey.id, "end-model"))
    await recordUsageEvent(event("after", "2026-08-06T18:00:00.000Z", secondKey.id, "after-model"))

    const payload = await getDashboardPayload({ preset: "budget" })
    expect(payload.summary.requests).toBe(2)
    expect(payload.keys.map((row) => [row.label, row.requests])).toEqual([["First key", 1], ["Second key", 1]])
    expect(payload.models.map((row) => [row.model, row.requests])).toEqual([["start-model", 1], ["end-model", 1]])
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
