import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"

import { closeLocalDatabase, listLocalDocuments, upsertLocalDocuments } from "@/lib/local-db"
import { startOfZonedDay, startOfZonedHour, startOfZonedMonth } from "@/lib/timezone"
import type { UsageEvent, UsageRollup } from "@/lib/types"

/**
 * Best-effort repair for successful responses whose provider returned no token
 * usage. The request payload is not stored, so exact billing is impossible;
 * use a robust median from nearby exact events instead of treating the request
 * as free or carrying a worst-case reservation into historical cost totals.
 *
 * Candidate priority:
 *   1. same key + model + UTC day
 *   2. same key + model across the stored history
 *   3. same model + UTC day
 *   4. same model across the stored history
 *
 * Every rewritten event remains `assumed` and is marked `empirical`. The
 * script is idempotent and defaults to a dry run; pass --apply explicitly.
 */

type Scope = {
  id: string
  eventsPath: string
  rollupsPath: string
  windowsPath: string
  sessionsPath: string
  countersPath: string
}
type Sample = { costMicros: number; completedAt: string }
type Prediction = {
  costMicros: number
  method: NonNullable<UsageEvent["predictionMethod"]>
  sampleCount: number
}

const apply = process.argv.includes("--apply")
const prefix = (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
const fromArgument = process.argv.find((argument) => argument.startsWith("--from="))?.slice("--from=".length)
const toArgument = process.argv.find((argument) => argument.startsWith("--to="))?.slice("--to=".length)
const from = fromArgument ? Date.parse(fromArgument) : Date.parse("2026-08-07T00:00:00.000Z")
const to = toArgument ? Date.parse(toArgument) : Date.parse("2026-08-09T00:00:00.000Z")

function scopeForEventCollection(collectionPath: string): Scope | undefined {
  if (collectionPath === `${prefix}_usage_events`) return {
    id: "default",
    eventsPath: `${prefix}_usage_events`,
    rollupsPath: `${prefix}_usage_rollups`,
    windowsPath: `${prefix}_budget_windows`,
    sessionsPath: `${prefix}_budget_bypass_sessions`,
    countersPath: `${prefix}_budget_counters`,
  }
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = collectionPath.match(new RegExp(`^${escapedPrefix}_workspaces/([^/]+)/usageEvents$`))
  if (!match) return undefined
  const base = `${prefix}_workspaces/${match[1]}`
  return {
    id: match[1],
    eventsPath: collectionPath,
    rollupsPath: `${base}/usageRollups`,
    windowsPath: `${base}/budgetWindows`,
    sessionsPath: `${base}/budgetBypassSessions`,
    countersPath: `${base}/budgetCounters`,
  }
}

function isEventCollection(collectionPath: string) {
  return collectionPath.endsWith("_usage_events") || collectionPath.endsWith("/usageEvents")
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function rollupId(granularity: UsageRollup["granularity"], bucket: string, event: UsageEvent) {
  return `${granularity}:${bucket}:${hash(`${event.gatewayKeyId}:${event.gatewayModelId}`).slice(0, 24)}`
}

function bucketStart(timestamp: string, granularity: UsageRollup["granularity"]) {
  const date = new Date(timestamp)
  if (granularity === "hourly") return startOfZonedHour(date).toISOString()
  if (granularity === "monthly") return startOfZonedMonth(date).toISOString()
  return startOfZonedDay(date).toISOString()
}

function utcDay(timestamp: string) {
  return timestamp.slice(0, 10)
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isSafeInteger(value) && value > 0).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function addSample(map: Map<string, Sample[]>, key: string, sample: Sample) {
  const current = map.get(key) || []
  current.push(sample)
  map.set(key, current)
}

function selectPrediction(
  event: UsageEvent,
  exactByKeyModelDay: Map<string, Sample[]>,
  exactByKeyModel: Map<string, Sample[]>,
  exactByModelDay: Map<string, Sample[]>,
  exactByModel: Map<string, Sample[]>,
): Prediction | undefined {
  const keyModel = `${event.gatewayKeyId}\u0000${event.gatewayModelId}`
  const keyModelDay = `${keyModel}\u0000${utcDay(event.completedAt)}`
  const modelDay = `${event.gatewayModelId}\u0000${utcDay(event.completedAt)}`
  const candidates: Array<{ values: Sample[] | undefined; method: Prediction["method"]; minimum: number }> = [
    { values: exactByKeyModelDay.get(keyModelDay), method: "same-key-model-day-median", minimum: 3 },
    { values: exactByKeyModel.get(keyModel), method: "same-key-model-median", minimum: 5 },
    { values: exactByModelDay.get(modelDay), method: "same-model-day-median", minimum: 5 },
    { values: exactByModel.get(event.gatewayModelId), method: "same-model-median", minimum: 5 },
  ]
  for (const candidate of candidates) {
    if (!candidate.values || candidate.values.length < candidate.minimum) continue
    const costMicros = median(candidate.values.map((sample) => sample.costMicros))
    if (costMicros > 0) return { costMicros, method: candidate.method, sampleCount: candidate.values.length }
  }
  return undefined
}

function eligibleForPrediction(event: UsageEvent) {
  if (event.status < 200 || event.status >= 300) return false
  if (event.costSource === "provider-recorded" || event.costSource === "empirical") return false
  if (event.usageAvailable === true && event.usageCompleteness !== "missing") return false
  return event.pricingConfidence === "unpriced" || event.pricingConfidence === "assumed"
}

async function main() {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("Invalid --from/--to range.")
  const documents = await listLocalDocuments()
  const byPath = new Map(documents.map((document) => [document.path, document]))
  const eventDocuments = documents.filter((document) => isEventCollection(document.collection_path))
  const exactByKeyModelDay = new Map<string, Sample[]>()
  const exactByKeyModel = new Map<string, Sample[]>()
  const exactByModelDay = new Map<string, Sample[]>()
  const exactByModel = new Map<string, Sample[]>()
  for (const document of eventDocuments) {
    const event = document.data as unknown as UsageEvent
    const completedAt = Date.parse(event.completedAt)
    if (!Number.isFinite(completedAt) || event.status < 200 || event.status >= 300 || event.pricingConfidence !== "exact" || event.usageAvailable !== true) continue
    const costMicros = Math.round(number(event.costMicros))
    if (!Number.isSafeInteger(costMicros) || costMicros <= 0 || !event.gatewayModelId) continue
    const sample = { costMicros, completedAt: event.completedAt }
    const keyModel = `${event.gatewayKeyId}\u0000${event.gatewayModelId}`
    addSample(exactByKeyModelDay, `${keyModel}\u0000${utcDay(event.completedAt)}`, sample)
    addSample(exactByKeyModel, keyModel, sample)
    addSample(exactByModelDay, `${event.gatewayModelId}\u0000${utcDay(event.completedAt)}`, sample)
    addSample(exactByModel, event.gatewayModelId, sample)
  }

  const updates: Array<{ path: string; data: UsageEvent; beforeCost: number; prediction: Prediction }> = []
  const rollupDeltas = new Map<string, { event: UsageEvent; cost: number }>()
  const budgetDeltas = new Map<string, { event: UsageEvent; usageStartAt: string; windowEnd: string; cost: number }>()
  for (const document of eventDocuments) {
    const scope = scopeForEventCollection(document.collection_path)
    if (!scope) continue
    const event = document.data as unknown as UsageEvent
    const completedAt = Date.parse(event.completedAt)
    if (!Number.isFinite(completedAt) || completedAt < from || completedAt >= to || !eligibleForPrediction(event)) continue
    const prediction = selectPrediction(event, exactByKeyModelDay, exactByKeyModel, exactByModelDay, exactByModel)
    if (!prediction) continue
    const beforeCost = Math.max(0, Math.round(number(event.costMicros)))
    const after: UsageEvent = {
      ...event,
      costMicros: prediction.costMicros,
      pricingConfidence: "assumed",
      costSource: "empirical",
      usageCompleteness: event.usageCompleteness || "missing",
      predictionMethod: prediction.method,
      predictionSampleCount: prediction.sampleCount,
    }
    updates.push({ path: document.path, data: after, beforeCost, prediction })
    const deltaCost = prediction.costMicros - beforeCost
    for (const granularity of ["hourly", "daily", "monthly"] as const) {
      const bucket = bucketStart(event.completedAt, granularity)
      const path = `${scope.rollupsPath}/${rollupId(granularity, bucket, after)}`
      if (!byPath.has(path) && granularity === "monthly") continue
      const current = rollupDeltas.get(path)
      rollupDeltas.set(path, { event: after, cost: (current?.cost || 0) + deltaCost })
    }
    if (event.status >= 200 && event.status < 300) {
      const window = documents.find((candidate) => candidate.collection_path === scope.windowsPath && candidate.document_id === "current")
      if (!window || typeof window.data.end !== "string") continue
      let usageStartAt = typeof window.data.start === "string" ? window.data.start : ""
      if (typeof window.data.bypassSessionId === "string") {
        const session = documents.find((candidate) => candidate.collection_path === scope.sessionsPath && candidate.document_id === window.data.bypassSessionId)
        if (typeof session?.data.startedAt === "string") usageStartAt = session.data.startedAt
      }
      const windowEnd = window.data.end
      if (!usageStartAt || completedAt < Date.parse(usageStartAt) || completedAt >= Date.parse(windowEnd)) continue
      const counterPath = `${scope.countersPath}/${hash(`${event.gatewayKeyId}:${usageStartAt}`)}`
      const current = budgetDeltas.get(counterPath)
      budgetDeltas.set(counterPath, { event: after, usageStartAt, windowEnd, cost: (current?.cost || 0) + deltaCost })
    }
  }

  const writes = new Map<string, object>()
  for (const update of updates) writes.set(update.path, update.data)
  for (const [path, delta] of rollupDeltas) {
    const existing = byPath.get(path)
    if (!existing || !delta.cost) continue
    writes.set(path, {
      ...existing.data,
      costMicros: Math.max(0, Math.round(number(existing.data.costMicros) + delta.cost)),
      updatedAt: new Date().toISOString(),
    })
  }
  for (const [path, delta] of budgetDeltas) {
    const existing = byPath.get(path)
    const existingLastUsedAt = typeof existing?.data.lastUsedAt === "string" ? existing.data.lastUsedAt : ""
    writes.set(path, {
      ...(existing?.data || {}),
      apiKeyId: delta.event.gatewayKeyId,
      usageStartAt: delta.usageStartAt,
      windowEnd: delta.windowEnd,
      spentMicros: Math.max(0, Math.round(number(existing?.data.spentMicros) + delta.cost)),
      lastUsedAt: existingLastUsedAt > delta.event.completedAt ? existingLastUsedAt : delta.event.completedAt,
      updatedAt: new Date().toISOString(),
    })
  }

  if (apply && writes.size) {
    const backupPath = `/tmp/rawroute-empirical-prediction-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}.jsonl`
    await writeFile(backupPath, [...writes.keys()].map((path) => JSON.stringify({ path, data: byPath.get(path)?.data || null })).join("\n") + "\n", "utf8")
    await upsertLocalDocuments([...writes.entries()].map(([path, data]) => ({ path, data })))
    console.log(JSON.stringify({ backupPath }, null, 2))
  }

  const byMethod = new Map<string, { candidates: number; beforeCost: number; afterCost: number }>()
  for (const update of updates) {
    const current = byMethod.get(update.prediction.method) || { candidates: 0, beforeCost: 0, afterCost: 0 }
    current.candidates += 1
    current.beforeCost += update.beforeCost
    current.afterCost += update.prediction.costMicros
    byMethod.set(update.prediction.method, current)
  }
  const beforeCost = updates.reduce((sum, update) => sum + update.beforeCost, 0)
  const afterCost = updates.reduce((sum, update) => sum + update.prediction.costMicros, 0)
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    candidates: updates.length,
    writes: writes.size,
    eventCostBeforeMicros: beforeCost,
    eventCostAfterMicros: afterCost,
    eventCostDeltaMicros: afterCost - beforeCost,
    eventCostBeforeUsd: beforeCost / 1_000_000,
    eventCostAfterUsd: afterCost / 1_000_000,
    rollupDocuments: rollupDeltas.size,
    budgetCounters: budgetDeltas.size,
    byMethod: Object.fromEntries(byMethod),
  }, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(() => closeLocalDatabase())
