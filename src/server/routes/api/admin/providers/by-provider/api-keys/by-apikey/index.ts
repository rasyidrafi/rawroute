import { CliProxyProviderSyncError, syncNonCodexProviderProjection } from "@/lib/cliproxy/provider-sync"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { deleteProviderApiKey, getProvider } from "@/server/store"

export async function DELETE(_request: Request, params: { providerId: string; apiKeyId: string }) {
  const { providerId, apiKeyId } = params
  try {
    const provider = await getProvider(providerId)
    if (provider?.prefix === "codex") throw new Error("Codex accounts are managed by CLIProxy. Use the Codex account flow.")
    await deleteProviderApiKey(providerId, apiKeyId)
    if (provider?.prefix !== "codex") await syncNonCodexProviderProjection(providerId)
    recordLog("admin.provider.api.key.deleted", { providerId, apiKeyId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.provider.api.key.delete.failed", { providerId, apiKeyId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete provider API key.", error instanceof CliProxyProviderSyncError ? error.status : 400)
  }
}
