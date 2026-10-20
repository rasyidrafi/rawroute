import { validateBudgetModelIds } from "../../../../../budget-models"
import { getBudgetBeyondLimitsSettings, setBudgetBeyondLimitsSettings } from "../../../../../analytics"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../logging"

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (typeof body?.enabled !== "boolean" || !Array.isArray(body.modelIds) || !body.modelIds.every((id) => typeof id === "string")) {
    return jsonError("enabled must be boolean and modelIds must be an array of strings.", 400)
  }
  const modelIds = [...new Set(body.modelIds.map((id) => id.trim()).filter(Boolean))]
  if (modelIds.length > 100) return jsonError("Choose at most 100 models.", 400)
  try {
    const current = await getBudgetBeyondLimitsSettings()
    if (!await validateBudgetModelIds(modelIds, current.modelIds)) return jsonError("One or more selected models are unavailable.", 400)
    const settings = await setBudgetBeyondLimitsSettings({ enabled: body.enabled, modelIds })
    recordLog("admin.beyond.limits.settings.updated", { enabled: settings.enabled, modelCount: settings.modelIds.length }, { level: "info" })
    return Response.json({ settings })
  } catch (error) {
    recordLog("admin.beyond.limits.settings.update.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Beyond Limits settings.", 400)
  }
}
