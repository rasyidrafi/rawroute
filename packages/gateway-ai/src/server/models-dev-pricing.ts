import type { PricingContextTier, PricingRates, PricingServiceTier } from "../contracts/domain"
import { normalizeServiceTier } from "../contracts/service-tier"

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function micros(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) : 0
}

function threshold(value: unknown) {
  const when = record(value)
  if (Object.keys(when).length !== 1) return undefined
  const context = record(when.context)
  if (Object.keys(context).length !== 1) return undefined
  const tokens = typeof context.gt === "number" ? context.gt + 1 : context.gte
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

function overrides(value: Record<string, unknown>) {
  return (Array.isArray(value.overrides) ? value.overrides : []).flatMap(raw => {
    const entry = record(raw)
    const tokens = threshold(entry.when)
    return tokens === undefined ? [] : [{ tokens, entry }]
  }).sort((a, b) => a.tokens - b.tokens)
}

function atContext(value: Record<string, unknown>, tokens: number): Record<string, unknown> {
  const selected = overrides(value).filter(entry => tokens >= entry.tokens).at(-1)?.entry
  return { ...value, ...selected, cache: { ...record(value.cache), ...record(selected?.cache) } }
}

function cacheWrite(value: unknown) {
  if (typeof value === "number") return value
  const rates = record(value)
  // The existing cache-creation rate represents the provider's short TTL.
  return rates["5m"] ?? rates["30m"] ?? rates["1h"] ?? rates["12h"]
}

function ratesAt(cost: Record<string, unknown>, tokens: number): PricingRates {
  const text = record(cost.text)
  const input = atContext(record(text.input), tokens)
  const output = atContext(record(text.output), tokens)
  const cache = record(input.cache)
  return { inputMicrosPerMillion: micros(input.price), outputMicrosPerMillion: micros(output.price), cacheReadMicrosPerMillion: micros(cache.read), cacheCreationMicrosPerMillion: micros(cacheWrite(cache.write)) }
}

function schedule(cost: Record<string, unknown>) {
  const text = record(cost.text)
  const sizes = new Set([...overrides(record(text.input)), ...overrides(record(text.output))].map(entry => entry.tokens))
  const contextTiers: PricingContextTier[] = [...sizes].sort((a, b) => a - b).map(thresholdTokens => ({ id: `models-dev-context-${thresholdTokens}`, thresholdTokens, ...ratesAt(cost, thresholdTokens) }))
  return { ...ratesAt(cost, 0), contextTiers }
}

function scaledRates(rates: PricingRates, factor: number): PricingRates {
  return { inputMicrosPerMillion: Math.round(rates.inputMicrosPerMillion * factor), outputMicrosPerMillion: Math.round(rates.outputMicrosPerMillion * factor), cacheReadMicrosPerMillion: Math.round(rates.cacheReadMicrosPerMillion * factor), cacheCreationMicrosPerMillion: Math.round(rates.cacheCreationMicrosPerMillion * factor) }
}

/** models.dev v2 retains service-tier multipliers, unlike its lossy v1 projection. */
export function modelsDevPricing(detail: Record<string, unknown>) {
  const cost = record(detail.cost)
  const { contextTiers, ...pricing } = schedule(cost)
  const tiers = new Map<string, PricingServiceTier>()
  for (const raw of Array.isArray(cost.multipliers) ? cost.multipliers : []) {
    const multiplier = record(raw)
    const when = record(multiplier.when)
    const rawTier = normalizeServiceTier(record(when.speed).equals ?? record(when.service_tier).equals)
    const serviceTier = when.speed === undefined && rawTier === "fast" ? "priority" : rawTier
    const factor = typeof multiplier.factor === "number" ? multiplier.factor : record(multiplier.factor).text
    if (Object.keys(when).length !== 1 || !serviceTier || typeof factor !== "number" || !Number.isFinite(factor) || factor < 0) continue
    tiers.set(serviceTier, { serviceTier, source: "catalog", ...scaledRates(pricing, factor), contextTiers: contextTiers.map(tier => ({ ...tier, ...scaledRates(tier, factor) })) })
  }
  const modes = record(record(detail.experimental).modes)
  for (const mode of Object.values(modes)) {
    const value = record(mode)
    const speed = value.speed ?? record(value.body).speed
    const rawTier = normalizeServiceTier(speed ?? value.service_tier ?? record(value.body).service_tier)
    const serviceTier = speed === undefined && rawTier === "fast" ? "priority" : rawTier
    if (serviceTier && record(value.cost).text) tiers.set(serviceTier, { serviceTier, source: "catalog", ...schedule(record(value.cost)) })
  }
  return { pricing, contextTiers, serviceTiers: [...tiers.values()].sort((a, b) => a.serviceTier.localeCompare(b.serviceTier)) }
}
