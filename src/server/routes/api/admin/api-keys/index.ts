import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { ApiKeyConflictError, createApiKey } from "@/server/store"

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const name = String(body.name || "").trim()
  if (!name) return jsonError("API key name is required.", 400)
  if (name.length > 80) return jsonError("API key name must be 80 characters or fewer.", 400)
  const customKey = Object.hasOwn(body, "key") ? body.key : undefined
  if (customKey !== undefined && typeof customKey !== "string") return jsonError("API key value is required.", 400)

  try {
    const apiKey = await createApiKey(name, customKey as string | undefined)
    recordLog("admin.gateway.api.key.created", {}, { level: "info" })
    return Response.json({ ok: true, apiKey })
  } catch (error) {
    recordLog("admin.gateway.api.key.create.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to create API key.", error instanceof ApiKeyConflictError ? 409 : 400)
  }
}
