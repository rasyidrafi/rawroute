import { budgetModelOptions } from "./budget-models"
import { queryLocalRequestLogs, queryLocalUsageRange } from "./local-db"
import type { OverviewDetails, OverviewPayload } from "../contracts/overview"
import { selectRequestLogGroups, requestLogLatest, requestLogCursor, type RequestLogQuery } from "./request-logs"
import { groupRequestLogEvents } from "../contracts/request-logs"
import { normalizeRequestLogMetadata } from "./request-log-metadata"
import { createHash } from "node:crypto"
import { getSqliteDatabase, listLocalDocuments, type SqliteDatabase } from "@rawroute/platform/server/database"

import { localCacheSetIfAbsent } from "@rawroute/platform/server/local-cache"
import { listAliases, listApiKeys, listIndexedApiKeyNames, listModels } from "./store"
import { listCodexAccounts } from "./codex/oauth"
import { getCodexUsageForAccount } from "./codex/usage"
import { getModelPricingGeneration, getPricingForModelAt as getModernPricingForModelAt, getPricingJob, listPricingGroups, listPricingVersions, resetModelPricingForTests, updatePricingJob } from "./model-pricing"
import { calculateCostMicros, normalizeUsageMetrics, type UsageMetrics } from "./usage-metrics"
import { selectServiceTierPricing } from "./service-tier-pricing"
import { requestServiceTier, serviceTierProfile } from "../contracts/service-tier"
import { isOpenAiCodexModel, predictPayloadCalibratedCost, type PayloadUsageSample } from "./usage-prediction"
import { addZonedDays, addZonedMonths, formatAppTrendBucket, getAppTimeZone, mondayInAppTimeZone, startOfZonedDay, startOfZonedMonth, startOfZonedYear, startOfZonedHour, zonedDateStringToDate } from "@rawroute/platform/server/timezone"
import { recordLog } from "./logging"
import { listSharedModelsForRecipient } from "./model-shares"
import type { BudgetBeyondLimitsSettings, BudgetBypassSession, BudgetUnlimitedSettings, BudgetWindow, BudgetWindowAnchor, DashboardPayload, DashboardQuery, GatewayKeyBudget, ModelPricingVersion, UsageEvent } from "../contracts/domain"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { appendMemoryAudit } from "@rawroute/platform/server/audit"

function auditMemoryBudgetMutation() {
  appendMemoryAudit({ action: "config.update", resource: "budget", workspaceId: currentWorkspaceId(), result: "success" })
}
import { projectMemoryUsage, usageCalendarBucket, type UsageBucket } from "./usage-projection"
import { readMemoryUsageRange, type UsageRangeResult } from "./usage-range"
import { listWorkspaces } from "@rawroute/platform/server/runtime"
import { collectionPrefix, isMemoryBackend } from "@rawroute/platform/server/storage-config"

let localDatabase: SqliteDatabase | undefined
interface AnalyticsMemoryState {
  projectionTimeZone: string
  projection: Map<string, UsageBucket>
  events: Map<string, UsageEvent>
  eventsByHour: Map<string, Set<string>>
  budgets: Map<string, GatewayKeyBudget>
  bypassSessions: Map<string, BudgetBypassSession>
  beyondLimits?: BudgetBeyondLimitsSettings
  unlimited?: BudgetUnlimitedSettings
  window?: BudgetWindow
}
declare global { var __rawrouteAnalyticsMemory: Map<string, AnalyticsMemoryState> | undefined }
function memoryStates() { return globalThis.__rawrouteAnalyticsMemory ||= new Map<string, AnalyticsMemoryState>() }
export function cleanupWorkspaceAnalytics(workspaceId: string) {
  memoryStates().delete(workspaceId)
  // Read caches are process-local derived data. Invalidate them after draining;
  // this does not alter any other workspace's canonical data or accounting.
  clearWorkspaceAnalyticsCaches()
}
function memoryState() {
  const workspaceId = currentWorkspaceId()
  let state = memoryStates().get(workspaceId)
  if (!state) {
    state = { projectionTimeZone: getAppTimeZone(), projection: new Map(), events: new Map(), eventsByHour: new Map(), budgets: new Map(), bypassSessions: new Map() }
    memoryStates().set(workspaceId, state)
  }
  if (state.projectionTimeZone !== getAppTimeZone()) throw new Error("Memory usage projection timezone mismatch; restart required")
  if (!state.eventsByHour) throw new Error("Memory usage projection changed; restart required")
  return state
}
export type ResolvedModelPricing = Exclude<Awaited<ReturnType<typeof getModernPricingForModelAt>>, undefined>
const pricingCache = new Map<string, { value: ResolvedModelPricing | undefined; expiresAt: number; modelPricingGeneration: number }>()
const pricingInflight = new Map<string, Promise<ResolvedModelPricing | undefined>>()
const pricingCacheTtlMs = 60_000

interface TimedValue<T> { value: T; expiresAt: number }

const budgetCacheTtlMs = 60_000
const dashboardCacheTtlMs = 30_000
const defaultBudgetOutputTokens = 4_096
const defaultPredictedOutputTokens = 1_024
const budgetInputBytesPerToken = 3
const estimatedCacheReadRatio = 0.5
const missingUsageEstimateMaxCostMicros = 2_000_000
const missingUsageQuantile = 0.25
const predictionPriorStrength = 500
const predictionBaselineMinimumSamples = 30
const usagePredictionSampleLimit = 2_048
const payloadPredictionMinimumSamples = 3
const payloadPredictionMaximumNeighbors = 31

interface UsagePredictionSamples {
  outputs: number[]
  costs: number[]
  payloads: PayloadUsageSample[]
}

interface ExpectedCostPrediction {
  costMicros: number
  source: "empirical" | "payload-calibrated" | "bounded-formula"
  predictionMethod?: NonNullable<UsageEvent["predictionMethod"]>
  predictionSampleCount?: number
  predictedUsage?: UsageMetrics
}

const usagePredictionSamples = new Map<string, UsagePredictionSamples>()
let usagePredictionWarmup: Promise<void> | undefined
const budgetConfigCache = new Map<string, TimedValue<GatewayKeyBudget | null>>()
const budgetConfigInflight = new Map<string, Promise<GatewayKeyBudget | undefined>>()
type BudgetUsageValue = { spentMicros: number; lastUsedAt: string | null; available: boolean }
const budgetUsageCache = new Map<string, TimedValue<Map<string, BudgetUsageValue>>>()
const budgetUsageInflight = new Map<string, Promise<Map<string, BudgetUsageValue>>>()
const bypassSessionCache = new Map<string, TimedValue<BudgetBypassSession | null>>()
const bypassSessionInflight = new Map<string, Promise<BudgetBypassSession | undefined>>()
const bypassSessionListCache = new Map<string, TimedValue<BudgetBypassSession[]>>()
const bypassSessionListInflight = new Map<string, Promise<BudgetBypassSession[]>>()
const beyondLimitsCache = new Map<string, TimedValue<BudgetBeyondLimitsSettings>>()
const beyondLimitsInflight = new Map<string, Promise<BudgetBeyondLimitsSettings>>()
const unlimitedSettingsCache = new Map<string, TimedValue<BudgetUnlimitedSettings>>()
const unlimitedSettingsInflight = new Map<string, Promise<BudgetUnlimitedSettings>>()
const dashboardCache = new Map<string, TimedValue<DashboardPayload>>()
const dashboardInflight = new Map<string, Promise<DashboardPayload>>()
const dashboardModelLabelCache = new Map<string, TimedValue<Map<string, string>>>()
const publicUsageKeyIds = new Map<string, Map<string, string>>()
const dashboardModelLabelInflight = new Map<string, Promise<Map<string, string>>>()
const budgetsCaches = new Map<string, TimedValue<GatewayKeyBudget[]>>()
const budgetsInflights = new Map<string, Promise<GatewayKeyBudget[]>>()
const budgetWindowCaches = new Map<string, TimedValue<BudgetWindow>>()
const budgetWindowInflights = new Map<string, Promise<BudgetWindow>>()
const codexBudgetWindowSyncAttempts = new Map<string, number>()
const codexBudgetWindowSyncInflights = new Map<string, Promise<BudgetWindow>>()
const codexBudgetWindowSyncIntervalMs = 5 * 60_000
const codexBudgetWindowSyncLockTtlMs = codexBudgetWindowSyncIntervalMs + 60_000
const budgetCacheGenerations = new Map<string, number>()

function canonicalPredictionModel(gatewayModelId: string) {
  return gatewayModelId.trim().toLowerCase().replace(/^(?:codex|cx)\//, "")
}

function predictionKey(scope: "local" | "default" | "global", workspaceId: string, gatewayKeyId: string | undefined, gatewayModelId: string) {
  return `${scope}\u0000${workspaceId}\u0000${gatewayKeyId || "*"}\u0000${canonicalPredictionModel(gatewayModelId)}`
}

function predictionSampleKeys(workspaceId: string, gatewayKeyId: string | undefined, gatewayModelId: string) {
  const keys = [
    predictionKey("local", workspaceId, gatewayKeyId, gatewayModelId),
    predictionKey("global", "*", undefined, gatewayModelId),
  ]
  if (workspaceId === "default") keys.push(predictionKey("default", "default", undefined, gatewayModelId))
  return keys
}

function rememberUsagePrediction(event: UsageEvent, workspaceId = currentWorkspaceId()) {
  if (event.status < 200 || event.status >= 300 || event.pricingConfidence !== "exact" || event.usageCompleteness === "partial" || event.usageCompleteness === "missing") return
  const output = Number.isSafeInteger(event.outputTokens) && event.outputTokens > 0 ? event.outputTokens : undefined
  const standardTier = !event.pricingServiceTier || ["default", "standard"].includes(event.pricingServiceTier)
  const cost = standardTier && Number.isSafeInteger(event.costMicros) && event.costMicros > 0 ? event.costMicros : undefined
  const payload = isOpenAiCodexModel(event.gatewayModelId)
    && Number.isSafeInteger(event.requestBodyBytes)
    && Number(event.requestBodyBytes) > 0
    && Number.isSafeInteger(event.inputTokens)
    && event.inputTokens > 0
    ? {
      requestBodyBytes: Number(event.requestBodyBytes),
      inputTokens: event.inputTokens,
      outputTokens: Math.max(0, event.outputTokens),
      cacheReadTokens: Math.max(0, Math.min(event.inputTokens, event.cacheReadTokens)),
      cacheCreationTokens: 0,
      protocol: event.protocol,
    } satisfies PayloadUsageSample
    : undefined
  if (payload) {
    payload.cacheCreationTokens = Math.max(0, Math.min(payload.inputTokens - payload.cacheReadTokens, event.cacheCreationTokens))
  }
  if (output === undefined && cost === undefined && payload === undefined) return
  for (const key of predictionSampleKeys(workspaceId, event.gatewayKeyId, event.gatewayModelId)) {
    const samples = usagePredictionSamples.get(key) || { outputs: [], costs: [], payloads: [] }
    if (output !== undefined) samples.outputs.push(output)
    if (cost !== undefined) samples.costs.push(cost)
    if (payload !== undefined) samples.payloads.push(payload)
    if (samples.outputs.length > usagePredictionSampleLimit) samples.outputs.splice(0, samples.outputs.length - usagePredictionSampleLimit)
    if (samples.costs.length > usagePredictionSampleLimit) samples.costs.splice(0, samples.costs.length - usagePredictionSampleLimit)
    if (samples.payloads.length > usagePredictionSampleLimit) samples.payloads.splice(0, samples.payloads.length - usagePredictionSampleLimit)
    usagePredictionSamples.set(key, samples)
  }
}

function quantile(values: number[], probability: number) {
  const sorted = values.filter((value) => Number.isSafeInteger(value) && value > 0).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * probability))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower))
}

function median(values: number[]) {
  return quantile(values, 0.5)
}

function predictionValues(scope: "local" | "default" | "global", workspaceId: string, gatewayKeyId: string | undefined, gatewayModelId: string, field: "costs" | "outputs") {
  return usagePredictionSamples.get(predictionKey(scope, scope === "global" ? "*" : scope === "default" ? "default" : workspaceId, scope === "local" ? gatewayKeyId : undefined, gatewayModelId))?.[field] || []
}

function payloadPredictionValues(scope: "local" | "default" | "global", workspaceId: string, gatewayKeyId: string | undefined, gatewayModelId: string) {
  return usagePredictionSamples.get(predictionKey(scope, scope === "global" ? "*" : scope === "default" ? "default" : workspaceId, scope === "local" ? gatewayKeyId : undefined, gatewayModelId))?.payloads || []
}

function payloadPredictionSamples(gatewayKeyId: string | undefined, gatewayModelId: string) {
  const workspaceId = currentWorkspaceId()
  const candidates = [
    payloadPredictionValues("local", workspaceId, gatewayKeyId, gatewayModelId),
    ...(workspaceId === "default" ? [payloadPredictionValues("default", "default", undefined, gatewayModelId)] : []),
    payloadPredictionValues("global", "*", undefined, gatewayModelId),
  ]
  return candidates.find((samples) => samples.length >= payloadPredictionMinimumSamples) || []
}

function historicalCostPrediction(gatewayKeyId: string | undefined, gatewayModelId: string) {
  const localValues = predictionValues("local", currentWorkspaceId(), gatewayKeyId, gatewayModelId, "costs")
  const defaultValues = predictionValues("default", "default", undefined, gatewayModelId, "costs")
  const globalValues = predictionValues("global", "*", undefined, gatewayModelId, "costs")
  const baselineValues = defaultValues.length >= predictionBaselineMinimumSamples
    ? defaultValues
    : globalValues.length >= predictionBaselineMinimumSamples ? globalValues : undefined
  const localValue = localValues.length >= 3 ? quantile(localValues, missingUsageQuantile) : 0
  if (baselineValues) {
    const baselineValue = quantile(baselineValues, missingUsageQuantile)
    const localWeight = Math.min(0.35, localValues.length / (localValues.length + predictionPriorStrength))
    const value = Math.max(1, Math.round(baselineValue * (1 - localWeight) + (localValue || baselineValue) * localWeight))
    return {
      value,
      method: localValue ? "default-model-shrunk-p25" as const : "pooled-model-p25" as const,
      sampleCount: baselineValues.length + (localValue ? localValues.length : 0),
    }
  }
  if (localValue > 0) return { value: localValue, method: "same-key-model-p25" as const, sampleCount: localValues.length }
  if (globalValues.length >= 3) return { value: quantile(globalValues, missingUsageQuantile), method: "pooled-model-p25" as const, sampleCount: globalValues.length }
  return undefined
}

function historicalOutputPrediction(gatewayKeyId: string | undefined, gatewayModelId: string) {
  const localValues = predictionValues("local", currentWorkspaceId(), gatewayKeyId, gatewayModelId, "outputs")
  const defaultValues = predictionValues("default", "default", undefined, gatewayModelId, "outputs")
  const globalValues = predictionValues("global", "*", undefined, gatewayModelId, "outputs")
  const values = localValues.length >= 3 ? localValues : defaultValues.length >= 3 ? defaultValues : globalValues
  if (!values.length) return undefined
  return { value: median(values), sampleCount: values.length }
}

function eventWorkspaceId(collectionPath: string) {
  const collectionPrefix = prefix()
  const match = collectionPath.match(new RegExp(`^${collectionPrefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}_workspaces/([^/]+)/usageEvents$`))
  return match?.[1]
}

async function warmUsagePredictionSamples() {
  if (isMemory() || usagePredictionWarmup) return usagePredictionWarmup
  usagePredictionWarmup = (async () => {
    const documents = await listLocalDocuments()
    const events = documents
      .filter((document) => document.collection_path.endsWith("/usageEvents"))
      .map((document) => ({ event: document.data as unknown as UsageEvent, workspaceId: eventWorkspaceId(document.collection_path) }))
      .filter((entry): entry is { event: UsageEvent; workspaceId: string } => Boolean(entry.workspaceId))
      .sort((left, right) => Date.parse(left.event.completedAt) - Date.parse(right.event.completedAt))
    for (const entry of events) rememberUsagePrediction(entry.event, entry.workspaceId)
  })().catch((error) => {
    usagePredictionWarmup = undefined
    recordLog("system.unable.to.warm.usage.prediction.history", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "warn" })
  })
  return usagePredictionWarmup
}

function boundedSet<T>(cache: Map<string, T>, key: string, value: T, maximum = 1_024) {
  if (!cache.has(key) && cache.size >= maximum) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
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

function invalidateUsageReadCaches() {
  const workspaceId = currentWorkspaceId()
  advanceWorkspaceGeneration(budgetCacheGenerations, workspaceId)
  clearWorkspaceEntries(budgetUsageCache, workspaceId)
  clearWorkspaceEntries(budgetUsageInflight, workspaceId)
  clearWorkspaceEntries(dashboardCache, workspaceId)
  clearWorkspaceEntries(dashboardInflight, workspaceId)
}

function invalidateBudgetReadCaches(options: { preserveWindowInflight?: boolean } = {}) {
  const workspaceId = currentWorkspaceId()
  advanceWorkspaceGeneration(budgetCacheGenerations, workspaceId)
  budgetsCaches.delete(workspaceId)
  budgetsInflights.delete(workspaceId)
  budgetWindowCaches.delete(workspaceId)
  if (!options.preserveWindowInflight) budgetWindowInflights.delete(workspaceId)
  clearWorkspaceEntries(budgetConfigCache, workspaceId)
  clearWorkspaceEntries(budgetConfigInflight, workspaceId)
  clearWorkspaceEntries(budgetUsageCache, workspaceId)
  clearWorkspaceEntries(budgetUsageInflight, workspaceId)
  clearWorkspaceEntries(bypassSessionCache, workspaceId)
  clearWorkspaceEntries(bypassSessionInflight, workspaceId)
  clearWorkspaceEntries(bypassSessionListCache, workspaceId)
  clearWorkspaceEntries(bypassSessionListInflight, workspaceId)
  beyondLimitsCache.delete(workspaceId)
  beyondLimitsInflight.delete(workspaceId)
  unlimitedSettingsCache.delete(workspaceId)
  unlimitedSettingsInflight.delete(workspaceId)
  clearWorkspaceEntries(dashboardCache, workspaceId)
  clearWorkspaceEntries(dashboardInflight, workspaceId)
}

/** Clear presentation-only Usage caches after aliases or shared models change. */
export function invalidateDashboardPresentation() {
  const workspaceId = currentWorkspaceId()
  clearWorkspaceEntries(dashboardCache, workspaceId)
  clearWorkspaceEntries(dashboardInflight, workspaceId)
  dashboardModelLabelCache.delete(workspaceId)
  dashboardModelLabelInflight.delete(workspaceId)
}

function isMemory() { return isMemoryBackend() }
function prefix() { return collectionPrefix() }
function db() {
  return localDatabase ||= getSqliteDatabase()
}
function workspaceRef() { return db().collection(`${prefix()}_workspaces`).doc(currentWorkspaceId()) }
function eventsRef() { return workspaceRef().collection("usageEvents") }
function budgetsRef() { return workspaceRef().collection("budgets") }
function bypassSessionsRef() { return workspaceRef().collection("budgetBypassSessions") }
function beyondLimitsRef() { return workspaceRef().collection("budgetSettings").doc("beyondLimits") }
function unlimitedSettingsRef() { return workspaceRef().collection("budgetSettings").doc("unlimited") }
function windowRef() { return workspaceRef().collection("budgetWindows").doc("current") }
function hash(value: string) { return createHash("sha256").update(value).digest("hex") }
function publicKeyUsageId(keyId: string) {
  const workspaceId = currentWorkspaceId()
  const publicId = hash(`${workspaceId}:${keyId}`)
  const entries = publicUsageKeyIds.get(workspaceId) || new Map<string, string>()
  entries.set(publicId, keyId)
  while (entries.size > 8_192) entries.delete(entries.keys().next().value!)
  publicUsageKeyIds.set(workspaceId, entries)
  while (publicUsageKeyIds.size > 128) publicUsageKeyIds.delete(publicUsageKeyIds.keys().next().value!)
  return publicId
}
function defaultWindow(): BudgetWindow { const start = mondayInAppTimeZone(); const end = addZonedDays(start, 7); return { start: start.toISOString(), end: end.toISOString(), anchor: "custom", codexAccountId: null, bypassLimits: false, bypassSessionId: null, bypassAutoDeactivateAtWindowEnd: false, updatedAt: new Date().toISOString() } }
function defaultBeyondLimitsSettings(): BudgetBeyondLimitsSettings { return { enabled: false, modelIds: [], updatedAt: "" } }
function defaultUnlimitedSettings(): BudgetUnlimitedSettings { return { excludedModelIds: [], updatedAt: "" } }
function budgetIntervalId(apiKeyId: string, usageStart: string) { return hash(`${apiKeyId}:${usageStart}`) }
function sharedWorkspaceBudgetId(workspaceId: string) { return `shared-workspace:${workspaceId}` }
function sharedWorkspaceIdFromBudgetId(value: string) { return value.startsWith("shared-workspace:") ? value.slice("shared-workspace:".length) : undefined }
function sharedWorkspaceUsageLabel(key: { name?: string } | undefined, workspaceId: string) {
  const workspaceName = key?.name?.replace(/ \(For Shared Models\)$/, "").trim() || workspaceId
  return `Shared Workspace: ${workspaceName}`
}
async function budgetSelectableKeys() {
  const [keys, workspaces] = await Promise.all([listApiKeys(), listWorkspaces()])
  return [
    ...keys,
    ...workspaces
      .filter((workspace) => workspace.status === "active" && workspace.id !== currentWorkspaceId())
      .map((workspace) => ({ id: sharedWorkspaceBudgetId(workspace.id), name: `${workspace.name} (For Shared Models)`, key: "", createdAt: workspace.createdAt })),
  ]
}


function budgetRetryAfter(window: BudgetWindow) { return Math.max(1, Math.ceil((Date.parse(window.end) - Date.now()) / 1000)) }
function advanceExpiredWindow(window: BudgetWindow, now = Date.now()) {
  let start = Date.parse(window.start)
  let end = Date.parse(window.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now) return window
  const duration = end - start
  // `end` is the exclusive boundary of the current window. At the exact
  // boundary, the next window starts at the old end; adding one extra step
  // skipped an entire week (e.g. Jul 1–7 became Jul 14–20).
  const steps = Math.max(1, Math.floor((now - start) / duration))
  start += steps * duration
  end += steps * duration
  return { ...window, start: new Date(start).toISOString(), end: new Date(end).toISOString(), updatedAt: new Date().toISOString() }
}

function shouldAutoDeactivateBypass(window: BudgetWindow, now = Date.now()) {
  const end = Date.parse(window.end)
  return window.bypassLimits && window.bypassAutoDeactivateAtWindowEnd === true && Number.isFinite(end) && end <= now
}

function reconcileExpiredBudgetWindowBypass(window: BudgetWindow, now = Date.now()) {
  if (!shouldAutoDeactivateBypass(window, now)) return { window, autoDeactivatedAt: null, endedSession: null }
  const endedSession = window.bypassSessionId
    ? { id: window.bypassSessionId, endedAt: window.end, endReason: "window_end" as const }
    : null
  return {
    window: { ...window, bypassLimits: false, bypassSessionId: null, bypassAutoDeactivateAtWindowEnd: false, updatedAt: new Date(now).toISOString() },
    autoDeactivatedAt: window.end,
    endedSession,
  }
}

function reconcileMemoryBudgetWindow(window: BudgetWindow, now = Date.now()) {
  const reconciliation = reconcileExpiredBudgetWindowBypass(window, now)
  if (reconciliation.endedSession) {
    const active = memoryState().bypassSessions.get(reconciliation.endedSession.id)
    if (active) {
      memoryState().bypassSessions.set(active.id, {
        ...active,
        endedAt: reconciliation.endedSession.endedAt,
        endReason: reconciliation.endedSession.endReason,
      })
    }
  }
  return advanceExpiredWindow(reconciliation.window, now)
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
    const budget = snapshot.exists ? currentBudgetConfig(snapshot.id, snapshot.data() as unknown as GatewayKeyBudget) : undefined
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetConfigCache, cacheId, { value: budget || null, expiresAt: Date.now() + budgetCacheTtlMs })
    return budget
  }).finally(() => {
    if (budgetConfigInflight.get(cacheId) === promise) budgetConfigInflight.delete(cacheId)
  })
  budgetConfigInflight.set(cacheId, promise)
  return promise
}



export class BudgetDeniedError extends Error { status = 429; retryAfterSeconds: number; constructor(message: string, retryAfterSeconds: number) { super(message); this.name = "BudgetDeniedError"; this.retryAfterSeconds = retryAfterSeconds } }
export class BudgetPricingUnavailableError extends Error { status = 503; constructor(message = "Budget pricing is unavailable.") { super(message); this.name = "BudgetPricingUnavailableError" } }
export class BudgetUsageUnavailableError extends Error { status = 503; constructor(message = "Actual budget usage is unavailable.") { super(message); this.name = "BudgetUsageUnavailableError" } }
export class BudgetModelExcludedError extends Error { status = 403; code = "model_excluded_in_unlimited_mode"; constructor(message = "This model is excluded while Unlimited Mode is active.") { super(message); this.name = "BudgetModelExcludedError" } }

export interface BudgetUsageContext {
  usageStartAt: string
  windowEnd: string
}



function isAlreadyExistsError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  return code === "DOCUMENT_EXISTS"
}

/** The captured admission window is not an ingestion-time financial authority. */
export async function recordUsageEvent(event: UsageEvent, budgetUsageContext?: BudgetUsageContext | null) {
  void budgetUsageContext
  if (isMemory()) {
    const memory = memoryState()
    if (memory.events.has(event.id)) return event
    memory.projection = projectMemoryUsage(memory.projection, currentWorkspaceId(), undefined, { ...event })
    memory.events.set(event.id, event)
    const hour = usageCalendarBucket(event.completedAt, "hourly").bucketStart
    const indexed = memory.eventsByHour.get(hour) || new Set<string>()
    indexed.add(event.id)
    memory.eventsByHour.set(hour, indexed)
  } else {
    try { await eventsRef().doc(event.id).create(event) }
    catch (error) { if (!isAlreadyExistsError(error)) throw error; return event }
  }
  rememberUsagePrediction(event)
  invalidateUsageReadCaches()
  return event
}




export interface GatewayUsageInput {
  routing?: UsageEvent["routing"]
  id?: string
  requestId?: string
  requestedModel?: string
  attemptIndex?: number
  requestFinal?: boolean
  gatewayKeyId: string
  providerId?: string
  providerModelId?: string
  gatewayModelId: string
  protocol: UsageEvent["protocol"]
  startedAt: string
  status: number
  durationMs: number
  ttftMs?: number
  requestBodyBytes?: number
  reasoningEffort?: string
  toolCount?: number
  requestedServiceTier?: string
  sentServiceTier?: string
  metrics?: UsageMetrics
  estimatedUsage?: UsageMetrics
  assumedCostMicros?: number
  assumedCostSource?: "reservation" | "empirical" | "payload-calibrated"
  predictionMethod?: UsageEvent["predictionMethod"]
  predictionSampleCount?: number
}

export async function createGatewayUsageEvent(input: GatewayUsageInput, resolvedPricing?: ResolvedModelPricing): Promise<UsageEvent> {
  const requestMetadata = normalizeRequestLogMetadata({ ...input, effectiveServiceTier: input.metrics?.effectiveServiceTier })
  const normalized = normalizeUsageMetrics(input.metrics)
  let pricing = resolvedPricing
  if (!pricing) {
    try { pricing = await getPricingForModel(input.gatewayModelId, input.providerModelId) }
    catch { pricing = undefined }
  }
  const calculated = calculateCostMicros(normalized, pricing, requestMetadata)
  const tierPricing = selectServiceTierPricing(pricing, requestMetadata)
  // Pricing confidence describes whether every pricing-relevant field was
  // observed. It does not describe whether the provider returned enough token
  // usage to justify replacing the measured calculation with a request
  // estimate. An omitted cache field keeps the confidence assumed, but a
  // complete input/output pair still gives us the measured settlement basis.
  const fallbackEligible = input.status >= 200 && input.status < 300 && normalized.usageCompleteness !== "complete"
  const estimatedCost = input.estimatedUsage ? calculateCostMicros(normalizeUsageMetrics(input.estimatedUsage), pricing, requestMetadata).costMicros : input.assumedCostMicros
  const suppliedAssumption = fallbackEligible && tierPricing.rates && Number.isSafeInteger(estimatedCost) && Number(estimatedCost) > 0
    ? Math.min(missingUsageEstimateMaxCostMicros, Number(estimatedCost))
    : undefined
  // A partial response gives us a useful lower-bound calculation. The request
  // admission estimate is conservative, so settle to the larger of the two
  // instead of replacing a known partial cost with a smaller guess.
  const assumedCostMicros = suppliedAssumption === undefined
    ? undefined
    : Math.max(calculated.costMicros, suppliedAssumption)
  return {
    id: input.id || crypto.randomUUID(),
    ...(input.requestId ? { requestId: input.requestId, attemptIndex: input.attemptIndex, requestFinal: input.requestFinal } : {}),
    ...(input.requestedModel !== undefined ? { requestedModel: input.requestedModel } : {}),
    ...(input.routing ? { routing: { ...input.routing } } : {}),
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
    ...(Number.isSafeInteger(input.requestBodyBytes) && Number(input.requestBodyBytes) > 0 ? { requestBodyBytes: Number(input.requestBodyBytes) } : {}),
    ...requestMetadata,
    ...normalized,
    costMicros: assumedCostMicros ?? calculated.costMicros,
    pricingConfidence: assumedCostMicros !== undefined ? "assumed" : calculated.pricingConfidence,
    usageCompleteness: normalized.usageCompleteness,
    cacheUsageKnown: normalized.cacheUsageKnown,
    ...(assumedCostMicros !== undefined
      ? {
        costSource: input.assumedCostSource || "reservation",
        ...(input.predictionMethod ? { predictionMethod: input.predictionMethod } : {}),
        ...(input.predictionSampleCount !== undefined ? { predictionSampleCount: input.predictionSampleCount } : {}),
      }
      : pricing && calculated.pricingConfidence !== "unpriced"
        ? { costSource: "configured-pricing" as const }
        : {}),
    ...(pricing && "pricingGroupId" in pricing && pricing.pricingGroupId ? { pricingGroupId: pricing.pricingGroupId } : {}),
    ...(pricing && "pricingVersionId" in pricing && pricing.pricingVersionId ? { pricingVersionId: pricing.pricingVersionId } : {}),
    ...(calculated.pricingContextTier ? { pricingContextTier: calculated.pricingContextTier } : {}),
    ...(calculated.pricingServiceTier || assumedCostMicros !== undefined ? { pricingServiceTier: calculated.pricingServiceTier || tierPricing.serviceTier } : {}),
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

export async function listRequestLogs(query: RequestLogQuery) {
  const rows = isMemory()
    ? selectRequestLogGroups([...memoryState().events.values()], query)
    : await queryLocalRequestLogs(`${prefix()}_workspaces/${currentWorkspaceId()}/usageEvents`, query)
  const groups = groupRequestLogEvents(rows)
  const events = groups.slice(0, 25).flat()
  return { events, nextCursor: groups.length > 25 ? requestLogCursor(query, currentWorkspaceId(), requestLogLatest(groups[24]!)) : null, from: query.from, to: query.to }
}

export async function getPricingForModel(gatewayModelId: string, providerModelId?: string) {
  const key = scopedKey(`${gatewayModelId}:${providerModelId || ""}`)
  const modelGeneration = getModelPricingGeneration()
  const cached = pricingCache.get(key)
  if (cached && cached.expiresAt > Date.now() && cached.modelPricingGeneration === modelGeneration) return cached.value
  const inflightKey = scopedKey(`${modelGeneration}:${gatewayModelId}:${providerModelId || ""}`)
  const existing = pricingInflight.get(inflightKey)
  if (existing) return existing
  const promise = (async () => {
    let value: ResolvedModelPricing | undefined
    try {
      value = await getModernPricingForModelAt({ gatewayModelId, providerModelId })
    } catch {
      value = undefined
    }
    if (modelGeneration === getModelPricingGeneration()) {
      boundedSet(pricingCache, key, { value, expiresAt: Date.now() + pricingCacheTtlMs, modelPricingGeneration: modelGeneration })
    }
    return value
  })().finally(() => {
    if (pricingInflight.get(inflightKey) === promise) pricingInflight.delete(inflightKey)
  })
  pricingInflight.set(inflightKey, promise)
  return promise
}

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
    const budgets = snapshot.docs.map(document => currentBudgetConfig(document.id, document.data() as unknown as GatewayKeyBudget))
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

function currentBudgetConfig(apiKeyId: string, data: GatewayKeyBudget): GatewayKeyBudget {
  return { apiKeyId, weeklyLimitMicros: data.weeklyLimitMicros, enabled: data.enabled, updatedAt: data.updatedAt }
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

function normalizeBeyondLimitsSettings(value: Partial<BudgetBeyondLimitsSettings> | undefined): BudgetBeyondLimitsSettings {
  const fallback = defaultBeyondLimitsSettings()
  return {
    enabled: value?.enabled === true,
    modelIds: [...new Set((value?.modelIds || []).filter((id): id is string => typeof id === "string" && id.trim().length > 0))],
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  }
}

export async function getBudgetBeyondLimitsSettings(): Promise<BudgetBeyondLimitsSettings> {
  if (isMemory()) return normalizeBeyondLimitsSettings(memoryState().beyondLimits)
  const workspaceId = currentWorkspaceId()
  const cached = beyondLimitsCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = beyondLimitsInflight.get(workspaceId)
  if (existing) return existing
  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = beyondLimitsRef().get().then((snapshot) => {
    const settings = normalizeBeyondLimitsSettings(snapshot.exists ? snapshot.data() as Partial<BudgetBeyondLimitsSettings> : undefined)
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) {
      boundedSet(beyondLimitsCache, workspaceId, { value: settings, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
    }
    return settings
  }).finally(() => {
    if (beyondLimitsInflight.get(workspaceId) === promise) beyondLimitsInflight.delete(workspaceId)
  })
  beyondLimitsInflight.set(workspaceId, promise)
  return promise
}

export async function setBudgetBeyondLimitsSettings(input: Pick<BudgetBeyondLimitsSettings, "enabled" | "modelIds">): Promise<BudgetBeyondLimitsSettings> {
  const settings: BudgetBeyondLimitsSettings = {
    enabled: input.enabled === true,
    modelIds: [...new Set(input.modelIds.filter((id) => typeof id === "string" && id.trim().length > 0))],
    updatedAt: new Date().toISOString(),
  }
  if (isMemory()) { memoryState().beyondLimits = settings; auditMemoryBudgetMutation() }
  else await beyondLimitsRef().set(settings)
  invalidateBudgetReadCaches()
  boundedSet(beyondLimitsCache, currentWorkspaceId(), { value: settings, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
  return settings
}

function normalizeUnlimitedSettings(value: Partial<BudgetUnlimitedSettings> | undefined): BudgetUnlimitedSettings {
  const fallback = defaultUnlimitedSettings()
  return {
    excludedModelIds: [...new Set((value?.excludedModelIds || []).filter((id): id is string => typeof id === "string" && id.trim().length > 0))],
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  }
}

export async function getBudgetUnlimitedSettings(): Promise<BudgetUnlimitedSettings> {
  if (isMemory()) return normalizeUnlimitedSettings(memoryState().unlimited)
  const workspaceId = currentWorkspaceId()
  const cached = unlimitedSettingsCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = unlimitedSettingsInflight.get(workspaceId)
  if (existing) return existing
  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = unlimitedSettingsRef().get().then((snapshot) => {
    const settings = normalizeUnlimitedSettings(snapshot.exists ? snapshot.data() as Partial<BudgetUnlimitedSettings> : undefined)
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) {
      boundedSet(unlimitedSettingsCache, workspaceId, { value: settings, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
    }
    return settings
  }).finally(() => {
    if (unlimitedSettingsInflight.get(workspaceId) === promise) unlimitedSettingsInflight.delete(workspaceId)
  })
  unlimitedSettingsInflight.set(workspaceId, promise)
  return promise
}

export async function setBudgetUnlimitedSettings(input: Pick<BudgetUnlimitedSettings, "excludedModelIds">): Promise<BudgetUnlimitedSettings> {
  const settings: BudgetUnlimitedSettings = {
    excludedModelIds: [...new Set(input.excludedModelIds.filter((id) => typeof id === "string" && id.trim().length > 0))],
    updatedAt: new Date().toISOString(),
  }
  if (isMemory()) { memoryState().unlimited = settings; auditMemoryBudgetMutation() }
  else await unlimitedSettingsRef().set(settings)
  invalidateBudgetReadCaches()
  boundedSet(unlimitedSettingsCache, currentWorkspaceId(), { value: settings, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
  return settings
}

function codexBudgetWindowSyncKey(accountId: string) {
  return `${currentWorkspaceId()}:${accountId}`
}

function sameCodexBudgetWindow(left: BudgetWindow, right: Pick<BudgetWindow, "start" | "end" | "anchor" | "codexAccountId">) {
  return left.anchor === right.anchor && left.codexAccountId === right.codexAccountId && left.start === right.start && left.end === right.end
}

export function reconcileCodexBudgetWindowRollover(window: BudgetWindow, resolved: Pick<BudgetWindow, "start" | "end" | "anchor" | "codexAccountId">, reconciledAt = Date.now()) {
  const reconciliation = reconcileExpiredBudgetWindowBypass(window, reconciledAt)
  if (sameCodexBudgetWindow(reconciliation.window, resolved)) return reconciliation
  return {
    ...reconciliation,
    window: { ...reconciliation.window, ...resolved, updatedAt: new Date(reconciledAt).toISOString() },
  }
}

async function syncCodexBudgetWindowIfStale(window: BudgetWindow, now = Date.now()): Promise<BudgetWindow> {
  if (isMemory() || window.anchor !== "codex" || !window.codexAccountId) return window

  const workspaceId = currentWorkspaceId()
  const syncKey = codexBudgetWindowSyncKey(window.codexAccountId)
  const currentEnd = Date.parse(window.end)
  const lastAttempt = codexBudgetWindowSyncAttempts.get(syncKey) || 0
  const due = !lastAttempt || now - lastAttempt >= codexBudgetWindowSyncIntervalMs || !Number.isFinite(currentEnd) || currentEnd <= now
  if (!due) return window

  const existing = codexBudgetWindowSyncInflights.get(syncKey)
  if (existing) return existing
  boundedSet(codexBudgetWindowSyncAttempts, syncKey, now, 256)

  const promise = (async () => {
    const cacheLock = await localCacheSetIfAbsent(`rawroute:codex-budget-window-sync:${syncKey}`, "1", codexBudgetWindowSyncLockTtlMs)
    if (cacheLock === false) return window

    try {
      const resolved = await resolveCodexBudgetWindow(window.codexAccountId)
      const ref = windowRef()
      let result = window
      let changed = false
      let autoDeactivatedAt: string | null = null
      await db().runTransaction(async (transaction) => {
        changed = false
        autoDeactivatedAt = null
        const snapshot = await transaction.get(ref)
        const latest = snapshot.exists ? { ...defaultWindow(), ...snapshot.data() } as BudgetWindow : defaultWindow()
        // Do not let a delayed Codex refresh overwrite an administrator's
        // account or custom-window change made while the request was running.
        if (latest.anchor !== "codex" || latest.codexAccountId !== window.codexAccountId) {
          result = latest
          return
        }
        // The Codex request may have crossed the old window boundary, so
        // evaluate expiration only after reading the window to be updated.
        const reconciledAt = Date.now()
        const reconciliation = reconcileCodexBudgetWindowRollover(latest, resolved, reconciledAt)
        if (reconciliation.endedSession) {
          transaction.set(bypassSessionsRef().doc(reconciliation.endedSession.id), {
            endedAt: reconciliation.endedSession.endedAt,
            endReason: reconciliation.endedSession.endReason,
            updatedAt: new Date(reconciledAt).toISOString(),
          }, { merge: true })
        }
        result = reconciliation.window
        autoDeactivatedAt = reconciliation.autoDeactivatedAt
        if (result !== latest) {
          changed = true
          transaction.set(ref, result)
        }
      })

      if (changed) {
        // Preserve the current getBudgetWindow single-flight when this sync is
        // running inside it; the caller will repopulate the window cache.
        invalidateBudgetReadCaches({ preserveWindowInflight: true })
        boundedSet(budgetWindowCaches, workspaceId, { value: result, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
      } else if (result !== window) {
        boundedSet(budgetWindowCaches, workspaceId, { value: result, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
      }
      if (autoDeactivatedAt) recordLog("admin.unlimited.mode.auto.deactivated.at.budget.window.end", { endedAt: autoDeactivatedAt }, { level: "info" })
      return result
    } catch (error) {
      recordLog("admin.unable.to.sync.codex.budget.window", {
        accountId: window.codexAccountId || "unknown",
        error: error instanceof Error ? error.message : "Unknown error",
      }, { level: "warn" })
      return window
    }
  })().finally(() => {
    if (codexBudgetWindowSyncInflights.get(syncKey) === promise) codexBudgetWindowSyncInflights.delete(syncKey)
  })
  codexBudgetWindowSyncInflights.set(syncKey, promise)
  return promise
}

export async function getBudgetWindow(): Promise<BudgetWindow> {
  if (isMemory()) {
    const memory = memoryState()
    const current = memory.window || defaultWindow()
    const next = reconcileMemoryBudgetWindow(current)
    memory.window = next
    return next
  }
  const now = Date.now()
  const workspaceId = currentWorkspaceId()
  const budgetWindowCache = budgetWindowCaches.get(workspaceId)
  if (budgetWindowCache && budgetWindowCache.expiresAt > now) {
    const synced = await syncCodexBudgetWindowIfStale(budgetWindowCache.value, now)
    if (shouldAutoDeactivateBypass(synced, now)) budgetWindowCaches.delete(workspaceId)
    else {
      const next = advanceExpiredWindow(synced, now)
      if (next === budgetWindowCache.value) return next
      if (next === synced) {
        boundedSet(budgetWindowCaches, workspaceId, { value: next, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
        return next
      }
    }
  }
  const budgetWindowInflight = budgetWindowInflights.get(workspaceId)
  if (budgetWindowInflight) return budgetWindowInflight

  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = (async () => {
    const ref = windowRef()
    const snapshot = await ref.get()
    const current = snapshot.exists ? { ...defaultWindow(), ...snapshot.data() } as BudgetWindow : defaultWindow()
    const synced = await syncCodexBudgetWindowIfStale(current)
    const next = advanceExpiredWindow(synced)
    if (!shouldAutoDeactivateBypass(synced) && next === synced && synced !== current) return synced
    if (!shouldAutoDeactivateBypass(current) && snapshot.exists && next === current) return next

    let result = next
    let autoDeactivated = false
    let autoDeactivatedAt = ""
    await db().runTransaction(async (transaction) => {
      const latest = await transaction.get(ref)
      const latestWindow = latest.exists ? { ...defaultWindow(), ...latest.data() } as BudgetWindow : defaultWindow()
      const reconciliation = reconcileExpiredBudgetWindowBypass(latestWindow)
      const reconciled = reconciliation.window
      if (reconciliation.autoDeactivatedAt) {
        autoDeactivated = true
        autoDeactivatedAt = reconciliation.autoDeactivatedAt
        const nowIso = new Date().toISOString()
        if (reconciliation.endedSession) {
          transaction.set(bypassSessionsRef().doc(reconciliation.endedSession.id), { endedAt: reconciliation.endedSession.endedAt, endReason: reconciliation.endedSession.endReason, updatedAt: nowIso }, { merge: true })
        }
      }
      const advanced = advanceExpiredWindow(reconciled)
      if (!latest.exists) transaction.create(ref, advanced)
      else if (advanced !== latestWindow) transaction.set(ref, advanced)
      result = advanced
    })
    if (autoDeactivated) {
      invalidateBudgetReadCaches({ preserveWindowInflight: true })
      boundedSet(budgetWindowCaches, workspaceId, { value: result, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
      recordLog("admin.unlimited.mode.auto.deactivated.at.budget.window.end", { endedAt: autoDeactivatedAt }, { level: "info" })
    }
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
  if (isMemory()) { memoryState().window = next; auditMemoryBudgetMutation() }
  else await windowRef().set(next)
  invalidateBudgetReadCaches()
  if (!isMemory()) boundedSet(budgetWindowCaches, currentWorkspaceId(), { value: next, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
  if (next.anchor === "codex" && next.codexAccountId) boundedSet(codexBudgetWindowSyncAttempts, codexBudgetWindowSyncKey(next.codexAccountId), Date.now(), 256)
  return next
}

export async function setBudgetBypassEnabled(enabled: boolean, options: { autoDeactivateAtWindowEnd?: boolean } = {}): Promise<{ window: BudgetWindow; session: BudgetBypassSession | null }> {
  const now = new Date().toISOString()
  if (isMemory()) {
    const current = await getBudgetWindow()
    if (current.bypassLimits === enabled && (!enabled || current.bypassSessionId)) {
      return { window: current, session: enabled && current.bypassSessionId ? memoryState().bypassSessions.get(current.bypassSessionId) || null : null }
    }
    let session: BudgetBypassSession | null = null
    if (enabled) {
      session = { id: crypto.randomUUID(), startedAt: now, endedAt: null, endReason: null }
      memoryState().bypassSessions.set(session.id, session)
    } else if (current.bypassSessionId) {
      const active = memoryState().bypassSessions.get(current.bypassSessionId)
      if (active) { session = { ...active, endedAt: now, endReason: "manual" }; memoryState().bypassSessions.set(session.id, session) }
    } else if (current.bypassLimits) {
      session = { id: crypto.randomUUID(), startedAt: current.updatedAt, endedAt: now, endReason: "manual" }
      memoryState().bypassSessions.set(session.id, session)
    }
    const next: BudgetWindow = { ...current, bypassLimits: enabled, bypassSessionId: enabled ? session?.id || null : null, bypassAutoDeactivateAtWindowEnd: enabled && options.autoDeactivateAtWindowEnd === true, updatedAt: now }
    memoryState().window = next
    auditMemoryBudgetMutation()
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
      session = { id: crypto.randomUUID(), startedAt: now, endedAt: null, endReason: null }
      sessionId = session.id
      transaction.create(bypassSessionsRef().doc(session.id), session)
    } else if (current.bypassSessionId) {
      sessionId = current.bypassSessionId
      transaction.set(bypassSessionsRef().doc(sessionId), { endedAt: now, endReason: "manual", updatedAt: now }, { merge: true })
    } else if (current.bypassLimits) {
      session = { id: crypto.randomUUID(), startedAt: current.updatedAt, endedAt: now, endReason: "manual" }
      transaction.create(bypassSessionsRef().doc(session.id), session)
    }
    const next: BudgetWindow = { ...current, bypassLimits: enabled, bypassSessionId: enabled ? sessionId : null, bypassAutoDeactivateAtWindowEnd: enabled && options.autoDeactivateAtWindowEnd === true, updatedAt: now }
    transaction.set(ref, next)
    result = { window: next, session: enabled ? session : null }
  })
  invalidateBudgetReadCaches()
  boundedSet(budgetWindowCaches, currentWorkspaceId(), { value: result.window, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
  return result
}

export async function setBudgetBypassAutoDeactivateAtWindowEnd(enabled: boolean): Promise<BudgetWindow> {
  const now = new Date().toISOString()
  if (isMemory()) {
    const current = await getBudgetWindow()
    if (!current.bypassLimits) throw new Error("Unlimited Mode is not active.")
    const next = { ...current, bypassAutoDeactivateAtWindowEnd: enabled, updatedAt: now }
    memoryState().window = next
    auditMemoryBudgetMutation()
    invalidateBudgetReadCaches()
    return next
  }

  let result = defaultWindow()
  await db().runTransaction(async (transaction) => {
    const ref = windowRef()
    const snapshot = await transaction.get(ref)
    const current = snapshot.exists ? { ...defaultWindow(), ...snapshot.data() } as BudgetWindow : defaultWindow()
    if (!current.bypassLimits) throw new Error("Unlimited Mode is not active.")
    result = { ...current, bypassAutoDeactivateAtWindowEnd: enabled, updatedAt: now }
    transaction.set(ref, result)
  })
  invalidateBudgetReadCaches()
  boundedSet(budgetWindowCaches, currentWorkspaceId(), { value: result, expiresAt: Date.now() + budgetCacheTtlMs }, 256)
  return result
}
export async function upsertBudget(input: { apiKeyId: string; weeklyLimitMicros: number; enabled: boolean }) {
  if (!Number.isSafeInteger(input.weeklyLimitMicros) || input.weeklyLimitMicros <= 0) throw new Error("Weekly budget must be a positive safe integer in micros.")
  const sharedWorkspaceId = sharedWorkspaceIdFromBudgetId(input.apiKeyId)
  if (sharedWorkspaceId) {
    if (!(await listWorkspaces()).some((workspace) => workspace.id === sharedWorkspaceId && workspace.id !== currentWorkspaceId() && workspace.status === "active")) throw new Error("Shared workspace is unavailable.")
  } else if (!(await listApiKeys()).some((apiKey) => apiKey.id === input.apiKeyId)) throw new Error("API key not found in the selected workspace.")
  const budget: GatewayKeyBudget = {
    ...input,
    updatedAt: new Date().toISOString(),
  }
  if (isMemory()) { memoryState().budgets.set(input.apiKeyId, budget); auditMemoryBudgetMutation() }
  else await budgetsRef().doc(input.apiKeyId).set(budget)
  invalidateBudgetReadCaches()
  return budget
}
export async function deleteBudget(apiKeyId: string) {
  if (isMemory()) { memoryState().budgets.delete(apiKeyId); auditMemoryBudgetMutation() }
  else await budgetsRef().doc(apiKeyId).delete()
  invalidateBudgetReadCaches()
}

async function canonicalUsageRange(from: string, to: string, hourly = false, keyId?: string): Promise<UsageRangeResult> {
  const result = isMemory()
    ? readMemoryUsageRange(currentWorkspaceId(), memoryState().projection, memoryState().events, memoryState().eventsByHour, from, to, hourly, keyId)
    : await queryLocalUsageRange(currentWorkspaceId(), from, to, hourly, keyId)
  return result
}

async function getBudgetUsage(window: BudgetWindow, bypassCache = false): Promise<Map<string, BudgetUsageValue>> {
  const from = await budgetUsageStart(window)
  const workspaceId = currentWorkspaceId()
  const cacheId = scopedKey(`${from}:${window.end}`)
  if (!bypassCache) {
    const cached = budgetUsageCache.get(cacheId)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existing = budgetUsageInflight.get(cacheId)
    if (existing) return existing
  }
  const generation = workspaceGeneration(budgetCacheGenerations, workspaceId)
  const promise = canonicalUsageRange(from, window.end).then(range => {
    const result = new Map<string, BudgetUsageValue>()
    for (const row of range.rows) {
      const previous = result.get(row.gatewayKeyId)
      result.set(row.gatewayKeyId, {
        spentMicros: (previous?.spentMicros || 0) + row.successfulCostMicros,
        lastUsedAt: row.latestSuccessAt && (!previous?.lastUsedAt || row.latestSuccessAt > previous.lastUsedAt) ? row.latestSuccessAt : previous?.lastUsedAt || null,
        available: true,
      })
    }
    for (const key of range.financialUnavailableKeys) result.set(key, { spentMicros: result.get(key)?.spentMicros || 0, lastUsedAt: result.get(key)?.lastUsedAt || null, available: false })
    if (generation === workspaceGeneration(budgetCacheGenerations, workspaceId)) boundedSet(budgetUsageCache, cacheId, { value: result, expiresAt: Date.now() + dashboardCacheTtlMs }, 128)
    return result
  }).finally(() => {
    if (budgetUsageInflight.get(cacheId) === promise) budgetUsageInflight.delete(cacheId)
  })
  if (!bypassCache) budgetUsageInflight.set(cacheId, promise)
  return promise
}

async function budgetSpentMicros(budget: GatewayKeyBudget, window: BudgetWindow) {
  const usage = await getBudgetUsage(window).catch(() => { throw new BudgetUsageUnavailableError() })
  if (usage.get("")?.available === false || usage.get(budget.apiKeyId)?.available === false) throw new BudgetUsageUnavailableError()
  return usage.get(budget.apiKeyId)?.spentMicros || 0
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

function calibratedPayloadPrediction(
  payload: Record<string, unknown> | undefined,
  pricing: NonNullable<Parameters<typeof calculateCostMicros>[1]>,
  gatewayKeyId: string | undefined,
  gatewayModelId: string,
  protocol: UsageEvent["protocol"],
  requestBodyBytes: number | undefined,
  reservation = false,
) {
  if (!isOpenAiCodexModel(gatewayModelId)) return undefined
  const inputBytes = requestBodyBytes ?? (payload ? Buffer.byteLength(JSON.stringify(payload)) : 0)
  if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0) return undefined
  const samples = payloadPredictionSamples(gatewayKeyId, gatewayModelId)
  if (!samples.length) return undefined
  return predictPayloadCalibratedCost({
    gatewayModelId,
    requestBodyBytes: inputBytes,
    protocol,
    outputLimit: requestOutputLimit(payload),
    defaultOutputTokens: defaultPredictedOutputTokens,
    samples,
    pricing,
    maximumNeighbors: payloadPredictionMaximumNeighbors,
    minimumSamples: payloadPredictionMinimumSamples,
    reservation,
  })
}

function estimateReservationMicros(
  payload: Record<string, unknown> | undefined,
  pricing: Parameters<typeof calculateCostMicros>[1],
  limitMicros: number,
  requestBodyBytes?: number,
  gatewayKeyId?: string,
  gatewayModelId?: string,
  protocol: UsageEvent["protocol"] = "openai-chat",
) {
  if (pricing && gatewayModelId) {
    const calibrated = calibratedPayloadPrediction(payload, pricing, gatewayKeyId, gatewayModelId, protocol, requestBodyBytes, true)
    if (calibrated) return Math.min(limitMicros, Math.max(1, Math.ceil(calibrated.costMicros)))
  }
  const outputLimit = requestOutputLimit(payload) || defaultBudgetOutputTokens
  const inputBytes = requestBodyBytes ?? (payload ? Buffer.byteLength(JSON.stringify(payload)) : 0)
  const estimatedInputTokens = Math.max(1, Math.ceil(inputBytes / budgetInputBytesPerToken))
  const estimatedCachedTokens = Math.floor(estimatedInputTokens * estimatedCacheReadRatio)
  const usage = normalizeUsageMetrics({ input: estimatedInputTokens, cached: estimatedCachedTokens, output: outputLimit })
  const estimatedCost = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(calculateCostMicros(usage, pricing).costMicros))
  return Math.min(limitMicros, Math.max(1, estimatedCost))
}

function estimateExpectedCostMicros(
  payload: Record<string, unknown> | undefined,
  pricing: Parameters<typeof calculateCostMicros>[1],
  gatewayKeyId: string,
  gatewayModelId: string,
  providerModelId?: string,
  requestBodyBytes?: number,
  protocol: UsageEvent["protocol"] = "openai-chat",
  allowHistoricalCost = true,
) : ExpectedCostPrediction {
  if (pricing) {
    const calibrated = calibratedPayloadPrediction(payload, pricing, gatewayKeyId, gatewayModelId, protocol, requestBodyBytes)
    if (calibrated) {
      return {
        costMicros: Math.min(missingUsageEstimateMaxCostMicros, Math.max(1, calibrated.costMicros)),
        source: "payload-calibrated",
        predictionMethod: calibrated.method,
        predictionSampleCount: calibrated.sampleCount,
        predictedUsage: { input: calibrated.predictedUsage.inputTokens, output: calibrated.predictedUsage.outputTokens, cached: calibrated.predictedUsage.cacheReadTokens, cacheCreation: calibrated.predictedUsage.cacheCreationTokens },
      }
    }
  }
  const historicalCost = allowHistoricalCost ? historicalCostPrediction(gatewayKeyId, gatewayModelId) : undefined
  if (historicalCost) {
    return {
      costMicros: historicalCost.value,
      source: "empirical",
      predictionMethod: historicalCost.method,
      predictionSampleCount: historicalCost.sampleCount,
    }
  }

  const inputBytes = requestBodyBytes ?? (payload ? Buffer.byteLength(JSON.stringify(payload)) : 0)
  const estimatedInputTokens = Math.max(1, Math.ceil(inputBytes / budgetInputBytesPerToken))
  const outputLimit = requestOutputLimit(payload)
  const historicalOutput = historicalOutputPrediction(gatewayKeyId, gatewayModelId)
  const expectedOutputTokens = outputLimit
    ? Math.min(outputLimit, historicalOutput?.value || defaultPredictedOutputTokens)
    : historicalOutput?.value || defaultPredictedOutputTokens
  const estimatedCachedTokens = Math.floor(estimatedInputTokens * estimatedCacheReadRatio)
  const usage = normalizeUsageMetrics({ input: estimatedInputTokens, cached: estimatedCachedTokens, output: expectedOutputTokens })
  const calculatedCost = Math.max(1, calculateCostMicros(usage, pricing).costMicros)
  return {
    costMicros: Math.min(missingUsageEstimateMaxCostMicros, calculatedCost),
    source: "bounded-formula",
    predictedUsage: { input: estimatedInputTokens, cached: estimatedCachedTokens, output: expectedOutputTokens },
    ...(historicalOutput ? { predictionSampleCount: historicalOutput.sampleCount } : {}),
  }
}

export interface BudgetRequestState {
  admission?: BudgetAdmission
  usageContext?: BudgetUsageContext
  pricing?: ResolvedModelPricing
  requestBodyBytes?: number
  /** Conservative request estimate used to settle successful responses whose
   * provider did not return complete usage metadata. */
  estimatedCostMicros?: number
  estimatedCostSource?: ExpectedCostPrediction["source"]
  predictionMethod?: NonNullable<UsageEvent["predictionMethod"]>
  predictionSampleCount?: number
  estimatedUsage?: UsageMetrics
}

// requestedCombo is trusted routing context, never a client payload field.
export async function getBudgetRequestState(
  apiKeyId: string,
  gatewayModelId: string,
  providerModelId?: string,
  payload?: Record<string, unknown>,
  requestBodyBytes?: number,
  protocol: UsageEvent["protocol"] = "openai-chat",
  requestedCombo?: string,
  tierProfile = serviceTierProfile(protocol),
): Promise<BudgetRequestState> {
  await warmUsagePredictionSamples()
  const budget = await budgetConfig(apiKeyId)
  // Pricing is needed for usage accounting even when a key has no RawRoute
  // budget. A budget is an admission policy, not a prerequisite for billing.
  let pricing: ResolvedModelPricing | undefined
  try { pricing = await getPricingForModel(gatewayModelId, providerModelId) }
  catch { pricing = undefined }
  const requestedServiceTier = requestServiceTier(payload || {}, tierProfile)
  const selectedPricing = selectServiceTierPricing(pricing, { requestedServiceTier }).rates
  const estimatedCost = selectedPricing
    ? estimateExpectedCostMicros(payload, selectedPricing, apiKeyId, gatewayModelId, providerModelId, requestBodyBytes, protocol, !requestedServiceTier && !pricing?.serviceTiers?.length)
    : undefined
  const estimatedState = estimatedCost
    ? {
      estimatedCostMicros: estimatedCost.costMicros,
      estimatedCostSource: estimatedCost.source,
      estimatedUsage: estimatedCost.predictedUsage,
      ...(estimatedCost.predictionMethod ? { predictionMethod: estimatedCost.predictionMethod } : {}),
      ...(estimatedCost.predictionSampleCount !== undefined ? { predictionSampleCount: estimatedCost.predictionSampleCount } : {}),
    }
    : {}
  const window = await getBudgetWindow()
  if (window.bypassLimits) {
    const requestedModel = typeof payload?.model === "string" ? payload.model.trim() : ""
    await assertUnlimitedModelsAllowed([requestedCombo, requestedModel, gatewayModelId, providerModelId], window)
  }
  if (!budget) return { pricing, requestBodyBytes, ...estimatedState }

  const usageStartAt = await budgetUsageStart(window)
  const usageContext = { usageStartAt, windowEnd: window.end } satisfies BudgetUsageContext
  if (window.bypassLimits) return { usageContext, pricing, requestBodyBytes, ...estimatedState }
  if (!budget.enabled) return { usageContext, pricing, requestBodyBytes, ...estimatedState }
  if (!selectedPricing) throw new BudgetPricingUnavailableError("This API key cannot call a model or service tier without configured pricing.")

  const spentMicros = await budgetSpentMicros(budget, window)
  if (spentMicros >= budget.weeklyLimitMicros) {
    const beyondLimits = await getBudgetBeyondLimitsSettings()
    const requestedModel = typeof payload?.model === "string" ? payload.model : ""
    if (beyondLimits.enabled && (beyondLimits.modelIds.includes(gatewayModelId) || (requestedModel && beyondLimits.modelIds.includes(requestedModel)) || (requestedCombo && beyondLimits.modelIds.includes(requestedCombo)))) return { usageContext, pricing, requestBodyBytes, ...estimatedState }
    throw new BudgetDeniedError("Weekly budget exceeded.", budgetRetryAfter(window))
  }
  return {
    usageContext,
    pricing,
    admission: {
      key: `rawroute:budget:v2:${currentWorkspaceId()}:${budgetIntervalId(apiKeyId, usageStartAt)}:${hash(`${budget.updatedAt || ""}:${window.updatedAt || ""}`).slice(0, 16)}`,
      limitMicros: budget.weeklyLimitMicros,
      spentMicros,
      reservationMicros: estimateReservationMicros(payload, selectedPricing, budget.weeklyLimitMicros, requestBodyBytes, apiKeyId, gatewayModelId, protocol),
      ttlSeconds: budgetRetryAfter(window) + 60,
    },
    requestBodyBytes,
    ...estimatedState,
  }
}

export async function assertUnlimitedModelsAllowed(modelIds: Array<string | undefined>, currentWindow?: BudgetWindow) {
  const window = currentWindow || await getBudgetWindow()
  if (!window.bypassLimits) return
  const settings = await getBudgetUnlimitedSettings()
  if (!settings.excludedModelIds.length) return
  const excluded = new Set(settings.excludedModelIds)
  if (modelIds.some((id) => id && excluded.has(id))) throw new BudgetModelExcludedError()
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
  // Keep this estimate only for settling responses that omit usage metadata.
  // It must never reserve or spend quota before actual usage is recorded.
  if (admission.spentMicros >= admission.limitMicros) {
    throw new BudgetDeniedError("Weekly budget exceeded.", admission.ttlSeconds)
  }
  const id = budgetIntervalId(apiKeyId, usageContext.usageStartAt)
  return { id, amountMicros: admission.reservationMicros, usageStartAt: usageContext.usageStartAt } satisfies BudgetReservation
}

export async function releaseBudgetReservation(reservation: BudgetReservation | undefined) {
  // Reservations do not alter actual recorded spend, so there is nothing
  // to release. Keep the lifecycle hook so request finalization stays uniform.
  void reservation
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
  const [usageStartAt, usage] = await Promise.all([budgetUsageStart(window), getBudgetUsage(window, options.freshUsage === true)])
  const names = new Map(keys.map(key => [key.id, key.name]))
  return {
    rows: budgets.map(budget => ({
      ...budget,
      spentMicros: usage.get("")?.available === false || usage.get(budget.apiKeyId)?.available === false ? null : usage.get(budget.apiKeyId)?.spentMicros || 0,
      ...(usage.get("")?.available === false || usage.get(budget.apiKeyId)?.available === false ? { usageAvailable: false as const } : {}),
      windowStart: window.start, windowEnd: window.end, usageStartAt,
      name: names.get(budget.apiKeyId) || "Unknown",
      lastUsedAt: usage.get(budget.apiKeyId)?.lastUsedAt || null,
    })),
    window,
  }
}

export async function getBudgetAdminData() {
  const [keys, window, codex, modelOptions, beyondLimits, unlimited] = await Promise.all([
    budgetSelectableKeys(),
    getBudgetWindow(),
    listCodexAccounts().catch(() => ({ provider: null, accounts: [] })),
    budgetModelOptions(),
    getBudgetBeyondLimitsSettings(),
    getBudgetUnlimitedSettings(),
  ])
  const [{ rows }, bypassSessions] = await Promise.all([
    loadBudgetRows(keys, window, undefined, { freshUsage: true }),
    listBudgetBypassSessions(50, window),
  ])
  return {
    budgets: rows,
    bypassSessions,
    window,
    beyondLimits,
    unlimited,
    modelOptions,
    apiKeys: keys.map((key) => ({ id: key.id, name: key.name })),
    codexAccounts: codex.accounts.map((account) => ({ id: account.id, name: account.name, ...(account.planType ? { planType: account.planType } : {}) })),
  }
}

export async function getBudgetRows() {
  const [keys, window] = await Promise.all([budgetSelectableKeys(), getBudgetWindow()])
  return (await loadBudgetRows(keys, window, undefined, { freshUsage: true })).rows
}

const maximumHourlyDashboardSpanMs = 31 * 86_400_000
const maximumDailyDashboardSpanMs = 730 * 86_400_000
const maximumWeeklyDashboardSpanMs = 7_300 * 86_400_000

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
  if (query.preset === "custom" && query.from && query.to) return { label: "Custom range", from: zonedDateStringToDate(query.from, "00:00"), to: new Date(addZonedDays(zonedDateStringToDate(query.to, "00:00"), 1).getTime() - 1) }
  return { label: "All time", from: new Date("2000-01-01T00:00:00.000Z"), to: now }
}
function bucketStart(date: Date, granularity: string) { if (granularity === "hourly") return startOfZonedHour(date); if (granularity === "monthly") return startOfZonedMonth(date); if (granularity === "weekly") return mondayInAppTimeZone(date); return startOfZonedDay(date) }
function mask(key: string) { return key.length <= 12 ? `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 4))}` : `${key.slice(0, 7)}${"•".repeat(12)}${key.slice(-4)}` }
function publicKeyName(key: { name?: string } | undefined, keyId: string, indexedNames: ReadonlyMap<string, string>) {
  return key?.name?.trim() || indexedNames.get(keyId)?.trim() || keyId
}

/** Shared display labels for analytics and request history, including groups and aliases. */
export async function loadDashboardModelLabels() {
  const workspaceId = currentWorkspaceId()
  const cached = dashboardModelLabelCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = dashboardModelLabelInflight.get(workspaceId)
  if (existing) return existing

  const promise = (async () => {
    const [groups, models, aliases, sharedModels] = await Promise.all([
      listPricingGroups(),
      listModels(),
      listAliases(),
      listSharedModelsForRecipient(),
    ])
    const allModels = new Map<string, typeof models[number]>()
    for (const model of models) {
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
      const label = groupByMemberId.get(model.id) || groupByMemberId.get(model.gatewayModelId) || model.name.trim() || model.gatewayModelId
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
    for (const sharedModel of sharedModels) {
      const label = sharedModel.sourceModelName.trim()
      if (label) labelsByGatewayModel.set(sharedModel.qualifiedModelId, label)
    }
    for (const alias of aliases) {
      // Aliases are routing IDs, not Usage dimensions. Their target's resolved
      // model name keeps every alias of the same model in one Usage group.
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

async function buildDashboardPayload(query: DashboardQuery, publicView: boolean, exactRange?: { from: string; to: string }, keyId?: string): Promise<DashboardPayload & { overview?: OverviewDetails }> {
  const budgetsPromise = listBudgets().then(budgets => keyId ? budgets.filter(budget => budget.apiKeyId === keyId) : budgets)
  const windowPromise = query.preset === "budget" ? getBudgetWindow() : undefined
  const range = exactRange ? { label: "Rolling range", from: new Date(exactRange.from), to: new Date(Date.parse(exactRange.to) - 1) } : await resolveRange(query, windowPromise ? await windowPromise : undefined)
  const trendGranularity = effectiveDashboardGranularity(query.granularity, range.to.getTime() - range.from.getTime())
  const toExclusive = exactRange ? exactRange.to : new Date(range.to.getTime() + (query.preset === "budget" ? 0 : 1)).toISOString()
  const from = range.from.toISOString()
  const [usage, keys, indexedNames, labels, budgetData] = await Promise.all([
    canonicalUsageRange(from, toExclusive, trendGranularity === "hourly", keyId),
    budgetSelectableKeys(),
    publicView ? listIndexedApiKeyNames() : Promise.resolve(new Map<string, string>()),
    loadDashboardModelLabels(),
    budgetsPromise.then(async budgets => {
      if (!budgets.length) return { rows: [], window: windowPromise ? await windowPromise : undefined }
      return loadBudgetRows([], windowPromise ? await windowPromise : await getBudgetWindow(), budgets)
    }),
  ]).catch(() => { throw new Error(exactRange ? "Overview data unavailable" : "Usage data unavailable") })
  const keyMap = new Map(keys.map(key => [key.id, key]))
  const budgetMap = new Map(budgetData.rows.map(budget => [budget.apiKeyId, budget]))
  const keyRows = new Map<string, DashboardPayload["keys"][number]>()
  const modelsByKey = new Map<string, Set<string>>()
  // Keep quiet/configured keys visible even when this window has no attempts.
  if (keyId) {
    const key = keyMap.get(keyId)
    const shared = sharedWorkspaceIdFromBudgetId(keyId)
    const label = shared ? sharedWorkspaceUsageLabel(key, shared) : publicView ? publicKeyName(key, keyId, indexedNames) : key?.name?.trim() || keyId
    keyRows.set(keyId, { id: publicView ? label : keyId, label, ...(publicView ? { publicId: publicKeyUsageId(keyId) } : {}), maskedKey: "hidden", requests: 0, tokens: 0, costMicros: 0, models: [], lastUsed: null })
    modelsByKey.set(keyId, new Set())
  }
  const models = new Map<string, DashboardPayload["models"][number]>()
  const trend = new Map<string, DashboardPayload["trend"][number]>()
  const compact = (query.preset === "today" || query.preset === "yesterday") && trendGranularity === "hourly"
  const presentation = trendGranularity === "hourly" ? "hourly" : "daily"
  const dates = new Map<string, string>()
  const ends = new Map<string, string>()
  const chartEnd = (at: string, granularity: string) => {
    const key = `${granularity}:${at}`
    let value = ends.get(key)
    if (!value) { value = nextBucketStart(new Date(at), granularity).toISOString(); ends.set(key, value) }
    return value
  }
  const chartBucket = (at: string, granularity: string) => {
    const key = `${granularity}:${at}`
    const cached = dates.get(key)
    if (cached) return cached
    const value = granularity === "hourly" || granularity === "daily" ? usageCalendarBucket(at, granularity).bucketStart : bucketStart(new Date(at), granularity).toISOString()
    dates.set(key, value)
    return value
  }
  const wholeBuckets = new Map<string, boolean>()
  const dimensions = new Map<string, string>()
  const dimensionOrder = (row: UsageBucket) => {
    const key = `${row.gatewayKeyId}:${row.gatewayModelId}`
    let value = dimensions.get(key)
    if (!value) { value = hash(key); dimensions.set(key, value) }
    return value
  }
  const whole = (row: UsageBucket) => {
    const start = chartBucket(row.bucketStart, presentation)
    const cached = wholeBuckets.get(start)
    if (cached !== undefined) return cached
    const value = start >= from && chartEnd(start, presentation) <= toExclusive
    wholeBuckets.set(start, value)
    return value
  }
  const rows = [...usage.rows].sort((a,b) => Number(whole(b)) - Number(whole(a)) || chartBucket(a.bucketStart,presentation).localeCompare(chartBucket(b.bucketStart,presentation)) || dimensionOrder(a).localeCompare(dimensionOrder(b)))
  let lastEventAt: string | null = null
  for (const row of rows) {
    const tokens = exactRange ? row.inputTokens + row.outputTokens : row.totalTokens
    if (row.latestEventAt && (!lastEventAt || row.latestEventAt > lastEventAt)) lastEventAt = row.latestEventAt
    const bucket = chartBucket(row.bucketStart, trendGranularity)
    const next = chartEnd(bucket, trendGranularity)
    if (row.provenance === "historical" && row.bucketEnd > next) {
      usage.coverage.unsupportedTrendSources++
      usage.gaps.push({ from: row.bucketStart, to: row.bucketEnd })
    } else {
      const point = trend.get(bucket) || { bucketStart: bucket, label: formatAppTrendBucket(bucket, trendGranularity, compact ? "hour" : undefined), requests: 0, tokens: 0, costMicros: 0 }
      point.requests += row.requests; point.tokens += tokens; point.costMicros += row.costMicros
      trend.set(bucket, point)
    }
    if (row.gatewayKeyId) {
      let keyRow = keyRows.get(row.gatewayKeyId)
      if (!keyRow) {
        const key = keyMap.get(row.gatewayKeyId)
        const shared = sharedWorkspaceIdFromBudgetId(row.gatewayKeyId)
        const name = shared ? sharedWorkspaceUsageLabel(key, shared) : publicView ? publicKeyName(key, row.gatewayKeyId, indexedNames) : key?.name?.trim() || row.gatewayKeyId
        keyRow = { id: publicView ? name : row.gatewayKeyId, label: name, ...(publicView ? { publicId: publicKeyUsageId(row.gatewayKeyId) } : {}), maskedKey: publicView ? "hidden" : mask(key?.key || "unknown"), requests: 0, tokens: 0, costMicros: 0, models: [], lastUsed: null }
        keyRows.set(row.gatewayKeyId, keyRow); modelsByKey.set(row.gatewayKeyId, new Set())
      }
      keyRow.requests += row.requests; keyRow.tokens += tokens; keyRow.costMicros += row.costMicros
      if (row.latestEventAt && (!keyRow.lastUsed || row.latestEventAt > keyRow.lastUsed)) keyRow.lastUsed = row.latestEventAt
      if (row.gatewayModelId) modelsByKey.get(row.gatewayKeyId)?.add(labels.get(row.gatewayModelId) || row.gatewayModelId)
    }
    if (row.gatewayModelId) {
      const name = labels.get(row.gatewayModelId) || row.gatewayModelId
      const model = models.get(name) || { model: name, requests: 0, tokens: 0, costMicros: 0 }
      model.requests += row.requests; model.tokens += tokens; model.costMicros += row.costMicros
      models.set(name, model)
    }
  }
  const allTime = query.preset === "all" && !exactRange
  if (trend.size || !allTime) {
    const first = allTime ? [...trend.keys()].sort()[0]! : chartBucket(from, trendGranularity)
    const last = chartBucket(new Date(Date.parse(toExclusive) - 1).toISOString(), trendGranularity)
    for (let cursor = new Date(first); cursor.toISOString() <= last; cursor = new Date(chartEnd(cursor.toISOString(), trendGranularity))) {
      const bucket = cursor.toISOString()
      const next = chartEnd(bucket, trendGranularity)
      if (trendGranularity === "weekly" && bucket < from && !trend.has(bucket)) continue
      if (usage.gaps.some(gap => (!gap.from || gap.from < next) && (!gap.to || gap.to > bucket))) continue
      if (!trend.has(bucket)) trend.set(bucket, { bucketStart: bucket, label: formatAppTrendBucket(bucket, trendGranularity, compact ? "hour" : undefined), requests: 0, tokens: 0, costMicros: 0 })
    }
  }
  for (const [id,row] of keyRows) {
    row.models = [...(modelsByKey.get(id) || [])].sort((a,b) => a.localeCompare(b))
    const budget = budgetMap.get(id)
    if (budget && budgetData.window) row.budget = {
      enabled: budget.enabled,
      weeklyLimitMicros: budget.weeklyLimitMicros, spentMicros: budget.spentMicros,
      remainingMicros: budget.spentMicros === null ? null : Math.max(0, budget.weeklyLimitMicros - budget.spentMicros),
      percentUsed: budget.spentMicros === null ? null : budget.weeklyLimitMicros > 0 ? budget.spentMicros / budget.weeklyLimitMicros * 100 : 0,
      bypassLimits: budgetData.window.bypassLimits, usageStartAt: budget.usageStartAt,
      windowStart: budget.windowStart, windowEnd: budget.windowEnd,
      ...(budget.usageAvailable === false ? { usageAvailable: false } : {}),
    }
  }
  usage.coverage.partial ||= usage.coverage.unsupportedTrendSources > 0 || budgetData.rows.some(row => row.usageAvailable === false)
  usage.coverage.financialUnavailable ||= budgetData.rows.some(row => row.usageAvailable === false)
  const totals = usage.totals
  const payload: DashboardPayload & { overview?: OverviewDetails } = {
    ...(exactRange ? { overview: {
      inputTokens: totals.inputTokens, cacheReadTokens: totals.cacheReadTokens, failedRequests: totals.failedRequests, statusCoveredRequests: totals.statusCoveredRequests,
      cacheUsageInputTokens: totals.cacheUsageInputTokens, cacheUsageReadTokens: totals.cacheUsageReadTokens, cacheUsageCoveredRequests: totals.cacheUsageCoveredRequests,
      durationCount: totals.durationCount, durationSumMs: totals.durationSumMs,
      budgets: budgetData.rows.map(budget => ({ id: budget.apiKeyId, name: keyMap.get(budget.apiKeyId)?.name || budget.apiKeyId, enabled: budget.enabled, limitMicros: budget.weeklyLimitMicros, spentMicros: budget.spentMicros, ...(budget.usageAvailable === false ? { usageAvailable: false } : {}) })),
      budgetWindow: budgetData.window ? { from: budgetData.window.start, to: budgetData.window.end, bypassLimits: budgetData.window.bypassLimits } : null,
    } } : {}),
    generatedAt: new Date().toISOString(),
    range: { label: range.label, from, to: range.to.toISOString(), granularity: trendGranularity },
    summary: { requests: totals.requests, tokens: exactRange ? totals.inputTokens + totals.outputTokens : totals.totalTokens, costMicros: totals.costMicros, activeKeys: [...keyRows.values()].filter(row => row.requests > 0).length, pricedRequests: totals.pricedRequests, unpricedRequests: totals.unpricedRequests },
    trend: [...trend.values()].sort((a,b) => a.bucketStart.localeCompare(b.bucketStart)),
    keys: [...keyRows.values()].sort((a,b) => b.requests - a.requests),
    models: [...models.values()].sort((a,b) => b.costMicros - a.costMicros || b.requests - a.requests),
    freshness: { source: isMemory() ? "memory" : "sqlite", lastEventAt },
    pricingConfidence: { pricedRequests: totals.pricedRequests, unpricedRequests: totals.unpricedRequests },
    coverage: usage.coverage,
  }
  return payload
}


export async function getOverviewPayload(range: { from: string; to: string }): Promise<OverviewPayload> {
  const payload = await buildDashboardPayload({ preset: "all" }, false, range)
  if (!payload.overview) throw new Error("Overview data unavailable")
  return { ...payload, range: { ...payload.range, ...range }, models: [...payload.models].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)), overview: payload.overview }
}

function nextBucketStart(value: Date, granularity: string) {
  if (granularity === "hourly") return new Date(usageCalendarBucket(value.toISOString(), "hourly").bucketEnd)
  if (granularity === "monthly") return addZonedMonths(value, 1)
  if (granularity === "weekly") return addZonedDays(value, 7)
  return new Date(usageCalendarBucket(value.toISOString(), "daily").bucketEnd)
}

/** Private, workspace-scoped detail using the same canonical data as Usage. */
export async function getKeyUsagePayload(keyId: string): Promise<DashboardPayload> {
  return buildDashboardPayload({ preset: "budget", granularity: "daily" }, false, undefined, keyId)
}

/** Public, opaque-ID detail for one key visible in the selected public workspace. */
export async function getPublicKeyUsageDetail(publicId: string): Promise<{ keyId: string; payload: DashboardPayload } | undefined> {
  if (!/^[a-f0-9]{64}$/.test(publicId)) return undefined
  let keyId = publicUsageKeyIds.get(currentWorkspaceId())?.get(publicId)
  const [keys, workspaces, indexedNames] = await Promise.all([listApiKeys(), listWorkspaces(), listIndexedApiKeyNames()])
  const candidates = [
    ...keys.map(key => key.id),
    ...indexedNames.keys(),
    ...workspaces.filter(workspace => workspace.status === "active" && workspace.id !== currentWorkspaceId()).map(workspace => sharedWorkspaceBudgetId(workspace.id)),
  ]
  keyId ||= candidates.find(candidate => hash(`${currentWorkspaceId()}:${candidate}`) === publicId)
  if (!keyId) {
    await getDashboardPayload({ preset: "all" }, true)
    keyId = publicUsageKeyIds.get(currentWorkspaceId())?.get(publicId)
  }
  if (!keyId) return undefined
  return {
    keyId,
    payload: await buildDashboardPayload({ preset: "budget", granularity: "daily" }, true, undefined, keyId),
  }
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

type RepricedEvent = {
  after: UsageEvent
}

type RepricingBudgetContext = {
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
      // Keep the catalog association for the admin view, but preserve the
      // source cost because no token-complete recalculation occurred.
      after: { ...event, pricingGroupId: groupId, pricingVersionId: version.id },
    }
  }
  const normalized = normalizeUsageMetrics({ input: event.inputTokens, output: event.outputTokens, cached: event.cacheReadTokens, cacheCreation: event.cacheCreationTokens })
  const calculated = calculateCostMicros(normalized, version, event)
  // Persisted events do not retain cache-field presence. If the original
  // event was complete but pricing was assumed, recalculating the token-based
  // amount is safe, while promoting it to exact would invent certainty that
  // the source record did not have.
  const pricingConfidence = event.pricingConfidence === "assumed" && calculated.pricingConfidence !== "unpriced"
    ? "assumed" as const
    : calculated.pricingConfidence
  const after: UsageEvent = {
    ...event,
    ...normalized,
    // Repricing normalized zeros must not manufacture cache-field provenance.
    cacheUsageKnown: event.cacheUsageKnown,
    costMicros: calculated.costMicros,
    pricingConfidence,
    costSource: calculated.pricingConfidence === "unpriced" ? event.costSource : "configured-pricing",
    pricingGroupId: groupId,
    pricingVersionId: version.id,
  }
  if (calculated.pricingContextTier) after.pricingContextTier = calculated.pricingContextTier
  else delete after.pricingContextTier
  if (calculated.pricingServiceTier) after.pricingServiceTier = calculated.pricingServiceTier
  else delete after.pricingServiceTier
  return { after }
}

async function repricingBudgetContext(): Promise<RepricingBudgetContext | null> {
  const budgets = await listBudgets()
  if (!budgets.length) return null
  const window = await getBudgetWindow()
  return { window }
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



async function applyRepricingChunk(updates: RepricedEvent[]) {
  if (isMemory()) {
    const memory = memoryState()
    let projection = memory.projection
    for (const update of updates) projection = projectMemoryUsage(projection, currentWorkspaceId(), memory.events.get(update.after.id) ? { ...memory.events.get(update.after.id)! } : undefined, { ...update.after })
    memory.projection = projection
    for (const update of updates) memory.events.set(update.after.id, update.after)
    invalidateUsageReadCaches()
    return
  }
  const batch = db().batch()
  for (const update of updates) batch.set(eventsRef().doc(update.after.id), update.after)
  await batch.commit()
  invalidateUsageReadCaches()
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
    await applyRepricingChunk(chunk.map((event) => repriceEvent(event, group.id, version)))
    currentJob = await updatePricingJob(jobId, { processedEvents: Math.min(index + chunk.length, events.length) }, currentJob)
    if (!currentJob) return
  }
  // Cache budget aggregates are versioned by the budget/window timestamps.
  // Repricing changes persisted spend, so advance the shared revision once to
  // invalidate any previously issued admission identity without reserving spend.
  await bumpBudgetStateRevision(budgetContext)
  invalidateBudgetReadCaches()
  return updatePricingJob(jobId, { status: "completed", processedEvents: events.length, completedAt: new Date().toISOString() }, currentJob)
}

export function resetAnalyticsForTests() {
  memoryStates().clear()
  clearWorkspaceAnalyticsCaches()
  resetModelPricingForTests()
}

function clearWorkspaceAnalyticsCaches() {
  usagePredictionSamples.clear()
  usagePredictionWarmup = undefined
  pricingCache.clear()
  pricingInflight.clear()
  budgetConfigCache.clear()
  budgetConfigInflight.clear()
  budgetUsageCache.clear()
  budgetUsageInflight.clear()
  bypassSessionCache.clear()
  bypassSessionInflight.clear()
  bypassSessionListCache.clear()
  bypassSessionListInflight.clear()
  beyondLimitsCache.clear()
  beyondLimitsInflight.clear()
  unlimitedSettingsCache.clear()
  unlimitedSettingsInflight.clear()
  dashboardCache.clear()
  dashboardInflight.clear()
  dashboardModelLabelCache.clear()
  publicUsageKeyIds.clear()
  dashboardModelLabelInflight.clear()
  budgetsCaches.clear()
  budgetsInflights.clear()
  budgetWindowCaches.clear()
  budgetWindowInflights.clear()
  codexBudgetWindowSyncAttempts.clear()
  codexBudgetWindowSyncInflights.clear()
  budgetCacheGenerations.clear()
}
