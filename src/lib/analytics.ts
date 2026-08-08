import { createHash } from "node:crypto"
import { FieldPath, FieldValue, getLocalFirestore, type Firestore, type LocalQuery } from "@/lib/local-db"

import { listAliases, listApiKeys, listIndexedApiKeyNames, listModels } from "@/lib/store"
import { listCliProxyModels } from "@/lib/cliproxy-catalog"
import { listCodexAccounts } from "@/lib/codex"
import { getCodexUsageForAccount } from "@/lib/codex-usage"
import { getModelPricingGeneration, getPricingForModelAt as getModernPricingForModelAt, getPricingJob, listPricingGroups, listPricingVersions, resetModelPricingForTests, updatePricingJob } from "@/lib/model-pricing"
import { calculateCostMicros, normalizeUsageMetrics, type UsageMetrics } from "@/lib/usage-metrics"
import { addZonedDays, addZonedMonths, formatAppTrendBucket, mondayInAppTimeZone, startOfZonedDay, startOfZonedMonth, startOfZonedYear, startOfZonedHour, zonedDateStringToDate } from "@/lib/timezone"
import type { BudgetBypassSession, BudgetWindow, BudgetWindowAnchor, DashboardPayload, DashboardQuery, GatewayKeyBudget, ModelPricing, ModelPricingVersion, UsageEvent, UsageRollup } from "@/lib/types"
import { currentWorkspaceId, usesLegacyWorkspaceStorage } from "@/lib/workspace-context"

let localDatabase: Firestore | undefined
interface AnalyticsMemoryState {
  events: Map<string, UsageEvent>
  rollups: Map<string, UsageRollup>
  pricing: Map<string, ModelPricing>
  budgets: Map<string, GatewayKeyBudget>
  budgetCounters: Map<string, { spentMicros: number; lastUsedAt?: string }>
  bypassSessions: Map<string, BudgetBypassSession>
  window?: BudgetWindow
}
declare global { var __rawrouteAnalyticsMemory: Map<string, AnalyticsMemoryState> | undefined }
function memoryStates() { return globalThis.__rawrouteAnalyticsMemory ||= new Map<string, AnalyticsMemoryState>() }
function memoryState() {
  const workspaceId = currentWorkspaceId()
  let state = memoryStates().get(workspaceId)
  if (!state) {
    state = { events: new Map(), rollups: new Map(), pricing: new Map(), budgets: new Map(), budgetCounters: new Map(), bypassSessions: new Map() }
    memoryStates().set(workspaceId, state)
  }
  return state
}
export type ResolvedModelPricing = Exclude<Awaited<ReturnType<typeof getModernPricingForModelAt>>, undefined> | ModelPricing
const pricingCache = new Map<string, { value: ResolvedModelPricing | undefined; expiresAt: number; modelPricingGeneration: number; legacyPricingGeneration: number }>()
const pricingInflight = new Map<string, Promise<ResolvedModelPricing | undefined>>()
const pricingCacheTtlMs = positiveDuration(process.env.PRICING_CATALOG_CACHE_TTL_MS, 60_000)
const legacyPricingCaches = new Map<string, TimedValue<{ byProviderModelId: Map<string, ModelPricing>; byGatewayModelId: Map<string, ModelPricing> }>>()
const legacyPricingInflights = new Map<string, Promise<{ byProviderModelId: Map<string, ModelPricing>; byGatewayModelId: Map<string, ModelPricing> }>>()
const legacyPricingGenerations = new Map<string, number>()

interface TimedValue<T> { value: T; expiresAt: number }

const budgetCacheTtlMs = positiveDuration(process.env.BUDGET_CACHE_TTL_MS, 60_000)
const budgetCounterCacheTtlMs = positiveDuration(process.env.BUDGET_COUNTER_CACHE_TTL_MS, 30_000)
const dashboardCacheTtlMs = positiveDuration(process.env.DASHBOARD_CACHE_TTL_MS, 30_000)
const maximumBudgetContextLagMs = (
  Math.max(
    positiveNumber(process.env.ROUTING_MAX_STREAM_DURATION_SECONDS || process.env.ROUTING_MAX_REQUEST_DURATION_SECONDS, 290),
    positiveNumber(process.env.ROUTING_MAX_NON_STREAM_DURATION_SECONDS, 60),
  ) * 1_000
) + 10_000
const analyticsReadConcurrency = positiveInteger(process.env.DATABASE_ANALYTICS_READ_CONCURRENCY, 8)
const defaultBudgetOutputTokens = positiveInteger(process.env.BUDGET_DEFAULT_OUTPUT_TOKENS, 4_096)
const defaultPredictedOutputTokens = positiveInteger(process.env.BUDGET_PREDICTED_OUTPUT_TOKENS, Math.min(defaultBudgetOutputTokens, 1_024))
const budgetInputBytesPerToken = positiveNumber(process.env.BUDGET_INPUT_BYTES_PER_TOKEN, 3)
const budgetReservationSafetyMultiplier = positiveNumber(process.env.BUDGET_RESERVATION_SAFETY_PERCENT, 125) / 100
const usagePredictionSamples = new Map<string, number[]>()
const budgetConfigCache = new Map<string, TimedValue<GatewayKeyBudget | null>>()
const budgetConfigInflight = new Map<string, Promise<GatewayKeyBudget | undefined>>()
const budgetCounterCache = new Map<string, TimedValue<number>>()
const budgetCounterInflight = new Map<string, Promise<number>>()
type BudgetCounterRow = { id: string; spentMicros?: number; lastUsedAt?: string }
const budgetCounterListCache = new Map<string, TimedValue<BudgetCounterRow[]>>()
const budgetCounterListInflight = new Map<string, Promise<BudgetCounterRow[]>>()
type BudgetUsageValue = { spentMicros: number; lastUsedAt: string | null }
type BudgetCounterBaseline = { offsetMicros: number; lastUsedAt: string | null; expiresAt: number; stable: boolean; durable?: boolean }
const budgetCounterBaselineCache = new Map<string, BudgetCounterBaseline>()
const budgetUsageCache = new Map<string, TimedValue<Map<string, BudgetUsageValue>>>()
const budgetUsageInflight = new Map<string, Promise<Map<string, BudgetUsageValue>>>()
const bypassSessionCache = new Map<string, TimedValue<BudgetBypassSession | null>>()
const bypassSessionInflight = new Map<string, Promise<BudgetBypassSession | undefined>>()
const bypassSessionListCache = new Map<string, TimedValue<BudgetBypassSession[]>>()
const bypassSessionListInflight = new Map<string, Promise<BudgetBypassSession[]>>()
const dashboardCache = new Map<string, TimedValue<DashboardPayload>>()
const dashboardInflight = new Map<string, Promise<DashboardPayload>>()
const dashboardModelLabelCache = new Map<string, TimedValue<Map<string, string>>>()
const dashboardModelLabelInflight = new Map<string, Promise<Map<string, string>>>()
const budgetsCaches = new Map<string, TimedValue<GatewayKeyBudget[]>>()
const budgetsInflights = new Map<string, Promise<GatewayKeyBudget[]>>()
const budgetWindowCaches = new Map<string, TimedValue<BudgetWindow>>()
const budgetWindowInflights = new Map<string, Promise<BudgetWindow>>()
const budgetCacheGenerations = new Map<string, number>()

const dashboardPerformanceLogging = process.env.DASHBOARD_PERF_LOG === "1"

function dashboardPerf(message: string) {
  if (dashboardPerformanceLogging) console.info(`[dashboard-perf] ${message}`)
}

function dashboardTimed<T>(label: string, promise: Promise<T>) {
  if (!dashboardPerformanceLogging) return promise
  const startedAt = performance.now()
  return promise.then((value) => {
    dashboardPerf(`${label} ${(performance.now() - startedAt).toFixed(1)}ms`)
    return value
  }, (error) => {
    dashboardPerf(`${label} failed ${(performance.now() - startedAt).toFixed(1)}ms`)
    throw error
  })
}

function positiveDuration(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function usagePredictionKey(gatewayModelId: string, providerModelId?: string) {
  return `${currentWorkspaceId()}\u0000${gatewayModelId}\u0000${providerModelId || ""}`
}

function rememberUsagePrediction(event: UsageEvent) {
  if (event.status < 200 || event.status >= 300 || event.pricingConfidence !== "exact" || event.usageCompleteness === "partial" || event.usageCompleteness === "missing") return
  if (!Number.isSafeInteger(event.outputTokens) || event.outputTokens <= 0) return
  const key = usagePredictionKey(event.gatewayModelId, event.providerModelId)
  const samples = usagePredictionSamples.get(key) || []
  samples.push(event.outputTokens)
  if (samples.length > 256) samples.splice(0, samples.length - 256)
  usagePredictionSamples.set(key, samples)
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isSafeInteger(value) && value > 0).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function boundedSet<T>(cache: Map<string, T>, key: string, value: T, maximum = 1_024) {
  if (!cache.has(key) && cache.size >= maximum) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

async function parallelMap<T, R>(items: readonly T[], mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length <= analyticsReadConcurrency) return Promise.all(items.map(mapper))
  const output = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: analyticsReadConcurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      output[index] = await mapper(items[index], index)
    }
  }))
  return output
}

async function settledParallelMap<T, R>(items: readonly T[], mapper: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  return parallelMap(items, async (item, index) => {
    try { return { status: "fulfilled", value: await mapper(item, index) } as const }
    catch (reason) { return { status: "rejected", reason } as const }
  })
}

function mergeDateRanges(ranges: ReadonlyArray<readonly [Date, Date]>): Array<[Date, Date]> {
  const sorted = ranges
    .filter(([from, to]) => from < to)
    .map(([from, to]) => [new Date(from.getTime()), new Date(to.getTime())] as [Date, Date])
    .sort((left, right) => left[0].getTime() - right[0].getTime())
  const merged: Array<[Date, Date]> = []
  for (const current of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && current[0] <= previous[1]) previous[1] = new Date(Math.max(previous[1].getTime(), current[1].getTime()))
    else merged.push(current)
  }
  return merged
}

function subtractDateRanges(ranges: ReadonlyArray<readonly [Date, Date]>, covered: ReadonlyArray<readonly [Date, Date]>) {
  const coverage = mergeDateRanges(covered)
  const result: Array<[Date, Date]> = []
  for (const [from, to] of mergeDateRanges(ranges)) {
    let cursor = from.getTime()
    const end = to.getTime()
    for (const [coveredFrom, coveredTo] of coverage) {
      if (coveredTo.getTime() <= cursor) continue
      if (coveredFrom.getTime() >= end) break
      if (coveredFrom.getTime() > cursor) result.push([new Date(cursor), new Date(Math.min(end, coveredFrom.getTime()))])
      cursor = Math.max(cursor, coveredTo.getTime())
      if (cursor >= end) break
    }
    if (cursor < end) result.push([new Date(cursor), new Date(end)])
  }
  return result
}

function uniqueUsageEvents(batches: Iterable<Iterable<UsageEvent>>) {
  const unique = new Map<string, UsageEvent>()
  for (const batch of batches) {
    for (const event of batch) unique.set(event.id, event)
  }
  return [...unique.values()]
}

function scopedKey(key: string) {
  return `${currentWorkspaceId()}:${key}`
}

function workspaceGeneration(generations: Map<string, number>, workspaceId = currentWorkspaceId()) {
  return generations.get(workspaceId) || 0
}

function advanceWorkspaceGeneration(generations: Map<string, number>, workspaceId: string) {
  generations.set(workspaceId, workspaceGeneration(generations, workspaceId) + 1)
}

function clearWorkspaceEntries<T>(cache: Map<string, T>, workspaceId: string) {
  const prefix = `${workspaceId}:`
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
}

function invalidateBudgetReadCaches() {
  const workspaceId = currentWorkspaceId()
  advanceWorkspaceGeneration(budgetCacheGenerations, workspaceId)
  budgetsCaches.delete(workspaceId)
  budgetsInflights.delete(workspaceId)
  budgetWindowCaches.delete(workspaceId)
  budgetWindowInflights.delete(workspaceId)
  clearWorkspaceEntries(budgetConfigCache, workspaceId)
  clearWorkspaceEntries(budgetConfigInflight, workspaceId)
  clearWorkspaceEntries(budgetCounterCache, workspaceId)
  clearWorkspaceEntries(budgetCounterInflight, workspaceId)
  clearWorkspaceEntries(budgetCounterListCache, workspaceId)
  clearWorkspaceEntries(budgetCounterListInflight, workspaceId)
  clearWorkspaceEntries(budgetCounterBaselineCache, workspaceId)
  clearWorkspaceEntries(budgetUsageCache, workspaceId)
  clearWorkspaceEntries(budgetUsageInflight, workspaceId)
  clearWorkspaceEntries(bypassSessionCache, workspaceId)
  clearWorkspaceEntries(bypassSessionInflight, workspaceId)
  clearWorkspaceEntries(bypassSessionListCache, workspaceId)
  clearWorkspaceEntries(bypassSessionListInflight, workspaceId)
  clearWorkspaceEntries(dashboardCache, workspaceId)
  clearWorkspaceEntries(dashboardInflight, workspaceId)
}

function invalidateLegacyPricingCaches() {
  const workspaceId = currentWorkspaceId()
  advanceWorkspaceGeneration(legacyPricingGenerations, workspaceId)
  legacyPricingCaches.delete(workspaceId)
  legacyPricingInflights.delete(workspaceId)
  clearWorkspaceEntries(pricingCache, workspaceId)
  clearWorkspaceEntries(pricingInflight, workspaceId)
}

function isMemory() { return process.env.STORAGE_BACKEND === "memory" || process.env.NODE_ENV === "test" }
function prefix() { return (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_") }
function db() {
  return localDatabase ||= getLocalFirestore()
}
function workspaceRef() { return db().collection(`${prefix()}_workspaces`).doc(currentWorkspaceId()) }
function eventsRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_usage_events`) : workspaceRef().collection("usageEvents") }
function rollupsRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_usage_rollups`) : workspaceRef().collection("usageRollups") }
function pricingRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_model_pricing`) : workspaceRef().collection("modelPricing") }
function budgetsRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_budgets`) : workspaceRef().collection("budgets") }
function budgetCountersRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_budget_counters`) : workspaceRef().collection("budgetCounters") }
function bypassSessionsRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_budget_bypass_sessions`) : workspaceRef().collection("budgetBypassSessions") }
function windowRef() { return usesLegacyWorkspaceStorage() ? db().collection(`${prefix()}_budget_windows`).doc("current") : workspaceRef().collection("budgetWindows").doc("current") }
function hash(value: string) { return createHash("sha256").update(value).digest("hex") }
function defaultWindow(): BudgetWindow { const start = mondayInAppTimeZone(); const end = addZonedDays(start, 7); return { start: start.toISOString(), end: end.toISOString(), anchor: "custom", codexAccountId: null, bypassLimits: false, bypassSessionId: null, updatedAt: new Date().toISOString() } }
function budgetCounterId(apiKeyId: string, usageStart: string) { return hash(`${apiKeyId}:${usageStart}`) }
function budgetBaselineRevision(budget: GatewayKeyBudget, window: BudgetWindow) { return hash(`${budget.updatedAt || ""}:${window.updatedAt || ""}`).slice(0, 24) }
function budgetCounterBaselineId(budget: GatewayKeyBudget, usageStart: string, window: BudgetWindow) {
  return scopedKey(`${budget.apiKeyId}:${usageStart}:${window.end}:${budgetBaselineRevision(budget, window)}`)
}
function budgetCounterBaselineExpiresAt(windowEnd: string) {
  const parsedEnd = Date.parse(windowEnd)
  return Number.isFinite(parsedEnd) ? Math.max(Date.now() + budgetCounterCacheTtlMs, parsedEnd + 60_000) : Date.now() + 60 * 60_000
}
function budgetRetryAfter(window: BudgetWindow) { return Math.max(1, Math.ceil((Date.parse(window.end) - Date.now()) / 1000)) }
function advanceExpiredWindow(window: BudgetWindow, now = Date.now()) {
  let start = Date.parse(window.start)
  let end = Date.parse(window.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now) return window
  const duration = end - start
  const steps = Math.floor((now - start) / duration) + 1
  start += steps * duration
  end += steps * duration
  return { ...window, start: new Date(start).toISOString(), end: new Date(end).toISOString(), updatedAt: new Date().toISOString() }
}

async function budgetUsageStart(window: BudgetWindow) {
  if (!window.bypassLimits || !window.bypassSessionId) return window.start
  if (isMemory()) return memoryState().bypassSessions.get(window.bypassSessionId)?.startedAt || window.start
  const sessionId = window.bypassSessionId
  const workspaceId = currentWorkspaceId()
  const cacheId = scopedKey(sessionId)
  const cached = bypassSessionCache.get(cacheId)
  if (cached && cached.expiresAt > Date.now()) return cached.value?.startedAt || window.start
  const existing = bypassSessionInflight.get(cacheId)
  if (existing) return (await existing)?.startedAt || window.start

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = bypassSessionsRef().doc(sessionId).get().then((snapshot) => {
    const session = snapshot.exists ? { ...snapshot.data(), id: snapshot.id } as BudgetBypassSession : undefined
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(bypassSessionCache, cacheId, { value: session || null, expiresAt: Date.now() + budgetCacheTtlMs }, 128)
    return session
  }).finally(() => {
    if (bypassSessionInflight.get(cacheId) === promise) bypassSessionInflight.delete(cacheId)
  })
  bypassSessionInflight.set(cacheId, promise)
  return (await promise)?.startedAt || window.start
}

async function budgetConfig(apiKeyId: string) {
  if (isMemory()) return memoryState().budgets.get(apiKeyId)
  const now = Date.now()
  const workspaceId = currentWorkspaceId()
  const cacheId = scopedKey(apiKeyId)
  const cached = budgetConfigCache.get(cacheId)
  if (cached && cached.expiresAt > now) return cached.value || undefined
  const budgetsCache = budgetsCaches.get(workspaceId)
  if (budgetsCache && budgetsCache.expiresAt > now) {
    const budget = budgetsCache.value.find((entry) => entry.apiKeyId === apiKeyId)
    boundedSet(budgetConfigCache, cacheId, { value: budget || null, expiresAt: budgetsCache.expiresAt })
    return budget
  }
  const existing = budgetConfigInflight.get(cacheId)
  if (existing) return existing

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = budgetsRef().doc(apiKeyId).get().then((snapshot) => {
    const budget = snapshot.exists ? { ...snapshot.data(), apiKeyId: snapshot.id } as GatewayKeyBudget : undefined
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetConfigCache, cacheId, { value: budget || null, expiresAt: Date.now() + budgetCacheTtlMs })
    return budget
  }).finally(() => {
    if (budgetConfigInflight.get(cacheId) === promise) budgetConfigInflight.delete(cacheId)
  })
  budgetConfigInflight.set(cacheId, promise)
  return promise
}

async function budgetCounter(apiKeyId: string, usageStart: string) {
  const id = budgetCounterId(apiKeyId, usageStart)
  if (isMemory()) return memoryState().budgetCounters.get(id)?.spentMicros || 0
  const workspaceId = currentWorkspaceId()
  const cacheId = scopedKey(id)
  const cached = budgetCounterCache.get(cacheId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = budgetCounterInflight.get(cacheId)
  if (existing) return existing

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = budgetCountersRef().doc(id).get().then((snapshot) => {
    const spentMicros = safeUsageInteger((snapshot.data() as { spentMicros?: number } | undefined)?.spentMicros)
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetCounterCache, cacheId, { value: spentMicros, expiresAt: Date.now() + budgetCounterCacheTtlMs })
    return spentMicros
  }).finally(() => {
    if (budgetCounterInflight.get(cacheId) === promise) budgetCounterInflight.delete(cacheId)
  })
  budgetCounterInflight.set(cacheId, promise)
  return promise
}

function rollupId(granularity: UsageRollup["granularity"], bucket: string, event: UsageEvent) {
  return `${granularity}:${bucket}:${hash(`${event.gatewayKeyId}:${event.gatewayModelId}`).slice(0, 24)}`
}

function emptyRollup(id: string, granularity: UsageRollup["granularity"], bucketStart: string, event: UsageEvent): UsageRollup {
  return {
    id, granularity, bucketStart, gatewayKeyId: event.gatewayKeyId, gatewayModelId: event.gatewayModelId,
    requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0,
    costMicros: 0, pricedRequests: 0, unpricedRequests: 0, failedRequests: 0, lastEventAt: event.completedAt, updatedAt: new Date().toISOString(),
  }
}

export class BudgetDeniedError extends Error { status = 429; retryAfterSeconds: number; constructor(message: string, retryAfterSeconds: number) { super(message); this.name = "BudgetDeniedError"; this.retryAfterSeconds = retryAfterSeconds } }

export interface BudgetUsageContext {
  usageStartAt: string
  windowEnd: string
}

// Hourly rollups keep short-range dashboards bounded, while daily rollups keep
// long-range queries bounded. Monthly rollups are optional because writing one
// for every request usually costs more than reading daily rows on comparatively
// infrequent long-range dashboards. Set USAGE_ROLLUP_GRANULARITIES to include
// "monthly" when dashboard-read volume makes that trade-off worthwhile.
const usageRollupGranularities: readonly UsageRollup["granularity"][] = process.env.USAGE_ROLLUP_GRANULARITIES
  ?.split(",")
  .map((value) => value.trim().toLowerCase())
  .includes("monthly")
  ? ["hourly", "daily", "monthly"]
  : ["hourly", "daily"]
const usageRollupGranularitySet = new Set<UsageRollup["granularity"]>(usageRollupGranularities)

function storageGranularityFor(trendGranularity: NonNullable<DashboardQuery["granularity"]>) {
  if (trendGranularity === "hourly") return "hourly" as const
  if (trendGranularity === "daily" || trendGranularity === "weekly") return "daily" as const
  return usageRollupGranularitySet.has("monthly") ? "monthly" as const : "daily" as const
}

function isAlreadyExistsError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS"
}

async function usageBudgetContext(event: UsageEvent) {
  const budget = await budgetConfig(event.gatewayKeyId).catch(() => undefined)
  if (!budget) return null
  const window = await getBudgetWindow().catch(() => undefined)
  if (!window) return null
  const usageStartAt = await budgetUsageStart(window).catch(() => window.start)
  return { usageStartAt, windowEnd: window.end } satisfies BudgetUsageContext
}

export async function recordUsageEvent(event: UsageEvent, budgetUsageContext?: BudgetUsageContext | null) {
  rememberUsagePrediction(event)
  const context = budgetUsageContext === undefined ? await usageBudgetContext(event) : budgetUsageContext
  const completedAtMs = Date.parse(event.completedAt)
  const countForBudget = Boolean(
    context &&
    event.status >= 200 && event.status < 300 &&
    completedAtMs >= Date.parse(context.usageStartAt) &&
    completedAtMs < Date.parse(context.windowEnd),
  )
  const counterId = countForBudget && context ? budgetCounterId(event.gatewayKeyId, context.usageStartAt) : undefined
  const completedDate = new Date(event.completedAt)
  const updatedAt = new Date().toISOString()
  const countsAsPricedRequest = event.status >= 200 && event.status < 300 && event.pricingConfidence === "exact"
  const countsAsUnpricedRequest = event.status >= 200 && event.status < 300 && event.pricingConfidence !== "exact"

  if (isMemory()) {
    const memory = memoryState()
    if (memory.events.has(event.id)) return event
    memory.events.set(event.id, event)
    for (const granularity of usageRollupGranularities) {
      const bucket = bucketStart(completedDate, granularity).toISOString()
      const id = rollupId(granularity, bucket, event)
      const current = memory.rollups.get(id) || emptyRollup(id, granularity, bucket, event)
      memory.rollups.set(id, {
        ...current,
        requests: current.requests + 1,
        inputTokens: current.inputTokens + event.inputTokens,
        outputTokens: current.outputTokens + event.outputTokens,
        cacheReadTokens: current.cacheReadTokens + event.cacheReadTokens,
        cacheCreationTokens: current.cacheCreationTokens + event.cacheCreationTokens,
        totalTokens: current.totalTokens + event.totalTokens,
        costMicros: current.costMicros + event.costMicros,
        pricedRequests: (current.pricedRequests || 0) + (countsAsPricedRequest ? 1 : 0),
        unpricedRequests: (current.unpricedRequests || 0) + (countsAsUnpricedRequest ? 1 : 0),
        failedRequests: (current.failedRequests || 0) + (event.status >= 200 && event.status < 300 ? 0 : 1),
        lastEventAt: !current.lastEventAt || current.lastEventAt < event.completedAt ? event.completedAt : current.lastEventAt,
        updatedAt,
      })
    }
    if (counterId) {
      memory.budgetCounters.set(counterId, {
        spentMicros: (memory.budgetCounters.get(counterId)?.spentMicros || 0) + event.costMicros,
        lastUsedAt: event.completedAt,
      })
    }
    // Match the in-memory dashboard behavior: a completed local write should
    // make the next budget read see the new rollup immediately. Firestore
    // workers rely on the shared dashboard TTL instead of clearing on every
    // request.
    const workspaceId = currentWorkspaceId()
    clearWorkspaceEntries(budgetUsageCache, workspaceId)
    clearWorkspaceEntries(budgetUsageInflight, workspaceId)
    clearWorkspaceEntries(dashboardCache, workspaceId)
    return event
  }

  const batch = db().batch()
  batch.create(eventsRef().doc(event.id), event)
  for (const granularity of usageRollupGranularities) {
    const bucket = bucketStart(completedDate, granularity).toISOString()
    const ref = rollupsRef().doc(rollupId(granularity, bucket, event))
    const base = emptyRollup(ref.id, granularity, bucket, event)
    batch.set(ref, {
      ...base,
      requests: FieldValue.increment(1),
      inputTokens: FieldValue.increment(event.inputTokens),
      outputTokens: FieldValue.increment(event.outputTokens),
      cacheReadTokens: FieldValue.increment(event.cacheReadTokens),
      cacheCreationTokens: FieldValue.increment(event.cacheCreationTokens),
      totalTokens: FieldValue.increment(event.totalTokens),
      costMicros: FieldValue.increment(event.costMicros),
      pricedRequests: FieldValue.increment(countsAsPricedRequest ? 1 : 0),
      unpricedRequests: FieldValue.increment(countsAsUnpricedRequest ? 1 : 0),
      failedRequests: FieldValue.increment(event.status >= 200 && event.status < 300 ? 0 : 1),
      lastEventAt: FieldValue.maximum(event.completedAt),
      updatedAt,
    }, { merge: true })
  }
  if (counterId && context) {
    batch.set(budgetCountersRef().doc(counterId), {
      apiKeyId: event.gatewayKeyId,
      usageStartAt: context.usageStartAt,
      windowEnd: context.windowEnd,
      spentMicros: FieldValue.increment(event.costMicros),
      lastUsedAt: FieldValue.maximum(event.completedAt),
      updatedAt,
    }, { merge: true })
  }

  try {
    await batch.commit()
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error
    return event
  }
  if (counterId && context) {
    const now = Date.now()
    const counterCacheId = scopedKey(counterId)
    const cached = budgetCounterCache.get(counterCacheId)
    if (cached && cached.expiresAt > now) {
      budgetCounterCache.set(counterCacheId, { value: cached.value + event.costMicros, expiresAt: cached.expiresAt })
    }
    const list = budgetCounterListCache.get(scopedKey(context.usageStartAt))
    if (list && list.expiresAt > now) {
      const row = list.value.find((entry) => entry.id === counterId)
      if (row) {
        row.spentMicros = Number(row.spentMicros || 0) + event.costMicros
        if (!row.lastUsedAt || row.lastUsedAt < event.completedAt) row.lastUsedAt = event.completedAt
      } else {
        list.value.push({ id: counterId, spentMicros: event.costMicros, lastUsedAt: event.completedAt })
      }
    }
  }
  return event
}

export async function listUsageRollups(granularity?: UsageRollup["granularity"], from?: string, to?: string) {
  if (isMemory()) {
    return [...memoryState().rollups.values()].filter((rollup) =>
      (!granularity || rollup.granularity === granularity) &&
      (!from || rollup.bucketStart >= from) &&
      (!to || rollup.bucketStart < to),
    )
  }

  let query = rollupsRef() as LocalQuery
  if (granularity) {
    // IDs begin with `${granularity}:${ISO bucket}`. The document-ID range avoids
    // downloading all historical rollups and requires no composite index.
    query = query
      .where(FieldPath.documentId(), ">=", `${granularity}:${from || ""}`)
      .where(FieldPath.documentId(), "<", to ? `${granularity}:${to}` : `${granularity};`)
  } else {
    if (from) query = query.where("bucketStart", ">=", from)
    if (to) query = query.where("bucketStart", "<", to)
  }
  const snapshot = await query.get()
  return snapshot.docs
    .map((document) => document.data() as UsageRollup)
    .filter((rollup) =>
      (!granularity || rollup.granularity === granularity) &&
      (!from || rollup.bucketStart >= from) &&
      (!to || rollup.bucketStart < to),
    )
}

export interface GatewayUsageInput {
  id?: string
  gatewayKeyId: string
  providerId?: string
  providerModelId?: string
  gatewayModelId: string
  protocol: UsageEvent["protocol"]
  startedAt: string
  status: number
  durationMs: number
  ttftMs?: number
  metrics?: UsageMetrics
  assumedCostMicros?: number
}

export async function createGatewayUsageEvent(input: GatewayUsageInput, resolvedPricing?: ResolvedModelPricing): Promise<UsageEvent> {
  const normalized = normalizeUsageMetrics(input.metrics)
  let pricing = resolvedPricing
  if (!pricing) {
    try { pricing = await getPricingForModel(input.gatewayModelId, input.providerModelId) }
    catch { pricing = undefined }
  }
  const calculated = calculateCostMicros(normalized, pricing)
  const suppliedAssumption = calculated.pricingConfidence !== "exact" && pricing && Number.isSafeInteger(input.assumedCostMicros) && Number(input.assumedCostMicros) > 0
    ? Number(input.assumedCostMicros)
    : undefined
  // A partial response gives us a useful lower-bound calculation. The request
  // admission estimate is conservative, so settle to the larger of the two
  // instead of replacing a known partial cost with a smaller guess.
  const assumedCostMicros = suppliedAssumption === undefined
    ? undefined
    : Math.max(calculated.costMicros, suppliedAssumption)
  return {
    id: input.id || crypto.randomUUID(),
    gatewayKeyId: input.gatewayKeyId,
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.providerModelId ? { providerModelId: input.providerModelId } : {}),
    gatewayModelId: input.gatewayModelId,
    protocol: input.protocol,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    status: input.status,
    durationMs: Math.max(0, input.durationMs),
    ...(input.ttftMs !== undefined ? { ttftMs: Math.max(0, input.ttftMs) } : {}),
    ...normalized,
    costMicros: assumedCostMicros ?? calculated.costMicros,
    pricingConfidence: assumedCostMicros !== undefined ? "assumed" : calculated.pricingConfidence,
    usageCompleteness: normalized.usageCompleteness,
    ...(assumedCostMicros !== undefined
      ? { costSource: "reservation" as const }
      : pricing && calculated.pricingConfidence !== "unpriced"
        ? { costSource: "configured-pricing" as const }
        : {}),
    ...(pricing && "pricingGroupId" in pricing && pricing.pricingGroupId ? { pricingGroupId: pricing.pricingGroupId } : {}),
    ...(pricing && "pricingVersionId" in pricing && pricing.pricingVersionId ? { pricingVersionId: pricing.pricingVersionId } : {}),
    ...(calculated.pricingContextTier ? { pricingContextTier: calculated.pricingContextTier } : {}),
  }
}

export async function recordGatewayUsage(input: GatewayUsageInput, budgetUsageContext?: BudgetUsageContext | null) {
  return recordUsageEvent(await createGatewayUsageEvent(input), budgetUsageContext)
}

export async function listUsageEvents(from?: string, to?: string): Promise<UsageEvent[]> {
  const start = from ? Date.parse(from) : -Infinity
  const end = to ? Date.parse(to) : Infinity
  if (isMemory()) return [...memoryState().events.values()].filter((event) => Date.parse(event.completedAt) >= start && Date.parse(event.completedAt) < end)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
  const snapshot = await eventsRef().where("completedAt", ">=", from || "2000-01-01T00:00:00.000Z").where("completedAt", "<", to || new Date().toISOString()).withoutDefaultOrder().get()
  return snapshot.docs.map((document) => document.data() as UsageEvent).sort((a, b) => a.completedAt.localeCompare(b.completedAt))
}

export async function listModelPricing() {
  if (isMemory()) return [...memoryState().pricing.values()].sort((a, b) => a.gatewayModelId.localeCompare(b.gatewayModelId))
  const snapshot = await pricingRef().get()
  return snapshot.docs.map((document) => ({ ...document.data(), id: document.id } as ModelPricing))
}

async function legacyPricingIndex() {
  if (isMemory()) {
    const byProviderModelId = new Map<string, ModelPricing>()
    const byGatewayModelId = new Map<string, ModelPricing>()
    for (const pricing of memoryState().pricing.values()) {
      if (!pricing.enabled) continue
      if (!byProviderModelId.has(pricing.modelId)) byProviderModelId.set(pricing.modelId, pricing)
      if (!byGatewayModelId.has(pricing.gatewayModelId)) byGatewayModelId.set(pricing.gatewayModelId, pricing)
    }
    return { byProviderModelId, byGatewayModelId }
  }
  const workspaceId = currentWorkspaceId()
  const legacyPricingCache = legacyPricingCaches.get(workspaceId)
  if (legacyPricingCache && legacyPricingCache.expiresAt > Date.now()) return legacyPricingCache.value
  const existingInflight = legacyPricingInflights.get(workspaceId)
  if (existingInflight) return existingInflight
  const generation = workspaceGeneration(legacyPricingGenerations, workspaceId)
  const promise = listModelPricing().then((entries) => {
    const byProviderModelId = new Map<string, ModelPricing>()
    const byGatewayModelId = new Map<string, ModelPricing>()
    for (const pricing of entries) {
      if (!pricing.enabled) continue
      if (!byProviderModelId.has(pricing.modelId)) byProviderModelId.set(pricing.modelId, pricing)
      if (!byGatewayModelId.has(pricing.gatewayModelId)) byGatewayModelId.set(pricing.gatewayModelId, pricing)
    }
    const value = { byProviderModelId, byGatewayModelId }
    if (generation === workspaceGeneration(legacyPricingGenerations, workspaceId)) boundedSet(legacyPricingCaches, workspaceId, { value, expiresAt: Date.now() + pricingCacheTtlMs }, 128)
    return value
  }).finally(() => {
    if (legacyPricingInflights.get(workspaceId) === promise) legacyPricingInflights.delete(workspaceId)
  })
  legacyPricingInflights.set(workspaceId, promise)
  return promise
}

export async function getPricingForModel(gatewayModelId: string, providerModelId?: string) {
  const workspaceId = currentWorkspaceId()
  const key = scopedKey(`${gatewayModelId}:${providerModelId || ""}`)
  const modelGeneration = getModelPricingGeneration()
  const legacyGeneration = workspaceGeneration(legacyPricingGenerations, workspaceId)
  const cached = pricingCache.get(key)
  if (cached && cached.expiresAt > Date.now() && cached.modelPricingGeneration === modelGeneration && cached.legacyPricingGeneration === legacyGeneration) return cached.value
  const inflightKey = scopedKey(`${modelGeneration}:${legacyGeneration}:${gatewayModelId}:${providerModelId || ""}`)
  const existing = pricingInflight.get(inflightKey)
  if (existing) return existing
  const promise = (async () => {
    let value: ResolvedModelPricing | undefined
    try {
      value = await getModernPricingForModelAt({ gatewayModelId, providerModelId })
    } catch {
      // Legacy pricing remains available while the advanced catalog is unavailable.
    }
    if (!value) {
      const legacy = await legacyPricingIndex()
      value = (providerModelId ? legacy.byProviderModelId.get(providerModelId) : undefined) || legacy.byGatewayModelId.get(gatewayModelId)
    }
    if (modelGeneration === getModelPricingGeneration() && legacyGeneration === workspaceGeneration(legacyPricingGenerations, workspaceId)) {
      boundedSet(pricingCache, key, { value, expiresAt: Date.now() + pricingCacheTtlMs, modelPricingGeneration: modelGeneration, legacyPricingGeneration: legacyGeneration })
    }
    return value
  })().finally(() => {
    if (pricingInflight.get(inflightKey) === promise) pricingInflight.delete(inflightKey)
  })
  pricingInflight.set(inflightKey, promise)
  return promise
}
export async function upsertModelPricing(input: Omit<ModelPricing, "id" | "updatedAt"> & { id?: string }) {
  for (const rate of [input.inputMicrosPerMillion, input.outputMicrosPerMillion, input.cacheReadMicrosPerMillion, input.cacheCreationMicrosPerMillion]) {
    if (!Number.isSafeInteger(rate) || rate < 0) throw new Error("Pricing rates must be non-negative integers in micros per million tokens.")
  }
  const pricing: ModelPricing = { ...input, id: input.id || crypto.randomUUID(), updatedAt: new Date().toISOString() }
  if (isMemory()) memoryState().pricing.set(pricing.id, pricing)
  else await pricingRef().doc(pricing.id).set(pricing)
  invalidateLegacyPricingCaches()
  return pricing
}
export async function deleteModelPricing(id: string) { if (isMemory()) memoryState().pricing.delete(id); else await pricingRef().doc(id).delete(); invalidateLegacyPricingCaches() }

export async function listBudgets(): Promise<GatewayKeyBudget[]> {
  if (isMemory()) return [...memoryState().budgets.values()]
  const now = Date.now()
  const workspaceId = currentWorkspaceId()
  const budgetsCache = budgetsCaches.get(workspaceId)
  if (budgetsCache && budgetsCache.expiresAt > now) return budgetsCache.value
  const budgetsInflight = budgetsInflights.get(workspaceId)
  if (budgetsInflight) return budgetsInflight

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = budgetsRef().get().then((snapshot) => {
    const budgets = snapshot.docs.map((document) => ({ ...document.data(), apiKeyId: document.id } as GatewayKeyBudget))
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) {
      const expiresAt = Date.now() + budgetCacheTtlMs
      boundedSet(budgetsCaches, workspaceId, { value: budgets, expiresAt }, 256)
      for (const budget of budgets) boundedSet(budgetConfigCache, scopedKey(budget.apiKeyId), { value: budget, expiresAt })
    }
    return budgets
  }).finally(() => {
    if (budgetsInflights.get(workspaceId) === promise) budgetsInflights.delete(workspaceId)
  })
  budgetsInflights.set(workspaceId, promise)
  return promise
}

export async function listBudgetBypassSessions(limit = 50, currentWindow?: BudgetWindow): Promise<BudgetBypassSession[]> {
  const window = currentWindow || await getBudgetWindow()
  if (window.bypassLimits && !window.bypassSessionId) await setBudgetBypassEnabled(true)
  if (isMemory()) return [...memoryState().bypassSessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)

  const workspaceId = currentWorkspaceId()
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const cacheId = scopedKey(`bypass-list:${boundedLimit}`)
  const cached = bypassSessionListCache.get(cacheId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = bypassSessionListInflight.get(cacheId)
  if (existing) return existing

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = bypassSessionsRef().orderBy("startedAt", "desc").limit(boundedLimit).get().then((snapshot) => {
    const sessions = snapshot.docs.map((document) => ({ ...document.data(), id: document.id } as BudgetBypassSession))
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) {
      boundedSet(bypassSessionListCache, cacheId, { value: sessions, expiresAt: Date.now() + budgetCacheTtlMs }, 32)
    }
    return sessions
  }).finally(() => {
    if (bypassSessionListInflight.get(cacheId) === promise) bypassSessionListInflight.delete(cacheId)
  })
  bypassSessionListInflight.set(cacheId, promise)
  return promise
}

export async function getBudgetWindow(): Promise<BudgetWindow> {
  if (isMemory()) {
    const memory = memoryState()
    const current = memory.window || defaultWindow()
    const next = advanceExpiredWindow(current)
    memory.window = next
    return next
  }
  const now = Date.now()
  const workspaceId = currentWorkspaceId()
  const budgetWindowCache = budgetWindowCaches.get(workspaceId)
  if (budgetWindowCache && budgetWindowCache.expiresAt > now) {
    const next = advanceExpiredWindow(budgetWindowCache.value, now)
    if (next === budgetWindowCache.value) return next
  }
  const budgetWindowInflight = budgetWindowInflights.get(workspaceId)
  if (budgetWindowInflight) return budgetWindowInflight

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = (async () => {
    const ref = windowRef()
    const snapshot = await ref.get()
    const current = snapshot.exists ? { ...defaultWindow(), ...snapshot.data() } as BudgetWindow : defaultWindow()
    const next = advanceExpiredWindow(current)
    if (snapshot.exists && next === current) return next

    let result = next
    await db().runTransaction(async (transaction) => {
      const latest = await transaction.get(ref)
      const latestWindow = latest.exists ? { ...defaultWindow(), ...latest.data() } as BudgetWindow : defaultWindow()
      const advanced = advanceExpiredWindow(latestWindow)
      if (!latest.exists) transaction.create(ref, advanced)
      else if (advanced !== latestWindow) transaction.set(ref, advanced)
      result = advanced
    })
    return result
  })().then((window) => {
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetWindowCaches, workspaceId, { value: window, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
    return window
  }).finally(() => {
    if (budgetWindowInflights.get(workspaceId) === promise) budgetWindowInflights.delete(workspaceId)
  })
  budgetWindowInflights.set(workspaceId, promise)
  return promise
}
async function resolveCodexBudgetWindow(accountId: string | null | undefined) {
  const { accounts } = await listCodexAccounts()
  if (!accounts.length) throw new Error("Connect a Codex account before syncing the budget window.")
  const account = accounts.find((entry) => entry.id === accountId) || (accountId ? undefined : accounts[0])
  if (!account) throw new Error("The selected Codex account was not found.")
  const usage = await getCodexUsageForAccount(account)
  const resetAt = usage.weekly?.resetAt
  if (!resetAt) throw new Error("The selected Codex account has no weekly reset time available.")
  const end = new Date(resetAt)
  if (!Number.isFinite(end.getTime())) throw new Error("The selected Codex account returned an invalid weekly reset time.")
  const start = addZonedDays(end, -7)
  return { start: start.toISOString(), end: end.toISOString(), anchor: "codex" as const, codexAccountId: account.id }
}

export async function updateBudgetWindow(input: Partial<BudgetWindow> & { anchor?: BudgetWindowAnchor; codexAccountId?: string | null }) {
  const current = await getBudgetWindow()
  let base = current
  if (input.bypassLimits !== undefined && input.bypassLimits !== current.bypassLimits) base = (await setBudgetBypassEnabled(input.bypassLimits)).window
  const anchor = input.anchor || base.anchor || "custom"
  let next = { ...base, ...input, anchor, bypassSessionId: base.bypassSessionId, updatedAt: new Date().toISOString() } as BudgetWindow
  if (anchor === "codex" && (input.anchor === "codex" || input.codexAccountId !== undefined)) {
    next = { ...next, ...await resolveCodexBudgetWindow(input.codexAccountId ?? base.codexAccountId) }
  } else if (anchor === "custom") {
    next = { ...next, anchor: "custom", codexAccountId: null }
  }
  const start = new Date(next.start)
  const end = new Date(next.end)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("Invalid budget window.")
  if (isMemory()) memoryState().window = next
  else await windowRef().set(next)
  invalidateBudgetReadCaches()
  if (!isMemory()) boundedSet(budgetWindowCaches, currentWorkspaceId(), { value: next, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
  return next
}

export async function setBudgetBypassEnabled(enabled: boolean): Promise<{ window: BudgetWindow; session: BudgetBypassSession | null }> {
  const now = new Date().toISOString()
  if (isMemory()) {
    const current = await getBudgetWindow()
    if (current.bypassLimits === enabled && (!enabled || current.bypassSessionId)) {
      return { window: current, session: enabled && current.bypassSessionId ? memoryState().bypassSessions.get(current.bypassSessionId) || null : null }
    }
    let session: BudgetBypassSession | null = null
    if (enabled) {
      session = { id: crypto.randomUUID(), startedAt: now, endedAt: null }
      memoryState().bypassSessions.set(session.id, session)
    } else if (current.bypassSessionId) {
      const active = memoryState().bypassSessions.get(current.bypassSessionId)
      if (active) { session = { ...active, endedAt: now }; memoryState().bypassSessions.set(session.id, session) }
    } else if (current.bypassLimits) {
      session = { id: crypto.randomUUID(), startedAt: current.updatedAt, endedAt: now }
      memoryState().bypassSessions.set(session.id, session)
    }
    const next: BudgetWindow = { ...current, bypassLimits: enabled, bypassSessionId: enabled ? session?.id || null : null, updatedAt: now }
    memoryState().window = next
    invalidateBudgetReadCaches()
    return { window: next, session: enabled ? session : null }
  }

  let result: { window: BudgetWindow; session: BudgetBypassSession | null } = { window: defaultWindow(), session: null }
  await db().runTransaction(async (transaction) => {
    const ref = windowRef()
    const snapshot = await transaction.get(ref)
    const current = snapshot.exists ? { ...defaultWindow(), ...snapshot.data() } as BudgetWindow : defaultWindow()
    if (current.bypassLimits === enabled && (!enabled || current.bypassSessionId)) {
      result = { window: current, session: enabled && current.bypassSessionId ? { id: current.bypassSessionId, startedAt: current.updatedAt, endedAt: null } : null }
      return
    }
    let session: BudgetBypassSession | null = null
    let sessionId: string | null = null
    if (enabled) {
      session = { id: crypto.randomUUID(), startedAt: now, endedAt: null }
      sessionId = session.id
      transaction.create(bypassSessionsRef().doc(session.id), session)
    } else if (current.bypassSessionId) {
      sessionId = current.bypassSessionId
      transaction.set(bypassSessionsRef().doc(sessionId), { endedAt: now, updatedAt: now }, { merge: true })
    } else if (current.bypassLimits) {
      session = { id: crypto.randomUUID(), startedAt: current.updatedAt, endedAt: now }
      transaction.create(bypassSessionsRef().doc(session.id), session)
    }
    const next: BudgetWindow = { ...current, bypassLimits: enabled, bypassSessionId: enabled ? sessionId : null, updatedAt: now }
    transaction.set(ref, next)
    result = { window: next, session: enabled ? session : null }
  })
  invalidateBudgetReadCaches()
  boundedSet(budgetWindowCaches, currentWorkspaceId(), { value: result.window, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
  return result
}
export async function upsertBudget(input: { apiKeyId: string; weeklyLimitMicros: number; enabled: boolean }) {
  if (!Number.isSafeInteger(input.weeklyLimitMicros) || input.weeklyLimitMicros <= 0) throw new Error("Weekly budget must be a positive safe integer in micros.")
  if (!(await listApiKeys()).some((apiKey) => apiKey.id === input.apiKeyId)) throw new Error("API key not found in the selected workspace.")
  const window = await getBudgetWindow()
  const budget: GatewayKeyBudget = {
    ...input,
    spentMicros: 0,
    windowStart: window.start,
    windowEnd: window.end,
    updatedAt: new Date().toISOString(),
  }
  if (isMemory()) memoryState().budgets.set(input.apiKeyId, budget)
  else await budgetsRef().doc(input.apiKeyId).set(budget)
  invalidateBudgetReadCaches()
  return budget
}
export async function deleteBudget(apiKeyId: string) {
  if (isMemory()) memoryState().budgets.delete(apiKeyId)
  else await budgetsRef().doc(apiKeyId).delete()
  invalidateBudgetReadCaches()
}

async function listBudgetCounters(usageStart: string, bypassCache = false): Promise<BudgetCounterRow[]> {
  if (isMemory()) return [...memoryState().budgetCounters.entries()].map(([id, value]) => ({ id, ...value }))
  const now = Date.now()
  const workspaceId = currentWorkspaceId()
  const cacheId = scopedKey(usageStart)
  if (!bypassCache) {
    const cached = budgetCounterListCache.get(cacheId)
    if (cached && cached.expiresAt > now) return cached.value
    const existing = budgetCounterListInflight.get(cacheId)
    if (existing) return existing
  }

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = budgetCountersRef().where("usageStartAt", "==", usageStart).get().then((snapshot) => {
    const rows = snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as Omit<BudgetCounterRow, "id">) }))
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetCounterListCache, cacheId, { value: rows, expiresAt: Date.now() + budgetCounterCacheTtlMs }, 8)
    return rows
  }).finally(() => {
    if (budgetCounterListInflight.get(cacheId) === promise) budgetCounterListInflight.delete(cacheId)
  })
  if (!bypassCache) budgetCounterListInflight.set(cacheId, promise)
  return promise
}

function addBudgetUsage(map: Map<string, BudgetUsageValue>, rollup: UsageRollup) {
  if (!rollup.gatewayKeyId) return
  const current = map.get(rollup.gatewayKeyId) || { spentMicros: 0, lastUsedAt: null }
  const lastUsedAt = rollup.lastEventAt && (!current.lastUsedAt || current.lastUsedAt < rollup.lastEventAt) ? rollup.lastEventAt : current.lastUsedAt
  map.set(rollup.gatewayKeyId, { spentMicros: current.spentMicros + safeUsageInteger(rollup.costMicros), lastUsedAt })
}

function addBudgetEvent(map: Map<string, BudgetUsageValue>, event: UsageEvent) {
  if (event.status < 200 || event.status >= 300) return
  const current = map.get(event.gatewayKeyId) || { spentMicros: 0, lastUsedAt: null }
  const lastUsedAt = !current.lastUsedAt || current.lastUsedAt < event.completedAt ? event.completedAt : current.lastUsedAt
  map.set(event.gatewayKeyId, { spentMicros: current.spentMicros + safeUsageInteger(event.costMicros), lastUsedAt })
}

function safeUsageInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed)) : 0
}

/**
 * Unlimited Mode is a session boundary, not a calendar bucket. For that
 * window the event ledger is the canonical source: calendar rollups include
 * traffic before the session started and proportional scaling can otherwise
 * erase a busy boundary minute. Rollups remain a guarded fallback for a key
 * that has aggregate-only usage but no successful event documents at all.
 */
async function getBypassBudgetUsage(start: Date, end: Date) {
  const [events, hourly, daily] = await Promise.all([
    listUsageEvents(start.toISOString(), end.toISOString()),
    listUsageRollups("hourly", bucketStart(start, "hourly").toISOString(), nextBucketStart(end, "hourly").toISOString()),
    listUsageRollups("daily", bucketStart(start, "daily").toISOString(), nextBucketStart(end, "daily").toISOString()),
  ])
  const result = new Map<string, BudgetUsageValue>()
  const eventHourlyDimensions = new Set<string>()
  const eventDailyDimensions = new Set<string>()
  const eventHourlyKeyBuckets = new Set<string>()
  const eventDailyKeyBuckets = new Set<string>()
  for (const event of events) {
    if (event.status < 200 || event.status >= 300) continue
    const completedAt = new Date(event.completedAt)
    const hourlyBucket = bucketStart(completedAt, "hourly").toISOString()
    const dailyBucket = bucketStart(completedAt, "daily").toISOString()
    eventHourlyDimensions.add(usageDimensionKey(event.gatewayKeyId, event.gatewayModelId, hourlyBucket))
    eventDailyDimensions.add(usageDimensionKey(event.gatewayKeyId, event.gatewayModelId, dailyBucket))
    eventHourlyKeyBuckets.add(`${event.gatewayKeyId}:${hourlyBucket}`)
    eventDailyKeyBuckets.add(`${event.gatewayKeyId}:${dailyBucket}`)
    addBudgetEvent(result, event)
  }

  // A migrated aggregate has no event identity to reconcile. Only use it when
  // its key/model/bucket has no successful event records, and prefer hourly
  // rows so a daily aggregate cannot be added on top of the same usage.
  const fallbackHourlyGroups = new Set<string>()
  const fallbackHourlyKeyDays = new Set<string>()
  const eligibleFallback = (rollup: UsageRollup) => {
    if (!rollup.gatewayKeyId) return false
    const bucketStartMs = Date.parse(rollup.bucketStart)
    const bucketEndMs = nextBucketStart(new Date(bucketStartMs), rollup.granularity).getTime()
    const lastEventMs = rollup.lastEventAt ? Date.parse(rollup.lastEventAt) : NaN
    const bucket = rollup.granularity === "hourly"
      ? bucketStart(new Date(rollup.bucketStart), "hourly").toISOString()
      : bucketStart(new Date(rollup.bucketStart), "daily").toISOString()
    const dimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, bucket)
    const hasEvent = rollup.granularity === "hourly"
      ? (rollup.gatewayModelId ? eventHourlyDimensions.has(dimension) : eventHourlyKeyBuckets.has(`${rollup.gatewayKeyId}:${bucket}`))
      : (rollup.gatewayModelId ? eventDailyDimensions.has(dimension) : eventDailyKeyBuckets.has(`${rollup.gatewayKeyId}:${bucket}`))
    return Number.isFinite(bucketStartMs) && Number.isFinite(lastEventMs) &&
      bucketEndMs > start.getTime() && bucketStartMs < end.getTime() &&
      lastEventMs >= start.getTime() && lastEventMs < end.getTime() && !hasEvent
  }
  for (const rollup of hourly) {
    if (!eligibleFallback(rollup)) continue
    addBudgetUsage(result, scaleUsageRollupToRange(rollup, start, end))
    const day = bucketStart(new Date(rollup.bucketStart), "daily").toISOString()
    fallbackHourlyKeyDays.add(`${rollup.gatewayKeyId}:${day}`)
    if (rollup.gatewayModelId) fallbackHourlyGroups.add(`${rollup.gatewayKeyId}:${rollup.gatewayModelId}:${day}`)
  }
  for (const rollup of daily) {
    if (!eligibleFallback(rollup)) continue
    const day = bucketStart(new Date(rollup.bucketStart), "daily").toISOString()
    const group = `${rollup.gatewayKeyId}:${rollup.gatewayModelId || ""}:${day}`
    if (rollup.gatewayModelId ? fallbackHourlyGroups.has(group) : fallbackHourlyKeyDays.has(`${rollup.gatewayKeyId}:${day}`)) continue
    addBudgetUsage(result, scaleUsageRollupToRange(rollup, start, end))
  }
  return result
}

async function getBudgetUsage(window: BudgetWindow, bypassCache = false): Promise<Map<string, BudgetUsageValue>> {
  const usageStartAt = await budgetUsageStart(window)
  const workspaceId = currentWorkspaceId()
  const cacheId = scopedKey(`${usageStartAt}:${window.end}`)
  const now = Date.now()
  if (!bypassCache) {
    const cached = budgetUsageCache.get(cacheId)
    if (cached && cached.expiresAt > now) return cached.value
    const existing = budgetUsageInflight.get(cacheId)
    if (existing) return existing
  }

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const start = new Date(usageStartAt)
  const end = new Date(window.end)
  const promise = (async () => {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return new Map<string, BudgetUsageValue>()
    if (window.bypassLimits) return getBypassBudgetUsage(start, end)

    const hourlyFrom = bucketStart(start, "hourly").toISOString()
    const hourlyTo = nextBucketStart(end, "hourly").toISOString()
    const dailyFrom = bucketStart(start, "daily").toISOString()
    const dailyTo = nextBucketStart(end, "daily").toISOString()
    const [hourly, daily, fullEventsResult] = await Promise.all([
      dashboardTimed("budget.hourly-rollups", listUsageRollups("hourly", hourlyFrom, hourlyTo)),
      dashboardTimed("budget.daily-rollups", listUsageRollups("daily", dailyFrom, dailyTo)),
      dashboardTimed("budget.events", listUsageEvents(start.toISOString(), end.toISOString()).then((events) => ({ events, ok: true as const })).catch(() => ({ events: [] as UsageEvent[], ok: false as const }))),
    ])
    const fullEvents = fullEventsResult.events
    const allEventCountsByKey = new Map<string, number>()
    const hourlyStatsByKey = new Map<string, { requests: number; hasBackfill: boolean }>()
    const dailyStatsByKey = new Map<string, { requests: number; hasBackfill: boolean }>()
    for (const event of fullEvents) allEventCountsByKey.set(event.gatewayKeyId, (allEventCountsByKey.get(event.gatewayKeyId) || 0) + 1)
    for (const rollup of hourly) {
      if (!rollup.gatewayKeyId) continue
      const bucketTime = Date.parse(rollup.bucketStart)
      const bucketEnd = Number.isFinite(bucketTime) ? nextBucketStart(new Date(bucketTime), "hourly").getTime() : NaN
      if (!Number.isFinite(bucketTime) || bucketTime >= end.getTime() || bucketEnd <= start.getTime()) continue
      const current = hourlyStatsByKey.get(rollup.gatewayKeyId) || { requests: 0, hasBackfill: false }
      current.requests += Math.max(0, Number(rollup.requests || 0))
      current.hasBackfill ||= Boolean(rollup.backfillSource)
      hourlyStatsByKey.set(rollup.gatewayKeyId, current)
    }
    for (const rollup of daily) {
      if (!rollup.gatewayKeyId) continue
      const bucketTime = Date.parse(rollup.bucketStart)
      const bucketEnd = Number.isFinite(bucketTime) ? nextBucketStart(new Date(bucketTime), "daily").getTime() : NaN
      if (!Number.isFinite(bucketTime) || bucketTime >= end.getTime() || bucketEnd <= start.getTime()) continue
      const current = dailyStatsByKey.get(rollup.gatewayKeyId) || { requests: 0, hasBackfill: false }
      current.requests += Math.max(0, Number(rollup.requests || 0))
      current.hasBackfill ||= Boolean(rollup.backfillSource)
      dailyStatsByKey.set(rollup.gatewayKeyId, current)
    }
    const canonicalEventKeys = new Set<string>()
    if (fullEventsResult.ok) {
      const candidateKeys = new Set([...allEventCountsByKey.keys(), ...hourlyStatsByKey.keys(), ...dailyStatsByKey.keys()])
      for (const key of candidateKeys) {
        const hourlyStats = hourlyStatsByKey.get(key)
        const rollupStats = hourlyStats || dailyStatsByKey.get(key)
        const eventCount = allEventCountsByKey.get(key) || 0
        // A pure runtime key whose rollup request count matches the event
        // ledger is safe to read directly from events, including partial
        // calendar boundaries. Mixed aggregate/runtime keys stay on the
        // dimension-aware fallback below.
        if (!rollupStats || (!rollupStats.hasBackfill && rollupStats.requests === eventCount && eventCount > 0)) canonicalEventKeys.add(key)
      }
    }

    const hourlyBoundary = dashboardBoundaryRanges(start, end, "hourly")
    // Backfilled CCS data may have daily rollups but no usage-event documents.
    // Keep a dimension-level fallback for those boundary buckets so an empty
    // event query does not erase historical spend.
    const dailyBoundaryRanges: Array<[Date, Date]> = []
    const result = new Map<string, BudgetUsageValue>()
    const hourlyRequestTotals = new Map<string, number>()
    const hourlyRequestTotalsByKeyDay = new Map<string, number>()
    const hourlyRequestTotalsByDay = new Map<string, number>()
    const hourlyRequestTotalsByKeyDayFull = new Map<string, number>()
    const hourlyRowsByDimension = new Set<string>()
    const hourlyRowsByBucket = new Set<string>()
    for (const rollup of hourly) {
      const bucketTime = Date.parse(rollup.bucketStart)
      if (!Number.isFinite(bucketTime)) continue
      const bucketStartDate = new Date(bucketTime)
      if (rollup.gatewayKeyId) {
        const day = bucketStart(bucketStartDate, "daily").toISOString()
        const dimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, day)
        const keyDay = `${rollup.gatewayKeyId}:${day}`
        const requests = Math.max(0, Number(rollup.requests || 0))
        hourlyRequestTotalsByDay.set(dimension, (hourlyRequestTotalsByDay.get(dimension) || 0) + requests)
        hourlyRequestTotalsByKeyDayFull.set(keyDay, (hourlyRequestTotalsByKeyDayFull.get(keyDay) || 0) + requests)
      }
      const overlapsWindow = nextBucketStart(bucketStartDate, "hourly") > start && bucketStartDate < end
      if (rollup.gatewayKeyId && overlapsWindow) {
        const day = bucketStart(bucketStartDate, "daily").toISOString()
        const dimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, day)
        const keyDay = `${rollup.gatewayKeyId}:${day}`
        hourlyRequestTotals.set(dimension, (hourlyRequestTotals.get(dimension) || 0) + Math.max(0, Number(rollup.requests || 0)))
        hourlyRequestTotalsByKeyDay.set(keyDay, (hourlyRequestTotalsByKeyDay.get(keyDay) || 0) + Math.max(0, Number(rollup.requests || 0)))
        if (rollup.gatewayModelId) hourlyRowsByDimension.add(usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, rollup.bucketStart))
        else hourlyRowsByBucket.add(`${rollup.gatewayKeyId}:${rollup.bucketStart}`)
      }
    }

    const completeHourlyDimensions = new Set<string>()
    const completeHourlyBuckets = new Set<string>()
    const fallbackDailyDimensions = new Set<string>()
    const fallbackDailyBuckets = new Set<string>()
    // Prefer hourly data only when it covers the same request count as the
    // daily row. Merely having one hourly document is not proof of complete
    // coverage; otherwise a partial hourly backfill silently undercounts.
    for (const rollup of daily) {
      const bucketTime = Date.parse(rollup.bucketStart)
      if (!Number.isFinite(bucketTime) || bucketTime >= end.getTime() || !rollup.gatewayKeyId) continue
      const dayStart = new Date(bucketTime)
      const dayEnd = nextBucketStart(dayStart, "daily")
      if (dayEnd.getTime() <= start.getTime()) continue
      const day = bucketStart(dayStart, "daily").toISOString()
      const dimensionKey = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, day)
      const dayKey = `${rollup.gatewayKeyId}:${day}`
      const hourlyRequests = rollup.gatewayModelId
        ? hourlyRequestTotalsByDay.get(dimensionKey) || 0
        : hourlyRequestTotalsByKeyDayFull.get(dayKey) || 0
      const dailyRequests = Math.max(0, Number(rollup.requests || 0))
      const hourlyCoversWholeDay = dailyRequests > 0 && hourlyRequests === dailyRequests
      const fullDay = dayStart >= start && dayEnd <= end
      if (fullDay && hourlyCoversWholeDay) {
        if (rollup.gatewayModelId) completeHourlyDimensions.add(dimensionKey)
        else completeHourlyBuckets.add(dayKey)
      } else if (!hourlyCoversWholeDay) {
        if (rollup.gatewayModelId) fallbackDailyDimensions.add(dimensionKey)
        else fallbackDailyBuckets.add(dayKey)
      }
      if (!fullDay) {
        dailyBoundaryRanges.push([new Date(Math.max(start.getTime(), dayStart.getTime())), new Date(Math.min(end.getTime(), dayEnd.getTime()))])
      }
    }

    const boundaryRanges = mergeDateRanges([...hourlyBoundary.ranges, ...dailyBoundaryRanges])
    const boundaryResults = await dashboardTimed("budget.boundary-events", settledParallelMap(boundaryRanges, ([from, to]) => listUsageEvents(from.toISOString(), to.toISOString())))
    const boundaryDataAvailable = boundaryResults.every((entry) => entry.status === "fulfilled")
    const boundaryEvents = uniqueUsageEvents(boundaryResults.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []))
    const hourlyEventCounts = new Map<string, number>()
    const dailyEventCounts = new Map<string, number>()
    const hourlyEventBucketCounts = new Map<string, number>()
    const dailyEventBucketCounts = new Map<string, number>()
    for (const event of boundaryEvents) {
      const completedAt = new Date(event.completedAt)
      const hourlyKey = usageDimensionKey(event.gatewayKeyId, event.gatewayModelId, bucketStart(completedAt, "hourly").toISOString())
      const dailyKey = usageDimensionKey(event.gatewayKeyId, event.gatewayModelId, bucketStart(completedAt, "daily").toISOString())
      hourlyEventCounts.set(hourlyKey, (hourlyEventCounts.get(hourlyKey) || 0) + 1)
      dailyEventCounts.set(dailyKey, (dailyEventCounts.get(dailyKey) || 0) + 1)
      const hourlyBucket = `${event.gatewayKeyId}:${bucketStart(completedAt, "hourly").toISOString()}`
      const dailyBucket = `${event.gatewayKeyId}:${bucketStart(completedAt, "daily").toISOString()}`
      hourlyEventBucketCounts.set(hourlyBucket, (hourlyEventBucketCounts.get(hourlyBucket) || 0) + 1)
      dailyEventBucketCounts.set(dailyBucket, (dailyEventBucketCounts.get(dailyBucket) || 0) + 1)
    }

    type BoundaryResolution = "replace" | "preserve" | "zero"
    const hourlyBoundaryDimensions = new Map<string, BoundaryResolution>()
    const hourlyBoundaryBuckets = new Map<string, BoundaryResolution>()
    const dailyBoundaryDimensions = new Map<string, BoundaryResolution>()
    const dailyBoundaryBuckets = new Map<string, BoundaryResolution>()
    const boundaryResolution = (rollup: UsageRollup, eventCount: number): BoundaryResolution => {
      const requestCount = Math.max(0, Number(rollup.requests || 0))
      // For a runtime rollup, events are the only exact source for a partial
      // time slice. The slice can contain fewer events than the full bucket
      // because traffic before the range start is intentionally excluded.
      if (!rollup.backfillSource) {
        if (eventCount > 0) return "replace"
        return "zero"
      }
      if (eventCount === requestCount && requestCount > 0) return "replace"
      // A runtime rollup is written with one event per request. An empty,
      // successful boundary query therefore proves zero traffic in the slice.
      // Aggregate-only backfills do not have that proof and must be estimated.
      if (!rollup.backfillSource && eventCount === 0) return "zero"
      return "preserve"
    }
    for (const rollup of hourly) {
      if (!hourlyBoundary.partialBucketStarts.has(rollup.bucketStart)) continue
      const dimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, rollup.bucketStart)
      const eventCount = rollup.gatewayModelId
        ? hourlyEventCounts.get(dimension) || 0
        : hourlyEventBucketCounts.get(`${rollup.gatewayKeyId}:${rollup.bucketStart}`) || 0
      const resolution = boundaryDataAvailable ? boundaryResolution(rollup, eventCount) : "preserve"
      if (rollup.gatewayKeyId && rollup.gatewayModelId) hourlyBoundaryDimensions.set(dimension, resolution)
      else if (rollup.gatewayKeyId) hourlyBoundaryBuckets.set(`${rollup.gatewayKeyId}:${rollup.bucketStart}`, resolution)
    }
    for (const rollup of daily) {
      const bucket = bucketStart(new Date(rollup.bucketStart), "daily").toISOString()
      if (!dailyBoundaryRanges.some(([from, to]) => new Date(bucket).getTime() < to.getTime() && new Date(nextBucketStart(new Date(bucket), "daily")).getTime() > from.getTime())) continue
      const dimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, bucket)
      const eventCount = rollup.gatewayModelId
        ? dailyEventCounts.get(dimension) || 0
        : dailyEventBucketCounts.get(`${rollup.gatewayKeyId}:${bucket}`) || 0
      const resolution = boundaryDataAvailable ? boundaryResolution(rollup, eventCount) : "preserve"
      if (rollup.gatewayKeyId && rollup.gatewayModelId) dailyBoundaryDimensions.set(dimension, resolution)
      else if (rollup.gatewayKeyId) dailyBoundaryBuckets.set(`${rollup.gatewayKeyId}:${bucket}`, resolution)
    }

    for (const rollup of hourly) {
      const bucketTime = Date.parse(rollup.bucketStart)
      const bucketEnd = Number.isFinite(bucketTime) ? nextBucketStart(new Date(bucketTime), "hourly").getTime() : NaN
      if (!Number.isFinite(bucketTime) || bucketTime >= end.getTime() || bucketEnd <= start.getTime()) continue
      if (rollup.gatewayKeyId && canonicalEventKeys.has(rollup.gatewayKeyId)) continue
      const hourlyDimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, rollup.bucketStart)
      const hourlyDay = bucketStart(new Date(rollup.bucketStart), "daily").toISOString()
      const hourlyDayKey = `${rollup.gatewayKeyId}:${hourlyDay}`
      const hourlyDayDimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, hourlyDay)
      if (fallbackDailyDimensions.has(hourlyDayDimension) || fallbackDailyBuckets.has(hourlyDayKey)) continue
      const resolution = rollup.gatewayKeyId && rollup.gatewayModelId
        ? hourlyBoundaryDimensions.get(hourlyDimension)
        : hourlyBoundaryBuckets.get(`${rollup.gatewayKeyId}:${rollup.bucketStart}`)
      if (hourlyBoundary.partialBucketStarts.has(rollup.bucketStart) && boundaryDataAvailable && (resolution === "replace" || resolution === "zero")) continue
      addBudgetUsage(
        result,
        hourlyBoundary.partialBucketStarts.has(rollup.bucketStart)
          ? scaleUsageRollupToRange(rollup, start, end)
          : rollup,
      )
    }

    for (const rollup of daily) {
      const bucketTime = Date.parse(rollup.bucketStart)
      if (!Number.isFinite(bucketTime) || bucketTime >= end.getTime() || !rollup.gatewayKeyId) continue
      if (canonicalEventKeys.has(rollup.gatewayKeyId)) continue
      const dayStart = new Date(bucketTime)
      const dayEnd = nextBucketStart(dayStart, "daily")
      const dailyBucket = bucketStart(dayStart, "daily").toISOString()
      const dailyDimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, dailyBucket)
      const dailyDayKey = `${rollup.gatewayKeyId}:${dailyBucket}`
      const fullDay = dayStart >= start && dayEnd <= end
      const hasHourlyForDimension = rollup.gatewayModelId
        ? hourlyRequestTotals.has(dailyDimension)
        : hourlyRequestTotalsByKeyDay.has(dailyDayKey)
      const fallbackDaily = rollup.gatewayModelId
        ? fallbackDailyDimensions.has(dailyDimension)
        : fallbackDailyBuckets.has(dailyDayKey)
      if (fallbackDaily) {
        const resolution = rollup.gatewayKeyId && rollup.gatewayModelId
          ? dailyBoundaryDimensions.get(dailyDimension)
          : dailyBoundaryBuckets.get(`${rollup.gatewayKeyId}:${dailyBucket}`)
        if (boundaryDataAvailable && (resolution === "replace" || resolution === "zero")) continue
        addBudgetUsage(result, fullDay ? rollup : scaleUsageRollupToRange(rollup, start, end))
        continue
      }
      if (fullDay) {
        if (rollup.gatewayModelId ? completeHourlyDimensions.has(dailyDimension) : completeHourlyBuckets.has(dailyDayKey)) continue
        addBudgetUsage(result, rollup)
        continue
      }
      // When a partial day has hourly rows, use that higher-resolution slice
      // and do not add the overlapping daily estimate as well.
      if (hasHourlyForDimension) continue
      const resolution = rollup.gatewayKeyId && rollup.gatewayModelId
        ? dailyBoundaryDimensions.get(dailyDimension)
        : dailyBoundaryBuckets.get(`${rollup.gatewayKeyId}:${dailyBucket}`)
      if (boundaryDataAvailable && (resolution === "replace" || resolution === "zero")) continue
      addBudgetUsage(result, scaleUsageRollupToRange(rollup, start, end))
    }

    if (boundaryDataAvailable) {
      for (const event of boundaryEvents) {
        if (canonicalEventKeys.has(event.gatewayKeyId)) continue
        const completedAt = new Date(event.completedAt)
        const hourlyBucket = bucketStart(completedAt, "hourly").toISOString()
        const dailyBucket = bucketStart(completedAt, "daily").toISOString()
        const hourlyDimension = usageDimensionKey(event.gatewayKeyId, event.gatewayModelId, hourlyBucket)
        const dailyDimension = usageDimensionKey(event.gatewayKeyId, event.gatewayModelId, dailyBucket)
        const hourlyResolution = hourlyBoundaryDimensions.get(hourlyDimension) || hourlyBoundaryBuckets.get(`${event.gatewayKeyId}:${hourlyBucket}`)
        const dailyResolution = dailyBoundaryDimensions.get(dailyDimension) || dailyBoundaryBuckets.get(`${event.gatewayKeyId}:${dailyBucket}`)
        // A full hourly rollup has already contributed this event's bucket;
        // only boundary-hour replacements should add the event itself. This
        // prevents a daily boundary replacement from double-counting an event
        // that sits in a complete hourly bucket.
        const hasHourlyAggregate = hourlyRowsByDimension.has(hourlyDimension) || hourlyRowsByBucket.has(`${event.gatewayKeyId}:${hourlyBucket}`)
        if (hasHourlyAggregate && !hourlyResolution) continue
        const resolution = hourlyResolution || dailyResolution
        if (resolution === "preserve" || resolution === "zero") continue
        addBudgetEvent(result, event)
      }
    }
    for (const event of fullEvents) {
      if (canonicalEventKeys.has(event.gatewayKeyId)) addBudgetEvent(result, event)
    }
    return result
  })().then((value) => {
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetUsageCache, cacheId, { value, expiresAt: Date.now() + dashboardCacheTtlMs }, 128)
    return value
  }).finally(() => {
    if (budgetUsageInflight.get(cacheId) === promise) budgetUsageInflight.delete(cacheId)
  })
  if (!bypassCache) budgetUsageInflight.set(cacheId, promise)
  return promise
}

function budgetBaselineFields(budget: GatewayKeyBudget, usageStart: string, window: BudgetWindow, baseline: BudgetCounterBaseline) {
  return {
    baselineUsageStartAt: usageStart,
    baselineWindowEnd: window.end,
    baselineRevision: budgetBaselineRevision(budget, window),
    baselineOffsetMicros: baseline.offsetMicros,
    baselineLastUsedAt: baseline.lastUsedAt,
  } satisfies Pick<GatewayKeyBudget, "baselineUsageStartAt" | "baselineWindowEnd" | "baselineRevision" | "baselineOffsetMicros" | "baselineLastUsedAt">
}

function persistedBudgetCounterBaseline(budget: GatewayKeyBudget, usageStart: string, window: BudgetWindow) {
  if (
    budget.baselineUsageStartAt !== usageStart ||
    budget.baselineWindowEnd !== window.end ||
    budget.baselineRevision !== budgetBaselineRevision(budget, window)
  ) return undefined
  const offsetMicros = Number(budget.baselineOffsetMicros)
  if (!Number.isFinite(offsetMicros)) return undefined
  return {
    offsetMicros,
    lastUsedAt: typeof budget.baselineLastUsedAt === "string" ? budget.baselineLastUsedAt : null,
    expiresAt: budgetCounterBaselineExpiresAt(window.end),
    stable: true,
    durable: true,
  } satisfies BudgetCounterBaseline
}

function setBudgetCounterBaseline(budget: GatewayKeyBudget, usageStart: string, window: BudgetWindow, counterSpentMicros: number, usage?: BudgetUsageValue) {
  const baseline: BudgetCounterBaseline = {
    offsetMicros: usage ? Number(usage.spentMicros) - counterSpentMicros : 0,
    lastUsedAt: usage?.lastUsedAt || null,
    expiresAt: Date.now() + dashboardCacheTtlMs,
    stable: false,
  }
  boundedSet(budgetCounterBaselineCache, budgetCounterBaselineId(budget, usageStart, window), baseline)
  return baseline
}

function getBudgetCounterBaseline(budget: GatewayKeyBudget, usageStart: string, window: BudgetWindow, requireStable = false) {
  const key = budgetCounterBaselineId(budget, usageStart, window)
  const baseline = budgetCounterBaselineCache.get(key)
  if (baseline && baseline.expiresAt > Date.now() && (!requireStable || baseline.stable)) return baseline
  if (baseline && baseline.expiresAt <= Date.now()) budgetCounterBaselineCache.delete(key)
  const persisted = persistedBudgetCounterBaseline(budget, usageStart, window)
  if (persisted) boundedSet(budgetCounterBaselineCache, key, persisted)
  return persisted
}

async function persistBudgetCounterBaseline(budget: GatewayKeyBudget, usageStart: string, window: BudgetWindow, baseline: BudgetCounterBaseline) {
  const fields = budgetBaselineFields(budget, usageStart, window, baseline)
  if (isMemory()) memoryState().budgets.set(budget.apiKeyId, { ...budget, ...fields })
  else await budgetsRef().doc(budget.apiKeyId).set(fields, { merge: true })
  Object.assign(budget, fields)
}

interface BudgetBaselineWrite {
  budget: GatewayKeyBudget
  usageStart: string
  window: BudgetWindow
  baseline: BudgetCounterBaseline
}

async function persistBudgetCounterBaselines(entries: BudgetBaselineWrite[]) {
  const persisted = new Set<string>()
  if (!entries.length) return persisted
  if (isMemory()) {
    for (const entry of entries) {
      await persistBudgetCounterBaseline(entry.budget, entry.usageStart, entry.window, entry.baseline)
      persisted.add(entry.budget.apiKeyId)
    }
    return persisted
  }

  // Leave headroom below Firestore's batch-operation limit and keep failures
  // isolated so a shared-cache write never breaks the dashboard or admission.
  for (let offset = 0; offset < entries.length; offset += 400) {
    const chunk = entries.slice(offset, offset + 400)
    const batch = db().batch()
    for (const entry of chunk) {
      batch.set(
        budgetsRef().doc(entry.budget.apiKeyId),
        budgetBaselineFields(entry.budget, entry.usageStart, entry.window, entry.baseline),
        { merge: true },
      )
    }
    try {
      await batch.commit()
      for (const entry of chunk) {
        Object.assign(entry.budget, budgetBaselineFields(entry.budget, entry.usageStart, entry.window, entry.baseline))
        persisted.add(entry.budget.apiKeyId)
      }
    } catch {
      // Best-effort cache materialization. A later read retries safely.
    }
  }
  return persisted
}

function baselinePersistenceEligibleAt(budget: GatewayKeyBudget, window: BudgetWindow) {
  const revisionAt = Math.max(Date.parse(budget.updatedAt) || 0, Date.parse(window.updatedAt) || 0)
  // A peer can keep an old budget/window decision until its local cache expires,
  // then finish an already-admitted request at the configured proxy deadline.
  // Persist only after both periods pass so late usage cannot permanently fall
  // outside the counter baseline shared by future instances.
  return revisionAt + budgetCacheTtlMs + maximumBudgetContextLagMs
}

function reconciledBudgetCounterBaseline(
  budget: GatewayKeyBudget,
  window: BudgetWindow,
  counterBefore: number,
  counterAfter: number,
  usage?: BudgetUsageValue,
) {
  const now = Date.now()
  const stable = counterBefore === counterAfter
  const persistenceEligibleAt = baselinePersistenceEligibleAt(budget, window)
  const canPersist = stable && now >= persistenceEligibleAt
  const baseline: BudgetCounterBaseline = {
    offsetMicros: Number(usage?.spentMicros || 0) - counterBefore,
    lastUsedAt: usage?.lastUsedAt || null,
    expiresAt: canPersist
      ? budgetCounterBaselineExpiresAt(window.end)
      : stable
        ? Math.max(now + 1_000, Math.min(now + dashboardCacheTtlMs, persistenceEligibleAt))
        : now + 5_000,
    stable,
    durable: false,
  }
  return {
    baseline,
    canPersist,
  }
}

async function budgetCounterFresh(apiKeyId: string, usageStart: string) {
  const id = budgetCounterId(apiKeyId, usageStart)
  if (isMemory()) return memoryState().budgetCounters.get(id)?.spentMicros || 0
  const snapshot = await budgetCountersRef().doc(id).get()
  const spentMicros = safeUsageInteger((snapshot.data() as { spentMicros?: number } | undefined)?.spentMicros)
  boundedSet(budgetCounterCache, scopedKey(id), { value: spentMicros, expiresAt: Date.now() + budgetCounterCacheTtlMs })
  return spentMicros
}

async function budgetSpentMicros(budget: GatewayKeyBudget, window: BudgetWindow, usageStart: string) {
  // Unlimited Mode has a session-specific event-time boundary. Historical
  // migration/reconciliation can make the durable counter or its old baseline
  // stale, so the display and post-session accounting must use reconciled
  // usage for this window instead of carrying an ingestion-era offset.
  if (window.bypassLimits) {
    const usage = await getBudgetUsage(window)
    return Math.max(0, Number(usage.get(budget.apiKeyId)?.spentMicros || 0))
  }
  // A migrated counter can lag the event/rollup ledger, while reservations
  // can be ahead of it. Use the ledger as the lower bound and retain the raw
  // counter (plus any known baseline offset) as the reservation-aware bound.
  // This keeps admission accurate after migration without allowing concurrent
  // reservations to spend against a stale lower counter.
  const reconciledUsage = await getBudgetUsage(window).catch(() => undefined)
  const reconciledSpent = safeUsageInteger(reconciledUsage?.get(budget.apiKeyId)?.spentMicros)
  const cachedBaseline = getBudgetCounterBaseline(budget, usageStart, window, true)
  if (cachedBaseline) {
    const counterSpent = await budgetCounter(budget.apiKeyId, usageStart)
    const baselineSpent = Math.max(0, counterSpent + safeUsageInteger(cachedBaseline.offsetMicros))
    return Math.max(reconciledSpent, baselineSpent)
  }

  // A fresh counter -> usage -> counter sequence detects whether a concurrent
  // atomic usage batch crossed the reconciliation. Only a stable sequence is
  // reusable; an unstable one is returned conservatively and retried soon.
  const counterBefore = await budgetCounterFresh(budget.apiKeyId, usageStart)
  const usage = (reconciledUsage || await getBudgetUsage(window, true).catch(() => undefined))?.get(budget.apiKeyId)
  const counterAfter = await budgetCounterFresh(budget.apiKeyId, usageStart)
  const usageMicros = safeUsageInteger(usage?.spentMicros)
  const { baseline, canPersist } = reconciledBudgetCounterBaseline(budget, window, counterBefore, counterAfter, usage)
  const cacheId = budgetCounterBaselineId(budget, usageStart, window)
  boundedSet(budgetCounterBaselineCache, cacheId, baseline)
  if (canPersist) {
    try {
      await persistBudgetCounterBaseline(budget, usageStart, window, baseline)
      baseline.durable = true
    } catch {
      // Baseline persistence is a shared-cache optimization, not a reason to
      // reject an otherwise valid request. Retry after the counter cache TTL.
      baseline.expiresAt = Date.now() + budgetCounterCacheTtlMs
      boundedSet(budgetCounterBaselineCache, cacheId, baseline)
    }
  }
  if (baseline.stable) return Math.max(usageMicros, counterAfter + baseline.offsetMicros)
  return Math.max(0, usageMicros, counterAfter + Math.max(0, usageMicros - counterBefore))
}

export interface BudgetAdmission {
  key: string
  limitMicros: number
  spentMicros: number
  reservationMicros: number
  ttlSeconds: number
}

function requestOutputLimit(payload: Record<string, unknown> | undefined) {
  for (const key of ["max_output_tokens", "max_completion_tokens", "max_tokens"]) {
    const value = payload?.[key]
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

function estimateReservationMicros(
  payload: Record<string, unknown> | undefined,
  pricing: Parameters<typeof calculateCostMicros>[1],
  limitMicros: number,
  requestBodyBytes?: number,
) {
  const outputLimit = requestOutputLimit(payload) || defaultBudgetOutputTokens
  const inputBytes = requestBodyBytes ?? (payload ? Buffer.byteLength(JSON.stringify(payload)) : 0)
  const estimatedInputTokens = Math.ceil(inputBytes / budgetInputBytesPerToken)
  const usage = normalizeUsageMetrics({ input: estimatedInputTokens, output: outputLimit })
  const estimatedCost = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(calculateCostMicros(usage, pricing).costMicros * budgetReservationSafetyMultiplier))
  return Math.min(limitMicros, Math.max(1, estimatedCost))
}

function estimateExpectedCostMicros(
  payload: Record<string, unknown> | undefined,
  pricing: Parameters<typeof calculateCostMicros>[1],
  gatewayModelId: string,
  providerModelId?: string,
  requestBodyBytes?: number,
) {
  const inputBytes = requestBodyBytes ?? (payload ? Buffer.byteLength(JSON.stringify(payload)) : 0)
  const estimatedInputTokens = Math.max(1, Math.ceil(inputBytes / budgetInputBytesPerToken))
  const outputLimit = requestOutputLimit(payload)
  const historicalOutput = median(usagePredictionSamples.get(usagePredictionKey(gatewayModelId, providerModelId)) || [])
  const expectedOutputTokens = outputLimit
    ? Math.min(outputLimit, historicalOutput || defaultPredictedOutputTokens)
    : historicalOutput || defaultPredictedOutputTokens
  const usage = normalizeUsageMetrics({ input: estimatedInputTokens, output: expectedOutputTokens })
  return Math.max(1, calculateCostMicros(usage, pricing).costMicros)
}

export interface BudgetRequestState {
  admission?: BudgetAdmission
  usageContext?: BudgetUsageContext
  pricing?: ResolvedModelPricing
  /** Conservative request estimate used to settle successful responses whose
   * provider did not return complete usage metadata. */
  estimatedCostMicros?: number
}

export async function getBudgetRequestState(
  apiKeyId: string,
  gatewayModelId: string,
  providerModelId?: string,
  payload?: Record<string, unknown>,
  requestBodyBytes?: number,
): Promise<BudgetRequestState> {
  const budget = await budgetConfig(apiKeyId)
  // Pricing is needed for usage accounting even when a key has no RawRoute
  // budget. A budget is an admission policy, not a prerequisite for billing.
  let pricing: ResolvedModelPricing | undefined
  try { pricing = await getPricingForModel(gatewayModelId, providerModelId) }
  catch { pricing = undefined }
  const estimatedCostMicros = pricing
    ? estimateExpectedCostMicros(payload, pricing, gatewayModelId, providerModelId, requestBodyBytes)
    : undefined
  if (!budget) return { pricing, estimatedCostMicros }

  const window = await getBudgetWindow()
  const usageStartAt = await budgetUsageStart(window)
  const usageContext = { usageStartAt, windowEnd: window.end } satisfies BudgetUsageContext
  if (!budget.enabled || window.bypassLimits) return { usageContext, pricing, estimatedCostMicros }
  if (!pricing) throw new BudgetDeniedError("This API key cannot call a model without configured pricing.", budgetRetryAfter(window))

  const spentMicros = await budgetSpentMicros(budget, window, usageStartAt)
  if (spentMicros >= budget.weeklyLimitMicros) throw new BudgetDeniedError("Weekly budget exceeded.", budgetRetryAfter(window))
  return {
    usageContext,
    pricing,
    admission: {
      key: `rawroute:budget:v2:${currentWorkspaceId()}:${budgetCounterId(apiKeyId, usageStartAt)}:${hash(`${budget.updatedAt || ""}:${window.updatedAt || ""}`).slice(0, 16)}`,
      limitMicros: budget.weeklyLimitMicros,
      spentMicros,
      reservationMicros: estimateReservationMicros(payload, pricing, budget.weeklyLimitMicros, requestBodyBytes),
      ttlSeconds: budgetRetryAfter(window) + 60,
    },
    estimatedCostMicros,
  }
}

export async function getBudgetAdmission(
  apiKeyId: string,
  gatewayModelId: string,
  providerModelId?: string,
  payload?: Record<string, unknown>,
  requestBodyBytes?: number,
) {
  return (await getBudgetRequestState(apiKeyId, gatewayModelId, providerModelId, payload, requestBodyBytes)).admission
}

export interface BudgetReservation {
  id: string
  amountMicros: number
  usageStartAt: string
}

/**
 * Reserve the RawRoute-owned budget before a request enters CLIProxyAPI.
 * Provider rate limits and routing remain entirely outside this layer.
 */
export async function reserveBudgetAdmission(
  apiKeyId: string,
  admission: BudgetAdmission | undefined,
  usageContext: BudgetUsageContext | undefined,
) {
  if (!admission || !usageContext || admission.reservationMicros <= 0) return undefined
  const id = budgetCounterId(apiKeyId, usageContext.usageStartAt)
  const now = new Date().toISOString()
  const nextSpent = (current: number) => {
    const committed = Math.max(current, admission.spentMicros)
    if (committed + admission.reservationMicros > admission.limitMicros) throw new BudgetDeniedError("Weekly budget exceeded.", admission.ttlSeconds)
    // `current` may be a raw counter while `admission.spentMicros` includes a
    // reconciled historical baseline. Persist the baseline plus this
    // reservation so concurrent transactions cannot repeatedly spend against
    // the same stale raw counter.
    return committed + admission.reservationMicros
  }

  if (isMemory()) {
    const current = Number(memoryState().budgetCounters.get(id)?.spentMicros || 0)
    const spentMicros = nextSpent(current)
    memoryState().budgetCounters.set(id, { spentMicros, lastUsedAt: now })
    invalidateBudgetReadCaches()
    return { id, amountMicros: admission.reservationMicros, usageStartAt: usageContext.usageStartAt } satisfies BudgetReservation
  }

  const reference = budgetCountersRef().doc(id)
  await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference)
    const current = Number((snapshot.data() as { spentMicros?: number } | undefined)?.spentMicros || 0)
    const spentMicros = nextSpent(current)
    transaction.set(reference, {
      apiKeyId,
      usageStartAt: usageContext.usageStartAt,
      windowEnd: usageContext.windowEnd,
      spentMicros,
      lastUsedAt: now,
      updatedAt: now,
    }, { merge: true })
  })
  invalidateBudgetReadCaches()
  return { id, amountMicros: admission.reservationMicros, usageStartAt: usageContext.usageStartAt } satisfies BudgetReservation
}

export async function releaseBudgetReservation(reservation: BudgetReservation | undefined) {
  if (!reservation) return
  if (isMemory()) {
    const current = memoryState().budgetCounters.get(reservation.id)
    if (current) memoryState().budgetCounters.set(reservation.id, { ...current, spentMicros: Math.max(0, current.spentMicros - reservation.amountMicros) })
    invalidateBudgetReadCaches()
    return
  }
  const reference = budgetCountersRef().doc(reservation.id)
  await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference)
    if (!snapshot.exists) return
    const current = Number((snapshot.data() as { spentMicros?: number } | undefined)?.spentMicros || 0)
    transaction.set(reference, { spentMicros: Math.max(0, current - reservation.amountMicros), updatedAt: new Date().toISOString() }, { merge: true })
  })
  invalidateBudgetReadCaches()
}

export async function checkBudget(apiKeyId: string, gatewayModelId: string, providerModelId?: string) {
  await getBudgetAdmission(apiKeyId, gatewayModelId, providerModelId)
}

async function loadBudgetRows(
  keys: Awaited<ReturnType<typeof listApiKeys>> = [],
  currentWindow?: BudgetWindow,
  currentBudgets?: GatewayKeyBudget[],
  options: { freshUsage?: boolean } = {},
) {
  const budgets = currentBudgets || await listBudgets()
  if (!budgets.length) return { rows: [], window: currentWindow }
  const window = currentWindow || await getBudgetWindow()
  const usageStartAt = await budgetUsageStart(window)
  if (window.bypassLimits) {
    const usageByKey = await getBudgetUsage(window)
    const keyNames = new Map(keys.map((key) => [key.id, key.name]))
    return {
      rows: budgets.map((budget) => {
        const usage = usageByKey.get(budget.apiKeyId)
        return {
          ...budget,
          spentMicros: Math.max(0, Number(usage?.spentMicros || 0)),
          windowStart: window.start,
          windowEnd: window.end,
          usageStartAt,
          name: keyNames.get(budget.apiKeyId) || "Unknown",
          lastUsedAt: usage?.lastUsedAt || null,
        }
      }),
      window,
    }
  }
  const baselinesByKey = new Map<string, BudgetCounterBaseline>()
  const missingBaselines: GatewayKeyBudget[] = []
  let usageByKey: Map<string, BudgetUsageValue> | undefined
  for (const budget of budgets) {
    const baseline = getBudgetCounterBaseline(budget, usageStartAt, window, true)
    if (baseline) baselinesByKey.set(budget.apiKeyId, baseline)
    else missingBaselines.push(budget)
  }

  let counters: BudgetCounterRow[]
  const reconciledSpentByKey = new Map<string, number>()
  if (missingBaselines.length) {
    const countersBefore = await listBudgetCounters(usageStartAt, true)
    usageByKey = await getBudgetUsage(window, options.freshUsage === true)
    const countersAfter = await listBudgetCounters(usageStartAt, true)
    const beforeById = new Map(countersBefore.map((counter) => [counter.id, counter]))
    const afterById = new Map(countersAfter.map((counter) => [counter.id, counter]))
    const writes: BudgetBaselineWrite[] = []

    for (const budget of missingBaselines) {
      const counterId = budgetCounterId(budget.apiKeyId, usageStartAt)
      const counterBefore = Number(beforeById.get(counterId)?.spentMicros || 0)
      const counterAfter = Number(afterById.get(counterId)?.spentMicros || 0)
      const usage = usageByKey.get(budget.apiKeyId)
      const usageMicros = Number(usage?.spentMicros || 0)
      const { baseline, canPersist } = reconciledBudgetCounterBaseline(budget, window, counterBefore, counterAfter, usage)
      baselinesByKey.set(budget.apiKeyId, baseline)
      boundedSet(budgetCounterBaselineCache, budgetCounterBaselineId(budget, usageStartAt, window), baseline)
      reconciledSpentByKey.set(
        budget.apiKeyId,
        baseline.stable
          ? Math.max(0, counterAfter + baseline.offsetMicros)
          : Math.max(0, usageMicros, counterAfter + Math.max(0, usageMicros - counterBefore)),
      )
      if (canPersist) writes.push({ budget, usageStart: usageStartAt, window, baseline })
    }

    const persisted = await persistBudgetCounterBaselines(writes)
    for (const entry of writes) {
      if (persisted.has(entry.budget.apiKeyId)) entry.baseline.durable = true
      else {
        entry.baseline.expiresAt = Date.now() + budgetCounterCacheTtlMs
        boundedSet(budgetCounterBaselineCache, budgetCounterBaselineId(entry.budget, usageStartAt, window), entry.baseline)
      }
    }
    counters = countersAfter
  } else {
    counters = await listBudgetCounters(usageStartAt)
    // A durable baseline is an admission-cache optimization, not a source of
    // truth for the usage screen. Read the reconciled ledger even when the
    // baseline is stable so imported/backfilled rollups cannot hide newer
    // event-level usage. If a read is temporarily unavailable, retain the
    // counter-based result rather than breaking the dashboard.
    usageByKey = await getBudgetUsage(window, options.freshUsage === true).catch(() => undefined)
  }

  const countersById = new Map(counters.map((counter) => [counter.id, counter]))
  const keyNames = new Map(keys.map((key) => [key.id, key.name]))
  const rows = budgets.map((budget) => {
    const counter = countersById.get(budgetCounterId(budget.apiKeyId, usageStartAt))
    const counterSpentMicros = Number(counter?.spentMicros || 0)
    const baseline = baselinesByKey.get(budget.apiKeyId) || setBudgetCounterBaseline(budget, usageStartAt, window, counterSpentMicros)
    const counterLastUsedAt = counter?.lastUsedAt || null
    const ledgerUsage = usageByKey?.get(budget.apiKeyId)
    const lastUsedAt = ledgerUsage?.lastUsedAt || (baseline.lastUsedAt && (!counterLastUsedAt || baseline.lastUsedAt > counterLastUsedAt)
      ? baseline.lastUsedAt
      : counterLastUsedAt)
    return {
      ...budget,
      spentMicros: ledgerUsage
        ? safeUsageInteger(ledgerUsage.spentMicros)
        : reconciledSpentByKey.get(budget.apiKeyId) ?? Math.max(0, counterSpentMicros + baseline.offsetMicros),
      windowStart: window.start,
      windowEnd: window.end,
      usageStartAt,
      name: keyNames.get(budget.apiKeyId) || "Unknown",
      lastUsedAt,
    }
  })
  return { rows, window }
}

export async function getBudgetAdminData() {
  const [keys, window, codex] = await Promise.all([
    listApiKeys(),
    getBudgetWindow(),
    listCodexAccounts().catch(() => ({ provider: null, accounts: [] })),
  ])
  const [{ rows }, bypassSessions] = await Promise.all([
    loadBudgetRows(keys, window, undefined, { freshUsage: true }),
    listBudgetBypassSessions(50, window),
  ])
  return {
    budgets: rows,
    bypassSessions,
    window,
    apiKeys: keys.map((key) => ({ id: key.id, name: key.name })),
    codexAccounts: codex.accounts.map((account) => ({ id: account.id, name: account.name, ...(account.planType ? { planType: account.planType } : {}) })),
  }
}

export async function getBudgetRows() {
  const [keys, window] = await Promise.all([listApiKeys(), getBudgetWindow()])
  return (await loadBudgetRows(keys, window, undefined, { freshUsage: true })).rows
}

const maximumHourlyDashboardSpanMs = positiveDuration(process.env.DASHBOARD_MAX_HOURLY_RANGE_DAYS, 31) * 86_400_000
const maximumDailyDashboardSpanMs = positiveDuration(process.env.DASHBOARD_MAX_DAILY_RANGE_DAYS, 730) * 86_400_000
const maximumWeeklyDashboardSpanMs = positiveDuration(process.env.DASHBOARD_MAX_WEEKLY_RANGE_DAYS, 7_300) * 86_400_000

function effectiveDashboardGranularity(requested: DashboardQuery["granularity"], spanMs: number): Exclude<DashboardQuery["granularity"], "auto" | undefined> {
  if (!requested || requested === "auto") return spanMs <= 2 * 86_400_000 ? "hourly" : spanMs <= 45 * 86_400_000 ? "daily" : "monthly"
  if (requested === "hourly" && spanMs > maximumHourlyDashboardSpanMs) {
    if (spanMs <= maximumDailyDashboardSpanMs) return "daily"
    if (spanMs <= maximumWeeklyDashboardSpanMs) return "weekly"
    return "monthly"
  }
  if (requested === "daily" && spanMs > maximumDailyDashboardSpanMs) return spanMs <= maximumWeeklyDashboardSpanMs ? "weekly" : "monthly"
  if (requested === "weekly" && spanMs > maximumWeeklyDashboardSpanMs) return "monthly"
  return requested
}

async function resolveRange(query: DashboardQuery, currentBudgetWindow?: BudgetWindow) {
  const now = new Date()
  const today = startOfZonedDay(now)
  if (query.preset === "budget") {
    const window = currentBudgetWindow || await getBudgetWindow()
    return { label: "Budget window", from: new Date(window.start), to: new Date(window.end) }
  }
  if (query.preset === "today") return { label: "Today", from: today, to: now }
  if (query.preset === "yesterday") { const to = today; const from = addZonedDays(to, -1); return { label: "Yesterday", from, to: new Date(to.getTime() - 1) } }
  if (query.preset === "week") return { label: "This week", from: mondayInAppTimeZone(now), to: now }
  if (query.preset === "lastWeek") { const to = mondayInAppTimeZone(now); const from = addZonedDays(to, -7); return { label: "Last week", from, to: new Date(to.getTime() - 1) } }
  if (query.preset === "month") return { label: "This month", from: startOfZonedMonth(now), to: now }
  if (query.preset === "lastMonth") { const to = startOfZonedMonth(now); return { label: "Last month", from: addZonedMonths(to, -1), to: new Date(to.getTime() - 1) } }
  if (query.preset === "year") return { label: "This year", from: startOfZonedYear(now), to: now }
  if (query.preset === "custom" && query.from && query.to) return { label: "Custom range", from: zonedDateStringToDate(query.from, "00:00"), to: new Date(zonedDateStringToDate(query.to, "00:00").getTime() + 86400000 - 1) }
  return { label: "All time", from: new Date("2000-01-01T00:00:00.000Z"), to: now }
}
function bucketStart(date: Date, granularity: string) { if (granularity === "hourly") return startOfZonedHour(date); if (granularity === "monthly") return startOfZonedMonth(date); if (granularity === "weekly") return mondayInAppTimeZone(date); return startOfZonedDay(date) }
function mask(key: string) { return key.length <= 12 ? `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 4))}` : `${key.slice(0, 7)}${"•".repeat(12)}${key.slice(-4)}` }
function publicKeyName(key: { name?: string } | undefined, keyId: string, indexedNames: ReadonlyMap<string, string>) {
  return key?.name?.trim() || indexedNames.get(keyId)?.trim() || keyId
}

async function loadDashboardModelLabels() {
  const workspaceId = currentWorkspaceId()
  const cached = dashboardModelLabelCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = dashboardModelLabelInflight.get(workspaceId)
  if (existing) return existing

  const promise = (async () => {
    const [groups, models, aliases, cliProxyModels] = await Promise.all([
      dashboardTimed("labels.groups", listPricingGroups()),
      dashboardTimed("labels.models", listModels()),
      dashboardTimed("labels.aliases", listAliases()),
      dashboardTimed("labels.cliproxy", listCliProxyModels()),
    ])
    const allModels = new Map<string, typeof models[number]>()
    for (const model of [...models, ...cliProxyModels]) {
      if (!allModels.has(model.id)) allModels.set(model.id, model)
    }
    const groupByMemberId = new Map<string, string>()
    for (const group of groups) {
      const label = group.name.trim()
      if (!label) continue
      for (const modelId of group.memberModelIds) groupByMemberId.set(modelId, label)
    }

    const labelsByGatewayModel = new Map<string, string>()
    const upstreamLabels = new Map<string, Set<string>>()
    for (const model of allModels.values()) {
      const label = groupByMemberId.get(model.id) || groupByMemberId.get(model.gatewayModelId)
      if (!label) continue
      labelsByGatewayModel.set(model.gatewayModelId, label)
      const upstreamModel = model.upstreamModel.trim()
      if (!upstreamModel) continue
      const labels = upstreamLabels.get(upstreamModel) || new Set<string>()
      labels.add(label)
      upstreamLabels.set(upstreamModel, labels)
    }
    for (const [upstreamModel, labels] of upstreamLabels) {
      if (labels.size === 1) labelsByGatewayModel.set(upstreamModel, [...labels][0])
    }
    for (const alias of aliases) {
      const label = labelsByGatewayModel.get(alias.targetModelId)
      if (label) labelsByGatewayModel.set(alias.alias, label)
    }
    dashboardModelLabelCache.set(workspaceId, { value: labelsByGatewayModel, expiresAt: Date.now() + dashboardCacheTtlMs })
    return labelsByGatewayModel
  })().finally(() => {
    if (dashboardModelLabelInflight.get(workspaceId) === promise) dashboardModelLabelInflight.delete(workspaceId)
  })
  dashboardModelLabelInflight.set(workspaceId, promise)
  return promise
}

async function buildDashboardPayload(query: DashboardQuery, publicView: boolean): Promise<DashboardPayload> {
  const buildStartedAt = performance.now()
  dashboardPerf(`start workspace=${currentWorkspaceId()} preset=${query.preset || "all"} granularity=${query.granularity || "auto"}`)
  const budgetsPromise = dashboardTimed("budgets", listBudgets())
  const budgetWindowPromise = query.preset === "budget" ? dashboardTimed("budget-window", getBudgetWindow()) : undefined
  const range = await dashboardTimed("range", resolveRange(query, budgetWindowPromise ? await budgetWindowPromise : undefined))
  const span = Math.max(0, range.to.getTime() - range.from.getTime())
  const trendGranularity = effectiveDashboardGranularity(query.granularity, span)
  // Weekly charts are derived from daily rows. Long-range monthly charts also
  // use daily rows unless optional monthly persistence is enabled.
  const storageGranularity = storageGranularityFor(trendGranularity)
  const toExclusive = new Date(range.to.getTime() + (query.preset === "budget" ? 0 : 1))
  const boundary = dashboardBoundaryRanges(range.from, toExclusive, storageGranularity)

  const rollupsPromise = dashboardTimed("rollups", listUsageRollups(
    storageGranularity as UsageRollup["granularity"],
    // Query whole calendar buckets around the range. The selected range can
    // begin inside a daily/hourly bucket; querying from the raw timestamp
    // silently drops that leading bucket before boundary reconciliation can
    // prorate it or replace it with event-level data.
    bucketStart(range.from, storageGranularity).toISOString(),
    nextBucketStart(bucketStart(new Date(toExclusive.getTime() - 1), storageGranularity), storageGranularity).toISOString(),
  ))
  const boundaryEventsPromise = boundary.ranges.length
    ? dashboardTimed("boundary-events", parallelMap(boundary.ranges, ([from, to]) => listUsageEvents(from.toISOString(), to.toISOString()))
      .then(uniqueUsageEvents))
    : Promise.resolve([] as UsageEvent[])
  const keysPromise = dashboardTimed("keys", listApiKeys())
  const indexedKeyNamesPromise = publicView ? dashboardTimed("indexed-key-names", listIndexedApiKeyNames()) : Promise.resolve(new Map<string, string>())
  const modelLabelsPromise = dashboardTimed("model-labels", loadDashboardModelLabels())
  const budgetDataPromise = dashboardTimed("budget-data", budgetsPromise.then(async (budgets) => {
    if (!budgets.length) return { rows: [], window: budgetWindowPromise ? await budgetWindowPromise : undefined }
    const window = budgetWindowPromise ? await budgetWindowPromise : await getBudgetWindow()
    return loadBudgetRows([], window, budgets)
  }))
  const [rollupsResult, boundaryEventsResult, keysResult, indexedKeyNamesResult, modelLabelsResult, budgetResult] = await Promise.allSettled([
    rollupsPromise,
    boundaryEventsPromise,
    keysPromise,
    indexedKeyNamesPromise,
    modelLabelsPromise,
    budgetDataPromise,
  ])
  dashboardPerf(`reads complete rollups=${rollupsResult.status === "fulfilled" ? rollupsResult.value.length : 0} boundary=${boundaryEventsResult.status === "fulfilled" ? boundaryEventsResult.value.length : 0} elapsed=${(performance.now() - buildStartedAt).toFixed(1)}ms`)
  const rollups = rollupsResult.status === "fulfilled" ? rollupsResult.value : []
  const boundaryEvents = boundaryEventsResult.status === "fulfilled" ? boundaryEventsResult.value : []
  const exactBoundaryData = boundaryEventsResult.status === "fulfilled"
  const missingDimensionBucketStarts = new Set<string>()
  for (const rollup of rollups) {
    if (!rollup.gatewayKeyId || !rollup.gatewayModelId) missingDimensionBucketStarts.add(rollup.bucketStart)
  }
  const missingDimensionCandidates: Array<[Date, Date]> = []
  for (const bucket of missingDimensionBucketStarts) {
    const bucketDate = new Date(bucket)
    missingDimensionCandidates.push([
      new Date(Math.max(range.from.getTime(), bucketDate.getTime())),
      new Date(Math.min(toExclusive.getTime(), nextBucketStart(bucketDate, storageGranularity).getTime())),
    ])
  }
  const missingDimensionRanges = subtractDateRanges(
    missingDimensionCandidates,
    exactBoundaryData ? boundary.ranges : [],
  )
  const missingDimensionEventsResult = missingDimensionRanges.length
    ? await settledParallelMap(missingDimensionRanges, ([from, to]) => listUsageEvents(from.toISOString(), to.toISOString()))
    : []
  const missingDimensionData = missingDimensionRanges.length === 0 || missingDimensionEventsResult.every((result) => result.status === "fulfilled")
  const missingDimensionEvents = missingDimensionData
    ? uniqueUsageEvents(missingDimensionEventsResult.flatMap((result) => result.status === "fulfilled" ? [result.value] : []))
    : []
  const replacementCandidates = uniqueUsageEvents([boundaryEvents, missingDimensionEvents])
  const eventCountsByDimension = new Map<string, number>()
  const eventCountsByKeyBucket = new Map<string, number>()
  for (const event of replacementCandidates) {
    const bucket = usageEventBucketKey(event, storageGranularity as UsageRollup["granularity"])
    const dimension = usageDimensionKey(event.gatewayKeyId, event.gatewayModelId, bucket)
    eventCountsByDimension.set(dimension, (eventCountsByDimension.get(dimension) || 0) + 1)
    const keyBucket = `${event.gatewayKeyId}:${bucket}`
    eventCountsByKeyBucket.set(keyBucket, (eventCountsByKeyBucket.get(keyBucket) || 0) + 1)
  }
  const candidateDimensions = new Set<string>()
  const candidateKeyBuckets = new Set<string>()
  const replacementDimensions = new Set<string>()
  const replacementKeyBuckets = new Set<string>()
  for (const rollup of rollups) {
    const partial = boundary.partialBucketStarts.has(rollup.bucketStart)
    const missingDimension = missingDimensionBucketStarts.has(rollup.bucketStart)
    if (!partial && !(missingDimensionData && missingDimension)) continue
    if (rollup.gatewayKeyId && rollup.gatewayModelId) {
      const dimension = usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, rollup.bucketStart)
      candidateDimensions.add(dimension)
      const eventCount = eventCountsByDimension.get(dimension) || 0
      const completeEvents = eventCount === Math.max(0, Number(rollup.requests || 0)) && Number(rollup.requests || 0) > 0
      // Runtime writes have a corresponding event document. For a partial
      // bucket, the rollup request count also includes traffic before the
      // selected range, so any successfully queried runtime event slice is
      // authoritative even when its count is smaller than the full rollup.
      // Backfill aggregates may intentionally have no event documents.
      if (completeEvents || !rollup.backfillSource) replacementDimensions.add(dimension)
    } else {
      // A rollup without a model is still scoped to its API key. Never let a
      // different key's events prove coverage or suppress its replacement.
      if (!rollup.gatewayKeyId) continue
      const keyBucket = `${rollup.gatewayKeyId}:${rollup.bucketStart}`
      candidateKeyBuckets.add(keyBucket)
      if ((eventCountsByKeyBucket.get(keyBucket) === Math.max(0, Number(rollup.requests || 0)) && Number(rollup.requests || 0) > 0) || !rollup.backfillSource) replacementKeyBuckets.add(keyBucket)
    }
  }
  const replacementEvents = replacementCandidates.filter((event) => {
    const bucket = usageEventBucketKey(event, storageGranularity as UsageRollup["granularity"])
    const dimension = usageDimensionKey(event.gatewayKeyId, event.gatewayModelId, bucket)
    const keyBucket = `${event.gatewayKeyId}:${bucket}`
    if (replacementDimensions.has(dimension) || replacementKeyBuckets.has(keyBucket)) return true
    // Keep events for buckets without a corresponding aggregate row. They are
    // the only available data in that case; suppress only events belonging to
    // a candidate rollup whose coverage was proven incomplete.
    return !candidateDimensions.has(dimension) && !candidateKeyBuckets.has(keyBucket)
  })
  const keys = keysResult.status === "fulfilled" ? keysResult.value : []
  const indexedKeyNames = indexedKeyNamesResult.status === "fulfilled" ? indexedKeyNamesResult.value : new Map<string, string>()
  const modelLabels = modelLabelsResult.status === "fulfilled" ? modelLabelsResult.value : new Map<string, string>()
  const budgetRows = budgetResult.status === "fulfilled" ? budgetResult.value.rows : []
  const budgetWindow = budgetResult.status === "fulfilled" ? budgetResult.value.window : undefined

  const budgetMap = new Map(budgetRows.map((budget) => [budget.apiKeyId, budget]))
  const keyMap = new Map(keys.map((key) => [key.id, key]))
  const keyRows = new Map<string, DashboardPayload["keys"][number]>()
  const modelsByKey = new Map<string, Set<string>>()
  const modelRows = new Map<string, { model: string; requests: number; tokens: number; costMicros: number }>()
  const trend = new Map<string, { bucketStart: string; label: string; requests: number; tokens: number; costMicros: number }>()
  let requestCount = 0
  let totalTokens = 0
  let totalCostMicros = 0
  let pricedRequests = 0
  let failedRequests = 0
  let lastEventAt: string | null = null

  const compactHourLabels = (query.preset === "today" || query.preset === "yesterday") && trendGranularity === "hourly"
  function aggregateUsageRow(row: {
    bucketStart: string
    requests: number
    totalTokens: number
    costMicros: number
    pricedRequests: number
    failedRequests: number
    lastEventAt?: string
    gatewayKeyId?: string
    gatewayModelId?: string
  }) {
    const requests = safeUsageInteger(row.requests)
    const totalTokensForRow = safeUsageInteger(row.totalTokens)
    const costMicrosForRow = safeUsageInteger(row.costMicros)
    const pricedRequestsForRow = Math.min(requests, safeUsageInteger(row.pricedRequests))
    const failedRequestsForRow = Math.min(requests, safeUsageInteger(row.failedRequests))
    requestCount += requests
    totalTokens += totalTokensForRow
    totalCostMicros += costMicrosForRow
    pricedRequests += pricedRequestsForRow
    failedRequests += failedRequestsForRow
    if (row.lastEventAt && (!lastEventAt || lastEventAt < row.lastEventAt)) lastEventAt = row.lastEventAt

    const trendBucket = bucketStart(new Date(row.bucketStart), trendGranularity).toISOString()
    let point = trend.get(trendBucket)
    if (!point) {
      point = { bucketStart: trendBucket, label: formatAppTrendBucket(trendBucket, trendGranularity, compactHourLabels ? "hour" : undefined), requests: 0, tokens: 0, costMicros: 0 }
      trend.set(trendBucket, point)
    }
    point.requests += requests
    point.tokens += totalTokensForRow
    point.costMicros += costMicrosForRow

    if (row.gatewayKeyId && row.gatewayModelId) {
      addDimensions(row.gatewayKeyId, row.gatewayModelId, requests, totalTokensForRow, costMicrosForRow, row.lastEventAt)
    }
  }

  for (const rollup of rollups) {
    const partial = boundary.partialBucketStarts.has(rollup.bucketStart)
    const missingDimension = missingDimensionData && missingDimensionBucketStarts.has(rollup.bucketStart)
    const completeDimensionEvents = rollup.gatewayKeyId && rollup.gatewayModelId
      ? replacementDimensions.has(usageDimensionKey(rollup.gatewayKeyId, rollup.gatewayModelId, rollup.bucketStart))
      : rollup.gatewayKeyId ? replacementKeyBuckets.has(`${rollup.gatewayKeyId}:${rollup.bucketStart}`) : false
    if ((partial || missingDimension) && completeDimensionEvents) continue
    const scaled = partial
      ? scaleUsageRollupToRange(rollup, range.from, toExclusive)
      : rollup
    aggregateUsageRow({
      bucketStart: scaled.bucketStart,
      requests: scaled.requests,
      totalTokens: scaled.totalTokens,
      costMicros: scaled.costMicros,
      pricedRequests: scaled.pricedRequests || 0,
      failedRequests: Math.max(safeUsageInteger(scaled.failedRequests), Array.isArray(scaled.excludedEventIds) ? scaled.excludedEventIds.length : 0),
      lastEventAt: scaled.lastEventAt,
      gatewayKeyId: scaled.gatewayKeyId,
      gatewayModelId: scaled.gatewayModelId,
    })
  }
  for (const event of replacementEvents) {
    aggregateUsageRow({
      bucketStart: bucketStart(new Date(event.completedAt), storageGranularity).toISOString(),
      requests: 1,
      totalTokens: event.totalTokens,
      costMicros: event.costMicros,
      pricedRequests: event.status >= 200 && event.status < 300 && event.pricingConfidence === "exact" ? 1 : 0,
      failedRequests: event.status >= 200 && event.status < 300 ? 0 : 1,
      lastEventAt: event.completedAt,
      gatewayKeyId: event.gatewayKeyId,
      gatewayModelId: event.gatewayModelId,
    })
  }

  // Keep empty periods on the chart. This makes the x-axis represent the
  // selected window instead of the first/last period that happened to have
  // traffic. For all-time views, begin at the first recorded bucket.
  if (trend.size || query.preset !== "all") {
    const existingBuckets = [...trend.keys()].sort()
    const firstBucket = query.preset === "all"
      ? new Date(existingBuckets[0])
      : bucketStart(range.from, trendGranularity)
    const lastBucket = bucketStart(new Date(toExclusive.getTime() - 1), trendGranularity)
    for (let cursor = firstBucket; cursor <= lastBucket; cursor = nextBucketStart(cursor, trendGranularity)) {
      const bucket = cursor.toISOString()
      // Calendar weeks can begin before a short selected range. Do not add an
      // empty leading bucket whose label falls outside that range, while still
      // keeping it when the range contains real usage from that partial week.
      if (trendGranularity === "weekly" && cursor < range.from && !trend.has(bucket)) continue
      if (!trend.has(bucket)) trend.set(bucket, { bucketStart: bucket, label: formatAppTrendBucket(bucket, trendGranularity, compactHourLabels ? "hour" : undefined), requests: 0, tokens: 0, costMicros: 0 })
    }
  }

  function addDimensions(keyId: string, modelId: string, requests: number, tokens: number, costMicros: number, lastUsedAt?: string) {
    const displayModel = modelLabels.get(modelId) || modelId
    let row = keyRows.get(keyId)
    if (!row) {
      const key = keyMap.get(keyId)
      const displayName = publicView ? publicKeyName(key, keyId, indexedKeyNames) : key?.name?.trim() || keyId
      row = {
        id: publicView ? displayName : keyId,
        label: displayName,
        maskedKey: publicView ? "hidden" : mask(key?.key || "unknown"),
        requests: 0,
        tokens: 0,
        costMicros: 0,
        models: [],
        lastUsed: null,
      }
      keyRows.set(keyId, row)
      modelsByKey.set(keyId, new Set())
    }
    row.requests += requests
    row.tokens += tokens
    row.costMicros += costMicros
    modelsByKey.get(keyId)?.add(displayModel)
    if (lastUsedAt && (!row.lastUsed || row.lastUsed < lastUsedAt)) row.lastUsed = lastUsedAt

    let model = modelRows.get(displayModel)
    if (!model) {
      model = { model: displayModel, requests: 0, tokens: 0, costMicros: 0 }
      modelRows.set(displayModel, model)
    }
    model.requests += requests
    model.tokens += tokens
    model.costMicros += costMicros
  }

  for (const [keyId, row] of keyRows) {
    row.models = [...(modelsByKey.get(keyId) || [])].sort((left, right) => left.localeCompare(right))
    const budget = budgetMap.get(keyId)
    if (!budget || !budgetWindow) continue
    row.budget = {
      weeklyLimitMicros: budget.weeklyLimitMicros,
      spentMicros: budget.spentMicros,
      remainingMicros: Math.max(0, budget.weeklyLimitMicros - budget.spentMicros),
      percentUsed: budget.weeklyLimitMicros > 0 ? budget.spentMicros / budget.weeklyLimitMicros * 100 : 0,
      bypassLimits: budgetWindow.bypassLimits,
      usageStartAt: budget.usageStartAt,
      windowStart: budgetWindow.start,
      windowEnd: budgetWindow.end,
    }
  }

  // Failed requests remain part of request volume, but they are not pricing
  // failures. Exclude them from the estimated/unknown count explicitly.
  const unpricedRequests = Math.max(0, requestCount - pricedRequests - failedRequests)
  dashboardPerf(`assembled keys=${keyRows.size} models=${modelRows.size} requests=${requestCount} elapsed=${(performance.now() - buildStartedAt).toFixed(1)}ms`)
  return {
    generatedAt: new Date().toISOString(),
    range: { label: range.label, from: range.from.toISOString(), to: range.to.toISOString(), granularity: trendGranularity },
    summary: { requests: requestCount, tokens: totalTokens, costMicros: totalCostMicros, activeKeys: keyRows.size, pricedRequests, unpricedRequests },
    trend: [...trend.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
    keys: [...keyRows.values()].sort((a, b) => b.requests - a.requests),
    models: [...modelRows.values()].sort((a, b) => b.costMicros - a.costMicros || b.requests - a.requests),
    freshness: { source: isMemory() ? "memory" : "postgres", lastEventAt },
    pricingConfidence: { pricedRequests, unpricedRequests },
  }
}

function dashboardBoundaryRanges(from: Date, toExclusive: Date, granularity: string) {
  const startBucket = bucketStart(from, granularity)
  const endBucket = bucketStart(new Date(toExclusive.getTime() - 1), granularity)
  const startAligned = startBucket.getTime() === from.getTime()
  const endAligned = bucketStart(toExclusive, granularity).getTime() === toExclusive.getTime()
  const ranges: Array<[Date, Date]> = []

  if (!startAligned) ranges.push([from, new Date(Math.min(toExclusive.getTime(), nextBucketStart(startBucket, granularity).getTime()))])
  if (!endAligned) ranges.push([new Date(Math.max(from.getTime(), endBucket.getTime())), toExclusive])

  const merged = mergeDateRanges(ranges)
  const partialBucketStarts = new Set<string>()
  if (!startAligned) partialBucketStarts.add(startBucket.toISOString())
  if (!endAligned) partialBucketStarts.add(endBucket.toISOString())
  return { ranges: merged.filter(([rangeFrom, rangeTo]) => rangeFrom < rangeTo), partialBucketStarts }
}

function nextBucketStart(value: Date, granularity: string) {
  if (granularity === "hourly") return addZonedDays(value, 1 / 24)
  if (granularity === "monthly") return addZonedMonths(value, 1)
  if (granularity === "weekly") return addZonedDays(value, 7)
  return addZonedDays(value, 1)
}

function scaleUsageRollupToRange(rollup: UsageRollup, from: Date, to: Date): UsageRollup {
  const lastEventMs = rollup.lastEventAt ? Date.parse(rollup.lastEventAt) : NaN
  if (Number.isFinite(lastEventMs) && lastEventMs < from.getTime()) {
    return {
      ...rollup,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costMicros: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
      failedRequests: 0,
    }
  }
  const bucketFrom = new Date(rollup.bucketStart)
  const bucketTo = nextBucketStart(bucketFrom, rollup.granularity)
  const bucketDuration = bucketTo.getTime() - bucketFrom.getTime()
  if (!Number.isFinite(bucketDuration) || bucketDuration <= 0) return rollup
  const overlap = Math.max(0, Math.min(to.getTime(), bucketTo.getTime()) - Math.max(from.getTime(), bucketFrom.getTime()))
  if (overlap <= 0 || overlap >= bucketDuration) return rollup
  const ratio = overlap / bucketDuration
  const scaled = (value: unknown) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed * ratio))
      : 0
  }
  const requests = scaled(rollup.requests)
  return {
    ...rollup,
    requests,
    inputTokens: scaled(rollup.inputTokens),
    outputTokens: scaled(rollup.outputTokens),
    cacheReadTokens: scaled(rollup.cacheReadTokens),
    cacheCreationTokens: scaled(rollup.cacheCreationTokens),
    totalTokens: scaled(rollup.totalTokens),
    costMicros: scaled(rollup.costMicros),
    pricedRequests: Math.min(requests, scaled(rollup.pricedRequests)),
    unpricedRequests: Math.min(requests, scaled(rollup.unpricedRequests)),
    failedRequests: Math.min(requests, scaled(rollup.failedRequests)),
  }
}

function usageEventBucketKey(event: UsageEvent, granularity: UsageRollup["granularity"]) {
  return bucketStart(new Date(event.completedAt), granularity).toISOString()
}

function usageDimensionKey(gatewayKeyId: unknown, gatewayModelId: unknown, bucket: string) {
  return `${gatewayKeyId || ""}:${gatewayModelId || ""}:${bucket}`
}

export async function getDashboardPayload(query: DashboardQuery, publicView = false): Promise<DashboardPayload> {
  if (isMemory()) return buildDashboardPayload(query, publicView)
  const workspaceId = currentWorkspaceId()
  const cacheKey = scopedKey(JSON.stringify([publicView, query.preset || "all", query.from || "", query.to || "", query.granularity || "auto"]))
  const cached = dashboardCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = dashboardInflight.get(cacheKey)
  if (existing) return existing

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = buildDashboardPayload(query, publicView).then((payload) => {
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) {
      boundedSet(dashboardCache, cacheKey, { value: payload, expiresAt: Date.now() + dashboardCacheTtlMs }, 32)
    }
    return payload
  }).finally(() => {
    if (dashboardInflight.get(cacheKey) === promise) dashboardInflight.delete(cacheKey)
  })
  dashboardInflight.set(cacheKey, promise)
  return promise
}

export function redactPublicDashboard(payload: DashboardPayload): DashboardPayload {
  return { ...payload, keys: payload.keys.map((key) => ({ ...key, id: key.label, label: key.label, maskedKey: "hidden" })) }
}

type RepricedEvent = {
  before: UsageEvent
  after: UsageEvent
  costDelta: number
  pricedDelta: number
  unpricedDelta: number
}

type RepricingBudgetContext = {
  budgetIds: Set<string>
  usageStart: string
  windowEnd: string
  window: BudgetWindow
}

function repriceEvent(event: UsageEvent, groupId: string, version: ModelPricingVersion): RepricedEvent {
  // Old documents do not reliably preserve whether a zero token side was
  // absent or genuinely zero. Only an explicit complete marker (or an event
  // already marked exact by the original provider calculation) is safe to
  // recalculate; otherwise preserve its source-recorded amount.
  const completeUsage = event.usageCompleteness === "complete" || (event.usageCompleteness === undefined && event.pricingConfidence === "exact")
  if (!completeUsage) {
    // Historical aggregate/source records often contain numeric placeholders
    // for missing token sides. Do not promote those values to an exact bill or
    // overwrite a source-recorded cost during a later pricing sync.
    return {
      before: event,
      // Keep the catalog association for the admin view, but preserve the
      // source cost because no token-complete recalculation occurred.
      after: { ...event, pricingGroupId: groupId, pricingVersionId: version.id },
      costDelta: 0,
      pricedDelta: 0,
      unpricedDelta: 0,
    }
  }
  const normalized = normalizeUsageMetrics({ input: event.inputTokens, output: event.outputTokens, cached: event.cacheReadTokens, cacheCreation: event.cacheCreationTokens })
  const calculated = calculateCostMicros(normalized, version)
  const after: UsageEvent = {
    ...event,
    ...normalized,
    costMicros: calculated.costMicros,
    pricingConfidence: calculated.pricingConfidence,
    costSource: calculated.pricingConfidence === "unpriced" ? event.costSource : "configured-pricing",
    pricingGroupId: groupId,
    pricingVersionId: version.id,
  }
  if (calculated.pricingContextTier) after.pricingContextTier = calculated.pricingContextTier
  else delete after.pricingContextTier
  const wasPriced = event.pricingConfidence === "exact" ? 1 : 0
  const isPriced = after.pricingConfidence === "exact" ? 1 : 0
  return {
    before: event,
    after,
    costDelta: after.costMicros - event.costMicros,
    pricedDelta: isPriced - wasPriced,
    unpricedDelta: wasPriced - isPriced,
  }
}

async function repricingBudgetContext(): Promise<RepricingBudgetContext | null> {
  const budgets = await listBudgets()
  if (!budgets.length) return null
  const window = await getBudgetWindow()
  return { budgetIds: new Set(budgets.map((budget) => budget.apiKeyId)), usageStart: await budgetUsageStart(window), windowEnd: window.end, window }
}

async function bumpBudgetStateRevision(context: RepricingBudgetContext | null) {
  if (!context) return
  const withNextRevision = (window: BudgetWindow) => {
    const previousUpdatedAt = Date.parse(window.updatedAt)
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0)).toISOString()
    return { ...window, updatedAt }
  }
  if (isMemory()) {
    memoryState().window = withNextRevision(memoryState().window || context.window)
    return
  }
  await db().runTransaction(async (transaction) => {
    const reference = windowRef()
    const snapshot = await transaction.get(reference)
    const current = snapshot.exists ? snapshot.data() as BudgetWindow : context.window
    transaction.set(reference, withNextRevision(current))
  })
}

function countsForRepricingBudget(event: UsageEvent, context: RepricingBudgetContext | null) {
  if (!context || !context.budgetIds.has(event.gatewayKeyId) || event.status < 200 || event.status >= 300) return false
  const completedAt = Date.parse(event.completedAt)
  return completedAt >= Date.parse(context.usageStart) && completedAt < Date.parse(context.windowEnd)
}

async function applyRepricingChunk(updates: RepricedEvent[], budgetContext: RepricingBudgetContext | null) {
  const now = new Date().toISOString()
  const rollupDeltas = new Map<string, { granularity: UsageRollup["granularity"]; bucketStart: string; event: UsageEvent; cost: number; priced: number; unpriced: number }>()
  const budgetDeltas = new Map<string, { event: UsageEvent; cost: number }>()

  for (const update of updates) {
    for (const granularity of usageRollupGranularities) {
      const bucket = bucketStart(new Date(update.after.completedAt), granularity).toISOString()
      const id = rollupId(granularity, bucket, update.after)
      const current = rollupDeltas.get(id)
      rollupDeltas.set(id, {
        granularity,
        bucketStart: bucket,
        event: update.after,
        cost: (current?.cost || 0) + update.costDelta,
        priced: (current?.priced || 0) + update.pricedDelta,
        unpriced: (current?.unpriced || 0) + update.unpricedDelta,
      })
    }
    if (update.costDelta && countsForRepricingBudget(update.after, budgetContext)) {
      const id = budgetCounterId(update.after.gatewayKeyId, budgetContext!.usageStart)
      const current = budgetDeltas.get(id)
      budgetDeltas.set(id, { event: update.after, cost: (current?.cost || 0) + update.costDelta })
    }
  }

  if (isMemory()) {
    const memory = memoryState()
    for (const update of updates) memory.events.set(update.after.id, update.after)
    for (const [id, delta] of rollupDeltas) {
      if (!delta.cost && !delta.priced && !delta.unpriced) continue
      const current = memory.rollups.get(id) || emptyRollup(id, delta.granularity, delta.bucketStart, delta.event)
      memory.rollups.set(id, { ...current, costMicros: current.costMicros + delta.cost, pricedRequests: (current.pricedRequests || 0) + delta.priced, unpricedRequests: (current.unpricedRequests || 0) + delta.unpriced, updatedAt: now })
    }
    for (const [id, delta] of budgetDeltas) {
      const current = memory.budgetCounters.get(id)
      memory.budgetCounters.set(id, { spentMicros: (current?.spentMicros || 0) + delta.cost, lastUsedAt: current?.lastUsedAt || delta.event.completedAt })
    }
    return
  }

  const batch = db().batch()
  for (const update of updates) batch.set(eventsRef().doc(update.after.id), update.after)
  for (const [id, delta] of rollupDeltas) {
    if (!delta.cost && !delta.priced && !delta.unpriced) continue
    batch.set(rollupsRef().doc(id), {
      id,
      granularity: delta.granularity,
      bucketStart: delta.bucketStart,
      gatewayKeyId: delta.event.gatewayKeyId,
      gatewayModelId: delta.event.gatewayModelId,
      costMicros: FieldValue.increment(delta.cost),
      pricedRequests: FieldValue.increment(delta.priced),
      unpricedRequests: FieldValue.increment(delta.unpriced),
      updatedAt: now,
    }, { merge: true })
  }
  for (const [id, delta] of budgetDeltas) {
    batch.set(budgetCountersRef().doc(id), {
      apiKeyId: delta.event.gatewayKeyId,
      usageStartAt: budgetContext!.usageStart,
      windowEnd: budgetContext!.windowEnd,
      spentMicros: FieldValue.increment(delta.cost),
      updatedAt: now,
    }, { merge: true })
  }
  await batch.commit()
}

export async function repriceUsageForGroup(jobId: string) {
  const job = await getPricingJob(jobId)
  if (!job) return
  if (job.status === "completed") return job
  const group = (await listPricingGroups()).find((entry) => entry.id === job.groupId)
  if (!group) throw new Error("Pricing group not found for repricing job.")
  const version = (await listPricingVersions(group.id)).find((entry) => entry.id === job.versionId)
  if (!version) throw new Error("Pricing version not found for repricing job.")
  const modelIds = new Set<string>(group.memberModelIds)
  const [localModels, cliProxyModels] = await Promise.all([listModels(), listCliProxyModels()])
  const groupModels = [...localModels, ...cliProxyModels.filter((candidate) => !localModels.some((model) => model.gatewayModelId === candidate.gatewayModelId))]
  const gatewayModelIds = new Set<string>(groupModels.filter((model) => modelIds.has(model.id)).map((model) => model.gatewayModelId))
  const suffixOwners = new Map<string, string>()
  for (const gatewayModelId of gatewayModelIds) {
    const suffix = gatewayModelId.split("/").at(-1)
    if (!suffix) continue
    suffixOwners.set(suffix, suffixOwners.has(suffix) ? "" : gatewayModelId)
  }
  const eventsPromise = listUsageEvents().then((allEvents) => allEvents.filter((event) => {
    if (event.providerModelId && modelIds.has(event.providerModelId)) return true
    if (gatewayModelIds.has(event.gatewayModelId)) return true
    const suffixOwner = suffixOwners.get(event.gatewayModelId)
    return Boolean(suffixOwner)
  }))
  const [events, budgetContext] = await Promise.all([eventsPromise, repricingBudgetContext()])
  let currentJob = await updatePricingJob(jobId, { status: "running", totalEvents: events.length, processedEvents: 0, startedAt: new Date().toISOString() }, job)
  if (!currentJob) return
  for (let index = 0; index < events.length; index += 100) {
    const chunk = events.slice(index, index + 100)
    await applyRepricingChunk(chunk.map((event) => repriceEvent(event, group.id, version)), budgetContext)
    currentJob = await updatePricingJob(jobId, { processedEvents: Math.min(index + chunk.length, events.length) }, currentJob)
    if (!currentJob) return
  }
  // Redis budget aggregates are versioned by the budget/window timestamps.
  // Repricing changes persisted spend, so advance the shared revision once to
  // force the next reservation to initialize from the reconciled counter.
  await bumpBudgetStateRevision(budgetContext)
  invalidateBudgetReadCaches()
  return updatePricingJob(jobId, { status: "completed", processedEvents: events.length, completedAt: new Date().toISOString() }, currentJob)
}

export function resetAnalyticsForTests() {
  memoryStates().clear()
  usagePredictionSamples.clear()
  pricingCache.clear()
  pricingInflight.clear()
  legacyPricingCaches.clear()
  legacyPricingInflights.clear()
  legacyPricingGenerations.clear()
  budgetConfigCache.clear()
  budgetConfigInflight.clear()
  budgetCounterCache.clear()
  budgetCounterInflight.clear()
  budgetCounterListCache.clear()
  budgetCounterListInflight.clear()
  budgetCounterBaselineCache.clear()
  budgetUsageCache.clear()
  budgetUsageInflight.clear()
  bypassSessionCache.clear()
  bypassSessionInflight.clear()
  bypassSessionListCache.clear()
  bypassSessionListInflight.clear()
  dashboardCache.clear()
  dashboardInflight.clear()
  dashboardModelLabelCache.clear()
  dashboardModelLabelInflight.clear()
  budgetsCaches.clear()
  budgetsInflights.clear()
  budgetWindowCaches.clear()
  budgetWindowInflights.clear()
  budgetCacheGenerations.clear()
  resetModelPricingForTests()
}
