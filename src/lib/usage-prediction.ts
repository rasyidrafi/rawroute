import { calculateCostMicros, normalizeUsageMetrics } from "@/lib/usage-metrics"
import type { PricingContextTier, PricingRates, Protocol } from "@/lib/types"

export const OPENAI_CODEX_PAYLOAD_P50_METHOD = "openai-codex-payload-calibrated-p50" as const
export const OPENAI_CODEX_PAYLOAD_P75_RESERVATION_METHOD = "openai-codex-payload-calibrated-p75-reservation" as const

export type PayloadUsageSample = {
  requestBodyBytes: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  protocol: Protocol
}

export type PayloadPredictionResult = {
  costMicros: number
  sampleCount: number
  method: typeof OPENAI_CODEX_PAYLOAD_P50_METHOD | typeof OPENAI_CODEX_PAYLOAD_P75_RESERVATION_METHOD
  predictedUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
}

export type PayloadPredictionOptions = {
  gatewayModelId: string
  requestBodyBytes: number
  protocol: Protocol
  outputLimit?: number
  defaultOutputTokens: number
  samples: readonly PayloadUsageSample[]
  pricing: PricingRates & { contextTiers?: PricingContextTier[] }
  inputQuantile?: number
  cacheReadQuantile?: number
  cacheCreationQuantile?: number
  outputQuantile?: number
  maximumNeighbors?: number
  minimumSamples?: number
  reservation?: boolean
}

function clampedQuantile(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, Number(value))) : fallback
}

function quantile(values: readonly number[], probability: number, allowZero = true) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0))
    .sort((left, right) => left - right)
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function validInteger(value: number, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function validSample(sample: PayloadUsageSample) {
  return validInteger(sample.requestBodyBytes, 1)
    && validInteger(sample.inputTokens, 1)
    && validInteger(sample.outputTokens)
    && validInteger(sample.cacheReadTokens)
    && validInteger(sample.cacheCreationTokens)
    && sample.cacheReadTokens + sample.cacheCreationTokens <= sample.inputTokens
}

/**
 * The payload estimator is deliberately limited to direct OpenAI model ids
 * and the Codex transport namespace. A provider such as cx/gpt-* may have
 * different tokenization or cache semantics and must use the generic fallback.
 */
export function isOpenAiCodexModel(gatewayModelId: string) {
  const normalized = gatewayModelId.trim().toLowerCase()
  if (normalized.startsWith("codex/")) return normalized.slice("codex/".length).startsWith("gpt-")
  return !normalized.includes("/") && normalized.startsWith("gpt-")
}

function selectedSamples(options: PayloadPredictionOptions) {
  const valid = options.samples.filter(validSample)
  const minimumSamples = Math.max(3, Math.floor(options.minimumSamples || 3))
  if (valid.length < minimumSamples) return []
  const sameProtocol = valid.filter((sample) => sample.protocol === options.protocol)
  const pool = sameProtocol.length >= minimumSamples ? sameProtocol : valid
  const maximumNeighbors = Math.max(minimumSamples, Math.floor(options.maximumNeighbors || 31))
  return pool
    .map((sample) => ({
      sample,
      distance: Math.abs(Math.log(sample.requestBodyBytes / options.requestBodyBytes)),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.min(maximumNeighbors, pool.length))
    .map(({ sample }) => sample)
}

export function predictPayloadCalibratedCost(options: PayloadPredictionOptions): PayloadPredictionResult | undefined {
  if (!isOpenAiCodexModel(options.gatewayModelId) || !validInteger(options.requestBodyBytes, 1)) return undefined
  const samples = selectedSamples(options)
  if (!samples.length) return undefined

  const inputQuantile = clampedQuantile(options.inputQuantile, options.reservation ? 0.75 : 0.5)
  const cacheReadQuantile = clampedQuantile(options.cacheReadQuantile, options.reservation ? 0.25 : 0.5)
  const cacheCreationQuantile = clampedQuantile(options.cacheCreationQuantile, options.reservation ? 0.75 : 0.5)
  const outputQuantile = clampedQuantile(options.outputQuantile, options.reservation ? 0.75 : 0.5)
  const inputRate = quantile(samples.map((sample) => sample.inputTokens / sample.requestBodyBytes), inputQuantile, false)
  const inputTokens = Math.max(1, Math.round(options.requestBodyBytes * inputRate))
  const cacheReadRatio = quantile(samples.map((sample) => sample.cacheReadTokens / sample.inputTokens), cacheReadQuantile)
  const cacheCreationRatio = quantile(samples.map((sample) => sample.cacheCreationTokens / sample.inputTokens), cacheCreationQuantile)
  let cacheReadTokens = Math.min(inputTokens, Math.max(0, Math.floor(inputTokens * cacheReadRatio)))
  let cacheCreationTokens = Math.min(inputTokens - cacheReadTokens, Math.max(0, Math.floor(inputTokens * cacheCreationRatio)))
  if (cacheReadTokens + cacheCreationTokens > inputTokens) {
    cacheReadTokens = Math.min(cacheReadTokens, inputTokens)
    cacheCreationTokens = Math.max(0, inputTokens - cacheReadTokens)
  }
  const outputValues = samples.map((sample) => sample.outputTokens)
  const predictedOutput = outputValues.length ? Math.max(0, Math.round(quantile(outputValues, outputQuantile))) : Math.max(0, Math.floor(options.defaultOutputTokens))
  const outputTokens = validInteger(options.outputLimit || 0, 1) ? Math.min(predictedOutput, options.outputLimit || predictedOutput) : predictedOutput
  const usage = normalizeUsageMetrics({ input: inputTokens, cached: cacheReadTokens, cacheCreation: cacheCreationTokens, output: outputTokens })
  const calculated = calculateCostMicros(usage, options.pricing)
  return {
    costMicros: Math.max(0, calculated.costMicros),
    sampleCount: samples.length,
    method: options.reservation ? OPENAI_CODEX_PAYLOAD_P75_RESERVATION_METHOD : OPENAI_CODEX_PAYLOAD_P50_METHOD,
    predictedUsage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
  }
}
