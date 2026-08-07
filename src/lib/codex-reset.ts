import { Redis } from "@upstash/redis"

import { invalidateCodexUsageCache } from "@/lib/codex-usage"
import { refreshCodexAccount } from "@/lib/codex"
import { writeLog } from "@/lib/logger"
import type { ProviderApiKey } from "@/lib/types"
import { currentWorkspaceId } from "@/lib/workspace-context"

const consumeUrl = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
const locks = new Map<string, string>()
let redisClient: Redis | undefined

type ResetLock = { key: string; token: string; redis: boolean }

const releaseLockScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

function redis() {
  if (redisClient) return redisClient
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return undefined
  redisClient = new Redis({ url, token })
  return redisClient
}

async function acquire(accountId: string): Promise<ResetLock | undefined> {
  const key = `rawroute:codex-reset-lock:${currentWorkspaceId()}:${accountId}`
  const token = crypto.randomUUID()
  const client = redis()
  if (client) {
    const acquired = (await client.set(key, token, { nx: true, ex: 60 })) === "OK"
    return acquired ? { key, token, redis: true } : undefined
  }
  if (locks.has(key)) return undefined
  locks.set(key, token)
  return { key, token, redis: false }
}

async function release(lock: ResetLock) {
  if (!lock.redis) {
    if (locks.get(lock.key) === lock.token) locks.delete(lock.key)
    return
  }
  const client = redis()
  if (client) await client.eval(releaseLockScript, [lock.key], [lock.token]).catch(() => undefined)
}

function numberValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

export async function redeemCodexReset(account: ProviderApiKey, confirmation: string, fetchImpl: typeof fetch = fetch) {
  if (account.credentialKind !== "codex-oauth") throw new Error("Codex reset credits are only available for OAuth accounts.")
  if (!confirmation.toLowerCase().includes("use my codex reset")) throw new Error("Confirmation must contain: use my codex reset")
  const lock = await acquire(account.id)
  if (!lock) throw new Error("A reset redemption is already in progress for this account.")
  const redeemRequestId = crypto.randomUUID()
  try {
    const current = await refreshCodexAccount(account, true)
    const headers = new Headers({ authorization: `Bearer ${current.key}`, accept: "application/json" })
    if (current.accountId) headers.set("chatgpt-account-id", current.accountId)
    if (process.env.CODEX_FEDRAMP === "true") headers.set("chatgpt-federated", "true")
    const usageResponse = await fetchImpl(process.env.CODEX_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage", { headers, cache: "no-store" })
    if (!usageResponse.ok) throw new Error(`Codex usage request failed (${usageResponse.status})`)
    const usage = objectValue(await usageResponse.json())
    const credits = objectValue(usage?.rate_limit_reset_credits)
    if (numberValue(credits?.available_count) < 1) throw new Error("No unused Codex reset credits are available.")
    const rateLimit = objectValue(usage?.rate_limit) || objectValue(usage?.rate_limits)
    const weekly = objectValue(rateLimit?.secondary_window)
    const weeklyUsed = numberValue(weekly?.used_percent ?? weekly?.percent_used)
    if (weeklyUsed < 100) throw new Error("The weekly Codex quota must be exhausted before redeeming a reset credit.")
    const response = await fetchImpl(consumeUrl, { method: "POST", headers: new Headers({ ...Object.fromEntries(headers.entries()), "content-type": "application/json" }), body: JSON.stringify({ redeem_request_id: redeemRequestId }), cache: "no-store" })
    if (!response.ok) throw new Error(`Codex reset redemption failed (${response.status})`)
    await invalidateCodexUsageCache(current.id)
    writeLog("info", "admin", "Codex reset credit redeemed", { accountId: current.id, redeemRequestId })
    return { ok: true, redeemRequestId, status: response.status, message: "Codex reset credit redeemed." }
  } finally { await release(lock) }
}
