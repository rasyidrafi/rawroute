import { describe, expect, test } from "vitest"

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
      source: "models.dev",
    }])
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
})
