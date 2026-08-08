import { requireAdmin } from "@/lib/auth"
import { invalidateCodexCliProxySync, syncCodexAccountsToCliProxy } from "@/lib/cliproxy-codex"
import { listCodexAccounts } from "@/lib/codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteProviderApiKey, upsertProviderApiKey } from "@/lib/store"


export async function PATCH(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const { accountId } = await context.params
  const body = await request.json().catch(() => null) as { enabled?: unknown; name?: unknown; rpmLimit?: unknown; maxConcurrency?: unknown } | null

  try {
    const result = await listCodexAccounts()
    const account = result.accounts.find((entry) => entry.id === accountId)
    if (!result.provider || !account) return jsonError("Codex account not found.", 404)
    const enabled = body?.enabled === undefined ? account.enabled : body.enabled
    if (typeof enabled !== "boolean") throw new Error("Enabled value must be boolean.")
    const name = body?.name === undefined ? account.name : body.name
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new Error("Account name must be between 1 and 80 characters.")
    const positiveInteger = (value: unknown, fallback: number | undefined, label: string) => {
      if (value === undefined) return fallback
      const parsed = typeof value === "number" ? value : Number(value)
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive whole number.`)
      return parsed
    }
    await upsertProviderApiKey(result.provider.id, {
      originalId: account.id,
      name: name.trim(),
      key: "__unchanged__",
      enabled,
      rpmLimit: positiveInteger(body?.rpmLimit, account.rpmLimit, "RPM limit"),
      maxConcurrency: positiveInteger(body?.maxConcurrency, account.maxConcurrency, "Maximum concurrency"),
      priority: account.priority,
    })
    invalidateCodexCliProxySync()
    await syncCodexAccountsToCliProxy({ force: true })
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
    await deleteProviderApiKey(result.provider.id, accountId)
    invalidateCodexCliProxySync()
    await syncCodexAccountsToCliProxy({ force: true })
    writeLog("info", "admin", "Codex account deleted", { accountId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Codex account delete failed", { accountId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete Codex account.", 502)
  }
}
