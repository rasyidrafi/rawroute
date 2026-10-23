import { describe, expect, test } from "bun:test"

import { buildModelsDevCanonicalModels, createModelsDevCatalogClient, filterModelsDevCanonicalModels } from "../../packages/gateway-ai/src/server/models-dev"

describe("models.dev canonical catalog", () => {
  test("normalizes model IDs and pricing into integer micros", () => {
    const models = buildModelsDevCanonicalModels({
      openai: {
        models: {
          "gpt-5": {
            name: "GPT-5",
            family: "gpt",
            cost: { text: { input: { price: 1.25, cache: { read: 0.125, write: 2.5 } }, output: { price: 10 } } },
            limit: { context: 400000 },
          },
        },
      },
    })
    expect(models).toEqual([{
      id: "openai/gpt-5",
      name: "GPT-5",
      provider: "openai",
      family: "gpt",
      pricing: { inputMicrosPerMillion: 1_250_000, outputMicrosPerMillion: 10_000_000, cacheReadMicrosPerMillion: 125_000, cacheCreationMicrosPerMillion: 2_500_000 },
      contextLimit: 400000,
      contextTiers: [],
      serviceTiers: [],
      source: "models.dev",
    }])
  })

  test("imports v2 context conditions with exact boundaries and inherited cache rates", () => {
    const [model] = buildModelsDevCanonicalModels({ provider: { models: { model: {
      cost: { text: { input: { price: 2, cache: { read: 0.2, write: 3 }, overrides: [
        { price: 5, when: { context: { gt: 272000 } } },
        { price: 99, when: { region: { equals: "us" } } },
        { price: 99, when: { context: { gte: -1 } } },
      ] }, output: { price: 10, overrides: [{ price: 12, when: { context: { gte: 32000 } } }] } } },
    } } } })
    expect(model!.contextTiers.map((tier) => [tier.thresholdTokens, tier.inputMicrosPerMillion, tier.outputMicrosPerMillion, tier.cacheCreationMicrosPerMillion])).toEqual([
      [32000, 2_000_000, 12_000_000, 3_000_000],
      [272001, 5_000_000, 12_000_000, 3_000_000],
    ])
  })

  test("provider-scoped IDs prevent reseller collisions regardless of catalog order", () => {
    const providers = { openai: { models: { "gpt-6-astra": { name: "Official", cost: { text: { input: { price: 10 } } } } } }, edenai: { models: { "openai/gpt-6-astra": { name: "Reseller", cost: { text: { input: { price: 99 } } } } } }, openrouter: { models: { "openrouter/auto": { name: "Router" } } } }
    for (const catalog of [providers, Object.fromEntries(Object.entries(providers).reverse())]) {
      const models = buildModelsDevCanonicalModels(catalog)
      expect(models.find(model => model.id === "openai/gpt-6-astra")).toMatchObject({ provider: "openai", pricing: { inputMicrosPerMillion: 10_000_000 } })
      expect(models.find(model => model.id === "edenai/openai/gpt-6-astra")).toMatchObject({ provider: "edenai", pricing: { inputMicrosPerMillion: 99_000_000 } })
      expect(models.some(model => model.id === "openrouter/openrouter/auto")).toBe(true)
    }
  })

  test("imports Fast, Ultrafast and Flex multipliers across context and cache rates", () => {
    const [model] = buildModelsDevCanonicalModels({ openai: { models: { astra: {
      cost: { text: { input: { price: 10, cache: { read: 1, write: 12.5 }, overrides: [{ when: { context: { gt: 272000 } }, price: 20, cache: { read: 2, write: 25 } }] }, output: { price: 50, overrides: [{ when: { context: { gt: 272000 } }, price: 75 }] } }, multipliers: [
        { when: { service_tier: { equals: "priority" } }, factor: 2 }, { when: { service_tier: { equals: "ultrafast" } }, factor: 6 }, { when: { service_tier: { equals: "flex" } }, factor: 0.5 },
        { when: { region: { equals: "us" } }, factor: 1.1 },
      ] },
    } } } })
    expect(model!.serviceTiers).toHaveLength(3)
    expect(model!.serviceTiers?.find(tier => tier.serviceTier === "priority")).toMatchObject({ inputMicrosPerMillion: 20_000_000, outputMicrosPerMillion: 100_000_000, cacheReadMicrosPerMillion: 2_000_000, cacheCreationMicrosPerMillion: 25_000_000, contextTiers: [{ thresholdTokens: 272001, inputMicrosPerMillion: 40_000_000, outputMicrosPerMillion: 150_000_000 }] })
    expect(model!.serviceTiers?.find(tier => tier.serviceTier === "ultrafast")?.contextTiers[0]).toMatchObject({ inputMicrosPerMillion: 120_000_000, outputMicrosPerMillion: 450_000_000 })
  })

  test("imports text-scoped catalog multipliers for GPT-6 Luna including context and cache rates", () => {
    const [model] = buildModelsDevCanonicalModels({ openai: { models: { "gpt-6-luna": {
      cost: { text: { input: { price: 0.1, cache: { read: 0.01, write: 0.125 }, overrides: [{ when: { context: { gt: 272000 } }, price: 0.2, cache: { read: 0.02, write: 0.25 } }] }, output: { price: 0.5, overrides: [{ when: { context: { gt: 272000 } }, price: 0.75 }] } }, multipliers: [
        { when: { service_tier: { equals: "priority" } }, factor: { text: 2 } },
        { when: { service_tier: { equals: "flex" } }, factor: { text: 0.5 } },
        { when: { region: { equals: "us" } }, factor: { text: 1.1 } },
      ] },
    } } } })
    expect(model!.serviceTiers).toEqual([
      { serviceTier: "flex", source: "catalog", inputMicrosPerMillion: 50_000, outputMicrosPerMillion: 250_000, cacheReadMicrosPerMillion: 5_000, cacheCreationMicrosPerMillion: 62_500, contextTiers: [{ id: "models-dev-context-272001", thresholdTokens: 272001, inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 375_000, cacheReadMicrosPerMillion: 10_000, cacheCreationMicrosPerMillion: 125_000 }] },
      { serviceTier: "priority", source: "catalog", inputMicrosPerMillion: 200_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 20_000, cacheCreationMicrosPerMillion: 250_000, contextTiers: [{ id: "models-dev-context-272001", thresholdTokens: 272001, inputMicrosPerMillion: 400_000, outputMicrosPerMillion: 1_500_000, cacheReadMicrosPerMillion: 40_000, cacheCreationMicrosPerMillion: 500_000 }] },
    ])
  })

  test("rejects invalid or non-text multipliers without inventing rates", () => {
    for (const factor of [undefined, null, {}, { image: 2 }, { text: "2" }, { text: -1 }, { text: NaN }, { text: Infinity }, { text: null }, [], "2", -1, NaN, Infinity]) {
      const [model] = buildModelsDevCanonicalModels({ openai: { models: { model: {
        cost: { text: { input: { price: 1 }, output: { price: 2 } }, multipliers: [{ when: { service_tier: { equals: "priority" } }, factor }] },
      } } } })
      expect(model!.serviceTiers).toEqual([])
    }
  })

  test("accepts zero text multipliers but skips compound conditions", () => {
    const [model] = buildModelsDevCanonicalModels({ openai: { models: { model: {
      cost: { text: { input: { price: 1 }, output: { price: 2 } }, multipliers: [
        { when: { service_tier: { equals: "flex" } }, factor: { text: 0 } },
        { when: { service_tier: { equals: "priority" }, region: { equals: "us" } }, factor: { text: 2 } },
      ] },
    } } } })
    expect(model!.serviceTiers).toMatchObject([{ serviceTier: "flex", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }])
    expect(model!.serviceTiers).toHaveLength(1)
  })

  test("ranks multi-token searches by canonical ID and name", () => {
    const models = buildModelsDevCanonicalModels({
      openai: { models: { "gpt-5": { name: "GPT-5" }, "gpt-4o": { name: "GPT-4o" } } },
      anthropic: { models: { "claude-3": { name: "Claude 3" } } },
    })
    expect(filterModelsDevCanonicalModels(models, "openai gpt-5", 10).map((model) => model.id)).toEqual(["openai/gpt-5"])
  })

  test("caches values and deduplicates concurrent catalog loads", async () => {
    let calls = 0
    const client = createModelsDevCatalogClient({
      fetchFn: async () => {
        calls += 1
        return new Response(JSON.stringify({ provider: { models: { model: { name: "Model" } } } }))
      },
      ttlMs: 60_000,
    })
    const [first, second] = await Promise.all([client.getModels(), client.getModels()])
    await client.getModels()
    expect(calls).toBe(1)
    expect(first).toEqual(second)
    client.clear()
    await client.getModels()
    expect(calls).toBe(2)
  })

  test("does not let a cleared in-flight load repopulate the cache", async () => {
    let releaseFirst: ((response: Response) => void) | undefined
    let calls = 0
    const client = createModelsDevCatalogClient({
      ttlMs: 60_000,
      fetchFn: async () => {
        calls += 1
        if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve })
        return new Response(JSON.stringify({ provider: { models: { fresh: { name: "Fresh" } } } }))
      },
    })
    const staleLoad = client.getModels()
    await Promise.resolve()
    client.clear()
    const fresh = await client.getModels()
    releaseFirst?.(new Response(JSON.stringify({ provider: { models: { stale: { name: "Stale" } } } })))
    await staleLoad
    expect(fresh.map((model) => model.id)).toEqual(["provider/fresh"])
    expect((await client.getModels()).map((model) => model.id)).toEqual(["provider/fresh"])
    expect(calls).toBe(2)
  })
})
