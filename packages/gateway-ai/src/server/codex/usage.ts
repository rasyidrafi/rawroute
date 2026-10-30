import { cliProxyCodexApiCall } from "./cliproxy"
import { localCacheGet, localCacheSet, localCacheSetIfAbsent, localCacheDelete } from "@rawroute/platform/server/local-cache"
import type { ProviderApiKey } from "../../contracts/domain"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import type { CodexQuotaWindow, CodexUsageSnapshot, CodexResetCredit, CodexUsageResult } from "../../contracts/codex"

export const CODEX_USAGE_CACHE_TTL_SECONDS = 5 * 60

const CACHE_RETENTION_SECONDS = 24 * 60 * 60
const REFRESH_LOCK_TTL_SECONDS = 30
const CACHE_PREFIX = "rawroute:codex-usage:v2"
const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const localCacheTtlMs = CODEX_USAGE_CACHE_TTL_SECONDS * 1000
const resetRefreshIntervalMs = 2_000
const maximumLocalCacheEntries = 128
const maximumWorkspaceEntries = 256

export function parseCodexResetCredits(payload: unknown): CodexResetCredit[] {
  const data = objectValue(payload)
  if (!Array.isArray(data?.credits)) throw new Error("Invalid reset credit inventory")
  return data.credits.map((entry) => {
    const credit = objectValue(entry)
    if (typeof credit?.id !== "string" || typeof credit.status !== "string") throw new Error("Invalid reset credit")
    const expiresAt = parseResetAt(credit.expires_at)
    if (credit.expires_at != null && !expiresAt) throw new Error("Invalid reset credit expiry")
    return { id: credit.id, status: credit.status, grantedAt: parseResetAt(credit.granted_at), expiresAt }
  }).sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity))
}

interface CachedCodexUsage {
  snapshot: CodexUsageSnapshot | null
  fetchedAt: string | null
  retryAt: number
  error?: string
  reauthRequired?: boolean
  refreshPending?: boolean
}

export interface UsageCache {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T, options?: { ex?: number; nx?: boolean }): Promise<unknown>
  del?(key: string): Promise<unknown>
}

let cacheClient: UsageCache | undefined
type CodexApiCall = typeof cliProxyCodexApiCall
let codexApiCall: CodexApiCall = cliProxyCodexApiCall
let now = () => Date.now()
const localUsageCache = new Map<string, { result: CodexUsageResult; expiresAt: number }>()
const usageInflight = new Map<string, Promise<CodexUsageResult>>()
const localCacheGenerations = new Map<string, number>()
let localCacheResetGeneration = 0

function localCacheGeneration(workspaceId: string) {
  return localCacheGenerations.get(workspaceId) || 0
}

function setLocalUsageCache(workspaceId: string, accountId: string, result: CodexUsageResult) {
  accountId = `${workspaceId}:${accountId}`
  if (localCacheTtlMs <= 0) return
  if (!localUsageCache.has(accountId) && localUsageCache.size >= maximumLocalCacheEntries) {
    const oldest = localUsageCache.keys().next().value
    if (oldest !== undefined) localUsageCache.delete(oldest)
  }
  localUsageCache.set(accountId, { result, expiresAt: now() + (result.refreshPending ? resetRefreshIntervalMs : localCacheTtlMs) })
}

function clearWorkspaceLocalUsageCache(accountId?: string) {
  const workspaceId = currentWorkspaceId()
  if (!localCacheGenerations.has(workspaceId) && localCacheGenerations.size >= maximumWorkspaceEntries) {
    const oldest = localCacheGenerations.keys().next().value
    if (oldest !== undefined) localCacheGenerations.delete(oldest)
  }
  localCacheGenerations.set(workspaceId, localCacheGeneration(workspaceId) + 1)
  if (accountId) {
    const key = `${workspaceId}:${accountId}`
    localUsageCache.delete(key)
    usageInflight.delete(key)
    return
  }
  const prefix = `${workspaceId}:`
  for (const key of localUsageCache.keys()) if (key.startsWith(prefix)) localUsageCache.delete(key)
  for (const key of usageInflight.keys()) if (key.startsWith(prefix)) usageInflight.delete(key)
}

function resetLocalUsageCache() {
  localCacheResetGeneration += 1
  localCacheGenerations.clear()
  localUsageCache.clear()
  usageInflight.clear()
}

function getUsageUrl() {
  return DEFAULT_USAGE_URL
}

function getCache(): UsageCache {
  if (cacheClient) return cacheClient
  const client: UsageCache = {
    async get<T = unknown>(key: string) {
      const value = await localCacheGet(key)
      if (value === null) return null
      try { return JSON.parse(value) as T } catch { return value as T }
    },
    async set<T = unknown>(key: string, value: T, options: { ex?: number; nx?: boolean } = {}) {
      const serialized = typeof value === "string" ? value : JSON.stringify(value)
      const ttl = (options.ex ?? CACHE_RETENTION_SECONDS) * 1000
      const saved = options.nx
        ? await localCacheSetIfAbsent(key, serialized, ttl)
        : await localCacheSet(key, serialized, ttl)
      return saved ? "OK" : null
    },
    async del(key: string) { return Number(await localCacheDelete(key)) },
  }
  cacheClient = client
  return client
}

function cacheKey(accountId: string) {
  return `${CACHE_PREFIX}:${currentWorkspaceId()}:${accountId}`
}

function lockKey(accountId: string) {
  return `${CACHE_PREFIX}:lock:${currentWorkspaceId()}:${accountId}`
}

function resetRefreshKey(accountId: string) {
  return `${CACHE_PREFIX}:reset-refresh:${currentWorkspaceId()}:${accountId}`
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseResetAt(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined
  const parsed = typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))
    ? Number(value)
    : NaN
  const date = Number.isFinite(parsed)
    ? new Date(parsed < 1e12 ? parsed * 1000 : parsed)
    : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function unwrapRateLimit(value: unknown) {
  const record = objectValue(value)
  const nested = objectValue(record?.rate_limit)
  return nested || record
}

function getWindow(rateLimit: Record<string, unknown> | undefined, names: string[]) {
  if (!rateLimit) return undefined
  for (const name of names) {
    const value = objectValue(rateLimit[name])
    if (value) return value
  }
  return undefined
}

type ParsedCodexWindow = {
  quota: CodexQuotaWindow
  windowSeconds?: number
}

function parseWindow(value: unknown): ParsedCodexWindow | null {
  const window = objectValue(value)
  if (!window) return null
  const usedValue = numberValue(window.used_percent ?? window.percent_used)
  const remainingValue = numberValue(window.remaining_percent ?? window.percent_remaining)
  const used = usedValue ?? (remainingValue === undefined ? undefined : 100 - remainingValue)
  if (used === undefined) return null
  const usedPercent = Math.max(0, Math.min(100, used))
  const resetAt = parseResetAt(window.reset_at ?? window.resets_at ?? window.resetAt)
  const windowSeconds = numberValue(window.limit_window_seconds ?? window.window_seconds)
  return {
    quota: {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      ...(resetAt ? { resetAt } : {}),
    },
    ...(windowSeconds !== undefined && windowSeconds > 0 ? { windowSeconds } : {}),
  }
}

function classifyWindow(windowSeconds: number | undefined, fallback: "fiveHour" | "weekly") {
  if (windowSeconds === undefined) return fallback
  if (windowSeconds >= 4 * 60 * 60 && windowSeconds <= 6 * 60 * 60) return "fiveHour" as const
  if (windowSeconds >= 6 * 24 * 60 * 60 && windowSeconds <= 8 * 24 * 60 * 60) return "weekly" as const
  return undefined
}

export function parseCodexUsagePayload(payload: unknown): CodexUsageSnapshot {
  const data = objectValue(payload)
  const rateLimits = objectValue(data?.rate_limits_by_limit_id)
  const normal = unwrapRateLimit(data?.rate_limit ?? data?.rate_limits ?? rateLimits?.codex ?? data)
  const snapshot: CodexUsageSnapshot = { fiveHour: null, weekly: null }
  if (typeof data?.plan_type === "string" && data.plan_type.trim()) snapshot.planType = data.plan_type.trim().toLowerCase()
  const windows: Array<["fiveHour" | "weekly", unknown]> = [
    ["fiveHour", getWindow(normal, ["primary_window", "primary"])],
    ["weekly", getWindow(normal, ["secondary_window", "secondary"])],
  ]

  for (const [fallback, value] of windows) {
    const parsed = parseWindow(value)
    if (!parsed) continue
    const kind = classifyWindow(parsed.windowSeconds, fallback)
    if (kind && !snapshot[kind]) snapshot[kind] = parsed.quota
  }

  const available = parseUnusedCodexResetCredits(payload)
  if (available !== undefined) snapshot.unusedResetCredits = available

  return snapshot
}

export function parseUnusedCodexResetCredits(payload: unknown) {
  const data = objectValue(payload)
  const normal = unwrapRateLimit(data?.rate_limit ?? data?.rate_limits ?? data)
  const resetCredits = objectValue(data?.rate_limit_reset_credits) || objectValue(normal?.rate_limit_reset_credits)
  const available = numberValue(resetCredits?.available_count ?? resetCredits?.unused_count ?? resetCredits?.remaining_count ?? resetCredits?.available)
  return available === undefined ? undefined : Math.max(0, Math.floor(available))
}

async function fetchCodexUsage(account: ProviderApiKey): Promise<CodexUsageSnapshot> {
  const headers: Record<string, string> = { authorization: "Bearer $TOKEN$", accept: "application/json" }
  if (account.accountId) headers["chatgpt-account-id"] = account.accountId
  const response = await codexApiCall(account, { method: "GET", url: getUsageUrl(), headers })
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(new Error(`Codex usage request failed (${response.status})${response.body ? `: ${response.body.slice(0, 200)}` : ""}`), { status: response.status })
  }
  try {
    const snapshot = parseCodexUsagePayload(JSON.parse(response.body) as unknown)
    try {
      const url = new URL(getUsageUrl())
      url.pathname = url.pathname.replace(/\/usage\/?$/, "/rate-limit-reset-credits")
      url.search = ""
      const details = await codexApiCall(account, { method: "GET", url: url.toString(), headers })
      if (details.status < 200 || details.status >= 300) throw new Error("Reset credit inventory unavailable")
      snapshot.resetCredits = parseCodexResetCredits(JSON.parse(details.body))
      snapshot.unusedResetCredits = snapshot.resetCredits.filter((credit) => credit.status === "available" && (!credit.expiresAt || Date.parse(credit.expiresAt) > now())).length
    } catch {
      snapshot.resetCreditsError = "Expiry unavailable"
    }
    return snapshot
  } catch {
    throw new Error("Codex usage response was not valid JSON.")
  }
}

/** Always performs upstream reads; reset coordination must not make decisions from a five-minute UI cache. */
export function fetchFreshCodexUsageForReset(account: ProviderApiKey) {
  return fetchCodexUsage(account)
}

function emptyResult(error?: string): CodexUsageResult {
  return { fiveHour: null, weekly: null, fetchedAt: null, stale: false, ...(error ? { error } : {}) }
}

function resultFromCache(cached: CachedCodexUsage, stale: boolean): CodexUsageResult {
  return {
    ...(cached.snapshot?.planType ? { planType: cached.snapshot.planType } : {}),
    fiveHour: cached.snapshot?.fiveHour || null,
    weekly: cached.snapshot?.weekly || null,
    resetCredits: cached.snapshot?.resetCredits,
    resetCreditsError: cached.snapshot?.resetCreditsError,
    ...(cached.snapshot?.unusedResetCredits !== undefined ? { unusedResetCredits: cached.snapshot.unusedResetCredits } : {}),
    fetchedAt: cached.fetchedAt,
    stale,
    ...(cached.refreshPending ? { refreshPending: true } : {}),
    ...(cached.error ? { error: cached.error } : {}),
    ...(cached.reauthRequired ? { reauthRequired: true } : {}),
  }
}

function readCache(value: unknown): CachedCodexUsage | undefined {
  const record = objectValue(value)
  const snapshot = objectValue(record?.snapshot)
  if (!record || (record.snapshot !== null && !snapshot)) return undefined
  const fetchedAt = typeof record.fetchedAt === "string" ? record.fetchedAt : null
  const retryAt = numberValue(record.retryAt)
  if (retryAt === undefined) return undefined
  return {
    snapshot: snapshot as unknown as CodexUsageSnapshot | null,
    fetchedAt,
    retryAt,
    ...(record.refreshPending === true ? { refreshPending: true } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(record.reauthRequired === true ? { reauthRequired: true } : {}),
  }
}

async function acquireRefreshLock(cache: UsageCache, accountId: string) {
  const result = await cache.set(lockKey(accountId), "1", { ex: REFRESH_LOCK_TTL_SECONDS, nx: true })
  return result === "OK"
}

function isUnauthorized(error: unknown) {
  return objectValue(error)?.status === 401 || (error instanceof Error && /\(401\)/.test(error.message))
}

async function loadCodexUsageForAccount(
  account: ProviderApiKey,
): Promise<CodexUsageResult> {
  let cache: UsageCache
  try {
    cache = getCache()
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : "Usage cache unavailable.")
  }

  const key = cacheKey(account.id)
  const workspaceId = currentWorkspaceId()
  const generation = localCacheGeneration(workspaceId)
  const resetGeneration = localCacheResetGeneration
  const isCurrent = () => generation === localCacheGeneration(workspaceId) && resetGeneration === localCacheResetGeneration
  let cached: CachedCodexUsage | undefined
  let refreshPending = false
  try {
    const refreshUntil = await cache.get<number>(resetRefreshKey(account.id))
    refreshPending = typeof refreshUntil === "number" && now() < refreshUntil
    cached = readCache(await cache.get(key))
    if (cached && Boolean(cached.refreshPending) === refreshPending && now() < cached.retryAt) return resultFromCache(cached, Boolean(cached.error))
    if (!(await acquireRefreshLock(cache, account.id))) {
      const concurrent = readCache(await cache.get(key))
      return { ...(concurrent ? resultFromCache(concurrent, Boolean(concurrent.error) || now() >= concurrent.retryAt) : emptyResult("Usage refresh in progress.")), ...(refreshPending ? { refreshPending: true } : {}) }
    }
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : "Usage cache unavailable.")
  }

  try {
    const snapshot = await fetchCodexUsage(account)
    if (refreshPending && snapshot.weekly && snapshot.weekly.remainingPercent > 0) {
      refreshPending = false
      await cache.del?.(resetRefreshKey(account.id))
    }
    const fetchedAt = new Date(now()).toISOString()
    const record: CachedCodexUsage = { snapshot, fetchedAt, retryAt: now() + (refreshPending ? resetRefreshIntervalMs : localCacheTtlMs), ...(refreshPending ? { refreshPending: true } : {}) }
    if (isCurrent()) await cache.set(key, record, { ex: CACHE_RETENTION_SECONDS })
    return resultFromCache(record, false)
  } catch (error) {
    const reauthRequired = isUnauthorized(error)
    const message = reauthRequired
      ? "Authentication token expired. Reauthorize this Codex account."
      : error instanceof Error ? error.message : "Codex usage unavailable."
    const record: CachedCodexUsage = {
      snapshot: cached?.snapshot || null,
      fetchedAt: cached?.fetchedAt || null,
      retryAt: now() + (refreshPending ? resetRefreshIntervalMs : localCacheTtlMs),
      ...(refreshPending ? { refreshPending: true } : {}),
      error: message,
      ...(reauthRequired ? { reauthRequired: true } : {}),
    }
    try {
      if (isCurrent()) await cache.set(key, record, { ex: CACHE_RETENTION_SECONDS })
    } catch {}
    return resultFromCache(record, Boolean(cached?.snapshot))
  } finally {
    await cache.del?.(lockKey(account.id)).catch(() => undefined)
  }
}

export async function getCodexUsageForAccount(
  account: ProviderApiKey,
): Promise<CodexUsageResult> {
  const localKey = `${currentWorkspaceId()}:${account.id}`
  const cached = localUsageCache.get(localKey)
  if (cached && cached.expiresAt > now()) return cached.result
  if (cached) localUsageCache.delete(localKey)

  const existing = usageInflight.get(localKey)
  if (existing) return existing
  const workspaceId = currentWorkspaceId()
  const resetGeneration = localCacheResetGeneration
  const generation = localCacheGeneration(workspaceId)
  const promise = loadCodexUsageForAccount(account).then((result) => {
    if (resetGeneration === localCacheResetGeneration && generation === localCacheGeneration(workspaceId)) setLocalUsageCache(workspaceId, account.id, result)
    return result
  }).finally(() => {
    if (usageInflight.get(localKey) === promise) usageInflight.delete(localKey)
  })
  usageInflight.set(localKey, promise)
  return promise
}

export function setCodexUsageCacheForTests(cache?: UsageCache) {
  cacheClient = cache
  resetLocalUsageCache()
}

export function setCodexUsageApiCallForTests(apiCall?: CodexApiCall) {
  codexApiCall = apiCall || cliProxyCodexApiCall
  resetLocalUsageCache()
}

export function setCodexUsageClockForTests(clock?: () => number) {
  now = clock || (() => Date.now())
  resetLocalUsageCache()
}

export async function invalidateCodexUsageCache(accountId: string, afterReset = false) {
  clearWorkspaceLocalUsageCache(accountId)
  try {
    const cache = getCache()
    if (afterReset) await cache.set(resetRefreshKey(accountId), now() + localCacheTtlMs, { ex: CODEX_USAGE_CACHE_TTL_SECONDS })
    if (cache.del) await cache.del(cacheKey(accountId))
  } catch {}
}
