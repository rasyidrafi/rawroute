import { requireAdmin } from "@/lib/auth"
import { setBudgetBypassEnabled } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"


export async function PATCH(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (typeof body?.enabled !== "boolean") return jsonError("enabled must be boolean.", 400)
  try {
    const result = await setBudgetBypassEnabled(body.enabled)
    writeLog("info", "admin", "Unlimited Mode updated", { enabled: body.enabled })
    return Response.json(result)
  } catch (error) {
    writeLog("error", "admin", "Unlimited Mode update failed", { enabled: body.enabled, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Unlimited Mode.", 500)
  }
}
