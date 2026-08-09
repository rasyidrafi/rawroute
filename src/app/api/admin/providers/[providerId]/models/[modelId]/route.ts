import { requireAdmin } from "@/lib/auth"
import { CliProxyProviderSyncError, syncNonCodexProviderProjection } from "@/lib/cliproxy-provider-sync"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteModel, getProvider } from "@/lib/store"


export async function DELETE(_request: Request, context: { params: Promise<{ providerId: string; modelId: string }> }) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId, modelId } = await context.params
  try {
    await deleteModel(providerId, decodeURIComponent(modelId))
    const provider = await getProvider(providerId)
    if (provider?.prefix !== "codex") await syncNonCodexProviderProjection(providerId)
    writeLog("info", "admin", "Model deleted", { providerId, modelId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Model delete failed", { providerId, modelId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete model.", error instanceof CliProxyProviderSyncError ? error.status : 400)
  }
}
