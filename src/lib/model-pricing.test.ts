import { beforeEach, describe, expect, test } from "vitest"

import { getPricingAdminData, getPricingForModelAt, savePricingVersion, syncModelPricingGroups, updatePricingGroup } from "@/lib/model-pricing"
import { getBudgetRows, getDashboardPayload, listUsageEvents, listUsageRollups, recordUsageEvent, repriceUsageForGroup, resetAnalyticsForTests, upsertBudget } from "@/lib/analytics"
import { _resetMemoryBackend, upsertModel, upsertProvider } from "@/lib/store"
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
    const historical: UsageEvent = { id: "historical", gatewayKeyId: "key", providerModelId: model.id, gatewayModelId: model.gatewayModelId, protocol: "openai-chat", startedAt: completedAt, completedAt, status: 200, durationMs: 1, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 100, costMicros: 0, pricingConfidence: "unpriced", usageAvailable: true }
    await upsertBudget({ apiKeyId: "key", weeklyLimitMicros: 1_000_000, enabled: true })
    await recordUsageEvent(historical)
    const replacement = await savePricingVersion({ groupId: group.id, mode: "replace", rates: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
    await repriceUsageForGroup(replacement.job!.id)

    const event = (await listUsageEvents()).find((entry) => entry.id === historical.id)
    expect(event).toMatchObject({ costMicros: 200, pricingConfidence: "exact", pricingGroupId: group.id, pricingVersionId: replacement.version.id })
    expect((await listUsageRollups("hourly")).reduce((total, rollup) => total + rollup.costMicros, 0)).toBe(200)
    expect((await getDashboardPayload({ preset: "all" })).summary.costMicros).toBe(200)
    expect((await getBudgetRows()).find((budget) => budget.apiKeyId === "key")?.spentMicros).toBe(200)
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
