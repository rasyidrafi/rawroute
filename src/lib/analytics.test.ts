import { beforeEach, describe, expect, test, vi } from "vitest"

import { checkBudget, getBudgetAdmission, getBudgetBeyondLimitsSettings, getBudgetRequestState, getBudgetRows, getBudgetWindow, listBudgetBypassSessions, getDashboardPayload, listUsageRollups, recordGatewayUsage, recordUsageEvent, resetAnalyticsForTests, reserveBudgetAdmission, setBudgetBeyondLimitsSettings, setBudgetBypassEnabled, updateBudgetWindow, upsertBudget } from "@/lib/analytics"
import { savePricingVersion, syncModelPricingGroups, listPricingVersions } from "@/lib/model-pricing"
import { createApiKey, _resetMemoryBackend, listModels, listProviders, upsertModel, upsertProvider } from "@/lib/store"
import type { UsageEvent } from "@/lib/types"

type TestPricing = {
  modelId: string
  gatewayModelId: string
  upstreamModel: string
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheCreationMicrosPerMillion: number
}

async function configureTestPricing(input: TestPricing) {
  const separator = input.gatewayModelId.indexOf("/")
  const prefix = separator > 0 ? input.gatewayModelId.slice(0, separator) : "test"
  const provider = (await listProviders()).find((entry) => entry.prefix === prefix)
    || await upsertProvider({ name: prefix, prefix, baseUrl: "https://example.test/v1", protocol: "openai-chat", authType: "none", headers: {}, enabled: true })
  const existing = (await listModels()).find((model) => model.providerId === provider.id && model.gatewayModelId === input.gatewayModelId)
  const model = await upsertModel(provider.id, {
    ...(existing ? { originalId: existing.id } : {}),
    gatewayModelId: input.gatewayModelId,
    name: input.upstreamModel,
    upstreamModel: input.upstreamModel,
    enabled: true,
  })
  const group = (await syncModelPricingGroups()).find((entry) => entry.memberModelIds.includes(model.id))
  if (!group) throw new Error(`Missing pricing group for ${input.gatewayModelId}`)
  const versions = await listPricingVersions(group.id)
  await savePricingVersion({
    groupId: group.id,
    mode: versions.length ? "replace" : "new",
    rates: {
      inputMicrosPerMillion: input.inputMicrosPerMillion,
      outputMicrosPerMillion: input.outputMicrosPerMillion,
      cacheReadMicrosPerMillion: input.cacheReadMicrosPerMillion,
      cacheCreationMicrosPerMillion: input.cacheCreationMicrosPerMillion,
    },
    contextTiers: [],
  })
  return model
}

beforeEach(() => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
})

describe.sequential("usage analytics", () => {
  test("normalizes cache buckets and calculates integer micros", async () => {
    const key = await createApiKey("Analytics")
    await configureTestPricing({ modelId: "model-doc", gatewayModelId: "test/model", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 100_000, cacheCreationMicrosPerMillion: 200_000 })
    await recordGatewayUsage({ gatewayKeyId: key.id, providerModelId: "model-doc", gatewayModelId: "test/model", protocol: "openai-chat", startedAt: "2026-08-05T00:00:00.000Z", status: 200, durationMs: 10, metrics: { input: 100, cached: 20, cacheCreation: 10, output: 5 } })
    const payload = await getDashboardPayload({ preset: "all" })
    expect(payload.summary.requests).toBe(1)
    expect(payload.summary.tokens).toBe(105)
    expect(payload.summary.costMicros).toBe(84)
    expect(payload.summary.pricedRequests).toBe(1)
    expect((await listUsageRollups()).map((rollup) => rollup.granularity).sort()).toEqual(["daily", "hourly"])
  })

  test("settles complete Astra usage from tokens instead of the oversized request estimate", async () => {
    const key = await createApiKey("Astra measured usage")
    const model = await configureTestPricing({
      modelId: "astra-model",
      gatewayModelId: "codex/gpt-6-astra",
      upstreamModel: "gpt-6-astra",
      inputMicrosPerMillion: 10_000_000,
      outputMicrosPerMillion: 50_000_000,
      cacheReadMicrosPerMillion: 1_000_000,
      cacheCreationMicrosPerMillion: 12_500_000,
    })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1_000_000, enabled: true })

    const startedAt = new Date(Date.now() - 10).toISOString()
    const first = await recordGatewayUsage({
      id: "astra-first",
      gatewayKeyId: key.id,
      providerModelId: model.id,
      gatewayModelId: model.gatewayModelId,
      protocol: "openai-responses",
      startedAt,
      status: 200,
      durationMs: 10,
      requestBodyBytes: 119_862,
      metrics: { input: 27_340, cached: 26_368, output: 207 },
      assumedCostMicros: 270_947,
    })
    const second = await recordGatewayUsage({
      id: "astra-second",
      gatewayKeyId: key.id,
      providerModelId: model.id,
      gatewayModelId: model.gatewayModelId,
      protocol: "openai-responses",
      startedAt,
      status: 200,
      durationMs: 10,
      metrics: { input: 26_465, cached: 26_112, output: 37 },
      assumedCostMicros: 263_939,
    })

    expect(first).toMatchObject({
      costMicros: 46_438,
      pricingConfidence: "assumed",
      costSource: "configured-pricing",
      usageCompleteness: "complete",
    })
    expect(second).toMatchObject({
      costMicros: 31_492,
      pricingConfidence: "assumed",
      costSource: "configured-pricing",
      usageCompleteness: "complete",
    })
    expect((await getDashboardPayload({ preset: "all" })).summary).toMatchObject({ costMicros: 77_930, unpricedRequests: 2 })
    expect((await getBudgetRows()).find((row) => row.apiKeyId === key.id)?.spentMicros).toBe(77_930)
  })

  test("keeps complete usage token-based while preserving cache uncertainty", async () => {
    const key = await createApiKey("Cache metadata")
    const model = await configureTestPricing({
      modelId: "cache-metadata-model",
      gatewayModelId: "test/cache-metadata",
      upstreamModel: "cache-metadata",
      inputMicrosPerMillion: 10_000_000,
      outputMicrosPerMillion: 50_000_000,
      cacheReadMicrosPerMillion: 1_000_000,
      cacheCreationMicrosPerMillion: 12_500_000,
    })

    const base = {
      gatewayKeyId: key.id,
      providerModelId: model.id,
      gatewayModelId: model.gatewayModelId,
      protocol: "openai-responses" as const,
      startedAt: new Date().toISOString(),
      status: 200,
      durationMs: 1,
    }
    const explicitZero = await recordGatewayUsage({
      ...base,
      id: "cache-zero",
      metrics: { input: 27_340, cached: 26_368, cacheCreation: 0, output: 207 },
      assumedCostMicros: 999_999,
    })
    const missingRead = await recordGatewayUsage({
      ...base,
      id: "cache-read-missing",
      metrics: { input: 27_340, cacheCreation: 0, output: 207 },
      assumedCostMicros: 999_999,
    })

    expect(explicitZero).toMatchObject({ costMicros: 46_438, pricingConfidence: "exact", costSource: "configured-pricing", usageCompleteness: "complete" })
    expect(missingRead).toMatchObject({ costMicros: 283_750, pricingConfidence: "assumed", costSource: "configured-pricing", usageCompleteness: "complete" })
  })

  test("uses the supplied estimate only for missing or partial successful usage", async () => {
    const key = await createApiKey("Fallback usage")
    const model = await configureTestPricing({
      modelId: "fallback-model",
      gatewayModelId: "test/fallback",
      upstreamModel: "fallback",
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 2_000_000,
      cacheReadMicrosPerMillion: 0,
      cacheCreationMicrosPerMillion: 0,
    })
    const common = {
      gatewayKeyId: key.id,
      providerModelId: model.id,
      gatewayModelId: model.gatewayModelId,
      protocol: "openai-chat" as const,
      startedAt: new Date().toISOString(),
      status: 200,
      durationMs: 1,
      assumedCostMicros: 1_000,
    }

    const partial = await recordGatewayUsage({ ...common, id: "partial-fallback", metrics: { input: 100 } })
    const missing = await recordGatewayUsage({ ...common, id: "missing-fallback", metrics: undefined })

    expect(partial).toMatchObject({ costMicros: 1_000, pricingConfidence: "assumed", costSource: "reservation", usageCompleteness: "partial" })
    expect(missing).toMatchObject({ costMicros: 1_000, pricingConfidence: "assumed", costSource: "reservation", usageCompleteness: "missing" })
  })

  test("keeps failed requests out of pricing-confidence totals", async () => {
    const key = await createApiKey("Failed request")
    await recordGatewayUsage({
      gatewayKeyId: key.id,
      providerModelId: "failed-model",
      gatewayModelId: "failed/model",
      protocol: "openai-chat",
      startedAt: new Date().toISOString(),
      status: 400,
      durationMs: 1,
      metrics: {},
    })

    const payload = await getDashboardPayload({ preset: "all" })
    expect(payload.summary.requests).toBe(1)
    expect(payload.summary.costMicros).toBe(0)
    expect(payload.summary.pricedRequests).toBe(0)
    expect(payload.summary.unpricedRequests).toBe(0)
  })

  test("does not settle a failed request with its supplied estimate", async () => {
    const key = await createApiKey("Failed estimate")
    const model = await configureTestPricing({
      modelId: "failed-estimate-model",
      gatewayModelId: "test/failed-estimate",
      upstreamModel: "failed-estimate",
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 2_000_000,
      cacheReadMicrosPerMillion: 1_000_000,
      cacheCreationMicrosPerMillion: 12_500_000,
    })

    const event = await recordGatewayUsage({
      gatewayKeyId: key.id,
      providerModelId: model.id,
      gatewayModelId: model.gatewayModelId,
      protocol: "openai-chat",
      startedAt: new Date().toISOString(),
      status: 502,
      durationMs: 1,
      metrics: { input: 100, output: 10 },
      assumedCostMicros: 999_999,
    })

    expect(event).toMatchObject({ costMicros: 120, pricingConfidence: "assumed", costSource: "configured-pricing", usageCompleteness: "complete" })
  })

  test("does not bill an estimate when the model is unpriced", async () => {
    const key = await createApiKey("Unpriced model")
    const event = await recordGatewayUsage({
      gatewayKeyId: key.id,
      gatewayModelId: "test/no-pricing",
      protocol: "openai-chat",
      startedAt: new Date().toISOString(),
      status: 200,
      durationMs: 1,
      metrics: { input: 100, output: 10 },
      assumedCostMicros: 999_999,
    })

    expect(event).toMatchObject({ costMicros: 0, pricingConfidence: "unpriced", usageCompleteness: "complete" })
    expect(event.costSource).toBeUndefined()
  })

  test("public dashboard shows key names without exposing credentials", async () => {
    const key = await createApiKey("Public traffic")
    await recordGatewayUsage({ gatewayKeyId: key.id, providerModelId: "public-model", gatewayModelId: "public/model", protocol: "openai-chat", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 1 } })

    const payload = await getDashboardPayload({ preset: "all" }, true)

    expect(payload.keys[0]).toMatchObject({ id: "Public traffic", label: "Public traffic", maskedKey: "hidden" })
    expect(payload.keys[0].id).not.toBe(key.id)
  })

  test("resolves usage pricing even when a key has no budget", async () => {
    const key = await createApiKey("Unbudgeted usage")
    await configureTestPricing({ modelId: "unbudgeted-model", gatewayModelId: "test/unbudgeted", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    const state = await getBudgetRequestState(key.id, "test/unbudgeted", "unbudgeted-model", { model: "test/unbudgeted" }, 64)
    expect(state.pricing).toBeDefined()
    expect(state.usageContext).toBeUndefined()
  })

  test("is idempotent and blocks configured budgets", async () => {
    const key = await createApiKey("Budgeted")
    await configureTestPricing({ modelId: "model-doc", gatewayModelId: "test/model", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
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

  test("allows only selected models past a budget limit and continues counting their usage", async () => {
    const key = await createApiKey("Beyond limit")
    expect(await getBudgetBeyondLimitsSettings()).toMatchObject({ enabled: false, modelIds: [], updatedAt: "" })
    const allowed = await configureTestPricing({ modelId: "allowed-model", gatewayModelId: "test/allowed", upstreamModel: "allowed", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    const blocked = await configureTestPricing({ modelId: "blocked-model", gatewayModelId: "test/blocked", upstreamModel: "blocked", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 100, enabled: true })
    await recordGatewayUsage({ gatewayKeyId: key.id, providerModelId: allowed.id, gatewayModelId: allowed.gatewayModelId, protocol: "openai-chat", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 100 } })

    await setBudgetBeyondLimitsSettings({ enabled: true, modelIds: [allowed.gatewayModelId] })
    expect(await getBudgetBeyondLimitsSettings()).toMatchObject({ enabled: true, modelIds: [allowed.gatewayModelId] })
    await expect(getBudgetAdmission(key.id, allowed.gatewayModelId, allowed.id)).resolves.toBeUndefined()
    await expect(getBudgetAdmission(key.id, blocked.gatewayModelId, blocked.id)).rejects.toThrow("budget")

    await recordGatewayUsage({ gatewayKeyId: key.id, providerModelId: allowed.id, gatewayModelId: allowed.gatewayModelId, protocol: "openai-chat", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 25 } })
    expect((await getBudgetRows()).find((row) => row.apiKeyId === key.id)?.spentMicros).toBe(125)
  })

  test("tracks Unlimited Mode usage from the active session in budgets and usage payloads", async () => {
    const key = await createApiKey("Unlimited usage")
    await configureTestPricing({ modelId: "unlimited-model", gatewayModelId: "test/unlimited", upstreamModel: "unlimited", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 100, enabled: true })
    const activation = await setBudgetBypassEnabled(true)
    await recordGatewayUsage({ gatewayKeyId: key.id, providerModelId: "unlimited-model", gatewayModelId: "test/unlimited", protocol: "openai-chat", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 20 } })

    const budget = (await getBudgetRows()).find((row) => row.apiKeyId === key.id)
    expect(budget?.usageStartAt).toBe(activation.session?.startedAt)
    expect(budget?.spentMicros).toBe(20)

    const payload = await getDashboardPayload({ preset: "all" })
    expect(payload.keys[0].budget).toMatchObject({ bypassLimits: true, spentMicros: 20, usageStartAt: activation.session?.startedAt })
  })

  test("uses active-session events instead of scaling pre-session boundary rollups", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T10:37:12.359Z"))
    try {
      const key = await createApiKey("Boundary usage")
      await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 10_000, enabled: true })
      const event = (id: string, completedAt: string, costMicros: number): UsageEvent => ({
        id,
        gatewayKeyId: key.id,
        gatewayModelId: "boundary/model",
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
      await recordUsageEvent(event("before-session", "2026-08-07T10:20:00.000Z", 400), null)
      const activation = await setBudgetBypassEnabled(true)
      await recordUsageEvent(event("inside-session", "2026-08-07T10:40:00.000Z", 100), null)
      await recordUsageEvent(event("inside-session-2", "2026-08-07T11:05:00.000Z", 200), null)

      const budget = (await getBudgetRows()).find((row) => row.apiKeyId === key.id)
      expect(budget).toMatchObject({ spentMicros: 300, usageStartAt: activation.session?.startedAt })
    } finally {
      await setBudgetBypassEnabled(false)
      vi.useRealTimers()
    }
  })

  test("persists a custom shared budget window", async () => {
    const window = await updateBudgetWindow({ anchor: "custom", start: "2026-08-06T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z" })
    expect(window).toMatchObject({ anchor: "custom", start: "2026-08-06T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z", codexAccountId: null })
    expect((await getBudgetWindow()).anchor).toBe("custom")
  })

  test("recalculates budget usage from historical rollups for custom boundaries", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"))
    try {
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

      await configureTestPricing({ modelId: "historical-model", gatewayModelId: "historical/model", upstreamModel: "historical", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
      await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 700, enabled: true })
      await expect(checkBudget(key.id, "historical/model")).rejects.toThrow("budget")

      await updateBudgetWindow({ anchor: "custom", start: "2026-08-08T10:00:00.000Z", end: "2026-08-08T18:00:00.000Z" })
      expect((await getBudgetRows()).find((budget) => budget.apiKeyId === key.id)?.spentMicros).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  test("uses event records inside partial hourly boundaries", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T08:00:00.000Z"))
    try {
      const key = await createApiKey("Partial boundary")
      await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 10_000, enabled: true })
      await updateBudgetWindow({ anchor: "custom", start: "2026-08-08T09:30:00.000Z", end: "2026-08-08T10:30:00.000Z" })
      const event = (id: string, completedAt: string, costMicros: number): UsageEvent => ({
        id,
        gatewayKeyId: key.id,
        gatewayModelId: "partial/model",
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
        usageCompleteness: "complete",
      })
      await recordUsageEvent(event("before-window", "2026-08-08T09:15:00.000Z", 400), null)
      await recordUsageEvent(event("inside-start-hour", "2026-08-08T09:45:00.000Z", 100), null)
      await recordUsageEvent(event("inside-end-hour", "2026-08-08T10:15:00.000Z", 200), null)

      expect((await getBudgetRows()).find((budget) => budget.apiKeyId === key.id)?.spentMicros).toBe(300)
    } finally {
      vi.useRealTimers()
    }
  })

  test("uses the runtime event ledger when a reset-window rollup briefly lags", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T08:00:00.000Z"))
    try {
      const key = await createApiKey("Rollup lag")
      await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 10_000, enabled: true })
      await updateBudgetWindow({ anchor: "custom", start: "2026-08-08T09:30:00.000Z", end: "2026-08-08T13:00:00.000Z" })
      const event = (id: string, completedAt: string, costMicros: number): UsageEvent => ({
        id,
        gatewayKeyId: key.id,
        gatewayModelId: "lag/model",
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
        usageCompleteness: "complete",
      })
      await recordUsageEvent(event("before-window", "2026-08-08T09:15:00.000Z", 50), null)
      await recordUsageEvent(event("inside-start-hour", "2026-08-08T09:45:00.000Z", 100), null)
      await recordUsageEvent(event("inside-complete-hour", "2026-08-08T10:15:00.000Z", 200), null)
      await recordUsageEvent(event("inside-later-hour", "2026-08-08T11:15:00.000Z", 400), null)

      // Simulate a daily rollup that was advanced before its hourly rows.
      // The historical event ledger is complete, so budget usage must remain
      // the exact $0.000700 rather than retaining only the first partial hour.
      const memory = globalThis.__rawrouteAnalyticsMemory?.get("default")
      const daily = [...(memory?.rollups.values() || [])].find((rollup) => rollup.granularity === "daily" && rollup.gatewayKeyId === key.id)
      if (!daily) throw new Error("Missing daily test rollup")
      daily.requests += 1

      expect((await getBudgetRows()).find((budget) => budget.apiKeyId === key.id)?.spentMicros).toBe(700)
    } finally {
      vi.useRealTimers()
    }
  })

  test("does not reject a request before actual usage reaches the budget", async () => {
    const usageContext = { usageStartAt: "2026-08-08T00:00:00.000Z", windowEnd: "2026-08-15T00:00:00.000Z" }
    const admission = { key: "baseline-test", limitMicros: 1_000, spentMicros: 900, reservationMicros: 50, ttlSeconds: 60 }
    await reserveBudgetAdmission("baseline-key", admission, usageContext)
    await reserveBudgetAdmission("baseline-key", admission, usageContext)
    await reserveBudgetAdmission("baseline-key", admission, usageContext)
    await expect(reserveBudgetAdmission("baseline-key", { ...admission, spentMicros: 1_000 }, usageContext)).rejects.toThrow("budget")
  })

  test("applies the budget at actual 100 percent, not the request estimate", async () => {
    const key = await createApiKey("Actual threshold")
    await configureTestPricing({ modelId: "threshold-model", gatewayModelId: "test/threshold", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 100, enabled: true })

    const usage = (input: number) => recordGatewayUsage({
      gatewayKeyId: key.id,
      providerModelId: "threshold-model",
      gatewayModelId: "test/threshold",
      protocol: "openai-chat",
      startedAt: new Date().toISOString(),
      status: 200,
      durationMs: 1,
      metrics: { input },
    })

    await usage(95)
    const admission = await getBudgetAdmission(key.id, "test/threshold", "threshold-model", { model: "test/threshold", max_output_tokens: 100 }, 64)
    expect(admission?.spentMicros).toBe(95)
    await expect(reserveBudgetAdmission(key.id, admission, { usageStartAt: new Date(Date.now() - 1_000).toISOString(), windowEnd: new Date(Date.now() + 86_400_000).toISOString() })).resolves.toBeDefined()
    expect((await getBudgetRows()).find((row) => row.apiKeyId === key.id)?.spentMicros).toBe(95)

    await usage(5)
    await expect(getBudgetAdmission(key.id, "test/threshold", "threshold-model")).rejects.toThrow("budget")
  })

  test("uses reconciled usage when an existing budget baseline lags the event ledger", async () => {
    const key = await createApiKey("Ledger admission")
    await configureTestPricing({ modelId: "ledger-model", gatewayModelId: "ledger/model", upstreamModel: "ledger", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 10_000, enabled: true })
    const completedAt = new Date().toISOString()
    const event = (id: string, costMicros: number): UsageEvent => ({
      id,
      gatewayKeyId: key.id,
      gatewayModelId: "ledger/model",
      providerModelId: "ledger-model",
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
      usageCompleteness: "complete",
    })
    // Passing an explicit null context simulates imported usage that reached
    // the event ledger without updating the old budget counter.
    await recordUsageEvent(event("ledger-1", 100), null)
    await getBudgetRows()
    await recordUsageEvent(event("ledger-2", 200), null)

    const admission = await getBudgetAdmission(key.id, "ledger/model", "ledger-model")
    expect(admission?.spentMicros).toBe(300)
  })

  test("uses the budget window as an analytics range and preserves custom hours", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T08:00:00.000Z"))
    try {
      await updateBudgetWindow({ anchor: "custom", start: "2026-08-06T09:30:00.000Z", end: "2026-08-13T17:45:00.000Z" })
      const payload = await getDashboardPayload({ preset: "budget" })
      expect(payload.range.label).toBe("Budget window")
      expect(payload.range.from).toBe("2026-08-06T09:30:00.000Z")
      expect(payload.range.to).toBe("2026-08-13T17:45:00.000Z")
    } finally {
      vi.useRealTimers()
    }
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

      const protectedAllTime = await getDashboardPayload({ preset: "all", granularity: "hourly" })
      expect(protectedAllTime.range.granularity).toBe("monthly")

      const weekly = await getDashboardPayload({ preset: "month", granularity: "weekly" })
      expect(weekly.range.granularity).toBe("weekly")
      expect(weekly.trend).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("calculates keys and models exactly inside partial budget-window buckets", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-06T04:00:00.000Z"))
    try {
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
    } finally {
      vi.useRealTimers()
    }
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

  test("starts the next window exactly at the previous end boundary", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-01T09:00:00.000Z"))
    try {
      await updateBudgetWindow({ anchor: "custom", start: "2026-07-01T17:45:00.000Z", end: "2026-07-08T17:45:00.000Z" })
      vi.setSystemTime(new Date("2026-07-08T17:45:00.000Z"))

      const window = await getBudgetWindow()
      expect(window.start).toBe("2026-07-08T17:45:00.000Z")
      expect(window.end).toBe("2026-07-15T17:45:00.000Z")
    } finally {
      vi.useRealTimers()
    }
  })

  test("uses a bounded request reservation when output is capped", async () => {
    const key = await createApiKey("Admission")
    await configureTestPricing({ modelId: "model-doc", gatewayModelId: "test/model", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 10_000, enabled: true })
    const admission = await getBudgetAdmission(key.id, "test/model", "model-doc", { model: "test/model", input: "hello", max_output_tokens: 2 })
    expect(admission?.reservationMicros).toBeLessThan(10_000)
  })

  test("keeps an uncapped request estimate bounded", async () => {
    const key = await createApiKey("Uncapped admission")
    await configureTestPricing({ modelId: "uncapped-model", gatewayModelId: "test/uncapped", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1_000_000, enabled: true })
    const admission = await getBudgetAdmission(key.id, "test/uncapped", "uncapped-model", { model: "test/uncapped", input: "hello" }, 48)
    expect(admission?.reservationMicros).toBeGreaterThan(0)
    expect(admission?.reservationMicros).toBeLessThan(10_000)
  })

  test("keeps request estimate separate from missing-usage cost prediction", async () => {
    const key = await createApiKey("Predicted usage")
    await configureTestPricing({ modelId: "predicted-model", gatewayModelId: "test/predicted", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1_000_000, enabled: true })
    const first = await getBudgetRequestState(key.id, "test/predicted", "predicted-model", { model: "test/predicted" }, 64)
    expect(first.estimatedCostMicros).toBeGreaterThan(0)
    expect(first.admission?.reservationMicros).toBeGreaterThan(0)

    for (const [index, costMicros] of [2_058, 2_060, 2_062].entries()) {
      await recordUsageEvent({
        id: `prediction-sample-${index}`,
        gatewayKeyId: key.id,
        providerModelId: "predicted-model",
        gatewayModelId: "test/predicted",
        protocol: "openai-chat",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 200,
        durationMs: 1,
        inputTokens: 10,
        outputTokens: 2_048,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 2_058,
        costMicros,
        pricingConfidence: "exact",
        usageAvailable: true,
        usageCompleteness: "complete",
      }, null)
    }
    const second = await getBudgetRequestState(key.id, "test/predicted", "predicted-model", { model: "test/predicted" }, 64)
    expect(second.estimatedCostMicros).toBeGreaterThan(first.estimatedCostMicros || 0)
    expect(second.estimatedCostSource).toBe("empirical")
    expect(second.predictionSampleCount).toBe(3)
    expect(second.admission?.reservationMicros).toBeGreaterThan(0)
  })

  test("uses OpenAI/Codex payload history before the generic missing-usage fallback", async () => {
    const key = await createApiKey("Payload calibrated")
    const model = await configureTestPricing({
      modelId: "payload-model",
      gatewayModelId: "gpt-5.6-sol",
      upstreamModel: "gpt-5.6-sol",
      inputMicrosPerMillion: 5_000_000,
      outputMicrosPerMillion: 30_000_000,
      cacheReadMicrosPerMillion: 500_000,
      cacheCreationMicrosPerMillion: 6_250_000,
    })

    for (const sample of [
      { requestBodyBytes: 1_000, input: 250, cached: 225, output: 100 },
      { requestBodyBytes: 2_000, input: 500, cached: 450, output: 200 },
      { requestBodyBytes: 3_000, input: 750, cached: 675, output: 300 },
    ]) {
      await recordGatewayUsage({
        gatewayKeyId: key.id,
        providerModelId: model.id,
        gatewayModelId: "gpt-5.6-sol",
        protocol: "openai-responses",
        startedAt: new Date().toISOString(),
        status: 200,
        durationMs: 1,
        requestBodyBytes: sample.requestBodyBytes,
        metrics: { input: sample.input, cached: sample.cached, cacheCreation: 0, output: sample.output },
      })
    }

    const state = await getBudgetRequestState(key.id, "gpt-5.6-sol", model.id, { model: "gpt-5.6-sol", max_output_tokens: 200 }, 2_000)
    expect(state.estimatedCostSource).toBe("payload-calibrated")
    expect(state.predictionMethod).toBe("openai-codex-payload-calibrated-p50")
    expect(state.predictionSampleCount).toBe(3)
    expect(state.estimatedCostMicros).toBe(6_475)
    expect(state.requestBodyBytes).toBe(2_000)
  })

  test("caps the no-history fallback instead of billing raw request bytes", async () => {
    const key = await createApiKey("Bounded missing usage")
    await configureTestPricing({ modelId: "bounded-missing-model", gatewayModelId: "test/bounded-missing", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 100_000, cacheCreationMicrosPerMillion: 0 })
    const state = await getBudgetRequestState(key.id, "test/bounded-missing", "bounded-missing-model", { model: "test/bounded-missing" }, 100_000_000)
    expect(state.estimatedCostSource).toBe("bounded-formula")
    expect(state.estimatedCostMicros).toBe(2_000_000)
  })

  test("recognizes the chat-completions max_completion_tokens cap", async () => {
    const key = await createApiKey("Completion cap")
    await configureTestPricing({ modelId: "completion-model", gatewayModelId: "test/completion", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1_000_000, enabled: true })
    const admission = await getBudgetAdmission(key.id, "test/completion", "completion-model", { model: "test/completion", messages: [], max_completion_tokens: 3 }, 64)
    expect(admission?.reservationMicros).toBeLessThan(100)
  })

  test("retains the request estimate when successful usage metadata is missing", async () => {
    const key = await createApiKey("Missing usage")
    await configureTestPricing({ modelId: "missing-usage-model", gatewayModelId: "test/missing-usage", upstreamModel: "upstream", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
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
