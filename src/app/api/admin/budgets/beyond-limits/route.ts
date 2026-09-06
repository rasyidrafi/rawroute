import { requireAdmin } from "@/lib/auth"
import { setBudgetBeyondLimitsSettings } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { listModels, listProviders } from "@/lib/store"

export async function PATCH(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
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
    writeLog("info", "admin", "Beyond Limits settings updated", { enabled: settings.enabled, modelCount: settings.modelIds.length })
    return Response.json({ settings })
  } catch (error) {
    writeLog("error", "admin", "Beyond Limits settings update failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Beyond Limits settings.", 400)
  }
}
