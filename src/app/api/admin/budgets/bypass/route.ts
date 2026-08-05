import { requireAdmin } from "@/lib/auth"
import { setBudgetBypassEnabled } from "@/lib/analytics"
import { jsonError } from "@/lib/http"


export async function PATCH(request: Request) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (typeof body?.enabled !== "boolean") return jsonError("enabled must be boolean.", 400)
  try { return Response.json(await setBudgetBypassEnabled(body.enabled)) }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Unable to update Unlimited Mode.", 500) }
}
