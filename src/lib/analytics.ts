import { createHash } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { FieldPath, FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore"

import { listApiKeys, listModels } from "@/lib/store"
import { listCodexAccounts } from "@/lib/codex"
import { getCodexUsageForAccount } from "@/lib/codex-usage"
import { getModelPricingGeneration, getPricingForModelAt as getModernPricingForModelAt, getPricingJob, listPricingGroups, listPricingVersions, resetModelPricingForTests, updatePricingJob } from "@/lib/model-pricing"
import { calculateCostMicros, normalizeUsageMetrics, type UsageMetrics } from "@/lib/usage-metrics"
import { addZonedDays, addZonedMonths, formatAppTrendBucket, mondayInAppTimeZone, startOfZonedDay, startOfZonedMonth, startOfZonedYear, startOfZonedHour, zonedDateStringToDate } from "@/lib/timezone"
import type { BudgetBypassSession, BudgetWindow, BudgetWindowAnchor, DashboardPayload, DashboardQuery, GatewayKeyBudget, ModelPricing, ModelPricingVersion, UsageEvent, UsageRollup } from "@/lib/types"
import { currentWorkspaceId, usesLegacyWorkspaceStorage } from "@/lib/workspace-context"

let firestore: Firestore | undefined
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
const pricingCacheTtlMs = 30_000
const legacyPricingCaches = new Map<string, TimedValue<{ byProviderModelId: Map<string, ModelPricing>; byGatewayModelId: Map<string, ModelPricing> }>>()
const legacyPricingInflights = new Map<string, Promise<{ byProviderModelId: Map<string, ModelPricing>; byGatewayModelId: Map<string, ModelPricing> }>>()
const legacyPricingGenerations = new Map<string, number>()

interface TimedValue<T> { value: T; expiresAt: number }

const budgetCacheTtlMs = positiveDuration(process.env.BUDGET_CACHE_TTL_MS, 30_000)
const budgetCounterCacheTtlMs = positiveDuration(process.env.BUDGET_COUNTER_CACHE_TTL_MS, 15_000)
const dashboardCacheTtlMs = positiveDuration(process.env.DASHBOARD_CACHE_TTL_MS, 15_000)
const analyticsReadConcurrency = positiveInteger(process.env.FIRESTORE_ANALYTICS_READ_CONCURRENCY, 8)
const defaultBudgetOutputTokens = positiveInteger(process.env.BUDGET_DEFAULT_OUTPUT_TOKENS, 4_096)
const budgetInputBytesPerToken = positiveNumber(process.env.BUDGET_INPUT_BYTES_PER_TOKEN, 3)
const budgetReservationSafetyMultiplier = positiveNumber(process.env.BUDGET_RESERVATION_SAFETY_PERCENT, 125) / 100
const budgetConfigCache = new Map<string, TimedValue<GatewayKeyBudget | null>>()
const budgetConfigInflight = new Map<string, Promise<GatewayKeyBudget | undefined>>()
const budgetCounterCache = new Map<string, TimedValue<number>>()
const budgetCounterInflight = new Map<string, Promise<number>>()
type BudgetCounterRow = { id: string; spentMicros?: number; lastUsedAt?: string }
const budgetCounterListCache = new Map<string, TimedValue<BudgetCounterRow[]>>()
const budgetCounterListInflight = new Map<string, Promise<BudgetCounterRow[]>>()
type BudgetUsageValue = { spentMicros: number; lastUsedAt: string | null }
type BudgetCounterBaseline = { offsetMicros: number; lastUsedAt: string | null; expiresAt: number }
const budgetCounterBaselineCache = new Map<string, BudgetCounterBaseline>()
const budgetUsageCache = new Map<string, TimedValue<Map<string, BudgetUsageValue>>>()
const budgetUsageInflight = new Map<string, Promise<Map<string, BudgetUsageValue>>>()
const bypassSessionCache = new Map<string, TimedValue<BudgetBypassSession | null>>()
const bypassSessionInflight = new Map<string, Promise<BudgetBypassSession | undefined>>()
const bypassSessionListCache = new Map<string, TimedValue<BudgetBypassSession[]>>()
const bypassSessionListInflight = new Map<string, Promise<BudgetBypassSession[]>>()
const dashboardCache = new Map<string, TimedValue<DashboardPayload>>()
const dashboardInflight = new Map<string, Promise<DashboardPayload>>()
const budgetsCaches = new Map<string, TimedValue<GatewayKeyBudget[]>>()
const budgetsInflights = new Map<string, Promise<GatewayKeyBudget[]>>()
const budgetWindowCaches = new Map<string, TimedValue<BudgetWindow>>()
const budgetWindowInflights = new Map<string, Promise<BudgetWindow>>()
const budgetCacheGenerations = new Map<string, number>()

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
function prefix() { return (process.env.FIRESTORE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_") }
function db() {
  if (firestore) return firestore
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replaceAll("\\n", "\n")
  const app = getApps().length ? getApp() : initializeApp({ credential: projectId && clientEmail && privateKey ? cert({ projectId, clientEmail, privateKey }) : applicationDefault(), projectId })
  firestore = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || "(default)")
  return firestore
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
function budgetCounterBaselineId(budget: GatewayKeyBudget, usageStart: string, windowEnd: string) { return scopedKey(`${budget.apiKeyId}:${budget.updatedAt}:${usageStart}:${windowEnd}`) }
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
    const spentMicros = Number((snapshot.data() as { spentMicros?: number } | undefined)?.spentMicros || 0)
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
    costMicros: 0, pricedRequests: 0, unpricedRequests: 0, lastEventAt: event.completedAt, updatedAt: new Date().toISOString(),
  }
}

export class BudgetDeniedError extends Error { status = 429; retryAfterSeconds: number; constructor(message: string, retryAfterSeconds: number) { super(message); this.name = "BudgetDeniedError"; this.retryAfterSeconds = retryAfterSeconds } }

export interface BudgetUsageContext {
  usageStartAt: string
  windowEnd: string
}

const usageRollupGranularities = ["hourly", "daily", "monthly"] as const

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
        pricedRequests: (current.pricedRequests || 0) + (event.pricingConfidence === "exact" ? 1 : 0),
        unpricedRequests: (current.unpricedRequests || 0) + (event.pricingConfidence === "exact" ? 0 : 1),
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
      pricedRequests: FieldValue.increment(event.pricingConfidence === "exact" ? 1 : 0),
      unpricedRequests: FieldValue.increment(event.pricingConfidence === "exact" ? 0 : 1),
      lastEventAt: event.completedAt,
      updatedAt,
    }, { merge: true })
  }
  if (counterId && context) {
    batch.set(budgetCountersRef().doc(counterId), {
      apiKeyId: event.gatewayKeyId,
      usageStartAt: context.usageStartAt,
      windowEnd: context.windowEnd,
      spentMicros: FieldValue.increment(event.costMicros),
      lastUsedAt: event.completedAt,
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

  let query = rollupsRef() as FirebaseFirestore.Query
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
  const assumedCostMicros = calculated.pricingConfidence !== "exact" && pricing && Number.isSafeInteger(input.assumedCostMicros) && Number(input.assumedCostMicros) > 0
    ? Number(input.assumedCostMicros)
    : undefined
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
  const snapshot = await eventsRef().where("completedAt", ">=", from || "2000-01-01T00:00:00.000Z").where("completedAt", "<", to || new Date().toISOString()).get()
  return snapshot.docs.map((document) => document.data() as UsageEvent).sort((a, b) => a.completedAt.localeCompare(b.completedAt))
}

async function listUsageEventsForModels(providerModelIds: Set<string>, gatewayModelIds: Set<string>) {
  if (isMemory()) {
    return [...memoryState().events.values()].filter((event) =>
      Boolean(event.providerModelId && providerModelIds.has(event.providerModelId)) || gatewayModelIds.has(event.gatewayModelId),
    ).sort((a, b) => a.completedAt.localeCompare(b.completedAt))
  }

  const queryChunks = <T,>(values: T[]) => Array.from({ length: Math.ceil(values.length / 30) }, (_, index) => values.slice(index * 30, index * 30 + 30))
  const queries = [
    ...queryChunks([...providerModelIds]).map((ids) => eventsRef().where("providerModelId", "in", ids)),
    ...queryChunks([...gatewayModelIds]).map((ids) => eventsRef().where("gatewayModelId", "in", ids)),
  ]
  const snapshots = await parallelMap(queries, (query) => query.get())
  const unique = new Map<string, UsageEvent>()
  for (const snapshot of snapshots) {
    for (const document of snapshot.docs) unique.set(document.id, document.data() as UsageEvent)
  }
  return [...unique.values()].sort((a, b) => a.completedAt.localeCompare(b.completedAt))
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
  if (!(await listApiKeys()).some((apiKey) => apiKey.id === input.apiKeyId)) throw new Error("API key not found in the selected workspace.")
  const window = await getBudgetWindow()
  const budget: GatewayKeyBudget = { ...input, spentMicros: 0, windowStart: window.start, windowEnd: window.end, updatedAt: new Date().toISOString() }
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

async function listBudgetCounters(usageStart: string): Promise<BudgetCounterRow[]> {
  if (isMemory()) return [...memoryState().budgetCounters.entries()].map(([id, value]) => ({ id, ...value }))
  const now = Date.now()
  const workspaceId = currentWorkspaceId()
  const cacheId = scopedKey(usageStart)
  const cached = budgetCounterListCache.get(cacheId)
  if (cached && cached.expiresAt > now) return cached.value
  const existing = budgetCounterListInflight.get(cacheId)
  if (existing) return existing

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = budgetCountersRef().where("usageStartAt", "==", usageStart).get().then((snapshot) => {
    const rows = snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as Omit<BudgetCounterRow, "id">) }))
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetCounterListCache, cacheId, { value: rows, expiresAt: Date.now() + budgetCounterCacheTtlMs }, 8)
    return rows
  }).finally(() => {
    if (budgetCounterListInflight.get(cacheId) === promise) budgetCounterListInflight.delete(cacheId)
  })
  budgetCounterListInflight.set(cacheId, promise)
  return promise
}

function addBudgetUsage(map: Map<string, BudgetUsageValue>, rollup: UsageRollup) {
  if (!rollup.gatewayKeyId) return
  const current = map.get(rollup.gatewayKeyId) || { spentMicros: 0, lastUsedAt: null }
  const lastUsedAt = rollup.lastEventAt && (!current.lastUsedAt || current.lastUsedAt < rollup.lastEventAt) ? rollup.lastEventAt : current.lastUsedAt
  map.set(rollup.gatewayKeyId, { spentMicros: current.spentMicros + Number(rollup.costMicros || 0), lastUsedAt })
}

function addBudgetEvent(map: Map<string, BudgetUsageValue>, event: UsageEvent) {
  if (event.status < 200 || event.status >= 300) return
  const current = map.get(event.gatewayKeyId) || { spentMicros: 0, lastUsedAt: null }
  const lastUsedAt = !current.lastUsedAt || current.lastUsedAt < event.completedAt ? event.completedAt : current.lastUsedAt
  map.set(event.gatewayKeyId, { spentMicros: current.spentMicros + Number(event.costMicros || 0), lastUsedAt })
}

async function getBudgetUsage(window: BudgetWindow): Promise<Map<string, BudgetUsageValue>> {
  const usageStartAt = await budgetUsageStart(window)
  const workspaceId = currentWorkspaceId()
  const cacheId = scopedKey(`${usageStartAt}:${window.end}`)
  const now = Date.now()
  const cached = budgetUsageCache.get(cacheId)
  if (cached && cached.expiresAt > now) return cached.value
  const existing = budgetUsageInflight.get(cacheId)
  if (existing) return existing

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const start = new Date(usageStartAt)
  const end = new Date(window.end)
  const promise = (async () => {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return new Map<string, BudgetUsageValue>()

    const hourlyFrom = bucketStart(start, "hourly").toISOString()
    const hourlyTo = nextBucketStart(end, "hourly").toISOString()
    const dailyFrom = bucketStart(start, "daily").toISOString()
    const dailyTo = nextBucketStart(end, "daily").toISOString()
    const [hourly, daily] = await Promise.all([
      listUsageRollups("hourly", hourlyFrom, hourlyTo),
      listUsageRollups("daily", dailyFrom, dailyTo),
    ])

    const hourlyBoundary = dashboardBoundaryRanges(start, end, "hourly")
    // Backfilled CCS data may have daily rollups but no usage-event documents.
    // Keep a dimension-level fallback for those boundary buckets so an empty
    // event query does not erase historical spend.
    const dailyBoundaryRanges: Array<[Date, Date]> = []
    const result = new Map<string, BudgetUsageValue>()
    const hourlyDays = new Set<string>()
    for (const rollup of hourly) {
      const bucketTime = Date.parse(rollup.bucketStart)
      if (!Number.isFinite(bucketTime)) continue
      const bucketStartDate = new Date(bucketTime)
      const overlapsWindow = nextBucketStart(bucketStartDate, "hourly") > start && bucketStartDate < end
      if (rollup.gatewayKeyId && overlapsWindow) hourlyDays.add(`${rollup.gatewayKeyId}:${bucketStart(bucketStartDate, "daily").toISOString()}`)
    }

    // Historical backfills may intentionally contain daily rollups without
    // hourly documents. Use those days only when hourly data does not exist
    // for the same key/day, preventing daily+hourly double counting.
    for (const rollup of daily) {
      const bucketTime = Date.parse(rollup.bucketStart)
      if (!Number.isFinite(bucketTime) || bucketTime >= end.getTime() || !rollup.gatewayKeyId) continue
      const dayKey = `${rollup.gatewayKeyId}:${bucketStart(new Date(bucketTime), "daily").toISOString()}`
      if (hourlyDays.has(dayKey)) continue
      const dayStart = new Date(bucketTime)
      const dayEnd = nextBucketStart(dayStart, "daily")
      if (dayStart >= start && dayEnd <= end) addBudgetUsage(result, rollup)
      else dailyBoundaryRanges.push([new Date(Math.max(start.getTime(), dayStart.getTime())), new Date(Math.min(end.getTime(), dayEnd.getTime()))])
    }

    const boundaryRanges = mergeDateRanges([...hourlyBoundary.ranges, ...dailyBoundaryRanges])
    const boundaryResults = await settledParallelMap(boundaryRanges, ([from, to]) => listUsageEvents(from.toISOString(), to.toISOString()))
    const boundaryDataAvailable = boundaryResults.every((entry) => entry.status === "fulfilled")
    const boundaryEvents = uniqueUsageEvents(boundaryResults.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []))
    const hourlyEventKeys = new Set<string>()
    const dailyEventKeys = new Set<string>()
    for (const event of boundaryEvents) {
      const completedAt = new Date(event.completedAt)
      hourlyEventKeys.add(`${event.gatewayKeyId}:${event.gatewayModelId}:${bucketStart(completedAt, "hourly").toISOString()}`)
      dailyEventKeys.add(`${event.gatewayKeyId}:${event.gatewayModelId}:${bucketStart(completedAt, "daily").toISOString()}`)
    }

    for (const rollup of hourly) {
      const bucketTime = Date.parse(rollup.bucketStart)
      if (!Number.isFinite(bucketTime) || bucketTime < start.getTime() || bucketTime >= end.getTime()) continue
      const hasBoundaryEvents = hourlyEventKeys.has(`${rollup.gatewayKeyId}:${rollup.gatewayModelId}:${rollup.bucketStart}`)
      if (hourlyBoundary.partialBucketStarts.has(rollup.bucketStart) && boundaryDataAvailable && hasBoundaryEvents) continue
      addBudgetUsage(result, rollup)
    }

    for (const rollup of daily) {
      const bucketTime = Date.parse(rollup.bucketStart)
      if (!Number.isFinite(bucketTime) || bucketTime >= end.getTime() || !rollup.gatewayKeyId) continue
      const dayKey = `${rollup.gatewayKeyId}:${bucketStart(new Date(bucketTime), "daily").toISOString()}`
      if (hourlyDays.has(dayKey)) continue
      const dayStart = new Date(bucketTime)
      const dayEnd = nextBucketStart(dayStart, "daily")
      if (dayStart >= start && dayEnd <= end) continue
      const hasBoundaryEvents = dailyEventKeys.has(`${rollup.gatewayKeyId}:${rollup.gatewayModelId}:${bucketStart(dayStart, "daily").toISOString()}`)
      if (boundaryDataAvailable && hasBoundaryEvents) continue
      addBudgetUsage(result, rollup)
    }

    if (boundaryDataAvailable) {
      for (const event of boundaryEvents) addBudgetEvent(result, event)
    }
    return result
  })().then((value) => {
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetUsageCache, cacheId, { value, expiresAt: Date.now() + dashboardCacheTtlMs }, 128)
    return value
  }).finally(() => {
    if (budgetUsageInflight.get(cacheId) === promise) budgetUsageInflight.delete(cacheId)
  })
  budgetUsageInflight.set(cacheId, promise)
  return promise
}

function setBudgetCounterBaseline(budget: GatewayKeyBudget, usageStart: string, window: BudgetWindow, counterSpentMicros: number, usage?: BudgetUsageValue) {
  const baseline: BudgetCounterBaseline = {
    offsetMicros: Number(usage?.spentMicros || 0) - counterSpentMicros,
    lastUsedAt: usage?.lastUsedAt || null,
    expiresAt: budgetCounterBaselineExpiresAt(window.end),
  }
  boundedSet(budgetCounterBaselineCache, budgetCounterBaselineId(budget, usageStart, window.end), baseline)
  return baseline
}

function getBudgetCounterBaseline(budget: GatewayKeyBudget, usageStart: string, window: BudgetWindow) {
  const key = budgetCounterBaselineId(budget, usageStart, window.end)
  const baseline = budgetCounterBaselineCache.get(key)
  if (baseline && baseline.expiresAt > Date.now()) return baseline
  if (baseline) budgetCounterBaselineCache.delete(key)
  return undefined
}

async function budgetSpentMicros(budget: GatewayKeyBudget, window: BudgetWindow, usageStart: string) {
  const counterPromise = budgetCounter(budget.apiKeyId, usageStart)
  const cachedBaseline = getBudgetCounterBaseline(budget, usageStart, window)
  if (cachedBaseline) return Math.max(0, await counterPromise + cachedBaseline.offsetMicros)

  const [counterSpentMicros, usageByKey] = await Promise.all([counterPromise, getBudgetUsage(window)])
  const usage = usageByKey.get(budget.apiKeyId)
  setBudgetCounterBaseline(budget, usageStart, window, counterSpentMicros, usage)
  return Math.max(0, Number(usage?.spentMicros || 0))
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
  const estimatedCost = Math.ceil(calculateCostMicros(usage, pricing).costMicros * budgetReservationSafetyMultiplier)
  return Math.min(limitMicros, Math.max(1, estimatedCost))
}

export interface BudgetRequestState {
  admission?: BudgetAdmission
  usageContext?: BudgetUsageContext
  pricing?: ResolvedModelPricing
}

export async function getBudgetRequestState(
  apiKeyId: string,
  gatewayModelId: string,
  providerModelId?: string,
  payload?: Record<string, unknown>,
  requestBodyBytes?: number,
): Promise<BudgetRequestState> {
  const budget = await budgetConfig(apiKeyId)
  if (!budget) return {}

  const window = await getBudgetWindow()
  const [usageStartAt, pricing] = await Promise.all([
    budgetUsageStart(window),
    budget.enabled && !window.bypassLimits ? getPricingForModel(gatewayModelId, providerModelId) : Promise.resolve(undefined),
  ])
  const usageContext = { usageStartAt, windowEnd: window.end } satisfies BudgetUsageContext
  if (!budget.enabled || window.bypassLimits) return { usageContext }
  if (!pricing) throw new BudgetDeniedError("This API key cannot call a model without configured pricing.", budgetRetryAfter(window))

  const spentMicros = await budgetSpentMicros(budget, window, usageStartAt)
  if (spentMicros >= budget.weeklyLimitMicros) throw new BudgetDeniedError("Weekly budget exceeded.", budgetRetryAfter(window))
  return {
    usageContext,
    pricing,
    admission: {
      key: `rawroute:budget:${currentWorkspaceId()}:${budgetCounterId(apiKeyId, usageStartAt)}:${hash(`${budget.updatedAt || ""}:${window.updatedAt || ""}`).slice(0, 16)}`,
      limitMicros: budget.weeklyLimitMicros,
      spentMicros,
      reservationMicros: estimateReservationMicros(payload, pricing, budget.weeklyLimitMicros, requestBodyBytes),
      ttlSeconds: budgetRetryAfter(window) + 60,
    },
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

export async function checkBudget(apiKeyId: string, gatewayModelId: string, providerModelId?: string) {
  await getBudgetAdmission(apiKeyId, gatewayModelId, providerModelId)
}

async function loadBudgetRows(
  keys: Awaited<ReturnType<typeof listApiKeys>> = [],
  currentWindow?: BudgetWindow,
  currentBudgets?: GatewayKeyBudget[],
) {
  const budgets = currentBudgets || await listBudgets()
  if (!budgets.length) return { rows: [], window: currentWindow }
  const window = currentWindow || await getBudgetWindow()
  const usageStartAt = await budgetUsageStart(window)
  const counters = budgets.length ? await listBudgetCounters(usageStartAt) : []
  const countersById = new Map(counters.map((counter) => [counter.id, counter]))
  const needsReconciliation = budgets.some((budget) => !getBudgetCounterBaseline(budget, usageStartAt, window))
  const usageByKey = needsReconciliation ? await getBudgetUsage(window) : undefined
  const keyNames = new Map(keys.map((key) => [key.id, key.name]))
  const rows = budgets.map((budget) => {
    const counter = countersById.get(budgetCounterId(budget.apiKeyId, usageStartAt))
    const counterSpentMicros = Number(counter?.spentMicros || 0)
    const usage = usageByKey?.get(budget.apiKeyId)
    const baseline = getBudgetCounterBaseline(budget, usageStartAt, window)
      || setBudgetCounterBaseline(budget, usageStartAt, window, counterSpentMicros, usage)
    const counterLastUsedAt = counter?.lastUsedAt || null
    const lastUsedAt = baseline.lastUsedAt && (!counterLastUsedAt || baseline.lastUsedAt > counterLastUsedAt)
      ? baseline.lastUsedAt
      : counterLastUsedAt
    return {
      ...budget,
      spentMicros: Math.max(0, counterSpentMicros + baseline.offsetMicros),
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
    loadBudgetRows(keys, window),
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
  return (await loadBudgetRows(keys, window)).rows
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
function publicKeyLabel(id: string) { return `Key ${hash(id).slice(0, 6).toUpperCase()}` }

async function buildDashboardPayload(query: DashboardQuery, publicView: boolean): Promise<DashboardPayload> {
  const budgetsPromise = listBudgets()
  const budgetWindowPromise = query.preset === "budget" ? getBudgetWindow() : undefined
  const range = await resolveRange(query, budgetWindowPromise ? await budgetWindowPromise : undefined)
  const span = range.to.getTime() - range.from.getTime()
  const requestedGranularity = query.granularity && query.granularity !== "auto"
    ? query.granularity
    : span <= 2 * 86_400_000 ? "hourly" : span <= 45 * 86_400_000 ? "daily" : "monthly"
  const trendGranularity = requestedGranularity
  // Firestore stores hourly/daily/monthly rollups. Weekly charts are derived
  // from daily rows so the group selector changes the chart without changing
  // the underlying usage totals or requiring another rollup collection.
  const storageGranularity = trendGranularity === "weekly" ? "daily" : trendGranularity
  const toExclusive = new Date(range.to.getTime() + (query.preset === "budget" ? 0 : 1))
  const boundary = dashboardBoundaryRanges(range.from, toExclusive, storageGranularity)

  const rollupsPromise = listUsageRollups(
    storageGranularity as UsageRollup["granularity"],
    range.from.toISOString(),
    toExclusive.toISOString(),
  )
  const boundaryEventsPromise = boundary.ranges.length
    ? parallelMap(boundary.ranges, ([from, to]) => listUsageEvents(from.toISOString(), to.toISOString()))
      .then(uniqueUsageEvents)
    : Promise.resolve([] as UsageEvent[])
  const keysPromise = listApiKeys()
  const budgetDataPromise = budgetsPromise.then(async (budgets) => {
    if (!budgets.length) return { rows: [], window: budgetWindowPromise ? await budgetWindowPromise : undefined }
    const window = budgetWindowPromise ? await budgetWindowPromise : await getBudgetWindow()
    return loadBudgetRows([], window, budgets)
  })
  const [rollupsResult, boundaryEventsResult, keysResult, budgetResult] = await Promise.allSettled([
    rollupsPromise,
    boundaryEventsPromise,
    keysPromise,
    budgetDataPromise,
  ])
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
  const replacementEvents = uniqueUsageEvents([boundaryEvents, missingDimensionEvents])
  const keys = keysResult.status === "fulfilled" ? keysResult.value : []
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
  let lastEventAt: string | null = null

  const compactHourLabels = (query.preset === "today" || query.preset === "yesterday") && trendGranularity === "hourly"
  function aggregateUsageRow(row: {
    bucketStart: string
    requests: number
    totalTokens: number
    costMicros: number
    pricedRequests: number
    lastEventAt?: string
    gatewayKeyId?: string
    gatewayModelId?: string
  }) {
    requestCount += row.requests
    totalTokens += row.totalTokens
    totalCostMicros += row.costMicros
    pricedRequests += row.pricedRequests
    if (row.lastEventAt && (!lastEventAt || lastEventAt < row.lastEventAt)) lastEventAt = row.lastEventAt

    const trendBucket = bucketStart(new Date(row.bucketStart), trendGranularity).toISOString()
    let point = trend.get(trendBucket)
    if (!point) {
      point = { bucketStart: trendBucket, label: formatAppTrendBucket(trendBucket, trendGranularity, compactHourLabels ? "hour" : undefined), requests: 0, tokens: 0, costMicros: 0 }
      trend.set(trendBucket, point)
    }
    point.requests += row.requests
    point.tokens += row.totalTokens
    point.costMicros += row.costMicros

    if (row.gatewayKeyId && row.gatewayModelId) {
      addDimensions(row.gatewayKeyId, row.gatewayModelId, row.requests, row.totalTokens, row.costMicros, row.lastEventAt)
    }
  }

  for (const rollup of rollups) {
    if (exactBoundaryData && boundary.partialBucketStarts.has(rollup.bucketStart)) continue
    if (missingDimensionData && missingDimensionBucketStarts.has(rollup.bucketStart)) continue
    aggregateUsageRow({
      bucketStart: rollup.bucketStart,
      requests: rollup.requests,
      totalTokens: rollup.totalTokens,
      costMicros: rollup.costMicros,
      pricedRequests: rollup.pricedRequests || 0,
      lastEventAt: rollup.lastEventAt,
      gatewayKeyId: rollup.gatewayKeyId,
      gatewayModelId: rollup.gatewayModelId,
    })
  }
  for (const event of replacementEvents) {
    aggregateUsageRow({
      bucketStart: bucketStart(new Date(event.completedAt), storageGranularity).toISOString(),
      requests: 1,
      totalTokens: event.totalTokens,
      costMicros: event.costMicros,
      pricedRequests: event.pricingConfidence === "exact" ? 1 : 0,
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
    let row = keyRows.get(keyId)
    if (!row) {
      const key = keyMap.get(keyId)
      row = {
        id: publicView ? publicKeyLabel(keyId) : keyId,
        label: key?.name || publicKeyLabel(keyId),
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
    modelsByKey.get(keyId)?.add(modelId)
    if (lastUsedAt && (!row.lastUsed || row.lastUsed < lastUsedAt)) row.lastUsed = lastUsedAt

    let model = modelRows.get(modelId)
    if (!model) {
      model = { model: modelId, requests: 0, tokens: 0, costMicros: 0 }
      modelRows.set(modelId, model)
    }
    model.requests += requests
    model.tokens += tokens
    model.costMicros += costMicros
  }

  for (const [keyId, row] of keyRows) {
    row.models = [...(modelsByKey.get(keyId) || [])]
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

  const unpricedRequests = Math.max(0, requestCount - pricedRequests)
  return {
    generatedAt: new Date().toISOString(),
    range: { label: range.label, from: range.from.toISOString(), to: range.to.toISOString(), granularity: trendGranularity },
    summary: { requests: requestCount, tokens: totalTokens, costMicros: totalCostMicros, activeKeys: keyRows.size, pricedRequests, unpricedRequests },
    trend: [...trend.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
    keys: [...keyRows.values()].sort((a, b) => b.requests - a.requests),
    models: [...modelRows.values()].sort((a, b) => b.requests - a.requests),
    freshness: { source: isMemory() ? "memory" : "firestore", lastEventAt },
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
  return { ...payload, keys: payload.keys.map((key) => ({ ...key, id: publicKeyLabel(key.id), maskedKey: "hidden" })) }
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
  const hasUsage = event.usageAvailable === true || (event.usageAvailable !== false && [event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheCreationTokens].some((value) => value > 0))
  const normalized = normalizeUsageMetrics(hasUsage ? { input: event.inputTokens, output: event.outputTokens, cached: event.cacheReadTokens, cacheCreation: event.cacheCreationTokens } : undefined)
  const calculated = calculateCostMicros(normalized, version)
  const after: UsageEvent = {
    ...event,
    ...normalized,
    costMicros: calculated.costMicros,
    pricingConfidence: calculated.pricingConfidence,
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
  const previousUpdatedAt = Date.parse(context.window.updatedAt)
  const nextUpdatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0)).toISOString()
  const next = { ...context.window, updatedAt: nextUpdatedAt }
  if (isMemory()) memoryState().window = next
  else await windowRef().set(next)
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
  const groupModels = await listModels()
  const gatewayModelIds = new Set<string>(groupModels.filter((model) => modelIds.has(model.id)).map((model) => model.gatewayModelId))
  const [events, budgetContext] = await Promise.all([listUsageEventsForModels(modelIds, gatewayModelIds), repricingBudgetContext()])
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
  budgetsCaches.clear()
  budgetsInflights.clear()
  budgetWindowCaches.clear()
  budgetWindowInflights.clear()
  budgetCacheGenerations.clear()
  resetModelPricingForTests()
}
