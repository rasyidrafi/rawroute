import { expect, test } from "bun:test"
import { calculateCostMicros, extractUsageMetrics, normalizeUsageMetrics } from "../../packages/gateway-ai/src/server/usage-metrics"
import { collectStreamUsage } from "../../packages/gateway-ai/src/server/gateway/stream-usage"
import { mergeCatalogServiceTiers, requestServiceTier } from "../../packages/gateway-ai/src/contracts/service-tier"
import { modelsDevPricing } from "../../packages/gateway-ai/src/server/models-dev-pricing"

const rates = (factor: number) => ({ inputMicrosPerMillion: 10_000_000 * factor, outputMicrosPerMillion: 50_000_000 * factor, cacheReadMicrosPerMillion: 1_000_000 * factor, cacheCreationMicrosPerMillion: 0 })
const pricing = { ...rates(1), serviceTiers: [{ serviceTier: "priority", ...rates(2), contextTiers: [] }, { serviceTier: "ultrafast", ...rates(6), contextTiers: [] }] }
const usage = normalizeUsageMetrics({ input: 10000, output: 1000, cached: 0 })

test("non-Standard served tiers control settlement, while Standard preserves the requested tier", () => {
  for (const [tier, cost] of [["priority", 300000], ["ultrafast", 900000]] as const) {
    expect(calculateCostMicros(usage, pricing, { requestedServiceTier: "ultrafast", effectiveServiceTier: tier })).toMatchObject({ costMicros: cost, pricingConfidence: "exact", pricingServiceTier: tier })
  }
  for (const effectiveServiceTier of ["default", "standard"]) {
    for (const [requestedServiceTier, costMicros] of [["priority", 300000], ["ultrafast", 900000]] as const) {
      expect(calculateCostMicros(usage, pricing, { requestedServiceTier, sentServiceTier: "default", effectiveServiceTier })).toMatchObject({ costMicros, pricingConfidence: "assumed", pricingServiceTier: requestedServiceTier })
    }
    for (const requestedServiceTier of [undefined, "auto", "default", "standard"]) {
      expect(calculateCostMicros(usage, pricing, { requestedServiceTier, effectiveServiceTier })).toMatchObject({ costMicros: 150000, pricingConfidence: "exact" })
    }
  }
  expect(calculateCostMicros(usage, pricing, { requestedServiceTier: "default", effectiveServiceTier: "priority" })).toMatchObject({ costMicros: 300000, pricingConfidence: "exact", pricingServiceTier: "priority" })
  expect(calculateCostMicros(usage, pricing, { requestedServiceTier: "ultrafast" })).toMatchObject({ costMicros: 900000, pricingConfidence: "assumed" })
  expect(calculateCostMicros(usage, pricing)).toMatchObject({ costMicros: 150000, pricingConfidence: "assumed" })
  expect(calculateCostMicros(usage, pricing, { effectiveServiceTier: "unknown" })).toMatchObject({ costMicros: 0, pricingConfidence: "unpriced" })
  expect(calculateCostMicros(usage, rates(1), { requestedServiceTier: "priority" })).toMatchObject({ costMicros: 0, pricingConfidence: "unpriced" })
  expect(calculateCostMicros(usage, rates(1), { requestedServiceTier: "priority", effectiveServiceTier: "default" })).toMatchObject({ costMicros: 0, pricingConfidence: "unpriced" })
})

test("Standard responses preserve protocol-normalized Fast and custom tier schedules", () => {
  const requestedServiceTier = requestServiceTier({ service_tier: "fast" }, "openai")
  expect(calculateCostMicros(usage, pricing, { requestedServiceTier, effectiveServiceTier: "default" })).toMatchObject({ costMicros: 300000, pricingServiceTier: "priority" })
  for (const tier of ["fast", "flex", "custom-tier"]) {
    const customPricing = { ...rates(1), serviceTiers: [{ serviceTier: tier, ...rates(3), contextTiers: [] }] }
    expect(calculateCostMicros(usage, customPricing, { requestedServiceTier: tier, effectiveServiceTier: "standard" })).toMatchObject({ costMicros: 450000, pricingConfidence: "assumed", pricingServiceTier: tier })
  }
})

test("JSON and fragmented SSE preserve reported tiers independently of token fields", async () => {
  expect(extractUsageMetrics({ service_tier: "priority", usage: { prompt_tokens: 10, completion_tokens: 2 } })).toEqual({ effectiveServiceTier: "priority", input: 10, output: 2 })
  const text = 'data: {"response":{"service_tier":"priority"}}\n\ndata: {"type":"response.completed","response":{"service_tier":"default","usage":{"input_tokens":10,"output_tokens":2}}}\n\n'
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < text.length; i += 7) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 7))); controller.close() } })
  expect((await collectStreamUsage(stream)).usage).toEqual({ effectiveServiceTier: "default", input: 10, output: 2 })
})

test("provider profiles distinguish Fast aliases from Anthropic Priority capacity", async () => {
  expect(requestServiceTier({ service_tier: "fast" }, "openai")).toBe("priority")
  expect(requestServiceTier({ service_tier: "priority" }, "anthropic")).toBeUndefined()
  expect(requestServiceTier({ service_tier: "priority", speed: "fast" }, "anthropic")).toBe("fast")
  expect(extractUsageMetrics({ service_tier: "fast", usage: { input_tokens: 10 } })).toMatchObject({ effectiveServiceTier: "priority" })
  expect(extractUsageMetrics({ usage: { service_tier: "priority", input_tokens: 10 } }, "anthropic")).toEqual({ input: 10 })
  const text = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"speed":"fast"}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":2,"speed":"standard"}}\n\nevent: message_stop\n\n'
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < text.length; i += 5) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 5))); controller.close() } })
  expect((await collectStreamUsage(stream, "anthropic")).usage).toEqual({ input: 10, output: 2, effectiveServiceTier: "default" })
  expect(calculateCostMicros(usage, pricing, { requestedServiceTier: "ultrafast", sentServiceTier: "priority" })).toMatchObject({ costMicros: 300000, pricingConfidence: "assumed" })
  expect(calculateCostMicros(usage, pricing, { requestedServiceTier: "ultrafast", sentServiceTier: "auto" })).toMatchObject({ costMicros: 150000, pricingConfidence: "assumed" })
})

test("catalog refresh imports available tiers and preserves user-owned schedules", () => {
  const custom = { ...pricing.serviceTiers[0]!, source: "custom" as const, inputMicrosPerMillion: 123 }
  const merged = mergeCatalogServiceTiers([custom], pricing.serviceTiers)
  expect(merged.find(tier => tier.serviceTier === "priority")).toEqual(custom)
  expect(merged.find(tier => tier.serviceTier === "ultrafast")?.source).toBe("catalog")
  expect(mergeCatalogServiceTiers([custom], [])).toEqual([custom])
})

test("catalog speed multipliers remain separate from OpenAI fast aliases", () => {
  const base = { text: { input: { price: 2 }, output: { price: 10 } } }
  const anthropic = modelsDevPricing({ cost: { ...base, multipliers: [{ when: { speed: { equals: "fast" } }, factor: 6 }] } })
  expect(anthropic.serviceTiers).toMatchObject([{ serviceTier: "fast", source: "catalog", inputMicrosPerMillion: 12_000_000 }])
  const openai = modelsDevPricing({ cost: { ...base, multipliers: [{ when: { service_tier: { equals: "fast" } }, factor: 2 }] } })
  expect(openai.serviceTiers).toMatchObject([{ serviceTier: "priority", source: "catalog", inputMicrosPerMillion: 4_000_000 }])
})
