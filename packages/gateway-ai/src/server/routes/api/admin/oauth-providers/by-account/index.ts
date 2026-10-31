import { deleteCodexCredential, updateCodexCredential } from "../../../../../codex-credentials"
import { scheduleCodexModelRefresh } from "../../../../../codex/model-refresh"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../logging"
import { getProviderApiKey, listProviders } from "../../../../../store"
import { completeCodexResetAccountRemoval, releaseCodexResetAccountRemoval, reserveCodexResetAccountRemoval } from "../../../../../codex/reset"

/** Resolve a workspace-owned OAuth account for local account management. */
async function resolveCodexAccount(accountId: string) {
  const provider = (await listProviders()).find((entry) => entry.prefix === "codex")
  if (!provider) return undefined
  const account = await getProviderApiKey(provider.id, accountId)
  return account?.credentialKind === "codex-oauth" ? { provider, account } : undefined
}

export async function PATCH(request: Request, params: { accountId: string }) {
  const { accountId } = params
  const body = await request.json().catch(() => null) as { enabled?: unknown; name?: unknown } | null

  try {
    const resolved = await resolveCodexAccount(accountId)
    if (!resolved) return jsonError("Codex account not found.", 404)
    const { provider, account } = resolved
    const enabled = body?.enabled === undefined ? account.enabled : body.enabled
    if (typeof enabled !== "boolean") throw new Error("Enabled value must be boolean.")
    const name = body?.name === undefined ? account.name : body.name
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new Error("Account name must be between 1 and 80 characters.")
    const removalToken = !enabled && account.enabled ? await reserveCodexResetAccountRemoval(account) : undefined
    try {
      await updateCodexCredential(provider.id, accountId, { name: name.trim(), enabled })
    } catch (error) {
      if (removalToken) await releaseCodexResetAccountRemoval(account, removalToken)
      throw error
    }
    if (removalToken) await releaseCodexResetAccountRemoval(account, removalToken)
    recordLog("admin.codex.account.updated", { accountId }, { level: "info" })
    scheduleCodexModelRefresh(true)
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.codex.account.update.failed", { accountId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Codex account.", 502)
  }
}

export async function DELETE(_request: Request, params: { accountId: string }) {
  const { accountId } = params
  try {
    const resolved = await resolveCodexAccount(accountId)
    if (!resolved) return jsonError("Codex account not found.", 404)
    const { provider } = resolved
    const removalToken = await reserveCodexResetAccountRemoval(resolved.account)
    try {
      // The account record and session material are removed together, and an
      // in-flight refresh cannot resurrect them.
      await deleteCodexCredential(provider.id, accountId)
      await completeCodexResetAccountRemoval(resolved.account, removalToken)
    } catch (error) {
      await releaseCodexResetAccountRemoval(resolved.account, removalToken)
      throw error
    }
    recordLog("admin.codex.account.deleted", { accountId }, { level: "info" })
    scheduleCodexModelRefresh(true)
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.codex.account.delete.failed", { accountId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete Codex account.", 502)
  }
}
