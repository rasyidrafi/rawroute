import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { reorderProviderApiKeys } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const { providerId } = await context.params
  const body = await request.json().catch(() => null) as { orderedIds?: unknown } | null
  if (!body || !Array.isArray(body.orderedIds) || !body.orderedIds.every((id) => typeof id === "string")) {
    return jsonError("An ordered API key ID list is required.", 400)
  }
  try {
    await reorderProviderApiKeys(providerId, body.orderedIds)
    return Response.json({ ok: true })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to reorder provider API keys.", 400)
  }
}
