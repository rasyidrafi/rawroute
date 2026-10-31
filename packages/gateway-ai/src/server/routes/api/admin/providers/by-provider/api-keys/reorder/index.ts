import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../../logging"
import { getProvider, listProviderApiKeys, reorderProviderApiKeys } from "../../../../../../../store"

/** Serialize Codex account ordering against the latest saved account list. */
const codexReorderLocks = new Map<string, Promise<unknown>>()

function withCodexReorderLock<T>(providerId: string, task: () => Promise<T>): Promise<T> {
  const previous = codexReorderLocks.get(providerId)
  const promise = (previous ?? Promise.resolve()).then(task, task)
  codexReorderLocks.set(providerId, promise)
  promise.catch(() => undefined).finally(() => {
    if (codexReorderLocks.get(providerId) === promise) codexReorderLocks.delete(providerId)
  })
  return promise
}

async function reorderCodexAccounts(providerId: string, orderedIds: string[]) {
  await withCodexReorderLock(providerId, async () => {
    const accounts = await listProviderApiKeys(providerId)
    if (accounts.some((account) => account.credentialKind !== "codex-oauth")) {
      throw new Error("Reconnect Codex accounts before changing their order.")
    }
    if (accounts.length !== orderedIds.length || orderedIds.some((id) => !accounts.some((account) => account.id === id))) {
      throw new Error("Codex account order is out of date.")
    }
    await reorderProviderApiKeys(providerId, orderedIds)
  })
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
      await reorderCodexAccounts(providerId, orderedIds)
    } else {
      await reorderProviderApiKeys(providerId, orderedIds)
    }
    recordLog("admin.provider.api.keys.reordered", { providerId, count: orderedIds.length }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.provider.api.key.reorder.failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to reorder provider API keys.", 400)
  }
}
