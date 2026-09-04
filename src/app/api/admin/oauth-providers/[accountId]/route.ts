import { requireAdmin } from "@/lib/auth"
import { deleteCliProxyCodexAccount, setCliProxyCodexAccountEnabled } from "@/lib/cliproxy-codex"
import { listCodexAccounts } from "@/lib/codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteProviderApiKey, upsertProviderApiKey } from "@/lib/store"


export async function PATCH(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const { accountId } = await context.params
  const body = await request.json().catch(() => null) as { enabled?: unknown; name?: unknown } | null

  try {
    const result = await listCodexAccounts()
    const account = result.accounts.find((entry) => entry.id === accountId)
    if (!result.provider || !account) return jsonError("Codex account not found.", 404)
    if (account.credentialKind !== "codex-cli-proxy") throw new Error("This legacy Codex credential is not mapped to CLIProxy. Remove it and reconnect the account.")
    const enabled = body?.enabled === undefined ? account.enabled : body.enabled
    if (typeof enabled !== "boolean") throw new Error("Enabled value must be boolean.")
    const name = body?.name === undefined ? account.name : body.name
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new Error("Account name must be between 1 and 80 characters.")
    await setCliProxyCodexAccountEnabled(account, enabled)
    try {
      await upsertProviderApiKey(result.provider.id, {
        originalId: account.id,
        name: name.trim(),
        key: "__unchanged__",
        enabled,
        priority: account.priority,
      })
    } catch (error) {
      await setCliProxyCodexAccountEnabled(account, account.enabled).catch(() => undefined)
      throw error
    }
    writeLog("info", "admin", "Codex account updated", { accountId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Codex account update failed", { accountId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Codex account.", 502)
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ accountId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const { accountId } = await context.params
  try {
    const result = await listCodexAccounts()
    if (!result.provider || !result.accounts.some((entry) => entry.id === accountId)) return jsonError("Codex account not found.", 404)
    const account = result.accounts.find((entry) => entry.id === accountId)
    if (!account) return jsonError("Codex account not found.", 404)
    if (account.credentialKind === "codex-cli-proxy" && account.cliProxyAuthFile) await deleteCliProxyCodexAccount(account)
    await deleteProviderApiKey(result.provider.id, accountId)
    writeLog("info", "admin", "Codex account deleted", { accountId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Codex account delete failed", { accountId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete Codex account.", 502)
  }
}
