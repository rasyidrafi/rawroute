import { jsonError } from "@rawroute/observability/contracts/http"
import { getCodexAutoRedeemStatus, requestCodexResetWorkspaceCheck, updateCodexAutoRedeemSettings } from "../../../../../codex/reset"
import { recordLog } from "../../../../../logging"

export async function GET() {
  try {
    return Response.json(await getCodexAutoRedeemStatus())
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load Codex reset settings.", 500)
  }
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Invalid Codex reset settings.", 400)
  if (body.expiryEnabled !== undefined && typeof body.expiryEnabled !== "boolean") return jsonError("Expiry setting must be boolean.", 400)
  if (body.weeklyExhaustionEnabled !== undefined && typeof body.weeklyExhaustionEnabled !== "boolean") return jsonError("Weekly exhaustion setting must be boolean.", 400)
  try {
    const settings = await updateCodexAutoRedeemSettings({
      ...(body.expiryEnabled !== undefined ? { expiryEnabled: body.expiryEnabled } : {}),
      ...(body.weeklyExhaustionEnabled !== undefined ? { weeklyExhaustionEnabled: body.weeklyExhaustionEnabled } : {}),
    })
    recordLog("admin.codex.reset.auto.settings.updated", { ...settings }, { level: "info" })
    await requestCodexResetWorkspaceCheck()
    return Response.json({ settings })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update Codex reset settings.", 500)
  }
}
