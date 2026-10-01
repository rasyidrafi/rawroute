import { mapConcurrent } from "@/lib/concurrency"
import { setCliProxyCodexAccountPriority } from "@/lib/codex/cliproxy"
import { listCodexAccounts } from "@/lib/codex/oauth"
import { syncNonCodexProviderProjection } from "@/lib/cliproxy/provider-sync"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { getProvider, reorderProviderApiKeys } from "@/server/store"
import { withManagementMutation } from "@/server/cliproxy/mutations"

async function reorderCodexAccounts(providerId: string, orderedIds: string[]) {
  const { accounts } = await listCodexAccounts()
  const byId = new Map(accounts.map((account) => [account.id, account]))
  if (accounts.length !== orderedIds.length || orderedIds.some((id) => !byId.has(id))) throw new Error("Codex account order is out of date.")
  const mapped = orderedIds.flatMap((id, index) => {
    const account = byId.get(id)!
    return account.credentialKind === "codex-cli-proxy" ? [{ account, priority: accounts.length - index - 1 }] : []
  })
  const changed: typeof mapped = []
  try {
    await mapConcurrent(mapped, 1, async (entry) => {
      await setCliProxyCodexAccountPriority(entry.account, entry.priority)
      changed.push(entry)
    })
    await reorderProviderApiKeys(providerId, orderedIds)
  } catch (error) {
    await Promise.allSettled(changed.map(({ account }) => setCliProxyCodexAccountPriority(account, account.priority ?? 0)))
    throw error
  }
}

export async function POST(request: Request, params: { providerId: string }) {
  const { providerId } = params
  const body = await request.json().catch(() => null) as { orderedIds?: unknown } | null
  if (!body || !Array.isArray(body.orderedIds) || !body.orderedIds.every((id) => typeof id === "string")) {
    return jsonError("An ordered API key ID list is required.", 400)
  }
  const orderedIds = body.orderedIds
  try {
    const provider = await getProvider(providerId)
    if (provider?.prefix === "codex") {
      // Keep the account snapshot, engine writes, database commit and rollback
      // inside one lifecycle boundary, including the nested priority mutations.
      await withManagementMutation(() => reorderCodexAccounts(providerId, orderedIds))
    } else {
      await reorderProviderApiKeys(providerId, orderedIds)
      await syncNonCodexProviderProjection(providerId)
    }
    recordLog("admin.provider.api.keys.reordered", { providerId, count: orderedIds.length }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.provider.api.key.reorder.failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to reorder provider API keys.", 502)
  }
}
