import { Redis } from "@upstash/redis"

import { invalidateCodexUsageCache } from "@/lib/codex-usage"
import { refreshCodexAccount } from "@/lib/codex"
import { writeLog } from "@/lib/logger"
import type { ProviderApiKey } from "@/lib/types"
import { currentWorkspaceId } from "@/lib/workspace-context"

const consumeUrl = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
const locks = new Set<string>()
let redisClient: Redis | undefined

function redis() {
  if (redisClient) return redisClient
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return undefined
  redisClient = new Redis({ url, token })
  return redisClient
}

async function acquire(accountId: string) {
  accountId = `${currentWorkspaceId()}:${accountId}`
  const client = redis()
  if (client) return (await client.set(`rawroute:codex-reset-lock:${accountId}`, "1", { nx: true, ex: 60 })) === "OK"
  if (locks.has(accountId)) return false
  locks.add(accountId)
  return true
}

async function release(accountId: string) {
  accountId = `${currentWorkspaceId()}:${accountId}`
  locks.delete(accountId)
  const client = redis()
  if (client) await client.del(`rawroute:codex-reset-lock:${accountId}`).catch(() => undefined)
}

function numberValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

export async function redeemCodexReset(account: ProviderApiKey, confirmation: string, fetchImpl: typeof fetch = fetch) {
  if (account.credentialKind !== "codex-oauth") throw new Error("Codex reset credits are only available for OAuth accounts.")
  if (!confirmation.toLowerCase().includes("use my codex reset")) throw new Error("Confirmation must contain: use my codex reset")
  if (!(await acquire(account.id))) throw new Error("A reset redemption is already in progress for this account.")
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
  } finally { await release(account.id) }
}
