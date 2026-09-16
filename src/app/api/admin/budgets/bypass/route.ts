import { requireAdmin } from "@/lib/auth"
import { setBudgetBypassAutoDeactivateAtWindowEnd, setBudgetBypassEnabled } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"


export async function PATCH(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const hasEnabled = typeof body?.enabled === "boolean"
  const hasAutoDeactivate = typeof body?.autoDeactivateAtWindowEnd === "boolean"
  if (!hasEnabled && !hasAutoDeactivate) return jsonError("enabled or autoDeactivateAtWindowEnd must be boolean.", 400)
  try {
    const result = hasEnabled
      ? await setBudgetBypassEnabled(body!.enabled as boolean, { autoDeactivateAtWindowEnd: body?.autoDeactivateAtWindowEnd === true })
      : { window: await setBudgetBypassAutoDeactivateAtWindowEnd(body!.autoDeactivateAtWindowEnd as boolean), session: null }
    writeLog("info", "admin", "Unlimited Mode updated", { enabled: result.window.bypassLimits, autoDeactivateAtWindowEnd: result.window.bypassAutoDeactivateAtWindowEnd === true })
    return Response.json(result)
  } catch (error) {
    writeLog("error", "admin", "Unlimited Mode update failed", { enabled: body?.enabled, autoDeactivateAtWindowEnd: body?.autoDeactivateAtWindowEnd, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Unlimited Mode.", error instanceof Error && error.message === "Unlimited Mode is not active." ? 400 : 500)
  }
}
