import { beforeEach, describe, expect, test, vi } from "vitest"

import { getPricingAdminData, getPricingForModelAt, savePricingVersion, syncModelPricingGroups, updatePricingGroup } from "@/lib/model-pricing"
import { getBudgetAdmission, getBudgetRows, getDashboardPayload, listUsageEvents, listUsageRollups, recordUsageEvent, repriceUsageForGroup, resetAnalyticsForTests, upsertBudget } from "@/lib/analytics"
import { _resetMemoryBackend, createApiKey, upsertAlias, upsertModel, upsertProvider } from "@/lib/store"
import type { Provider, UsageEvent } from "@/lib/types"

beforeEach(() => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
})

function provider(id: string): Partial<Provider> {
  return { id, name: id, prefix: id, baseUrl: "https://example.com/v1", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true }
}

describe("model pricing catalog", () => {
  test("groups matching model names across provider prefixes", async () => {
    const firstProvider = await upsertProvider(provider("cx"))
    const secondProvider = await upsertProvider(provider("cxb"))
    const first = await upsertModel(firstProvider.id, { id: "sol", name: "First label", gatewayModelId: "cx/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const second = await upsertModel(secondProvider.id, { id: "sol", name: "Second label", gatewayModelId: "cxb/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const nested = await upsertModel(firstProvider.id, { id: "poolside/laguna", name: "Laguna", gatewayModelId: "cx/poolside/laguna", upstreamModel: "laguna" })
    const nestedSibling = await upsertModel(secondProvider.id, { id: "poolside/laguna", name: "Different label", gatewayModelId: "cxb/poolside/laguna", upstreamModel: "laguna" })
    const deeper = await upsertModel(firstProvider.id, { id: "other/poolside/laguna", name: "Laguna", gatewayModelId: "cx/other/poolside/laguna", upstreamModel: "laguna" })
    const groups = await syncModelPricingGroups()
    const group = groups.find((entry) => entry.name === "First label")
    const nestedGroup = groups.find((entry) => entry.name === "Laguna")
    expect(group?.kind).toBe("fixed")
    expect(group?.memberModelIds.sort()).toEqual([first.id, second.id].sort())
    expect(nestedGroup?.memberModelIds.sort()).toEqual([nested.id, nestedSibling.id].sort())
    expect(groups.find((entry) => entry.memberModelIds.includes(deeper.id))).toMatchObject({ name: "Laguna" })
  })

  test("groups usage aliases by pricing group and keeps unmapped models visible", async () => {
    const firstProvider = await upsertProvider(provider("cx"))
    const secondProvider = await upsertProvider(provider("cxb"))
    const first = await upsertModel(firstProvider.id, { id: "shared", name: "First label", gatewayModelId: "cx/shared", upstreamModel: "shared" })
    const second = await upsertModel(secondProvider.id, { id: "shared", name: "Second label", gatewayModelId: "cxb/shared", upstreamModel: "shared" })
    const group = (await syncModelPricingGroups()).find((entry) => entry.memberModelIds.includes(first.id))!
    await updatePricingGroup(group.id, [first.id], undefined, "Shared pricing")
    await upsertAlias({ alias: "shared-alias", name: "Shared alias", targetModelId: first.gatewayModelId })

    const key = await createApiKey("Grouped models")
    const completedAt = new Date().toISOString()
    const event = (id: string, gatewayModelId: string, providerModelId: string, costMicros: number): UsageEvent => ({
      id,
      gatewayKeyId: key.id,
      providerModelId,
      gatewayModelId,
      protocol: "openai-chat",
      startedAt: completedAt,
      completedAt,
      status: 200,
      durationMs: 1,
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 10,
      costMicros,
      pricingConfidence: "exact",
      usageAvailable: true,
      usageCompleteness: "complete",
    })
    await recordUsageEvent(event("grouped-model", first.gatewayModelId, first.id, 100))
    await recordUsageEvent(event("grouped-alias", "shared-alias", first.id, 100))
    await recordUsageEvent(event("unmapped-model", second.gatewayModelId, second.id, 50))

    const payload = await getDashboardPayload({ preset: "all" })
    expect(payload.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "Shared pricing", requests: 2, costMicros: 200 }),
      expect.objectContaining({ model: second.gatewayModelId, requests: 1, costMicros: 50 }),
    ]))
    expect(payload.models.map((model) => model.model)).not.toContain(first.gatewayModelId)
    expect(payload.models.map((model) => model.model)).not.toContain("shared-alias")
    expect(payload.keys[0].models).toEqual(expect.arrayContaining(["Shared pricing", second.gatewayModelId]))
  })

  test("does not rewrite unchanged fixed groups during synchronization", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"))
    try {
      const providerEntry = await upsertProvider(provider("cx"))
      await upsertModel(providerEntry.id, { id: "stable", name: "Stable", gatewayModelId: "cx/stable", upstreamModel: "stable" })
      const first = (await syncModelPricingGroups()).find((group) => group.name === "Stable")!
      vi.advanceTimersByTime(60_000)
      const second = (await syncModelPricingGroups()).find((group) => group.id === first.id)!
      expect(second.updatedAt).toBe(first.updatedAt)
    } finally {
      vi.useRealTimers()
    }
  })

  test("supports fixed-group exclusions and context-aware versions", async () => {
    const providerEntry = await upsertProvider(provider("cx"))
    const secondProvider = await upsertProvider(provider("cxb"))
    const first = await upsertModel(providerEntry.id, { id: "first", name: "First", gatewayModelId: "cx/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const second = await upsertModel(secondProvider.id, { id: "second", name: "Second", gatewayModelId: "cxb/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const group = (await syncModelPricingGroups()).find((entry) => entry.name === "First")!
    await updatePricingGroup(group.id, [first.id])
    const result = await savePricingVersion({ groupId: group.id, mode: "new", rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 100_000, cacheCreationMicrosPerMillion: 200_000 }, contextTiers: [{ id: "long", thresholdTokens: 32_000, inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 4_000_000, cacheReadMicrosPerMillion: 200_000, cacheCreationMicrosPerMillion: 400_000 }] })
    expect(result.version.contextTiers[0].thresholdTokens).toBe(32_000)
    const data = await getPricingAdminData()
    expect(data.ungroupedModels.map((model) => model.id)).toContain(second.id)
    const pricing = await getPricingForModelAt({ gatewayModelId: first.gatewayModelId, providerModelId: first.id })
    expect(pricing?.pricingVersionId).toBe(result.version.id)
  })

  test("keeps a manually added model in another fixed group after refresh", async () => {
    const firstProvider = await upsertProvider(provider("cx"))
    const secondProvider = await upsertProvider(provider("cxb"))
    const first = await upsertModel(firstProvider.id, { id: "first", name: "First", gatewayModelId: "cx/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const second = await upsertModel(secondProvider.id, { id: "second", name: "Second", gatewayModelId: "cxb/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const other = await upsertModel(firstProvider.id, { id: "other", name: "Other", gatewayModelId: "cx/gpt-4.1", upstreamModel: "gpt-4.1" })
    const groups = await syncModelPricingGroups()
    const source = groups.find((group) => group.memberModelIds.includes(second.id))!
    const target = groups.find((group) => group.memberModelIds.includes(other.id))!

    await updatePricingGroup(source.id, [first.id])
    expect((await getPricingAdminData()).ungroupedModels.map((model) => model.id)).toContain(second.id)
    await updatePricingGroup(target.id, [other.id, second.id], undefined, "Shared models")
    await syncModelPricingGroups()

    const refreshed = await getPricingAdminData()
    expect(refreshed.groups.find((group) => group.id === target.id)?.memberModelIds).toContain(second.id)
    expect(refreshed.groups.find((group) => group.id === source.id)?.memberModelIds).not.toContain(second.id)
    expect(refreshed.groups.find((group) => group.id === target.id)?.name).toBe("Shared models")
  })

  test("persists a custom canonical link without fetching the catalog", async () => {
    const providerEntry = await upsertProvider(provider("cx"))
    const model = await upsertModel(providerEntry.id, { id: "first", name: "First", gatewayModelId: "cx/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const group = (await syncModelPricingGroups()).find((entry) => entry.memberModelIds.includes(model.id))!
    await updatePricingGroup(group.id, [model.id], { id: "vendor/gpt-5.6-sol", source: "custom" })
    const saved = (await getPricingAdminData()).groups.find((entry) => entry.id === group.id)!
    expect(saved.canonicalModelId).toBe("vendor/gpt-5.6-sol")
    expect(saved.canonicalSource).toBe("custom")
    expect(saved.canonicalModel).toBeNull()
  })

  test("replaces current pricing and reprices matching historical events", async () => {
    const providerEntry = await upsertProvider(provider("cx"))
    const model = await upsertModel(providerEntry.id, { id: "first", name: "First", gatewayModelId: "cx/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const group = (await syncModelPricingGroups()).find((entry) => entry.name === "First")!
    await savePricingVersion({ groupId: group.id, mode: "new", rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
    const completedAt = new Date(Date.now() - 3_600_000).toISOString()
    const key = await createApiKey("Historical")
    const historical: UsageEvent = { id: "historical", gatewayKeyId: key.id, providerModelId: model.id, gatewayModelId: model.gatewayModelId, protocol: "openai-chat", startedAt: completedAt, completedAt, status: 200, durationMs: 1, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 100, costMicros: 0, pricingConfidence: "unpriced", usageAvailable: true, usageCompleteness: "complete" }
    await upsertBudget({ apiKeyId: key.id, weeklyLimitMicros: 1_000_000, enabled: true })
    await recordUsageEvent(historical)
    const admissionBeforeRepricing = await getBudgetAdmission(key.id, model.gatewayModelId, model.id)
    const replacement = await savePricingVersion({ groupId: group.id, mode: "replace", rates: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
    await repriceUsageForGroup(replacement.job!.id)

    const event = (await listUsageEvents()).find((entry) => entry.id === historical.id)
    expect(event).toMatchObject({ costMicros: 200, pricingConfidence: "exact", pricingGroupId: group.id, pricingVersionId: replacement.version.id })
    expect((await listUsageRollups("hourly")).reduce((total, rollup) => total + rollup.costMicros, 0)).toBe(200)
    expect((await getDashboardPayload({ preset: "all" })).summary.costMicros).toBe(200)
    expect((await getBudgetRows()).find((budget) => budget.apiKeyId === key.id)?.spentMicros).toBe(200)
    const admissionAfterRepricing = await getBudgetAdmission(key.id, model.gatewayModelId, model.id)
    expect(admissionAfterRepricing?.key).not.toBe(admissionBeforeRepricing?.key)
  })

  test("keeps requests without recorded usage unpriced during repricing", async () => {
    const providerEntry = await upsertProvider(provider("cx"))
    const model = await upsertModel(providerEntry.id, { id: "first", name: "First", gatewayModelId: "cx/gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" })
    const group = (await syncModelPricingGroups()).find((entry) => entry.name === "First")!
    await savePricingVersion({ groupId: group.id, mode: "new", rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
    const completedAt = new Date(Date.now() - 3_600_000).toISOString()
    await recordUsageEvent({ id: "missing-usage", gatewayKeyId: "key", providerModelId: model.id, gatewayModelId: model.gatewayModelId, protocol: "openai-chat", startedAt: completedAt, completedAt, status: 200, durationMs: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costMicros: 0, pricingConfidence: "unpriced", usageAvailable: false })
    const replacement = await savePricingVersion({ groupId: group.id, mode: "replace", rates: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
    await repriceUsageForGroup(replacement.job!.id)

    expect((await listUsageEvents()).find((event) => event.id === "missing-usage")).toMatchObject({ costMicros: 0, pricingConfidence: "unpriced", pricingVersionId: replacement.version.id })
  })
})
