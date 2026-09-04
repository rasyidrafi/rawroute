import { requireAdmin } from "@/lib/auth"
import { CliProxyProviderSyncError, syncNonCodexProviderProjection } from "@/lib/cliproxy-provider-sync"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteProviderApiKey, getProvider } from "@/lib/store"


export async function DELETE(_request: Request, context: { params: Promise<{ providerId: string; apiKeyId: string }> }) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId, apiKeyId } = await context.params
  try {
    const provider = await getProvider(providerId)
    if (provider?.prefix === "codex") throw new Error("Codex accounts are managed by CLIProxy. Use the Codex account flow.")
    await deleteProviderApiKey(providerId, apiKeyId)
    if (provider?.prefix !== "codex") await syncNonCodexProviderProjection(providerId)
    writeLog("info", "admin", "Provider API key deleted", { providerId, apiKeyId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Provider API key delete failed", { providerId, apiKeyId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete provider API key.", error instanceof CliProxyProviderSyncError ? error.status : 400)
  }
}
