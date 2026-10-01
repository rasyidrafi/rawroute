import { setBudgetBeyondLimitsSettings } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { listModels, listProviders } from "@/server/store"

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (typeof body?.enabled !== "boolean" || !Array.isArray(body.modelIds) || !body.modelIds.every((id) => typeof id === "string")) {
    return jsonError("enabled must be boolean and modelIds must be an array of strings.", 400)
  }
  const modelIds = [...new Set(body.modelIds.map((id) => id.trim()).filter(Boolean))]
  if (modelIds.length > 100) return jsonError("Choose at most 100 models.", 400)
  try {
    const [models, providers] = await Promise.all([listModels(), listProviders()])
    const availableModelIds = new Set(models
      .filter((model) => model.enabled && providers.some((provider) => provider.id === model.providerId && provider.enabled))
      .map((model) => model.gatewayModelId || model.id))
    if (modelIds.some((id) => !availableModelIds.has(id))) return jsonError("One or more selected models are unavailable.", 400)
    const settings = await setBudgetBeyondLimitsSettings({ enabled: body.enabled, modelIds })
    recordLog("admin.beyond.limits.settings.updated", { enabled: settings.enabled, modelCount: settings.modelIds.length }, { level: "info" })
    return Response.json({ settings })
  } catch (error) {
    recordLog("admin.beyond.limits.settings.update.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Beyond Limits settings.", 400)
  }
}
