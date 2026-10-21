import type { UsageEvent } from "@rawroute/gateway-ai/contracts"
import { maintainCanonicalUsage, maintenanceArguments, type CanonicalEventDocument, type UsageRepair } from "./migrations/usage-maintenance"

const methods = new Set(["same-key-model-p25", "pooled-model-p25", "default-model-shrunk-p25"])
const modelKey = (value: string) => value.trim().toLowerCase().replace(/^(?:codex|cx)\//, "")
const localKey = (workspace: string, event: UsageEvent) => `${workspace}\u0000${event.gatewayKeyId}\u0000${modelKey(event.gatewayModelId)}`
const numeric = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0

function quantile(values: number[], probability: number) {
  const sorted = values.filter(value => Number.isSafeInteger(value) && value > 0).sort((a,b) => a-b)
  if (!sorted.length) return 0
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * probability))
  const lower = Math.floor(position); const upper = Math.ceil(position)
  return Math.round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower))
}

/** Same empirical quantile/prior policy; canonical raw events are the sole input. */
export function predictMissingUsageCosts(documents: CanonicalEventDocument[], from: string, to: string): UsageRepair[] {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || to <= from) throw new Error("Invalid --from/--to range")
  const probability = 0.25
  const strength = 500
  const minimum = 30
  const local = new Map<string, number[]>()
  const defaults = new Map<string, number[]>()
  const global = new Map<string, number[]>()
  const add = (map: Map<string, number[]>, key: string, cost: number) => { const values = map.get(key) || []; values.push(cost); map.set(key, values) }
  for (const { workspaceId, event } of documents) {
    const cost = Math.round(numeric(event.costMicros))
    if (!Number.isFinite(Date.parse(event.completedAt)) || !Number.isInteger(event.status) || event.status < 200 || event.status >= 300 || event.pricingConfidence !== "exact" || event.usageAvailable !== true || !Number.isSafeInteger(cost) || cost <= 0 || typeof event.gatewayModelId !== "string" || !event.gatewayModelId) continue
    add(local, localKey(workspaceId, event), cost)
    add(global, modelKey(event.gatewayModelId), cost)
    if (workspaceId === "default") add(defaults, modelKey(event.gatewayModelId), cost)
  }
  const updates: UsageRepair[] = []
  for (const { path, workspaceId, event } of documents) {
    if (!Number.isInteger(event.status) || event.status < 200 || event.status >= 300 || event.completedAt < from || event.completedAt >= to || typeof event.gatewayModelId !== "string" || !event.gatewayModelId) continue
    if (event.costSource === "provider-recorded" || (event.costSource === "empirical" && methods.has(event.predictionMethod || "")) || (event.usageAvailable === true && event.usageCompleteness !== "missing") || !["unpriced", "assumed"].includes(event.pricingConfidence)) continue
    const localValues = local.get(localKey(workspaceId, event)) || []
    const defaultValues = defaults.get(modelKey(event.gatewayModelId)) || []
    const globalValues = global.get(modelKey(event.gatewayModelId)) || []
    const baseline = defaultValues.length >= minimum ? defaultValues : globalValues.length >= minimum ? globalValues : undefined
    const localValue = localValues.length >= 3 ? quantile(localValues, probability) : 0
    let cost: number
    let method: NonNullable<UsageEvent["predictionMethod"]>
    let samples: number
    if (baseline) {
      const weight = Math.min(0.35, localValues.length / (localValues.length + strength))
      const prior = quantile(baseline, probability)
      cost = Math.max(1, Math.round(prior * (1 - weight) + (localValue || prior) * weight))
      method = localValue ? "default-model-shrunk-p25" : "pooled-model-p25"
      samples = baseline.length + (localValue ? localValues.length : 0)
    } else if (localValue > 0) {
      cost = localValue; method = "same-key-model-p25"; samples = localValues.length
    } else if (globalValues.length >= 3) {
      cost = quantile(globalValues, probability); method = "pooled-model-p25"; samples = globalValues.length
    } else continue
    updates.push({ path, event: { ...event, costMicros: cost, pricingConfidence: "assumed", costSource: "empirical", usageCompleteness: event.usageCompleteness || "missing", predictionMethod: method, predictionSampleCount: samples } })
  }
  return updates
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const { file, options } = maintenanceArguments(args)
  const from = new Date(args.find(arg => arg.startsWith("--from="))?.slice(7) || "2026-08-07T00:00:00.000Z").toISOString()
  const to = new Date(args.find(arg => arg.startsWith("--to="))?.slice(5) || "2026-08-09T00:00:00.000Z").toISOString()
  let before = 0; let after = 0
  const result = maintainCanonicalUsage(file, options, events => {
    const repairs = predictMissingUsageCosts(events, from, to)
    const byPath = new Map(events.map(event => [event.path, event.event]))
    before = repairs.reduce((sum, repair) => sum + Math.max(0, Math.round(numeric(byPath.get(repair.path)?.costMicros))), 0)
    after = repairs.reduce((sum, repair) => sum + repair.event.costMicros, 0)
    return repairs
  })
  console.log(JSON.stringify({ ...result, from, to, eventCostBeforeMicros: before, eventCostAfterMicros: after, eventCostDeltaMicros: after - before }, null, 2))
}
