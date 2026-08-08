import type { PricingContextTier } from "@/lib/types"

export interface UsageMetrics {
  input?: number
  output?: number
  cached?: number
  cacheCreation?: number
}

export type UsageCompleteness = "complete" | "partial" | "missing"

function objectValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numericValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function tokenCount(value: number | undefined) {
  if (value === undefined || value < 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

function firstNumber(record: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = numericValue(record?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

export function mergeUsage(current: UsageMetrics | undefined, next: UsageMetrics | undefined) {
  if (!next) return current
  return {
    ...(current || {}),
    ...(next.input !== undefined ? { input: next.input } : {}),
    ...(next.output !== undefined ? { output: next.output } : {}),
    ...(next.cached !== undefined ? { cached: next.cached } : {}),
    ...(next.cacheCreation !== undefined ? { cacheCreation: next.cacheCreation } : {}),
  }
}

export function extractUsageMetrics(payload: Record<string, unknown>): UsageMetrics | undefined {
  const response = objectValue(payload.response) || payload
  const message = objectValue(payload.message)
  const meta = objectValue(payload.meta)
  const metadata = objectValue(payload.metadata)
  const sources = [
    objectValue(response.usage),
    // Some Responses-compatible gateways attach usage beside the response
    // envelope (for example: { response: {...}, usage: {...} }). Keep this
    // fallback even when payload.response exists.
    objectValue(payload.usage),
    objectValue(message?.usage),
    objectValue(meta?.billed_units),
    objectValue(response.usageMetadata),
    objectValue(response.usage_metadata),
    objectValue(payload.metrics),
    objectValue(metadata?.usage),
    objectValue(payload["amazon-bedrock-invocationMetrics"]),
  ].filter((source): source is Record<string, unknown> => Boolean(source))

  let result: UsageMetrics | undefined
  for (const source of sources) {
    let input = firstNumber(source, [
      "input_tokens", "prompt_tokens", "inputTokens", "promptTokenCount", "inputTokenCount", "input_token_count",
    ])
    const output = firstNumber(source, [
      "output_tokens", "completion_tokens", "outputTokens", "candidatesTokenCount", "outputTokenCount", "output_token_count",
    ])
    const inputDetails = objectValue(source.input_tokens_details) || objectValue(source.prompt_tokens_details)
    const cached = firstNumber(inputDetails, ["cached_tokens", "cachedTokens", "cache_read_tokens", "cacheReadTokens"])
      ?? firstNumber(source, [
        "cache_read_input_tokens", "cacheReadInputTokens", "cacheReadInputTokenCount", "cached_content_token_count", "cachedContentTokenCount",
        "prompt_cache_hit_tokens", "cache_read_tokens", "cached_tokens", "cachedTokens", "input_cached_tokens",
      ])
    const cacheCreation = firstNumber(inputDetails, ["cache_write_tokens", "cacheWriteTokens"])
      ?? firstNumber(source, ["cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_tokens", "cacheWriteInputTokens"])
    const anthropicCacheRead = firstNumber(source, ["cache_read_input_tokens", "cacheReadInputTokens"])
    const anthropicCacheCreation = firstNumber(source, ["cache_creation_input_tokens", "cacheCreationInputTokens"])
    if (input !== undefined && (anthropicCacheRead !== undefined || anthropicCacheCreation !== undefined)) {
      input += (anthropicCacheRead || 0) + (anthropicCacheCreation || 0)
    }
    const extracted = {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cached !== undefined ? { cached } : {}),
      ...(cacheCreation !== undefined ? { cacheCreation } : {}),
    }
    if (input !== undefined || output !== undefined || cached !== undefined || cacheCreation !== undefined) {
      result = mergeUsage(result, extracted)
    }
  }
  return result
}

export function normalizeUsageMetrics(metrics: UsageMetrics | undefined) {
  const inputProvided = metrics?.input !== undefined && Number.isFinite(metrics.input) && metrics.input >= 0
  const outputProvided = metrics?.output !== undefined && Number.isFinite(metrics.output) && metrics.output >= 0
  const cacheReadProvided = metrics?.cached !== undefined && Number.isFinite(metrics.cached) && metrics.cached >= 0
  const cacheCreationProvided = metrics?.cacheCreation !== undefined && Number.isFinite(metrics.cacheCreation) && metrics.cacheCreation >= 0
  const inputTokens = tokenCount(inputProvided ? metrics!.input! : undefined)
  const outputTokens = tokenCount(outputProvided ? metrics!.output! : undefined)
  const cacheReadTokens = tokenCount(cacheReadProvided ? metrics!.cached! : undefined)
  const cacheCreationTokens = tokenCount(cacheCreationProvided ? metrics!.cacheCreation! : undefined)
  const usageAvailable = Boolean(metrics && (inputProvided || outputProvided || cacheReadProvided || cacheCreationProvided))
  const normalized = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: Math.min(Number.MAX_SAFE_INTEGER, inputTokens + outputTokens),
    usageAvailable,
    usageCompleteness: !usageAvailable ? "missing" as const : inputProvided && outputProvided ? "complete" as const : "partial" as const,
  }
  // Keep field presence available to the pricing calculation without writing
  // implementation-only flags into every UsageEvent document.
  Object.defineProperties(normalized, {
    cacheReadProvided: { value: cacheReadProvided, enumerable: false },
    cacheCreationProvided: { value: cacheCreationProvided, enumerable: false },
  })
  return normalized
}

export function calculateCostMicros(usage: ReturnType<typeof normalizeUsageMetrics>, pricing: {
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheCreationMicrosPerMillion: number
  contextTiers?: PricingContextTier[]
} | undefined) {
  if (!pricing || !usage.usageAvailable) return { costMicros: 0, pricingConfidence: "unpriced" as const }
  let selectedTier: PricingContextTier | undefined
  for (const tier of pricing.contextTiers || []) {
    if (Number.isSafeInteger(tier.thresholdTokens) && tier.thresholdTokens >= 0 && usage.inputTokens >= tier.thresholdTokens && (!selectedTier || tier.thresholdTokens > selectedTier.thresholdTokens)) selectedTier = tier
  }
  const rates = selectedTier || pricing
  const billableInput = Math.max(usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens, 0)
  const validRate = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
  if (!validRate(rates.inputMicrosPerMillion) || !validRate(rates.outputMicrosPerMillion) || !validRate(rates.cacheReadMicrosPerMillion) || !validRate(rates.cacheCreationMicrosPerMillion)) {
    return { costMicros: 0, pricingConfidence: "unpriced" as const }
  }
  const inputRate = rates.inputMicrosPerMillion
  const outputRate = rates.outputMicrosPerMillion
  const cacheReadRate = rates.cacheReadMicrosPerMillion
  const cacheCreationRate = rates.cacheCreationMicrosPerMillion
  const cacheReadKnown = (usage as { cacheReadProvided?: boolean }).cacheReadProvided === true || cacheReadRate === 0
  const cacheCreationKnown = (usage as { cacheCreationProvided?: boolean }).cacheCreationProvided === true || cacheCreationRate === 0
  const rawCostMicros =
    (billableInput * inputRate +
      usage.cacheReadTokens * cacheReadRate +
      usage.cacheCreationTokens * cacheCreationRate +
      usage.outputTokens * outputRate) / 1_000_000
  const costMicros = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(Number.isFinite(rawCostMicros) ? rawCostMicros : 0)))
  return {
    costMicros,
    // A provider response with only one token side is useful for a lower-bound
    // estimate, but it is not an exact bill. Keeping this distinction prevents
    // missing input/output fields from being silently interpreted as zero.
    pricingConfidence: usage.usageCompleteness === "complete" && cacheReadKnown && cacheCreationKnown ? "exact" as const : "assumed" as const,
    pricingContextTier: selectedTier ? `context-${selectedTier.thresholdTokens}` : "standard",
  }
}
