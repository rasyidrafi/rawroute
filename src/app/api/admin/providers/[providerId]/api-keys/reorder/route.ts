import { requireAdmin } from "@/lib/auth"
import { setCliProxyCodexAccountPriority } from "@/lib/cliproxy-codex"
import { listCodexAccounts } from "@/lib/codex"
import { syncNonCodexProviderProjection } from "@/lib/cliproxy-provider-sync"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { getProvider, reorderProviderApiKeys } from "@/lib/store"


export async function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const { providerId } = await context.params
  const body = await request.json().catch(() => null) as { orderedIds?: unknown } | null
  if (!body || !Array.isArray(body.orderedIds) || !body.orderedIds.every((id) => typeof id === "string")) {
    return jsonError("An ordered API key ID list is required.", 400)
  }
  try {
    const provider = await getProvider(providerId)
    if (provider?.prefix === "codex") {
      const { accounts } = await listCodexAccounts()
      const byId = new Map(accounts.map((account) => [account.id, account]))
      if (accounts.length !== body.orderedIds.length || body.orderedIds.some((id) => !byId.has(id))) throw new Error("Codex account order is out of date.")
      const mapped = body.orderedIds.flatMap((id, index) => {
        const account = byId.get(id)!
        return account.credentialKind === "codex-cli-proxy" ? [{ account, priority: accounts.length - index - 1 }] : []
      })
      const changed: typeof mapped = []
      try {
        for (const entry of mapped) {
          await setCliProxyCodexAccountPriority(entry.account, entry.priority)
          changed.push(entry)
        }
        await reorderProviderApiKeys(providerId, body.orderedIds)
      } catch (error) {
        await Promise.allSettled(changed.map(({ account }) => setCliProxyCodexAccountPriority(account, account.priority ?? 0)))
        throw error
      }
    } else {
      await reorderProviderApiKeys(providerId, body.orderedIds)
      await syncNonCodexProviderProjection(providerId)
    }
    writeLog("info", "admin", "Provider API keys reordered", { providerId, count: body.orderedIds.length })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Provider API key reorder failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to reorder provider API keys.", 502)
  }
}
