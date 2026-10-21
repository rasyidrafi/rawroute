import { expect, test } from "bun:test"
import { calculateCostMicros, extractUsageMetrics, normalizeUsageMetrics } from "../../packages/gateway-ai/src/server/usage-metrics"
import { collectStreamUsage } from "../../packages/gateway-ai/src/server/cliproxy/stream-usage"

const rates = (factor: number) => ({ inputMicrosPerMillion: 10_000_000 * factor, outputMicrosPerMillion: 50_000_000 * factor, cacheReadMicrosPerMillion: 1_000_000 * factor, cacheCreationMicrosPerMillion: 0 })
const pricing = { ...rates(1), serviceTiers: [{ serviceTier: "priority", ...rates(2), contextTiers: [] }, { serviceTier: "ultrafast", ...rates(6), contextTiers: [] }] }
const usage = normalizeUsageMetrics({ input: 10000, output: 1000, cached: 0 })

test("served tier controls settlement, while unreported requested tiers remain assumed", () => {
  for (const [tier, cost] of [["default", 150000], ["priority", 300000], ["ultrafast", 900000]] as const) {
    expect(calculateCostMicros(usage, pricing, { requestedServiceTier: "ultrafast", effectiveServiceTier: tier })).toMatchObject({ costMicros: cost, pricingConfidence: "exact", pricingServiceTier: tier })
  }
  expect(calculateCostMicros(usage, pricing, { requestedServiceTier: "ultrafast" })).toMatchObject({ costMicros: 900000, pricingConfidence: "assumed" })
  expect(calculateCostMicros(usage, pricing)).toMatchObject({ costMicros: 150000, pricingConfidence: "assumed" })
  expect(calculateCostMicros(usage, pricing, { effectiveServiceTier: "unknown" })).toMatchObject({ costMicros: 0, pricingConfidence: "unpriced" })
  expect(calculateCostMicros(usage, rates(1), { requestedServiceTier: "priority" })).toMatchObject({ costMicros: 0, pricingConfidence: "unpriced" })
})

test("JSON and fragmented SSE preserve reported tiers independently of token fields", async () => {
  expect(extractUsageMetrics({ service_tier: "priority", usage: { prompt_tokens: 10, completion_tokens: 2 } })).toEqual({ effectiveServiceTier: "priority", input: 10, output: 2 })
  const text = 'data: {"response":{"service_tier":"priority"}}\n\ndata: {"type":"response.completed","response":{"service_tier":"default","usage":{"input_tokens":10,"output_tokens":2}}}\n\n'
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < text.length; i += 7) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 7))); controller.close() } })
  expect((await collectStreamUsage(stream)).usage).toEqual({ effectiveServiceTier: "default", input: 10, output: 2 })
})
