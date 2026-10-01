import { setBudgetBypassAutoDeactivateAtWindowEnd, setBudgetBypassEnabled } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const hasEnabled = typeof body?.enabled === "boolean"
  const hasAutoDeactivate = typeof body?.autoDeactivateAtWindowEnd === "boolean"
  if (!hasEnabled && !hasAutoDeactivate) return jsonError("enabled or autoDeactivateAtWindowEnd must be boolean.", 400)
  try {
    const result = hasEnabled
      ? await setBudgetBypassEnabled(body!.enabled as boolean, { autoDeactivateAtWindowEnd: body?.autoDeactivateAtWindowEnd === true })
      : { window: await setBudgetBypassAutoDeactivateAtWindowEnd(body!.autoDeactivateAtWindowEnd as boolean), session: null }
    recordLog("admin.unlimited.mode.updated", { enabled: result.window.bypassLimits, autoDeactivateAtWindowEnd: result.window.bypassAutoDeactivateAtWindowEnd === true }, { level: "info" })
    return Response.json(result)
  } catch (error) {
    recordLog("admin.unlimited.mode.update.failed", { enabled: hasEnabled ? body!.enabled as boolean : "unchanged", autoDeactivateAtWindowEnd: hasAutoDeactivate ? body!.autoDeactivateAtWindowEnd as boolean : "unchanged", error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Unlimited Mode.", error instanceof Error && error.message === "Unlimited Mode is not active." ? 400 : 500)
  }
}
