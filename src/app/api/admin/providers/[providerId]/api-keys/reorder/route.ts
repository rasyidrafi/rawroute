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
    await reorderProviderApiKeys(providerId, body.orderedIds)
    const provider = await getProvider(providerId)
    if (provider?.prefix === "codex") {
      const { accounts } = await listCodexAccounts()
      await Promise.all(accounts.map((account, index) => setCliProxyCodexAccountPriority(account, accounts.length - index)))
    } else {
      await syncNonCodexProviderProjection(providerId)
    }
    writeLog("info", "admin", "Provider API keys reordered", { providerId, count: body.orderedIds.length })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Provider API key reorder failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to reorder provider API keys.", 502)
  }
}
