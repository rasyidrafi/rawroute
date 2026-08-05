import { createHash } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore"

import { listApiKeys, listModels } from "@/lib/store"
import { listCodexAccounts } from "@/lib/codex"
import { getCodexUsageForAccount } from "@/lib/codex-usage"
import { getPricingForModelAt as getModernPricingForModelAt, getPricingJob, listPricingGroups, resetModelPricingForTests, updatePricingJob } from "@/lib/model-pricing"
import { calculateCostMicros, normalizeUsageMetrics, type UsageMetrics } from "@/lib/usage-metrics"
import { addZonedDays, addZonedMonths, formatAppTrendBucket, mondayInAppTimeZone, startOfZonedDay, startOfZonedMonth, startOfZonedYear, startOfZonedHour, zonedDateStringToDate } from "@/lib/timezone"
import type { BudgetBypassSession, BudgetWindow, BudgetWindowAnchor, DashboardPayload, DashboardQuery, GatewayKeyBudget, ModelPricing, PricingContextTier, UsageEvent, UsageRollup } from "@/lib/types"

let firestore: Firestore | undefined
const memoryEvents = new Map<string, UsageEvent>()
const memoryRollups = new Map<string, UsageRollup>()
const memoryPricing = new Map<string, ModelPricing>()
const memoryBudgets = new Map<string, GatewayKeyBudget>()
const memoryBudgetCounters = new Map<string, { spentMicros: number; lastUsedAt?: string }>()
const memoryBypassSessions = new Map<string, BudgetBypassSession>()
let memoryWindow: BudgetWindow | undefined
const pricingCache = new Map<string, { value: Awaited<ReturnType<typeof getModernPricingForModelAt>> | ModelPricing | undefined; expiresAt: number }>()
const pricingInflight = new Map<string, Promise<Awaited<ReturnType<typeof getModernPricingForModelAt>> | ModelPricing | undefined>>()
const pricingCacheTtlMs = 30_000

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
  const snapshot = await bypassSessionsRef().doc(window.bypassSessionId).get()
  return snapshot.exists ? (snapshot.data() as BudgetBypassSession).startedAt : window.start
}

async function budgetConfig(apiKeyId: string) {
  if (isMemory()) return memoryBudgets.get(apiKeyId)
  const snapshot = await budgetsRef().doc(apiKeyId).get()
  return snapshot.exists ? { ...snapshot.data(), apiKeyId: snapshot.id } as GatewayKeyBudget : undefined
}

async function budgetCounter(apiKeyId: string, usageStart: string) {
  const id = budgetCounterId(apiKeyId, usageStart)
  if (isMemory()) return memoryBudgetCounters.get(id)?.spentMicros || 0
  const snapshot = await budgetCountersRef().doc(id).get()
  return Number((snapshot.data() as { spentMicros?: number } | undefined)?.spentMicros || 0)
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

export async function recordUsageEvent(event: UsageEvent) {
  const budget = await budgetConfig(event.gatewayKeyId).catch(() => undefined)
  const window = budget ? await getBudgetWindow().catch(() => undefined) : undefined
  const usageStart = window ? await budgetUsageStart(window).catch(() => window.start) : undefined
  const completedAt = Date.parse(event.completedAt)
  const countForBudget = Boolean(budget && window && usageStart && event.status >= 200 && event.status < 300 && completedAt >= Date.parse(usageStart) && completedAt < Date.parse(window.end))
  const counterId = countForBudget && usageStart ? budgetCounterId(event.gatewayKeyId, usageStart) : undefined
  if (isMemory()) {
    if (memoryEvents.has(event.id)) return event
    memoryEvents.set(event.id, event)
    for (const granularity of ["hourly", "daily", "monthly"] as const) {
      const bucket = bucketStart(new Date(event.completedAt), granularity).toISOString()
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
        updatedAt: new Date().toISOString(),
      })
    }
    if (counterId && budget) memoryBudgetCounters.set(counterId, { spentMicros: (memoryBudgetCounters.get(counterId)?.spentMicros || 0) + event.costMicros, lastUsedAt: event.completedAt })
    return event
  }
  const ref = eventsRef().doc(event.id)
  await db().runTransaction(async (transaction) => {
    const rollupRefs = (["hourly", "daily", "monthly"] as const).map((granularity) => {
      const bucket = bucketStart(new Date(event.completedAt), granularity).toISOString()
      return { granularity, ref: rollupsRef().doc(rollupId(granularity, bucket, event)), bucketStart: bucket }
    })
    const existing = await transaction.get(ref)
    if (existing.exists) return
    transaction.create(ref, event)
    rollupRefs.forEach((entry) => {
      const base = emptyRollup(entry.ref.id, entry.granularity, entry.bucketStart, event)
      transaction.set(entry.ref, {
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
        updatedAt: new Date().toISOString(),
      }, { merge: true })
    })
    if (counterId && budget && usageStart && window) {
      transaction.set(budgetCountersRef().doc(counterId), {
        apiKeyId: event.gatewayKeyId,
        usageStartAt: usageStart,
        windowEnd: window.end,
        spentMicros: FieldValue.increment(event.costMicros),
        lastUsedAt: event.completedAt,
        updatedAt: new Date().toISOString(),
      }, { merge: true })
    }
  })
  return event
}

export async function listUsageRollups(granularity?: UsageRollup["granularity"], from?: string, to?: string) {
  const fromTime = from ? Date.parse(from) : -Infinity
  const toTime = to ? Date.parse(to) : Infinity
  if (isMemory()) return [...memoryRollups.values()].filter((rollup) => (!granularity || rollup.granularity === granularity) && Date.parse(rollup.bucketStart) >= fromTime && Date.parse(rollup.bucketStart) < toTime)
  let query = rollupsRef() as FirebaseFirestore.Query
  if (granularity) query = query.where("granularity", "==", granularity)
  const snapshot = await query.get()
  return snapshot.docs.map((document) => document.data() as UsageRollup).filter((rollup) => (!granularity || rollup.granularity === granularity) && Date.parse(rollup.bucketStart) >= fromTime && Date.parse(rollup.bucketStart) < toTime)
}

export async function recordGatewayUsage(input: {
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
}) {
  const normalized = normalizeUsageMetrics(input.metrics)
  let pricing: (ModelPricing | { inputMicrosPerMillion: number; outputMicrosPerMillion: number; cacheReadMicrosPerMillion: number; cacheCreationMicrosPerMillion: number; contextTiers?: PricingContextTier[]; pricingGroupId?: string; pricingVersionId?: string }) | undefined
  try { pricing = await getPricingForModel(input.gatewayModelId, input.providerModelId) }
  catch { pricing = undefined }
  const calculated = calculateCostMicros(normalized, pricing || undefined)
  const event: UsageEvent = {
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
    costMicros: calculated.costMicros,
    pricingConfidence: calculated.pricingConfidence,
    ...(pricing && "pricingGroupId" in pricing && pricing.pricingGroupId ? { pricingGroupId: pricing.pricingGroupId } : {}),
    ...(pricing && "pricingVersionId" in pricing && pricing.pricingVersionId ? { pricingVersionId: pricing.pricingVersionId } : {}),
    ...(calculated.pricingContextTier ? { pricingContextTier: calculated.pricingContextTier } : {}),
  }
  return recordUsageEvent(event)
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
export async function getPricingForModel(gatewayModelId: string, providerModelId?: string) {
  const key = `${gatewayModelId}:${providerModelId || ""}`
  const cached = pricingCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = pricingInflight.get(key)
  if (existing) return existing
  const promise = (async () => {
    let value: Awaited<ReturnType<typeof getModernPricingForModelAt>> | ModelPricing | undefined
    try {
      value = await getModernPricingForModelAt({ gatewayModelId, providerModelId })
    } catch {
      // Legacy pricing remains available while the advanced catalog is unavailable.
    }
    if (!value) {
      const entries = await listModelPricing()
      value = entries.find((entry) => entry.enabled && (entry.modelId === providerModelId || entry.gatewayModelId === gatewayModelId))
    }
    pricingCache.set(key, { value, expiresAt: Date.now() + pricingCacheTtlMs })
    return value
  })().finally(() => pricingInflight.delete(key))
  pricingInflight.set(key, promise)
  return promise
}
export async function upsertModelPricing(input: Omit<ModelPricing, "id" | "updatedAt"> & { id?: string }) {
  const pricing: ModelPricing = { ...input, id: input.id || crypto.randomUUID(), updatedAt: new Date().toISOString() }
  if (isMemory()) memoryPricing.set(pricing.id, pricing)
  else await pricingRef().doc(pricing.id).set(pricing)
  pricingCache.clear()
  return pricing
}
export async function deleteModelPricing(id: string) { if (isMemory()) memoryPricing.delete(id); else await pricingRef().doc(id).delete(); pricingCache.clear() }

export async function listBudgets(): Promise<GatewayKeyBudget[]> {
  if (isMemory()) return [...memoryBudgets.values()]
  const snapshot = await budgetsRef().get()
  return snapshot.docs.map((document) => ({ ...document.data(), apiKeyId: document.id } as GatewayKeyBudget))
}

export async function listBudgetBypassSessions(limit = 50, currentWindow?: BudgetWindow): Promise<BudgetBypassSession[]> {
  const window = currentWindow || await getBudgetWindow()
  if (window.bypassLimits && !window.bypassSessionId) await setBudgetBypassEnabled(true)
  if (isMemory()) return [...memoryBypassSessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
  const snapshot = await bypassSessionsRef().orderBy("startedAt", "desc").limit(limit).get()
  return snapshot.docs.map((document) => ({ ...document.data(), id: document.id } as BudgetBypassSession))
}

export async function getBudgetWindow() {
  if (isMemory()) {
    const current = memoryWindow || defaultWindow()
    const next = advanceExpiredWindow(current)
    if (next !== current) memoryWindow = next
    return next
  }
  let result = defaultWindow()
  await db().runTransaction(async (transaction) => {
    const ref = windowRef()
    const snapshot = await transaction.get(ref)
    const current = snapshot.exists ? { ...defaultWindow(), ...snapshot.data() } as BudgetWindow : defaultWindow()
    const next = advanceExpiredWindow(current)
    if (!snapshot.exists) transaction.create(ref, next)
    else if (next.updatedAt !== current.updatedAt) transaction.set(ref, next)
    result = next
  })
  return result
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
  if (isMemory()) memoryWindow = next; else await windowRef().set(next)
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
  return result
}
export async function upsertBudget(input: { apiKeyId: string; weeklyLimitMicros: number; enabled: boolean }) {
  const window = await getBudgetWindow()
  const budget: GatewayKeyBudget = { ...input, spentMicros: 0, windowStart: window.start, windowEnd: window.end, updatedAt: new Date().toISOString() }
  if (isMemory()) memoryBudgets.set(input.apiKeyId, budget); else await budgetsRef().doc(input.apiKeyId).set(budget)
  return budget
}
export async function deleteBudget(apiKeyId: string) { if (isMemory()) memoryBudgets.delete(apiKeyId); else await budgetsRef().doc(apiKeyId).delete() }

async function listBudgetCounters(usageStart: string) {
  if (isMemory()) return [...memoryBudgetCounters.entries()].map(([id, value]) => ({ id, ...value }))
  const snapshot = await budgetCountersRef().where("usageStartAt", "==", usageStart).get()
  return snapshot.docs.map((document) => ({ id: document.id, ...(document.data() as { spentMicros?: number; lastUsedAt?: string }) }))
}

export interface BudgetAdmission {
  key: string
  limitMicros: number
  spentMicros: number
  reservationMicros: number
  ttlSeconds: number
}

function requestOutputLimit(payload: Record<string, unknown> | undefined) {
  for (const key of ["max_output_tokens", "max_tokens"]) {
    const value = payload?.[key]
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

function estimateReservationMicros(payload: Record<string, unknown> | undefined, pricing: Parameters<typeof calculateCostMicros>[1], limitMicros: number) {
  const outputLimit = requestOutputLimit(payload)
  if (outputLimit === undefined) return limitMicros
  const inputBytes = payload ? new TextEncoder().encode(JSON.stringify(payload)).byteLength : 0
  const usage = normalizeUsageMetrics({ input: inputBytes, output: outputLimit })
  return Math.min(limitMicros, Math.max(1, calculateCostMicros(usage, pricing).costMicros))
}

export async function getBudgetAdmission(apiKeyId: string, gatewayModelId: string, providerModelId?: string, payload?: Record<string, unknown>) {
  const budget = await budgetConfig(apiKeyId)
  const window = await getBudgetWindow()
  if (!budget || !budget.enabled || window.bypassLimits) return undefined
  const pricing = await getPricingForModel(gatewayModelId, providerModelId)
  if (!pricing) throw new BudgetDeniedError("This API key cannot call a model without configured pricing.", budgetRetryAfter(window))
  const usageStart = await budgetUsageStart(window)
  const spentMicros = await budgetCounter(apiKeyId, usageStart)
  if (spentMicros >= budget.weeklyLimitMicros) throw new BudgetDeniedError("Weekly budget exceeded.", budgetRetryAfter(window))
  return {
    key: `rawroute:budget:${budgetCounterId(apiKeyId, usageStart)}`,
    limitMicros: budget.weeklyLimitMicros,
    spentMicros,
    reservationMicros: estimateReservationMicros(payload, pricing, budget.weeklyLimitMicros),
    ttlSeconds: budgetRetryAfter(window) + 60,
  } satisfies BudgetAdmission
}

export async function checkBudget(apiKeyId: string, gatewayModelId: string, providerModelId?: string) {
  await getBudgetAdmission(apiKeyId, gatewayModelId, providerModelId)
}

export async function getBudgetAdminData() {
  const [budgets, window, keys] = await Promise.all([listBudgets(), getBudgetWindow(), listApiKeys()])
  const bypassSessions = await listBudgetBypassSessions(50, window)
  const usageStart = await budgetUsageStart(window)
  const counters = await listBudgetCounters(usageStart)
  const countersByKey = new Map<string, { spentMicros: number; lastUsedAt?: string }>()
  for (const counter of counters) {
    const budget = budgets.find((entry) => counter.id === budgetCounterId(entry.apiKeyId, usageStart))
    if (budget) countersByKey.set(budget.apiKeyId, { spentMicros: Number(counter.spentMicros || 0), lastUsedAt: counter.lastUsedAt })
  }
  const rows = budgets.map((budget) => ({
    ...budget,
    spentMicros: countersByKey.get(budget.apiKeyId)?.spentMicros || 0,
    windowStart: window.start,
    windowEnd: window.end,
    usageStartAt: usageStart,
    name: keys.find((key) => key.id === budget.apiKeyId)?.name || "Unknown",
    lastUsedAt: countersByKey.get(budget.apiKeyId)?.lastUsedAt || null,
  }))
  return { budgets: rows, bypassSessions, window }
}

export async function getBudgetRows() {
  return (await getBudgetAdminData()).budgets
}

async function resolveRange(query: DashboardQuery) {
  const now = new Date()
  const today = startOfZonedDay(now)
  if (query.preset === "budget") {
    const window = await getBudgetWindow()
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

export async function getDashboardPayload(query: DashboardQuery, publicView = false): Promise<DashboardPayload> {
  const range = await resolveRange(query)
  const span = range.to.getTime() - range.from.getTime()
  const requestedGranularity = query.granularity && query.granularity !== "auto" ? query.granularity : (span <= 2 * 86400000 ? "hourly" : span <= 45 * 86400000 ? "daily" : "monthly")
  const granularity = requestedGranularity === "weekly" ? "daily" : requestedGranularity
  const toExclusive = new Date(range.to.getTime() + (query.preset === "custom" ? 1 : 0))
  let rollups: UsageRollup[] = []
  let keys: Awaited<ReturnType<typeof listApiKeys>> = []
  let budgetRows: Awaited<ReturnType<typeof getBudgetRows>> = []
  let budgetWindow: BudgetWindow | undefined
  try {
    ;[rollups, keys, budgetRows, budgetWindow] = await Promise.all([
      listUsageRollups(granularity as UsageRollup["granularity"], range.from.toISOString(), toExclusive.toISOString()),
      listApiKeys(),
      getBudgetRows(),
      getBudgetWindow(),
    ])
  } catch {
    // Public analytics remains readable while optional Firestore is unavailable.
  }
  const dimensionalRollups = rollups.filter((rollup) => rollup.gatewayKeyId && rollup.gatewayModelId)
  const legacyRollups = rollups.filter((rollup) => !rollup.gatewayKeyId)
  const aggregateRollups = legacyRollups.length ? [...legacyRollups, ...dimensionalRollups] : dimensionalRollups
  const budgetMap = new Map(budgetRows.map((budget) => [budget.apiKeyId, budget]))
  const keyMap = new Map(keys.map((key) => [key.id, key]))
  const keyRows = new Map<string, DashboardPayload["keys"][number]>()
  const modelRows = new Map<string, { model: string; requests: number; tokens: number; costMicros: number }>()
  const trend = new Map<string, { bucketStart: string; label: string; requests: number; tokens: number; costMicros: number }>()
  let requestCount = 0
  let totalTokens = 0
  let totalCostMicros = 0
  let pricedRequests = 0
  let lastEventAt: string | null = null
  for (const rollup of aggregateRollups) {
    requestCount += rollup.requests
    totalTokens += rollup.totalTokens
    totalCostMicros += rollup.costMicros
    pricedRequests += rollup.pricedRequests || 0
    if (rollup.lastEventAt && (!lastEventAt || lastEventAt < rollup.lastEventAt)) lastEventAt = rollup.lastEventAt
    const point = trend.get(rollup.bucketStart) || { bucketStart: rollup.bucketStart, label: formatAppTrendBucket(rollup.bucketStart, granularity), requests: 0, tokens: 0, costMicros: 0 }
    point.requests += rollup.requests; point.tokens += rollup.totalTokens; point.costMicros += rollup.costMicros; trend.set(rollup.bucketStart, point)
    if (!rollup.gatewayKeyId || !rollup.gatewayModelId) continue
    const keyId = rollup.gatewayKeyId
    const modelId = rollup.gatewayModelId
    const key = keyMap.get(keyId)
    const row = keyRows.get(keyId) || { id: keyId, label: publicView ? publicKeyLabel(keyId) : (key?.name || publicKeyLabel(keyId)), maskedKey: publicView ? "hidden" : mask(key?.key || "unknown"), requests: 0, tokens: 0, costMicros: 0, models: [], lastUsed: null }
    row.requests += rollup.requests; row.tokens += rollup.totalTokens; row.costMicros += rollup.costMicros
    row.lastUsed = !row.lastUsed || (rollup.lastEventAt && row.lastUsed < rollup.lastEventAt) ? (rollup.lastEventAt || row.lastUsed) : row.lastUsed
    if (!row.models.includes(modelId)) row.models.push(modelId)
    keyRows.set(keyId, row)
    const model = modelRows.get(modelId) || { model: modelId, requests: 0, tokens: 0, costMicros: 0 }
    model.requests += rollup.requests; model.tokens += rollup.totalTokens; model.costMicros += rollup.costMicros; modelRows.set(modelId, model)
  }
  for (const [keyId, row] of keyRows) {
    const budget = budgetMap.get(keyId)
    if (!budget || !budgetWindow) continue
    row.budget = { weeklyLimitMicros: budget.weeklyLimitMicros, spentMicros: budget.spentMicros, remainingMicros: Math.max(0, budget.weeklyLimitMicros - budget.spentMicros), percentUsed: budget.weeklyLimitMicros > 0 ? budget.spentMicros / budget.weeklyLimitMicros * 100 : 0, bypassLimits: budgetWindow.bypassLimits, usageStartAt: budget.usageStartAt, windowStart: budgetWindow.start, windowEnd: budgetWindow.end }
  }
  return { generatedAt: new Date().toISOString(), range: { label: range.label, from: range.from.toISOString(), to: range.to.toISOString(), granularity }, summary: { requests: requestCount, tokens: totalTokens, costMicros: totalCostMicros, activeKeys: keyRows.size, pricedRequests, unpricedRequests: requestCount - pricedRequests }, trend: [...trend.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)), keys: [...keyRows.values()].sort((a, b) => b.requests - a.requests), models: [...modelRows.values()].sort((a, b) => b.requests - a.requests), freshness: { source: isMemory() ? "memory" : "firestore", lastEventAt }, pricingConfidence: { pricedRequests, unpricedRequests: requestCount - pricedRequests } }
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
    for (const id of [...memoryBudgetCounters.keys()]) if ([...totals.keys()].some((next) => next === id) || budgets.some((budget) => id === budgetCounterId(budget.apiKeyId, usageStart))) memoryBudgetCounters.delete(id)
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
    }
    await updatePricingJob(jobId, { processedEvents: Math.min(index + chunk.length, events.length) })
  }
  await rebuildUsageRollups(allEvents.map((event) => events.find((updated) => updated.id === event.id) || event))
  await rebuildBudgetCounters(allEvents.map((event) => events.find((updated) => updated.id === event.id) || event))
  return updatePricingJob(jobId, { status: "completed", processedEvents: events.length, completedAt: new Date().toISOString() })
}

export function resetAnalyticsForTests() { memoryEvents.clear(); memoryRollups.clear(); memoryPricing.clear(); memoryBudgetCounters.clear(); memoryBudgets.clear(); memoryBypassSessions.clear(); memoryWindow = undefined; pricingCache.clear(); pricingInflight.clear(); resetModelPricingForTests() }
