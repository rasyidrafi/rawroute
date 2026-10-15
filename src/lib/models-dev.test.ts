import { describe, expect, test } from "bun:test"

import { buildModelsDevCanonicalModels, createModelsDevCatalogClient, filterModelsDevCanonicalModels } from "@/lib/models-dev"

describe("models.dev canonical catalog", () => {
  test("normalizes model IDs and pricing into integer micros", () => {
    const models = buildModelsDevCanonicalModels({
      openai: {
        models: {
          "gpt-5": {
            name: "GPT-5",
            family: "gpt",
            cost: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 2.5 },
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
      source: "models.dev",
    }])
  })

  test("imports context tiers, inherits omitted rates, and prefers explicit tiers over the 200k fallback", () => {
    const [model] = buildModelsDevCanonicalModels({ provider: { models: { model: {
      cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 3,
        context_over_200k: { input: 4, output: 15 },
        tiers: [
          { input: 5, tier: { type: "context", size: 272000 } },
          { output: 12, tier: { type: "context", size: 32000 } },
          { input: 99, tier: { type: "other", size: 1000 } },
          { input: 99, tier: { type: "context", size: -1 } },
        ],
      },
    } } } })
    expect(model!.contextTiers.map((tier) => [tier.thresholdTokens, tier.inputMicrosPerMillion, tier.outputMicrosPerMillion, tier.cacheCreationMicrosPerMillion])).toEqual([
      [32000, 2_000_000, 12_000_000, 3_000_000],
      [272000, 5_000_000, 10_000_000, 3_000_000],
    ])
    const [fallback] = buildModelsDevCanonicalModels({ provider: { models: { model: { cost: { input: 2, output: 10, context_over_200k: { input: 4 } } } } } })
    expect(fallback!.contextTiers[0]?.inputMicrosPerMillion).toBe(4_000_000)
    expect(fallback!.contextTiers[0]?.outputMicrosPerMillion).toBe(10_000_000)
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
