import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteProviderApiKey } from "@/lib/store"


export async function DELETE(_request: Request, context: { params: Promise<{ providerId: string; apiKeyId: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId, apiKeyId } = await context.params
  try {
    await deleteProviderApiKey(providerId, apiKeyId)
    writeLog("info", "admin", "Provider API key deleted", { providerId, apiKeyId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Provider API key delete failed", { providerId, apiKeyId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete provider API key.", 400)
  }
}