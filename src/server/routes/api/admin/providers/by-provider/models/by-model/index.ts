import { CliProxyProviderSyncError, syncNonCodexProviderProjection } from "@/lib/cliproxy/provider-sync"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { deleteModel, getProvider } from "@/server/store"

export async function DELETE(_request: Request, params: { providerId: string; modelId: string }) {
  const { providerId, modelId } = params
  try {
    await deleteModel(providerId, decodeURIComponent(modelId))
    const provider = await getProvider(providerId)
    if (provider?.prefix !== "codex") await syncNonCodexProviderProjection(providerId)
    recordLog("admin.model.deleted", { providerId, modelId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.model.delete.failed", { providerId, modelId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete model.", error instanceof CliProxyProviderSyncError ? error.status : 400)
  }
}
