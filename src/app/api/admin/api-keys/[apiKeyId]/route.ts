import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteApiKey } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function DELETE(_request: Request, context: { params: Promise<{ apiKeyId: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { apiKeyId } = await context.params
  try {
    await deleteApiKey(apiKeyId)
    writeLog("info", "admin", "Gateway API key deleted", { apiKeyId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Gateway API key delete failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete API key.", 400)
  }
}