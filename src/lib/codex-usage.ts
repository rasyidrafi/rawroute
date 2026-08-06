import { Redis } from "@upstash/redis"

import { refreshCodexAccount } from "@/lib/codex"
import type { ProviderApiKey } from "@/lib/types"
import { currentWorkspaceId } from "@/lib/workspace-context"

export const CODEX_USAGE_CACHE_TTL_SECONDS = 5 * 60

const CACHE_RETENTION_SECONDS = 24 * 60 * 60
const REFRESH_LOCK_TTL_SECONDS = 30
const CACHE_PREFIX = "rawroute:codex-usage:v1"
const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const configuredLocalCacheTtlMs = Number(process.env.CODEX_USAGE_LOCAL_CACHE_TTL_MS || 30_000)
const localCacheTtlMs = Number.isFinite(configuredLocalCacheTtlMs) && configuredLocalCacheTtlMs >= 0 ? configuredLocalCacheTtlMs : 30_000
const maximumLocalCacheEntries = 128

export interface CodexQuotaWindow {
  usedPercent: number
  remainingPercent: number
  resetAt?: string
}

export interface CodexUsageSnapshot {
  fiveHour: CodexQuotaWindow | null
  weekly: CodexQuotaWindow | null
  unusedResetCredits?: number
}

export interface CodexUsageResult extends CodexUsageSnapshot {
  fetchedAt: string | null
  stale: boolean
  error?: string
}

interface CachedCodexUsage {
  snapshot: CodexUsageSnapshot | null
  fetchedAt: string | null
  retryAt: number
  error?: string
}

export interface UsageRedis {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T, options?: { ex?: number; nx?: boolean }): Promise<unknown>
  del?(key: string): Promise<unknown>
}

let redisClient: UsageRedis | undefined
let now = () => Date.now()
const localUsageCache = new Map<string, { result: CodexUsageResult; expiresAt: number }>()
const usageInflight = new Map<string, Promise<CodexUsageResult>>()
let localCacheGeneration = 0

function setLocalUsageCache(accountId: string, result: CodexUsageResult) {
  accountId = `${currentWorkspaceId()}:${accountId}`
  if (localCacheTtlMs <= 0) return
  if (!localUsageCache.has(accountId) && localUsageCache.size >= maximumLocalCacheEntries) {
    const oldest = localUsageCache.keys().next().value
    if (oldest !== undefined) localUsageCache.delete(oldest)
  }
  localUsageCache.set(accountId, { result, expiresAt: now() + localCacheTtlMs })
}

function clearLocalUsageCache(accountId?: string) {
  localCacheGeneration += 1
  if (accountId) {
    accountId = `${currentWorkspaceId()}:${accountId}`
    localUsageCache.delete(accountId)
    usageInflight.delete(accountId)
    return
  }
  localUsageCache.clear()
  usageInflight.clear()
}

function getUsageUrl() {
  return process.env.CODEX_USAGE_URL || DEFAULT_USAGE_URL
}

function getRedis(): UsageRedis {
  if (redisClient) return redisClient
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error("Upstash Redis is not configured.")
  const client: UsageRedis = new Redis({ url, token })
  redisClient = client
  return client
}

function cacheKey(accountId: string) {
  return `${CACHE_PREFIX}:${currentWorkspaceId()}:${accountId}`
}

function lockKey(accountId: string) {
  return `${CACHE_PREFIX}:lock:${currentWorkspaceId()}:${accountId}`
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

  const resetCredits = objectValue(data?.rate_limit_reset_credits)
  const available = numberValue(resetCredits?.available_count)
  if (available !== undefined) snapshot.unusedResetCredits = Math.max(0, Math.floor(available))

  return snapshot
}

async function fetchCodexUsage(account: ProviderApiKey, fetchImpl: typeof fetch): Promise<CodexUsageSnapshot> {
  const headers = new Headers({
    authorization: `Bearer ${account.key}`,
    accept: "application/json",
  })
  if (account.accountId) headers.set("chatgpt-account-id", account.accountId)
  const response = await fetchImpl(getUsageUrl(), { method: "GET", headers, cache: "no-store" })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200)
    throw Object.assign(new Error(`Codex usage request failed (${response.status})${detail ? `: ${detail}` : ""}`), { status: response.status })
  }
  return parseCodexUsagePayload(await response.json())
}

function emptyResult(error?: string): CodexUsageResult {
  return { fiveHour: null, weekly: null, fetchedAt: null, stale: false, ...(error ? { error } : {}) }
}

function resultFromCache(cached: CachedCodexUsage, stale: boolean): CodexUsageResult {
  return {
    fiveHour: cached.snapshot?.fiveHour || null,
    weekly: cached.snapshot?.weekly || null,
    fetchedAt: cached.fetchedAt,
    stale,
    ...(cached.error ? { error: cached.error } : {}),
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
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  }
}

async function acquireRefreshLock(redis: UsageRedis, accountId: string) {
  const result = await redis.set(lockKey(accountId), "1", { ex: REFRESH_LOCK_TTL_SECONDS, nx: true })
  return result === "OK"
}

function isUnauthorized(error: unknown) {
  return objectValue(error)?.status === 401 || (error instanceof Error && /\(401\)/.test(error.message))
}

async function loadCodexUsageForAccount(
  account: ProviderApiKey,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexUsageResult> {
  let redis: UsageRedis
  try {
    redis = getRedis()
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : "Usage cache unavailable.")
  }

  const key = cacheKey(account.id)
  let cached: CachedCodexUsage | undefined
  try {
    cached = readCache(await redis.get(key))
    if (cached && now() < cached.retryAt) return resultFromCache(cached, Boolean(cached.error))
    if (!(await acquireRefreshLock(redis, account.id))) {
      const concurrent = readCache(await redis.get(key))
      return concurrent ? resultFromCache(concurrent, Boolean(concurrent.error) || now() >= concurrent.retryAt) : emptyResult("Usage refresh in progress.")
    }
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : "Usage cache unavailable.")
  }

  try {
    let current = await refreshCodexAccount(account)
    let snapshot: CodexUsageSnapshot
    try {
      snapshot = await fetchCodexUsage(current, fetchImpl)
    } catch (error) {
      if (!isUnauthorized(error) || !current.refreshToken) throw error
      current = await refreshCodexAccount(current, true)
      snapshot = await fetchCodexUsage(current, fetchImpl)
    }
    const fetchedAt = new Date(now()).toISOString()
    const record: CachedCodexUsage = { snapshot, fetchedAt, retryAt: now() + CODEX_USAGE_CACHE_TTL_SECONDS * 1000 }
    await redis.set(key, record, { ex: CACHE_RETENTION_SECONDS })
    return resultFromCache(record, false)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex usage unavailable."
    const record: CachedCodexUsage = {
      snapshot: cached?.snapshot || null,
      fetchedAt: cached?.fetchedAt || null,
      retryAt: now() + CODEX_USAGE_CACHE_TTL_SECONDS * 1000,
      error: message,
    }
    try {
      await redis.set(key, record, { ex: CACHE_RETENTION_SECONDS })
    } catch {}
    return resultFromCache(record, Boolean(cached?.snapshot))
  }
}

export async function getCodexUsageForAccount(
  account: ProviderApiKey,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexUsageResult> {
  const localKey = `${currentWorkspaceId()}:${account.id}`
  const cached = localUsageCache.get(localKey)
  if (cached && cached.expiresAt > now()) return cached.result
  if (cached) localUsageCache.delete(localKey)

  const existing = usageInflight.get(localKey)
  if (existing) return existing
  const generation = localCacheGeneration
  const promise = loadCodexUsageForAccount(account, fetchImpl).then((result) => {
    if (generation === localCacheGeneration) setLocalUsageCache(account.id, result)
    return result
  }).finally(() => {
    if (usageInflight.get(localKey) === promise) usageInflight.delete(localKey)
  })
  usageInflight.set(localKey, promise)
  return promise
}

export function setCodexUsageRedisForTests(redis?: UsageRedis) {
  redisClient = redis
  clearLocalUsageCache()
}

export function setCodexUsageClockForTests(clock?: () => number) {
  now = clock || (() => Date.now())
  clearLocalUsageCache()
}

export async function invalidateCodexUsageCache(accountId: string) {
  clearLocalUsageCache(accountId)
  try {
    const redis = getRedis()
    if (redis.del) await redis.del(cacheKey(accountId))
  } catch {}
}
