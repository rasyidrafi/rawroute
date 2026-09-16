import { requireAdmin } from "@/lib/auth"
import { setBudgetUnlimitedSettings } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { listAliases, listCombos, listModels, listProviders } from "@/lib/store"

export async function PATCH(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!Array.isArray(body?.excludedModelIds) || !body.excludedModelIds.every((id) => typeof id === "string")) {
    return jsonError("excludedModelIds must be an array of strings.", 400)
  }
  const excludedModelIds = [...new Set(body.excludedModelIds.map((id) => id.trim()).filter(Boolean))]
  if (excludedModelIds.length > 100) return jsonError("Choose at most 100 models.", 400)
  try {
    const [models, providers, aliases, combos] = await Promise.all([listModels(), listProviders(), listAliases(), listCombos()])
    const enabledProviderIds = new Set(providers.filter((provider) => provider.enabled).map((provider) => provider.id))
    const availableModelIds = new Set([
      ...models.filter((model) => model.enabled && enabledProviderIds.has(model.providerId)).map((model) => model.gatewayModelId || model.id),
      ...aliases.map((alias) => alias.alias),
      ...combos.map((combo) => combo.combo),
    ])
    if (excludedModelIds.some((id) => !availableModelIds.has(id))) return jsonError("One or more selected models are unavailable.", 400)
    const settings = await setBudgetUnlimitedSettings({ excludedModelIds })
    writeLog("info", "admin", "Unlimited Mode exclusions updated", { modelCount: settings.excludedModelIds.length })
    return Response.json({ settings })
  } catch (error) {
    writeLog("error", "admin", "Unlimited Mode exclusions update failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update Unlimited Mode exclusions.", 400)
  }
}
