import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteApiKey, updateApiKeyName } from "@/lib/store"

export async function PATCH(request: Request, context: { params: Promise<{ apiKeyId: string }> }) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name) return jsonError("API key name is required.", 400)
  if (name.length > 80) return jsonError("API key name must be 80 characters or fewer.", 400)
  const { apiKeyId } = await context.params
  try {
    const apiKey = await updateApiKeyName(apiKeyId, name)
    writeLog("info", "admin", "Gateway API key renamed", { apiKeyId })
    return Response.json({ ok: true, apiKey })
  } catch (error) {
    writeLog("error", "admin", "Gateway API key rename failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update API key.", 400)
  }
}


export async function DELETE(_request: Request, context: { params: Promise<{ apiKeyId: string }> }) {
  try {
    (await requireAdmin())()
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
