import { validateBudgetModelIds } from "../../../../../budget-models"
import { getBudgetUnlimitedSettings, setBudgetUnlimitedSettings } from "../../../../../analytics"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../logging"

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!Array.isArray(body?.excludedModelIds) || !body.excludedModelIds.every((id) => typeof id === "string")) {
    return jsonError("excludedModelIds must be an array of strings.", 400)
  }
  const excludedModelIds = [...new Set(body.excludedModelIds.map((id) => id.trim()).filter(Boolean))]
  if (excludedModelIds.length > 100) return jsonError("Choose at most 100 models.", 400)
  try {
    const current = await getBudgetUnlimitedSettings()
    if (!await validateBudgetModelIds(excludedModelIds, current.excludedModelIds)) return jsonError("One or more selected models are unavailable.", 400)
    const settings = await setBudgetUnlimitedSettings({ excludedModelIds })
    recordLog("admin.unlimited.mode.exclusions.updated", { modelCount: settings.excludedModelIds.length }, { level: "info" })
    return Response.json({ settings })
  } catch (error) {
    recordLog("admin.unlimited.mode.exclusions.update.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Unlimited Mode exclusions.", 400)
  }
}
