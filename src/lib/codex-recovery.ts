import { cliProxyCodexApiCall, cliproxyManagement, listCliProxyCodexAuthFiles } from "@/lib/cliproxy-codex"
import { localRedisSetIfAbsent } from "@/lib/local-redis"
import { writeLog } from "@/lib/logger"
import { listProviderApiKeys } from "@/lib/store"
import { currentWorkspaceId } from "@/lib/workspace-context"

type UsagePayload = {
  rate_limit?: { allowed?: boolean; limit_reached?: boolean }
  model_usage?: Record<string, { available?: boolean }>
  additional_rate_limits?: Array<{ normal_model_slug?: string; rate_limit?: { allowed?: boolean; limit_reached?: boolean } }>
}

export function quotaAllowsProbe(payload: UsagePayload, model: string) {
  const limit = payload.rate_limit
  if (limit?.allowed !== true || limit.limit_reached !== false) return false
  if (payload.model_usage?.[model]?.available === false) return false
  return !payload.additional_rate_limits?.some((entry) => entry.normal_model_slug === model &&
    (entry.rate_limit?.allowed === false || entry.rate_limit?.limit_reached === true))
}

/** Called only by the single half-open combo request. Never infer health from cached percentages. */
export async function recoverCodexQuota(providerId: string, model: string): Promise<boolean> {
  try {
    const [accounts, files] = await Promise.all([listProviderApiKeys(providerId), listCliProxyCodexAuthFiles()])
    for (const account of accounts) {
      if (!account.enabled || account.credentialKind !== "codex-cli-proxy") continue
      const file = files.find((entry) => entry.name === account.cliProxyAuthFile)
      if (!file || file.disabled || !file.authIndex || !file.statusMessage?.includes("usage_limit_reached")) continue
      // Account lock spans models and gateway instances. Keep it after completion
      // so an inconsistent usage endpoint cannot trigger repeated quota resets.
      const lock = `rawroute:codex-recovery:v1:${currentWorkspaceId()}:${file.authIndex}`
      if (await localRedisSetIfAbsent(lock, "1", 300_000) !== true) continue
      const headers: Record<string, string> = { authorization: "Bearer $TOKEN$", accept: "application/json" }
      const accountId = file.accountId || account.accountId
      if (accountId) headers["chatgpt-account-id"] = accountId
      const usage = await cliProxyCodexApiCall({ ...account, cliProxyAuthIndex: file.authIndex }, {
        method: "GET", url: process.env.CODEX_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage", headers,
      })
      if (usage.status !== 200 || !quotaAllowsProbe(JSON.parse(usage.body), model)) continue
      const reset = await cliproxyManagement("/v0/management/reset-quota", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_index: file.authIndex }),
        signal: AbortSignal.timeout(5_000),
      })
      void reset.body?.cancel().catch(() => undefined)
      if (!reset.ok) {
        writeLog("warn", "gateway", "Codex quota recovery unavailable", { status: reset.status, providerId, model })
        continue
      }
      writeLog("info", "gateway", "Codex quota available; allowing inference probe", { providerId, model, accountId: account.id })
      return true
    }
  } catch {
    writeLog("warn", "gateway", "Codex quota recovery check failed", { providerId, model })
  }
  return false
}
