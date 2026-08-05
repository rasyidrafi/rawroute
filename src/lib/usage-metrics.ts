import type { PricingContextTier } from "@/lib/types"

export interface UsageMetrics {
  input?: number
  output?: number
  cached?: number
  cacheCreation?: number
}

function objectValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numericValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
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
    const cacheCreation = firstNumber(source, ["cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_tokens", "cacheWriteInputTokens"])
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
  const inputTokens = Math.max(0, Math.floor(metrics?.input || 0))
  const outputTokens = Math.max(0, Math.floor(metrics?.output || 0))
  const cacheReadTokens = Math.max(0, Math.floor(metrics?.cached || 0))
  const cacheCreationTokens = Math.max(0, Math.floor(metrics?.cacheCreation || 0))
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens,
    usageAvailable: Boolean(metrics && (metrics.input !== undefined || metrics.output !== undefined || metrics.cached !== undefined || metrics.cacheCreation !== undefined)),
  }
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
    if (usage.inputTokens >= tier.thresholdTokens && (!selectedTier || tier.thresholdTokens > selectedTier.thresholdTokens)) selectedTier = tier
  }
  const rates = selectedTier || pricing
  const billableInput = Math.max(usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens, 0)
  const costMicros = Math.round(
    (billableInput * rates.inputMicrosPerMillion +
      usage.cacheReadTokens * rates.cacheReadMicrosPerMillion +
      usage.cacheCreationTokens * rates.cacheCreationMicrosPerMillion +
      usage.outputTokens * rates.outputMicrosPerMillion) / 1_000_000,
  )
  return { costMicros, pricingConfidence: "exact" as const, pricingContextTier: selectedTier ? `context-${selectedTier.thresholdTokens}` : "standard" }
}
