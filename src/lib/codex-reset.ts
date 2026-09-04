import { invalidateCodexUsageCache, parseUnusedCodexResetCredits } from "@/lib/codex-usage"
import { cliProxyCodexApiCall } from "@/lib/cliproxy-codex"
import { getLocalRedis } from "@/lib/local-redis"
import { writeLog } from "@/lib/logger"
import type { ProviderApiKey } from "@/lib/types"
import { currentWorkspaceId } from "@/lib/workspace-context"

const consumeUrl = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
const locks = new Map<string, string>()
let redisClient: ReturnType<typeof getLocalRedis> | undefined

type ResetLock = { key: string; token: string; redis: boolean }

const releaseLockScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

function redis() {
  return redisClient ||= getLocalRedis()
}

async function acquire(accountId: string): Promise<ResetLock | undefined> {
  const key = `rawroute:codex-reset-lock:${currentWorkspaceId()}:${accountId}`
  const token = crypto.randomUUID()
  const client = redis()
  if (client) {
    const acquired = (await client.set(key, token, "EX", 60, "NX")) === "OK"
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
  if (client) await client.eval(releaseLockScript, 1, lock.key, lock.token).catch(() => undefined)
}

function numberValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

export async function redeemCodexReset(account: ProviderApiKey, confirmation: string) {
  if (account.credentialKind !== "codex-cli-proxy") throw new Error("Codex reset credits are only available for CLIProxy-managed OAuth accounts.")
  if (!confirmation.toLowerCase().includes("use my codex reset")) throw new Error("Confirmation must contain: use my codex reset")
  const lock = await acquire(account.id)
  if (!lock) throw new Error("A reset redemption is already in progress for this account.")
  const redeemRequestId = crypto.randomUUID()
  try {
    const headers: Record<string, string> = { authorization: "Bearer $TOKEN$", accept: "application/json" }
    if (account.accountId) headers["chatgpt-account-id"] = account.accountId
    if (process.env.CODEX_FEDRAMP === "true") headers["chatgpt-federated"] = "true"
    const usageResponse = await cliProxyCodexApiCall(account, { method: "GET", url: process.env.CODEX_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage", headers })
    if (usageResponse.status < 200 || usageResponse.status >= 300) throw new Error(`Codex usage request failed (${usageResponse.status})`)
    const usage = objectValue(JSON.parse(usageResponse.body) as unknown)
    if ((parseUnusedCodexResetCredits(usage) ?? 0) < 1) throw new Error("No unused Codex reset credits are available.")
    const rateLimit = objectValue(usage?.rate_limit) || objectValue(usage?.rate_limits)
    const weekly = objectValue(rateLimit?.secondary_window)
    const weeklyUsed = numberValue(weekly?.used_percent ?? weekly?.percent_used)
    if (weeklyUsed < 100) throw new Error("The weekly Codex quota must be exhausted before redeeming a reset credit.")
    const response = await cliProxyCodexApiCall(account, { method: "POST", url: consumeUrl, headers: { ...headers, "content-type": "application/json" }, data: JSON.stringify({ redeem_request_id: redeemRequestId }) })
    if (response.status < 200 || response.status >= 300) throw new Error(`Codex reset redemption failed (${response.status})`)
    await invalidateCodexUsageCache(account.id)
    writeLog("info", "admin", "Codex reset credit redeemed", { accountId: account.id, redeemRequestId })
    return { ok: true, redeemRequestId, status: response.status, message: "Codex reset credit redeemed." }
  } finally { await release(lock) }
}
