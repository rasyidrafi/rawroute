import { requireAdmin } from "@/lib/auth"
import { invalidateDashboardPresentation } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { getSharedModelForRecipient, listSharedModelsForRecipient } from "@/lib/model-shares"
import { listAliases, listCombos, listModels, listProviders, upsertAlias } from "@/lib/store"
import type { ModelAlias } from "@/lib/types"


export async function GET() {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const [aliases, combos, models, providers, sharedModels] = await Promise.all([listAliases(), listCombos(), listModels(), listProviders(), listSharedModelsForRecipient()])
  const providerIndex = new Map(providers.map((provider) => [provider.id, provider]))
  const availableModels = models
    .filter((model) => {
      const provider = providerIndex.get(model.providerId)
      return Boolean(provider && provider.enabled !== false && model.enabled)
    })
  const availableProviders = providers.filter((provider) => provider.enabled !== false)
  return Response.json({ aliases, combos, models: availableModels, providers: availableProviders, sharedModels })
}

export async function POST(request: Request) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const input = body.alias as Partial<ModelAlias> & { originalId?: string } | undefined
  if (!input) return jsonError("Alias payload is required.", 400)

  try {
    const alias = typeof input.alias === "string" ? input.alias.trim() : ""
    const name = typeof input.name === "string" ? input.name.trim() : ""
    const targetModelId = typeof input.targetModelId === "string" ? input.targetModelId.trim() : ""
    const sharedModelId = typeof input.sharedModelId === "string" ? input.sharedModelId.trim() : ""
    if (!alias || !name || !targetModelId) throw new Error("Alias fields are incomplete.")
    if (sharedModelId) {
      const shared = await getSharedModelForRecipient(sharedModelId)
      if (!shared || shared.status !== "active") throw new Error("Shared model is no longer available.")
      if (targetModelId !== shared.qualifiedModelId) throw new Error("Shared model target is invalid.")
    } else {
      const [models, providers] = await Promise.all([listModels(), listProviders()])
      const providerIndex = new Map(providers.map((provider) => [provider.id, provider]))
      const target = models.find((model) => (model.gatewayModelId || model.id) === targetModelId)
      if (!target) throw new Error("Target model not found.")
      if (!target.enabled) throw new Error("Target model is disabled.")
      const targetProvider = providerIndex.get(target.providerId)
      if (!targetProvider || targetProvider.enabled === false) throw new Error("Target model is unavailable.")
    }
    await upsertAlias({
      originalId: input.originalId,
      alias,
      name,
      targetModelId,
      sharedModelId,
    })
    invalidateDashboardPresentation()
    writeLog("info", "admin", "Alias saved", { alias })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Alias save failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save alias.", 400)
  }
}
