import { requireAdmin } from "@/lib/auth"
import { invalidateDashboardPresentation } from "@/lib/analytics"
import { cleanAliasId, jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { getSharedModelForRecipient } from "@/lib/model-shares"
import { listAliases, listCombos, listModels, listProviders, upsertCombo } from "@/lib/store"
import type { ModelCombo } from "@/lib/types"

async function validateCombo(input: Partial<ModelCombo> & { originalId?: string }) {
  const combo = cleanAliasId(typeof input.combo === "string" ? input.combo : "")
  const name = typeof input.name === "string" ? input.name.trim() : ""
  const memberModelIds = Array.isArray(input.memberModelIds) ? input.memberModelIds.map((member) => typeof member === "string" ? member.trim() : "") : []
  if (!combo || !name) throw new Error("Combo fields are incomplete.")
  if (memberModelIds.length < 2 || memberModelIds.length > 8) throw new Error("A combo needs between 2 and 8 models.")
  if (new Set(memberModelIds).size !== memberModelIds.length || memberModelIds.some((member) => !member)) throw new Error("Combo models must be unique.")

  const [models, providers, aliases, combos] = await Promise.all([listModels(), listProviders(), listAliases(), listCombos()])
  const enabledProviderIds = new Set(providers.filter((provider) => provider.enabled !== false).map((provider) => provider.id))
  const availableModelIds = new Set(models.filter((model) => model.enabled && enabledProviderIds.has(model.providerId)).map((model) => model.gatewayModelId || model.id))
  const availableAliasIds = new Set<string>()
  for (const alias of aliases) {
    if (!alias.sharedModelId && availableModelIds.has(alias.targetModelId)) availableAliasIds.add(alias.alias)
    if (alias.sharedModelId && (await getSharedModelForRecipient(alias.sharedModelId))?.status === "active") availableAliasIds.add(alias.alias)
  }
  if (memberModelIds.some((member) => !availableModelIds.has(member) && !availableAliasIds.has(member))) throw new Error("One or more combo models are unavailable.")
  if (availableModelIds.has(combo) || aliases.some((alias) => cleanAliasId(alias.alias) === combo) || combos.some((entry) => cleanAliasId(entry.combo) === combo && entry.id !== input.originalId)) throw new Error("Combo gateway ID is already in use.")
  return { combo, name, memberModelIds }
}

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const input = body?.combo as Partial<ModelCombo> & { originalId?: string } | undefined
  if (!input) return jsonError("Combo payload is required.", 400)
  try {
    const value = await validateCombo(input)
    const combo = await upsertCombo({ ...value, originalId: input.originalId })
    invalidateDashboardPresentation()
    writeLog("info", "admin", "Combo saved", { combo: combo.combo })
    return Response.json({ combo })
  } catch (error) {
    writeLog("error", "admin", "Combo save failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save combo.", 400)
  }
}
