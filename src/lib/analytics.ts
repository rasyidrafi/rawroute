import { createHash } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { FieldPath, FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore"

import { listApiKeys, listModels } from "@/lib/store"
import { listCodexAccounts } from "@/lib/codex"
import { getCodexUsageForAccount } from "@/lib/codex-usage"
import { getModelPricingGeneration, getPricingForModelAt as getModernPricingForModelAt, getPricingJob, listPricingGroups, resetModelPricingForTests, updatePricingJob } from "@/lib/model-pricing"
import { calculateCostMicros, normalizeUsageMetrics, type UsageMetrics } from "@/lib/usage-metrics"
import { addZonedDays, addZonedMonths, formatAppTrendBucket, mondayInAppTimeZone, startOfZonedDay, startOfZonedMonth, startOfZonedYear, startOfZonedHour, zonedDateStringToDate } from "@/lib/timezone"
import type { BudgetBypassSession, BudgetWindow, BudgetWindowAnchor, DashboardPayload, DashboardQuery, GatewayKeyBudget, ModelPricing, UsageEvent, UsageRollup } from "@/lib/types"

let firestore: Firestore | undefined
const memoryEvents = new Map<string, UsageEvent>()
const memoryRollups = new Map<string, UsageRollup>()
const memoryPricing = new Map<string, ModelPricing>()
const memoryBudgets = new Map<string, GatewayKeyBudget>()
const memoryBudgetCounters = new Map<string, { spentMicros: number; lastUsedAt?: string }>()
const memoryBypassSessions = new Map<string, BudgetBypassSession>()
let memoryWindow: BudgetWindow | undefined
export type ResolvedModelPricing = Exclude<Awaited<ReturnType<typeof getModernPricingForModelAt>>, undefined> | ModelPricing
const pricingCache = new Map<string, { value: ResolvedModelPricing | undefined; expiresAt: number; modelPricingGeneration: number; legacyPricingGeneration: number }>()
const pricingInflight = new Map<string, Promise<ResolvedModelPricing | undefined>>()
const pricingCacheTtlMs = 30_000
let legacyPricingCache: TimedValue<{ byProviderModelId: Map<string, ModelPricing>; byGatewayModelId: Map<string, ModelPricing> }> | undefined
let legacyPricingInflight: Promise<{ byProviderModelId: Map<string, ModelPricing>; byGatewayModelId: Map<string, ModelPricing> }> | undefined
let legacyPricingGeneration = 0

interface TimedValue<T> { value: T; expiresAt: number }

const budgetCacheTtlMs = positiveDuration(process.env.BUDGET_CACHE_TTL_MS, 5_000)
const budgetCounterCacheTtlMs = positiveDuration(process.env.BUDGET_COUNTER_CACHE_TTL_MS, 15_000)
const dashboardCacheTtlMs = positiveDuration(process.env.DASHBOARD_CACHE_TTL_MS, 5_000)
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
const bypassSessionCache = new Map<string, TimedValue<BudgetBypassSession | null>>()
const bypassSessionInflight = new Map<string, Promise<BudgetBypassSession | undefined>>()
const dashboardCache = new Map<string, TimedValue<DashboardPayload>>()
const dashboardInflight = new Map<string, Promise<DashboardPayload>>()
let budgetsCache: TimedValue<GatewayKeyBudget[]> | undefined
let budgetsInflight: Promise<GatewayKeyBudget[]> | undefined
let budgetWindowCache: TimedValue<BudgetWindow> | undefined
let budgetWindowInflight: Promise<BudgetWindow> | undefined
let budgetCacheGeneration = 0

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

function invalidateBudgetReadCaches() {
  budgetCacheGeneration += 1
  budgetsCache = undefined
  budgetsInflight = undefined
  budgetWindowCache = undefined
  budgetWindowInflight = undefined
  budgetConfigCache.clear()
  budgetConfigInflight.clear()
  budgetCounterCache.clear()
  budgetCounterInflight.clear()
  budgetCounterListCache.clear()
  budgetCounterListInflight.clear()
  bypassSessionCache.clear()
  bypassSessionInflight.clear()
  dashboardCache.clear()
  dashboardInflight.clear()
}

function invalidateLegacyPricingCaches() {
  legacyPricingGeneration += 1
  legacyPricingCache = undefined
  legacyPricingInflight = undefined
  pricingCache.clear()
  pricingInflight.clear()
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
function eventsRef() { return db().collection(`${prefix()}_usage_events`) }
function rollupsRef() { return db().collection(`${prefix()}_usage_rollups`) }
function pricingRef() { return db().collection(`${prefix()}_model_pricing`) }
function budgetsRef() { return db().collection(`${prefix()}_budgets`) }
function budgetCountersRef() { return db().collection(`${prefix()}_budget_counters`) }
function bypassSessionsRef() { return db().collection(`${prefix()}_budget_bypass_sessions`) }
function windowRef() { return db().collection(`${prefix()}_budget_windows`).doc("current") }
function hash(value: string) { return createHash("sha256").update(value).digest("hex") }
function defaultWindow(): BudgetWindow { const start = mondayInAppTimeZone(); const end = addZonedDays(start, 7); return { start: start.toISOString(), end: end.toISOString(), anchor: "custom", codexAccountId: null, bypassLimits: false, bypassSessionId: null, updatedAt: new Date().toISOString() } }
function budgetCounterId(apiKeyId: string, usageStart: string) { return hash(`${apiKeyId}:${usageStart}`) }
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
  if (isMemory()) return memoryBypassSessions.get(window.bypassSessionId)?.startedAt || window.start
  const sessionId = window.bypassSessionId
  const cached = bypassSessionCache.get(sessionId)
  if (cached && cached.expiresAt > Date.now()) return cached.value?.startedAt || window.start
  const existing = bypassSessionInflight.get(sessionId)
  if (existing) return (await existing)?.startedAt || window.start

  const generation = budgetCacheGeneration
  const promise = bypassSessionsRef().doc(sessionId).get().then((snapshot) => {
    const session = snapshot.exists ? { ...snapshot.data(), id: snapshot.id } as BudgetBypassSession : undefined
    if (generation === budgetCacheGeneration) boundedSet(bypassSessionCache, sessionId, { value: session || null, expiresAt: Date.now() + budgetCacheTtlMs }, 128)
    return session
  }).finally(() => {
    if (bypassSessionInflight.get(sessionId) === promise) bypassSessionInflight.delete(sessionId)
  })
  bypassSessionInflight.set(sessionId, promise)
  return (await promise)?.startedAt || window.start
}

async function budgetConfig(apiKeyId: string) {
  if (isMemory()) return memoryBudgets.get(apiKeyId)
  const now = Date.now()
  const cached = budgetConfigCache.get(apiKeyId)
  if (cached && cached.expiresAt > now) return cached.value || undefined
  if (budgetsCache && budgetsCache.expiresAt > now) {
    const budget = budgetsCache.value.find((entry) => entry.apiKeyId === apiKeyId)
    boundedSet(budgetConfigCache, apiKeyId, { value: budget || null, expiresAt: budgetsCache.expiresAt })
    return budget
  }
  const existing = budgetConfigInflight.get(apiKeyId)
  if (existing) return existing

  const generation = budgetCacheGeneration
  const promise = budgetsRef().doc(apiKeyId).get().then((snapshot) => {
    const budget = snapshot.exists ? { ...snapshot.data(), apiKeyId: snapshot.id } as GatewayKeyBudget : undefined
    if (generation === budgetCacheGeneration) boundedSet(budgetConfigCache, apiKeyId, { value: budget || null, expiresAt: Date.now() + budgetCacheTtlMs })
    return budget
  }).finally(() => {
    if (budgetConfigInflight.get(apiKeyId) === promise) budgetConfigInflight.delete(apiKeyId)
  })
  budgetConfigInflight.set(apiKeyId, promise)
  return promise
}

async function budgetCounter(apiKeyId: string, usageStart: string) {
  const id = budgetCounterId(apiKeyId, usageStart)
  if (isMemory()) return memoryBudgetCounters.get(id)?.spentMicros || 0
  const cached = budgetCounterCache.get(id)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = budgetCounterInflight.get(id)
  if (existing) return existing

  const generation = budgetCacheGeneration
  const promise = budgetCountersRef().doc(id).get().then((snapshot) => {
    const spentMicros = Number((snapshot.data() as { spentMicros?: number } | undefined)?.spentMicros || 0)
    if (generation === budgetCacheGeneration) boundedSet(budgetCounterCache, id, { value: spentMicros, expiresAt: Date.now() + budgetCounterCacheTtlMs })
    return spentMicros
  }).finally(() => {
    if (budgetCounterInflight.get(id) === promise) budgetCounterInflight.delete(id)
  })
  budgetCounterInflight.set(id, promise)
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
    if (memoryEvents.has(event.id)) return event
    memoryEvents.set(event.id, event)
    for (const granularity of usageRollupGranularities) {
      const bucket = bucketStart(completedDate, granularity).toISOString()
      const id = rollupId(granularity, bucket, event)
      const current = memoryRollups.get(id) || emptyRollup(id, granularity, bucket, event)
      memoryRollups.set(id, {
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
      memoryBudgetCounters.set(counterId, {
        spentMicros: (memoryBudgetCounters.get(counterId)?.spentMicros || 0) + event.costMicros,
        lastUsedAt: event.completedAt,
      })
    }
    dashboardCache.clear()
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
    const cached = budgetCounterCache.get(counterId)
    if (cached && cached.expiresAt > now) {
      budgetCounterCache.set(counterId, { value: cached.value + event.costMicros, expiresAt: cached.expiresAt })
    }
    const list = budgetCounterListCache.get(context.usageStartAt)
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
    return [...memoryRollups.values()].filter((rollup) =>
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
  if (isMemory()) return [...memoryEvents.values()].filter((event) => Date.parse(event.completedAt) >= start && Date.parse(event.completedAt) < end)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
  const snapshot = await eventsRef().where("completedAt", ">=", from || "2000-01-01T00:00:00.000Z").where("completedAt", "<", to || new Date().toISOString()).get()
  return snapshot.docs.map((document) => document.data() as UsageEvent).sort((a, b) => a.completedAt.localeCompare(b.completedAt))
}

export async function listModelPricing() {
  if (isMemory()) return [...memoryPricing.values()].sort((a, b) => a.gatewayModelId.localeCompare(b.gatewayModelId))
  const snapshot = await pricingRef().get()
  return snapshot.docs.map((document) => ({ ...document.data(), id: document.id } as ModelPricing))
}

async function legacyPricingIndex() {
  if (isMemory()) {
    const byProviderModelId = new Map<string, ModelPricing>()
    const byGatewayModelId = new Map<string, ModelPricing>()
    for (const pricing of memoryPricing.values()) {
      if (!pricing.enabled) continue
      if (!byProviderModelId.has(pricing.modelId)) byProviderModelId.set(pricing.modelId, pricing)
      if (!byGatewayModelId.has(pricing.gatewayModelId)) byGatewayModelId.set(pricing.gatewayModelId, pricing)
    }
    return { byProviderModelId, byGatewayModelId }
  }
  if (legacyPricingCache && legacyPricingCache.expiresAt > Date.now()) return legacyPricingCache.value
  if (legacyPricingInflight) return legacyPricingInflight
  const generation = legacyPricingGeneration
  const promise = listModelPricing().then((entries) => {
    const byProviderModelId = new Map<string, ModelPricing>()
    const byGatewayModelId = new Map<string, ModelPricing>()
    for (const pricing of entries) {
      if (!pricing.enabled) continue
      if (!byProviderModelId.has(pricing.modelId)) byProviderModelId.set(pricing.modelId, pricing)
      if (!byGatewayModelId.has(pricing.gatewayModelId)) byGatewayModelId.set(pricing.gatewayModelId, pricing)
    }
    const value = { byProviderModelId, byGatewayModelId }
    if (generation === legacyPricingGeneration) legacyPricingCache = { value, expiresAt: Date.now() + pricingCacheTtlMs }
    return value
  }).finally(() => {
    if (legacyPricingInflight === promise) legacyPricingInflight = undefined
  })
  legacyPricingInflight = promise
  return promise
}

export async function getPricingForModel(gatewayModelId: string, providerModelId?: string) {
  const key = `${gatewayModelId}:${providerModelId || ""}`
  const modelGeneration = getModelPricingGeneration()
  const legacyGeneration = legacyPricingGeneration
  const cached = pricingCache.get(key)
  if (cached && cached.expiresAt > Date.now() && cached.modelPricingGeneration === modelGeneration && cached.legacyPricingGeneration === legacyGeneration) return cached.value
  const inflightKey = `${modelGeneration}:${legacyGeneration}:${key}`
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
    if (modelGeneration === getModelPricingGeneration() && legacyGeneration === legacyPricingGeneration) {
      boundedSet(pricingCache, key, { value, expiresAt: Date.now() + pricingCacheTtlMs, modelPricingGeneration: modelGeneration, legacyPricingGeneration: legacyGeneration })
    }
    return value
  })().finally(() => pricingInflight.delete(inflightKey))
  pricingInflight.set(inflightKey, promise)
  return promise
}
export async function upsertModelPricing(input: Omit<ModelPricing, "id" | "updatedAt"> & { id?: string }) {
  const pricing: ModelPricing = { ...input, id: input.id || crypto.randomUUID(), updatedAt: new Date().toISOString() }
  if (isMemory()) memoryPricing.set(pricing.id, pricing)
  else await pricingRef().doc(pricing.id).set(pricing)
  invalidateLegacyPricingCaches()
  return pricing
}
export async function deleteModelPricing(id: string) { if (isMemory()) memoryPricing.delete(id); else await pricingRef().doc(id).delete(); invalidateLegacyPricingCaches() }

export async function listBudgets(): Promise<GatewayKeyBudget[]> {
  if (isMemory()) return [...memoryBudgets.values()]
  const now = Date.now()
  if (budgetsCache && budgetsCache.expiresAt > now) return budgetsCache.value
  if (budgetsInflight) return budgetsInflight

  const generation = budgetCacheGeneration
  const promise = budgetsRef().get().then((snapshot) => {
    const budgets = snapshot.docs.map((document) => ({ ...document.data(), apiKeyId: document.id } as GatewayKeyBudget))
    if (generation === budgetCacheGeneration) {
      const expiresAt = Date.now() + budgetCacheTtlMs
      budgetsCache = { value: budgets, expiresAt }
      for (const budget of budgets) boundedSet(budgetConfigCache, budget.apiKeyId, { value: budget, expiresAt })
    }
    return budgets
  }).finally(() => {
    if (budgetsInflight === promise) budgetsInflight = undefined
  })
  budgetsInflight = promise
  return promise
}

export async function listBudgetBypassSessions(limit = 50, currentWindow?: BudgetWindow): Promise<BudgetBypassSession[]> {
  const window = currentWindow || await getBudgetWindow()
  if (window.bypassLimits && !window.bypassSessionId) await setBudgetBypassEnabled(true)
  if (isMemory()) return [...memoryBypassSessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
  const snapshot = await bypassSessionsRef().orderBy("startedAt", "desc").limit(limit).get()
  return snapshot.docs.map((document) => ({ ...document.data(), id: document.id } as BudgetBypassSession))
}

export async function getBudgetWindow(): Promise<BudgetWindow> {
  if (isMemory()) {
    const current = memoryWindow || defaultWindow()
    const next = advanceExpiredWindow(current)
    memoryWindow = next
    return next
  }
  const now = Date.now()
  if (budgetWindowCache && budgetWindowCache.expiresAt > now) {
    const next = advanceExpiredWindow(budgetWindowCache.value, now)
    if (next === budgetWindowCache.value) return next
  }
  if (budgetWindowInflight) return budgetWindowInflight

  const generation = budgetCacheGeneration
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
    if (generation === budgetCacheGeneration) budgetWindowCache = { value: window, expiresAt: Date.now() + budgetCacheTtlMs }
    return window
  }).finally(() => {
    if (budgetWindowInflight === promise) budgetWindowInflight = undefined
  })
  budgetWindowInflight = promise
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
  if (isMemory()) memoryWindow = next
  else await windowRef().set(next)
  invalidateBudgetReadCaches()
  if (!isMemory()) budgetWindowCache = { value: next, expiresAt: Date.now() + budgetCacheTtlMs }
  return next
}

export async function setBudgetBypassEnabled(enabled: boolean): Promise<{ window: BudgetWindow; session: BudgetBypassSession | null }> {
  const now = new Date().toISOString()
  if (isMemory()) {
    const current = await getBudgetWindow()
    if (current.bypassLimits === enabled && (!enabled || current.bypassSessionId)) {
      return { window: current, session: enabled && current.bypassSessionId ? memoryBypassSessions.get(current.bypassSessionId) || null : null }
    }
    let session: BudgetBypassSession | null = null
    if (enabled) {
      session = { id: crypto.randomUUID(), startedAt: now, endedAt: null }
      memoryBypassSessions.set(session.id, session)
    } else if (current.bypassSessionId) {
      const active = memoryBypassSessions.get(current.bypassSessionId)
      if (active) { session = { ...active, endedAt: now }; memoryBypassSessions.set(session.id, session) }
    } else if (current.bypassLimits) {
      session = { id: crypto.randomUUID(), startedAt: current.updatedAt, endedAt: now }
      memoryBypassSessions.set(session.id, session)
    }
    const next: BudgetWindow = { ...current, bypassLimits: enabled, bypassSessionId: enabled ? session?.id || null : null, updatedAt: now }
    memoryWindow = next
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
  budgetWindowCache = { value: result.window, expiresAt: Date.now() + budgetCacheTtlMs }
  return result
}
export async function upsertBudget(input: { apiKeyId: string; weeklyLimitMicros: number; enabled: boolean }) {
  const window = await getBudgetWindow()
  const budget: GatewayKeyBudget = { ...input, spentMicros: 0, windowStart: window.start, windowEnd: window.end, updatedAt: new Date().toISOString() }
  if (isMemory()) memoryBudgets.set(input.apiKeyId, budget)
  else await budgetsRef().doc(input.apiKeyId).set(budget)
  invalidateBudgetReadCaches()
  return budget
}
export async function deleteBudget(apiKeyId: string) {
  if (isMemory()) memoryBudgets.delete(apiKeyId)
  else await budgetsRef().doc(apiKeyId).delete()
  invalidateBudgetReadCaches()
}

async function listBudgetCounters(usageStart: string): Promise<BudgetCounterRow[]> {
  if (isMemory()) return [...memoryBudgetCounters.entries()].map(([id, value]) => ({ id, ...value }))
  const now = Date.now()
  const cached = budgetCounterListCache.get(usageStart)
  if (cached && cached.expiresAt > now) return cached.value
  const existing = budgetCounterListInflight.get(usageStart)
  if (existing) return existing

  const generation = budgetCacheGeneration
  const promise = budgetCountersRef().where("usageStartAt", "==", usageStart).get().then((snapshot) => {
    const rows = snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as Omit<BudgetCounterRow, "id">) }))
    if (generation === budgetCacheGeneration) boundedSet(budgetCounterListCache, usageStart, { value: rows, expiresAt: Date.now() + budgetCacheTtlMs }, 8)
    return rows
  }).finally(() => {
    if (budgetCounterListInflight.get(usageStart) === promise) budgetCounterListInflight.delete(usageStart)
  })
  budgetCounterListInflight.set(usageStart, promise)
  return promise
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

  const spentMicros = await budgetCounter(apiKeyId, usageStartAt)
  if (spentMicros >= budget.weeklyLimitMicros) throw new BudgetDeniedError("Weekly budget exceeded.", budgetRetryAfter(window))
  return {
    usageContext,
    pricing,
    admission: {
      key: `rawroute:budget:${budgetCounterId(apiKeyId, usageStartAt)}`,
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

async function loadBudgetRows(keys: Awaited<ReturnType<typeof listApiKeys>> = [], currentWindow?: BudgetWindow) {
  const [budgets, window] = await Promise.all([
    listBudgets(),
    currentWindow ? Promise.resolve(currentWindow) : getBudgetWindow(),
  ])
  const usageStartAt = await budgetUsageStart(window)
  const counters = budgets.length ? await listBudgetCounters(usageStartAt) : []
  const apiKeyByCounterId = new Map<string, string>()
  for (const budget of budgets) apiKeyByCounterId.set(budgetCounterId(budget.apiKeyId, usageStartAt), budget.apiKeyId)

  const countersByKey = new Map<string, { spentMicros: number; lastUsedAt?: string }>()
  for (const counter of counters) {
    const apiKeyId = apiKeyByCounterId.get(counter.id)
    if (apiKeyId) countersByKey.set(apiKeyId, { spentMicros: Number(counter.spentMicros || 0), lastUsedAt: counter.lastUsedAt })
  }
  const keyNames = new Map(keys.map((key) => [key.id, key.name]))
  const rows = budgets.map((budget) => {
    const counter = countersByKey.get(budget.apiKeyId)
    return {
      ...budget,
      spentMicros: counter?.spentMicros || 0,
      windowStart: window.start,
      windowEnd: window.end,
      usageStartAt,
      name: keyNames.get(budget.apiKeyId) || "Unknown",
      lastUsedAt: counter?.lastUsedAt || null,
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
function bucketStart(date: Date, granularity: string) { if (granularity === "hourly") return startOfZonedHour(date); if (granularity === "monthly") return startOfZonedMonth(date); return startOfZonedDay(date) }
function mask(key: string) { return key.length <= 12 ? `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 4))}` : `${key.slice(0, 7)}${"•".repeat(12)}${key.slice(-4)}` }
function publicKeyLabel(id: string) { return `Key ${hash(id).slice(0, 6).toUpperCase()}` }

async function buildDashboardPayload(query: DashboardQuery, publicView: boolean): Promise<DashboardPayload> {
  const budgetWindowPromise = getBudgetWindow()
  const range = await resolveRange(query, query.preset === "budget" ? await budgetWindowPromise : undefined)
  const span = range.to.getTime() - range.from.getTime()
  const requestedGranularity = query.granularity && query.granularity !== "auto"
    ? query.granularity
    : span <= 2 * 86_400_000 ? "hourly" : span <= 45 * 86_400_000 ? "daily" : "monthly"
  const granularity = requestedGranularity === "weekly" ? "daily" : requestedGranularity
  const toExclusive = new Date(range.to.getTime() + (query.preset === "budget" ? 0 : 1))
  const boundary = dashboardBoundaryRanges(range.from, toExclusive, granularity)

  const rollupsPromise = listUsageRollups(
    granularity as UsageRollup["granularity"],
    range.from.toISOString(),
    toExclusive.toISOString(),
  )
  const boundaryEventsPromise = boundary.ranges.length
    ? Promise.all(boundary.ranges.map(([from, to]) => listUsageEvents(from.toISOString(), to.toISOString())))
      .then((batches) => [...new Map(batches.flat().map((event) => [event.id, event])).values()])
    : Promise.resolve([] as UsageEvent[])
  const keysPromise = publicView ? Promise.resolve([] as Awaited<ReturnType<typeof listApiKeys>>) : listApiKeys()
  const budgetDataPromise = budgetWindowPromise.then((window) => loadBudgetRows([], window))
  const [rollupsResult, boundaryEventsResult, keysResult, budgetResult] = await Promise.allSettled([
    rollupsPromise,
    boundaryEventsPromise,
    keysPromise,
    budgetDataPromise,
  ])
  const rollups = rollupsResult.status === "fulfilled" ? rollupsResult.value : []
  const boundaryEvents = boundaryEventsResult.status === "fulfilled" ? boundaryEventsResult.value : []
  const exactBoundaryData = boundaryEventsResult.status === "fulfilled"
  const missingDimensionBucketStarts = new Set(
    rollups
      .filter((rollup) => !rollup.gatewayKeyId || !rollup.gatewayModelId)
      .map((rollup) => rollup.bucketStart),
  )
  const missingDimensionRanges = [...missingDimensionBucketStarts].map((bucket) => [
    new Date(Math.max(range.from.getTime(), Date.parse(bucket))),
    new Date(Math.min(toExclusive.getTime(), nextBucketStart(new Date(bucket), granularity).getTime())),
  ] as [Date, Date]).filter(([from, to]) => from < to)
  const missingDimensionEventsResult = missingDimensionRanges.length
    ? await Promise.allSettled(missingDimensionRanges.map(([from, to]) => listUsageEvents(from.toISOString(), to.toISOString())))
    : []
  const missingDimensionData = missingDimensionRanges.length === 0 || missingDimensionEventsResult.every((result) => result.status === "fulfilled")
  const missingDimensionEvents = missingDimensionData
    ? missingDimensionEventsResult.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    : []
  const replacementEvents = [...new Map([...boundaryEvents, ...missingDimensionEvents].map((event) => [event.id, event])).values()]
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

  const rollupsToAggregate = exactBoundaryData
    ? rollups.filter((rollup) => !boundary.partialBucketStarts.has(rollup.bucketStart) && (!missingDimensionData || !missingDimensionBucketStarts.has(rollup.bucketStart)))
    : rollups.filter((rollup) => !missingDimensionData || !missingDimensionBucketStarts.has(rollup.bucketStart))
  for (const rollup of [...rollupsToAggregate, ...replacementEvents.map((event) => rollupFromEvent(event, granularity as UsageRollup["granularity"]))]) {
    requestCount += rollup.requests
    totalTokens += rollup.totalTokens
    totalCostMicros += rollup.costMicros
    pricedRequests += rollup.pricedRequests || 0
    if (rollup.lastEventAt && (!lastEventAt || lastEventAt < rollup.lastEventAt)) lastEventAt = rollup.lastEventAt

    let point = trend.get(rollup.bucketStart)
    if (!point) {
      point = { bucketStart: rollup.bucketStart, label: formatAppTrendBucket(rollup.bucketStart, granularity), requests: 0, tokens: 0, costMicros: 0 }
      trend.set(rollup.bucketStart, point)
    }
    point.requests += rollup.requests
    point.tokens += rollup.totalTokens
    point.costMicros += rollup.costMicros

    if (!rollup.gatewayKeyId || !rollup.gatewayModelId) continue
    addDimensions(rollup.gatewayKeyId, rollup.gatewayModelId, rollup.requests, rollup.totalTokens, rollup.costMicros, rollup.lastEventAt)
  }

  function addDimensions(keyId: string, modelId: string, requests: number, tokens: number, costMicros: number, lastUsedAt?: string) {
    let row = keyRows.get(keyId)
    if (!row) {
      const key = keyMap.get(keyId)
      row = {
        id: keyId,
        label: publicView ? publicKeyLabel(keyId) : (key?.name || publicKeyLabel(keyId)),
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
    range: { label: range.label, from: range.from.toISOString(), to: range.to.toISOString(), granularity },
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

  const merged = ranges.sort((a, b) => a[0].getTime() - b[0].getTime()).reduce<Array<[Date, Date]>>((result, current) => {
    const previous = result[result.length - 1]
    if (previous && current[0].getTime() <= previous[1].getTime()) previous[1] = new Date(Math.max(previous[1].getTime(), current[1].getTime()))
    else result.push(current)
    return result
  }, [])
  const partialBucketStarts = new Set<string>()
  if (!startAligned) partialBucketStarts.add(startBucket.toISOString())
  if (!endAligned) partialBucketStarts.add(endBucket.toISOString())
  return { ranges: merged.filter(([rangeFrom, rangeTo]) => rangeFrom < rangeTo), partialBucketStarts }
}

function nextBucketStart(value: Date, granularity: string) {
  if (granularity === "hourly") return addZonedDays(value, 1 / 24)
  if (granularity === "monthly") return addZonedMonths(value, 1)
  return addZonedDays(value, 1)
}

function rollupFromEvent(event: UsageEvent, granularity: UsageRollup["granularity"]): UsageRollup {
  const bucket = bucketStart(new Date(event.completedAt), granularity).toISOString()
  return {
    ...emptyRollup(`boundary:${event.id}`, granularity, bucket, event),
    requests: 1,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    totalTokens: event.totalTokens,
    costMicros: event.costMicros,
    pricedRequests: event.pricingConfidence === "exact" ? 1 : 0,
    unpricedRequests: event.pricingConfidence === "exact" ? 0 : 1,
  }
}

export async function getDashboardPayload(query: DashboardQuery, publicView = false): Promise<DashboardPayload> {
  if (isMemory()) return buildDashboardPayload(query, publicView)
  const cacheKey = JSON.stringify([publicView, query.preset || "all", query.from || "", query.to || "", query.granularity || "auto"])
  const cached = dashboardCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = dashboardInflight.get(cacheKey)
  if (existing) return existing

  const promise = buildDashboardPayload(query, publicView).then((payload) => {
    boundedSet(dashboardCache, cacheKey, { value: payload, expiresAt: Date.now() + dashboardCacheTtlMs }, 32)
    return payload
  }).finally(() => {
    if (dashboardInflight.get(cacheKey) === promise) dashboardInflight.delete(cacheKey)
  })
  dashboardInflight.set(cacheKey, promise)
  return promise
}

export function redactPublicDashboard(payload: DashboardPayload): DashboardPayload {
  return { ...payload, keys: payload.keys.map((key) => ({ ...key, id: publicKeyLabel(key.id), label: publicKeyLabel(key.id), maskedKey: "hidden" })) }
}

async function replaceUsageEvent(event: UsageEvent) {
  if (isMemory()) {
    memoryEvents.set(event.id, event)
    return
  }
  await eventsRef().doc(event.id).set(event)
}

async function rebuildUsageRollups(events: UsageEvent[]) {
  if (isMemory()) {
    memoryRollups.clear()
    for (const event of events) {
      for (const granularity of ["hourly", "daily", "monthly"] as const) {
        const bucket = bucketStart(new Date(event.completedAt), granularity).toISOString()
        const id = rollupId(granularity, bucket, event)
        const current = memoryRollups.get(id) || emptyRollup(id, granularity, bucket, event)
        memoryRollups.set(id, { ...current, requests: current.requests + 1, inputTokens: current.inputTokens + event.inputTokens, outputTokens: current.outputTokens + event.outputTokens, cacheReadTokens: current.cacheReadTokens + event.cacheReadTokens, cacheCreationTokens: current.cacheCreationTokens + event.cacheCreationTokens, totalTokens: current.totalTokens + event.totalTokens, costMicros: current.costMicros + event.costMicros, pricedRequests: (current.pricedRequests || 0) + (event.pricingConfidence === "exact" ? 1 : 0), unpricedRequests: (current.unpricedRequests || 0) + (event.pricingConfidence === "exact" ? 0 : 1), lastEventAt: !current.lastEventAt || current.lastEventAt < event.completedAt ? event.completedAt : current.lastEventAt, updatedAt: new Date().toISOString() })
      }
    }
    return
  }
  const existing = await rollupsRef().get()
  for (let index = 0; index < existing.docs.length; index += 400) {
    const batch = db().batch()
    for (const document of existing.docs.slice(index, index + 400)) batch.delete(document.ref)
    await batch.commit()
  }
  const aggregates = new Map<string, UsageRollup>()
  for (const event of events) {
    for (const granularity of ["hourly", "daily", "monthly"] as const) {
      const bucket = bucketStart(new Date(event.completedAt), granularity).toISOString()
      const id = rollupId(granularity, bucket, event)
      const current = aggregates.get(id) || emptyRollup(id, granularity, bucket, event)
      aggregates.set(id, { ...current, requests: current.requests + 1, inputTokens: current.inputTokens + event.inputTokens, outputTokens: current.outputTokens + event.outputTokens, cacheReadTokens: current.cacheReadTokens + event.cacheReadTokens, cacheCreationTokens: current.cacheCreationTokens + event.cacheCreationTokens, totalTokens: current.totalTokens + event.totalTokens, costMicros: current.costMicros + event.costMicros, pricedRequests: (current.pricedRequests || 0) + (event.pricingConfidence === "exact" ? 1 : 0), unpricedRequests: (current.unpricedRequests || 0) + (event.pricingConfidence === "exact" ? 0 : 1), lastEventAt: !current.lastEventAt || current.lastEventAt < event.completedAt ? event.completedAt : current.lastEventAt })
    }
  }
  const entries = [...aggregates.values()]
  for (let index = 0; index < entries.length; index += 400) {
    const batch = db().batch()
    for (const entry of entries.slice(index, index + 400)) batch.set(rollupsRef().doc(entry.id), entry)
    await batch.commit()
  }
}

async function rebuildBudgetCounters(events: UsageEvent[]) {
  const budgets = await listBudgets()
  if (!budgets.length) return
  const window = await getBudgetWindow()
  const usageStart = await budgetUsageStart(window)
  const budgetIds = new Set(budgets.map((budget) => budget.apiKeyId))
  const totals = new Map<string, { spentMicros: number; lastUsedAt: string }>()
  for (const event of events) {
    const completedAt = Date.parse(event.completedAt)
    if (!budgetIds.has(event.gatewayKeyId) || event.status < 200 || event.status >= 300 || completedAt < Date.parse(usageStart) || completedAt >= Date.parse(window.end)) continue
    const id = budgetCounterId(event.gatewayKeyId, usageStart)
    const current = totals.get(id)
    totals.set(id, { spentMicros: (current?.spentMicros || 0) + event.costMicros, lastUsedAt: !current || current.lastUsedAt < event.completedAt ? event.completedAt : current.lastUsedAt })
  }
  if (isMemory()) {
    const currentWindowCounterIds = new Set(budgets.map((budget) => budgetCounterId(budget.apiKeyId, usageStart)))
    for (const id of memoryBudgetCounters.keys()) {
      if (totals.has(id) || currentWindowCounterIds.has(id)) memoryBudgetCounters.delete(id)
    }
    for (const [id, value] of totals) memoryBudgetCounters.set(id, value)
    return
  }
  const existing = await budgetCountersRef().where("usageStartAt", "==", usageStart).get()
  for (let index = 0; index < existing.docs.length; index += 400) {
    const batch = db().batch()
    for (const document of existing.docs.slice(index, index + 400)) batch.delete(document.ref)
    await batch.commit()
  }
  const entries = [...totals.entries()]
  for (let index = 0; index < entries.length; index += 400) {
    const batch = db().batch()
    for (const [id, value] of entries.slice(index, index + 400)) batch.set(budgetCountersRef().doc(id), { usageStartAt: usageStart, windowEnd: window.end, ...value, updatedAt: new Date().toISOString() })
    await batch.commit()
  }
}

export async function repriceUsageForGroup(jobId: string) {
  const job = await getPricingJob(jobId)
  if (!job) return
  const group = (await listPricingGroups()).find((entry) => entry.id === job.groupId)
  if (!group) throw new Error("Pricing group not found for repricing job.")
  const modelIds = new Set(group.memberModelIds)
  const groupModels = await listModels()
  const gatewayModelIds = new Set(groupModels.filter((model) => modelIds.has(model.id)).map((model) => model.gatewayModelId))
  const allEvents = await listUsageEvents()
  const events = allEvents.filter((event) => (event.providerModelId && modelIds.has(event.providerModelId)) || gatewayModelIds.has(event.gatewayModelId))
  await updatePricingJob(jobId, { status: "running", totalEvents: events.length, processedEvents: 0, startedAt: new Date().toISOString() })
  const updatedEvents = new Map<string, UsageEvent>()
  for (let index = 0; index < events.length; index += 100) {
    const chunk = events.slice(index, index + 100)
    for (const event of chunk) {
      const pricing = await getModernPricingForModelAt({ gatewayModelId: event.gatewayModelId, providerModelId: event.providerModelId }, new Date(event.completedAt))
      const normalized = normalizeUsageMetrics({ input: event.inputTokens, output: event.outputTokens, cached: event.cacheReadTokens, cacheCreation: event.cacheCreationTokens })
      const calculated = calculateCostMicros(normalized, pricing)
      const updatedEvent: UsageEvent = {
        ...event,
        ...normalized,
        costMicros: calculated.costMicros,
        pricingConfidence: calculated.pricingConfidence,
        ...(calculated.pricingContextTier ? { pricingContextTier: calculated.pricingContextTier } : {}),
      }
      if (pricing) {
        updatedEvent.pricingGroupId = pricing.pricingGroupId
        updatedEvent.pricingVersionId = pricing.pricingVersionId
      } else {
        delete updatedEvent.pricingGroupId
        delete updatedEvent.pricingVersionId
      }
      await replaceUsageEvent(updatedEvent)
      updatedEvents.set(updatedEvent.id, updatedEvent)
    }
    await updatePricingJob(jobId, { processedEvents: Math.min(index + chunk.length, events.length) })
  }
  const repricedEvents = allEvents.map((event) => updatedEvents.get(event.id) || event)
  await rebuildUsageRollups(repricedEvents)
  await rebuildBudgetCounters(repricedEvents)
  dashboardCache.clear()
  return updatePricingJob(jobId, { status: "completed", processedEvents: events.length, completedAt: new Date().toISOString() })
}

export function resetAnalyticsForTests() { memoryEvents.clear(); memoryRollups.clear(); memoryPricing.clear(); memoryBudgetCounters.clear(); memoryBudgets.clear(); memoryBypassSessions.clear(); memoryWindow = undefined; invalidateLegacyPricingCaches(); invalidateBudgetReadCaches(); resetModelPricingForTests() }
