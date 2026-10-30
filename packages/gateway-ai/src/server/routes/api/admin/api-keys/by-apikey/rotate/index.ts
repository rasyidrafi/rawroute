import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../logging"
import { ApiKeyConflictError, rotateApiKey } from "../../../../../../store"

export async function POST(request: Request, params: { apiKeyId: string }) {
  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Invalid request.", 400)
  const input = body as Record<string, unknown>
  const customKey = Object.hasOwn(input, "key") ? input.key : undefined
  if (customKey !== undefined && typeof customKey !== "string") return jsonError("API key value is required.", 400)

  const { apiKeyId } = params
  try {
    const apiKey = await rotateApiKey(apiKeyId, customKey as string | undefined)
    recordLog("admin.gateway.api.key.rotated", { apiKeyId }, { level: "info" })
    return Response.json({ ok: true, apiKey })
  } catch (error) {
    recordLog("admin.gateway.api.key.rotation.failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to rotate API key.", error instanceof ApiKeyConflictError ? 409 : 400)
  }
}
