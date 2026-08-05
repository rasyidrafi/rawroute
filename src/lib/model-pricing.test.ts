import { beforeEach, describe, expect, test } from "bun:test"

import { getPricingAdminData, getPricingForModelAt, resetModelPricingForTests, savePricingVersion, syncModelPricingGroups, updatePricingGroup } from "@/lib/model-pricing"
import { listUsageEvents, recordGatewayUsage } from "@/lib/analytics"
import { _resetMemoryBackend, upsertModel, upsertProvider } from "@/lib/store"
import type { Provider } from "@/lib/types"

beforeEach(() => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetModelPricingForTests()
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
    await recordGatewayUsage({ id: "historical", gatewayKeyId: "key", providerModelId: model.id, gatewayModelId: model.gatewayModelId, protocol: "openai-chat", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 100 } })
    await savePricingVersion({ groupId: group.id, mode: "replace", rates: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await listUsageEvents()).find((event) => event.id === "historical")?.costMicros).toBe(200)
  })
})
