import { createHash } from "node:crypto"

import { closeLocalDatabase, listLocalDocuments, upsertLocalDocuments } from "@/lib/local-db"
import { listCliProxyModels } from "@/lib/cliproxy-catalog"
import { calculateCostMicros, normalizeUsageMetrics } from "@/lib/usage-metrics"
import { startOfZonedDay, startOfZonedHour, startOfZonedMonth } from "@/lib/timezone"
import type { ModelPricingGroup, ModelPricingVersion, UsageEvent, UsageRollup } from "@/lib/types"

/**
 * Reconciles event rows that contain complete token usage but were left at
 * zero cost because the request used an unprefixed upstream model spelling.
 * It also moves the exact cost delta into the matching rollups and budget
 * counter. The event's requested model spelling is preserved for reporting.
 */

type LocalDocument = Awaited<ReturnType<typeof listLocalDocuments>>[number]
type Scope = { id: string; groupsPath: string; versionsPath: string; modelsPrefix: string; rollupsPath: string; budgetsPath: string; windowsPath: string; sessionsPath: string; countersPath: string }

const apply = process.argv.includes("--apply")
const prefix = (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")

function scopeForEventCollection(collectionPath: string): Scope | undefined {
  if (collectionPath === `${prefix}_usage_events`) return {
    id: "default",
    groupsPath: `${prefix}_model_pricing_groups`,
    versionsPath: `${prefix}_model_pricing_versions`,
    modelsPrefix: `${prefix}/providers/providers/`,
    rollupsPath: `${prefix}_usage_rollups`,
    budgetsPath: `${prefix}_budgets`,
    windowsPath: `${prefix}_budget_windows`,
    sessionsPath: `${prefix}_budget_bypass_sessions`,
    countersPath: `${prefix}_budget_counters`,
  }
  const match = collectionPath.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}_workspaces/([^/]+)/usageEvents$`))
  if (!match) return undefined
  const id = match[1]
  const base = `${prefix}_workspaces/${id}`
  return {
    id,
    groupsPath: `${base}/modelPricingGroups`,
    versionsPath: `${base}/modelPricingVersions`,
    modelsPrefix: `${base}/providers/`,
    rollupsPath: `${base}/usageRollups`,
    budgetsPath: `${base}/budgets`,
    windowsPath: `${base}/budgetWindows`,
    sessionsPath: `${base}/budgetBypassSessions`,
    countersPath: `${base}/budgetCounters`,
  }
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

function eventCollection(document: LocalDocument) {
  return document.collection_path.endsWith("/usageEvents") || document.collection_path.endsWith("_usage_events")
}

function activeVersion(versions: ModelPricingVersion[], at: string) {
  const timestamp = Date.parse(at)
  return versions
    .filter((version) => Date.parse(version.effectiveAt) <= timestamp)
    .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))[0]
}

function modelsForScope(documents: LocalDocument[], scope: Scope, cliProxyModels: Awaited<ReturnType<typeof listCliProxyModels>>) {
  return [
    ...documents
    .filter((document) => document.collection_path.startsWith(scope.modelsPrefix) && document.collection_path.endsWith("/models"))
    .map((document) => ({ id: document.document_id, gatewayModelId: String(document.data.gatewayModelId || ""), upstreamModel: String(document.data.upstreamModel || "") }))
    .filter((model) => model.gatewayModelId || model.upstreamModel),
    ...cliProxyModels,
  ]
}

function pricingForScope(documents: LocalDocument[], scope: Scope, modelId: string, at: string, cliProxyModels: Awaited<ReturnType<typeof listCliProxyModels>>) {
  const groups = documents
    .filter((document) => document.collection_path === scope.groupsPath)
    .map((document) => ({ ...document.data, id: document.document_id } as ModelPricingGroup))
  const model = modelsForScope(documents, scope, cliProxyModels).find((candidate) => candidate.id === modelId)
  if (!model) return undefined
  const group = groups.find((candidate) => candidate.memberModelIds?.includes(model.id))
  if (!group) return undefined
  const versionRows = documents
    .filter((document) => document.collection_path === scope.versionsPath && document.data.groupId === group.id)
    .map((document) => ({ ...document.data, id: document.document_id } as ModelPricingVersion))
  const version = activeVersion(versionRows, at)
  return version ? { group, version } : undefined
}

function readRollupValue(data: Record<string, unknown>) {
  return {
    requests: Math.max(0, Math.round(number(data.requests))),
    inputTokens: Math.max(0, Math.round(number(data.inputTokens))),
    outputTokens: Math.max(0, Math.round(number(data.outputTokens))),
    cacheReadTokens: Math.max(0, Math.round(number(data.cacheReadTokens))),
    cacheCreationTokens: Math.max(0, Math.round(number(data.cacheCreationTokens))),
    totalTokens: Math.max(0, Math.round(number(data.totalTokens))),
    costMicros: Math.max(0, Math.round(number(data.costMicros))),
    pricedRequests: Math.max(0, Math.round(number(data.pricedRequests))),
    unpricedRequests: Math.max(0, Math.round(number(data.unpricedRequests))),
  }
}

async function main() {
  const documents = await listLocalDocuments()
  const byPath = new Map(documents.map((document) => [document.path, document]))
  const eventDocuments = documents.filter(eventCollection)
  const cliProxyModels = await listCliProxyModels()
  const updates: Array<{ path: string; data: UsageEvent }> = []
  const rollupDeltas = new Map<string, { event: UsageEvent; cost: number; priced: number; unpriced: number }>()
  const budgetDeltas = new Map<string, { scope: Scope; event: UsageEvent; usageStartAt: string; windowEnd: string; cost: number }>()
  let skippedAmbiguous = 0
  let skippedMissingPricing = 0

  for (const document of eventDocuments) {
    const scope = scopeForEventCollection(document.collection_path)
    if (!scope) continue
    const event = document.data as unknown as UsageEvent
    if (event.pricingConfidence === "exact" || event.usageCompleteness === "partial" || event.usageCompleteness === "missing" || event.usageAvailable !== true || !event.gatewayModelId || event.totalTokens <= 0) continue
    const models = modelsForScope(documents, scope, cliProxyModels)
    const exactModelCandidates = models.filter((model) => model.gatewayModelId === event.gatewayModelId)
    const modelCandidates = exactModelCandidates.length
      ? exactModelCandidates
      : models.filter((model) => model.upstreamModel === event.gatewayModelId || model.gatewayModelId.endsWith(`/${event.gatewayModelId}`))
    if (modelCandidates.length !== 1) {
      if (modelCandidates.length > 1) skippedAmbiguous += 1
      else skippedMissingPricing += 1
      continue
    }
    const pricing = pricingForScope(documents, scope, modelCandidates[0].id, event.completedAt, cliProxyModels)
    if (!pricing) {
      skippedMissingPricing += 1
      continue
    }
    const normalized = normalizeUsageMetrics({ input: event.inputTokens, output: event.outputTokens, cached: event.cacheReadTokens, cacheCreation: event.cacheCreationTokens })
    const calculated = calculateCostMicros(normalized, pricing.version)
    if (calculated.pricingConfidence !== "exact") {
      skippedMissingPricing += 1
      continue
    }
    const after: UsageEvent = {
      ...event,
      ...normalized,
      costMicros: calculated.costMicros,
      pricingConfidence: "exact",
      usageCompleteness: "complete",
      costSource: "configured-pricing",
      pricingGroupId: pricing.group.id,
      pricingVersionId: pricing.version.id,
      ...(calculated.pricingContextTier ? { pricingContextTier: calculated.pricingContextTier } : {}),
    }
    updates.push({ path: document.path, data: after })
    const oldCost = number(event.costMicros)
    for (const granularity of ["hourly", "daily", "monthly"] as const) {
      const bucket = bucketStart(event.completedAt, granularity)
      const path = `${scope.rollupsPath}/${rollupId(granularity, bucket, after)}`
      const existing = byPath.get(path)
      if (!existing && granularity === "monthly") continue
      const current = existing ? readRollupValue(existing.data) : { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costMicros: 0, pricedRequests: 0, unpricedRequests: 0 }
      const deltaCost = after.costMicros - oldCost
      const delta = rollupDeltas.get(path)
      rollupDeltas.set(path, {
        event: after,
        cost: (delta?.cost || 0) + deltaCost,
        priced: (delta?.priced || 0) + 1,
        unpriced: (delta?.unpriced || 0) - 1,
      })
      // Keep the document in the map so a second event in the same bucket
      // applies its delta to the same final row.
      if (existing) byPath.set(path, { ...existing, data: { ...existing.data, ...current } })
    }

    if (after.status < 200 || after.status >= 300) continue
    const window = documents.find((candidate) => candidate.collection_path === scope.windowsPath && candidate.document_id === "current")
    if (!window) continue
    const windowData = window.data
    let usageStartAt = typeof windowData.start === "string" ? windowData.start : ""
    if (windowData.bypassSessionId) {
      const session = documents.find((candidate) => candidate.collection_path === scope.sessionsPath && candidate.document_id === windowData.bypassSessionId)
      if (typeof session?.data.startedAt === "string") usageStartAt = session.data.startedAt
    }
    const windowEnd = typeof windowData.end === "string" ? windowData.end : ""
    const completedAt = Date.parse(after.completedAt)
    if (!usageStartAt || !windowEnd || !Number.isFinite(completedAt) || completedAt < Date.parse(usageStartAt) || completedAt >= Date.parse(windowEnd)) continue
    const counterPath = `${scope.countersPath}/${hash(`${after.gatewayKeyId}:${usageStartAt}`)}`
    const current = budgetDeltas.get(counterPath)
    budgetDeltas.set(counterPath, { scope, event: after, usageStartAt, windowEnd, cost: (current?.cost || 0) + (after.costMicros - oldCost) })
  }

  const writes: Array<{ path: string; data: object }> = [...updates]
  for (const [path, delta] of rollupDeltas) {
    const existing = byPath.get(path)
    if (!existing) continue
    const current = readRollupValue(existing.data)
    const next: UsageRollup = {
      ...(existing.data as unknown as UsageRollup),
      ...current,
      id: typeof existing.data.id === "string" ? String(existing.data.id) : existing.document_id,
      costMicros: Math.max(0, current.costMicros + delta.cost),
      pricedRequests: Math.max(0, current.pricedRequests + delta.priced),
      unpricedRequests: Math.max(0, current.unpricedRequests + delta.unpriced),
      updatedAt: new Date().toISOString(),
    }
    writes.push({ path, data: next })
  }
  for (const [path, delta] of budgetDeltas) {
    const existing = byPath.get(path)
    const current = existing ? number(existing.data.spentMicros) : 0
    writes.push({
      path,
      data: {
        ...(existing?.data || {}),
        apiKeyId: delta.event.gatewayKeyId,
        usageStartAt: delta.usageStartAt,
        windowEnd: delta.windowEnd,
        spentMicros: Math.max(0, current + delta.cost),
        lastUsedAt: delta.event.completedAt,
        updatedAt: new Date().toISOString(),
      },
    })
  }

  if (apply && writes.length) await upsertLocalDocuments(writes)
  const cost = updates.reduce((sum, update) => sum + update.data.costMicros, 0)
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    candidates: updates.length,
    writes: writes.length,
    repairedCostMicros: cost,
    repairedCostUsd: cost / 1_000_000,
    rollupDocuments: rollupDeltas.size,
    budgetCounters: budgetDeltas.size,
    skippedAmbiguous,
    skippedMissingPricing,
  }, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(() => closeLocalDatabase())
