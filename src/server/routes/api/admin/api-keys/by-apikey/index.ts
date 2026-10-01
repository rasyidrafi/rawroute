import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { deleteApiKey, updateApiKeyName } from "@/server/store"

export async function PATCH(request: Request, params: { apiKeyId: string }) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name) return jsonError("API key name is required.", 400)
  if (name.length > 80) return jsonError("API key name must be 80 characters or fewer.", 400)
  const { apiKeyId } = params
  try {
    const apiKey = await updateApiKeyName(apiKeyId, name)
    recordLog("admin.gateway.api.key.renamed", { apiKeyId }, { level: "info" })
    return Response.json({ ok: true, apiKey })
  } catch (error) {
    recordLog("admin.gateway.api.key.rename.failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update API key.", 400)
  }
}

export async function DELETE(_request: Request, params: { apiKeyId: string }) {
  const { apiKeyId } = params
  try {
    await deleteApiKey(apiKeyId)
    recordLog("admin.gateway.api.key.deleted", { apiKeyId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.gateway.api.key.delete.failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete API key.", 400)
  }
}
