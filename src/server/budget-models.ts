import { routingModelCatalog, type RoutingModelOption } from "@/lib/catalog"
import { listSharedModelsForRecipient } from "@/lib/workspace/model-shares"
import { listAliases, listCombos, listModels, listProviders } from "@/server/store"

export async function budgetModelOptions(): Promise<RoutingModelOption[]> {
  const [providers, models, aliases, combos, shares] = await Promise.all([
    listProviders(), listModels(), listAliases(), listCombos(), listSharedModelsForRecipient(),
  ])
  return routingModelCatalog(providers, models, aliases, combos, shares)
    .map(({ id, name, provider, kind, available, unavailableReason, members }) => ({ id, name, provider, kind, available, unavailableReason, members }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

export async function validateBudgetModelIds(modelIds: string[], savedIds: string[]) {
  const available = new Set((await budgetModelOptions()).filter((model) => model.available).map((model) => model.id))
  // Existing unavailable selections remain editable until explicitly removed.
  const saved = new Set(savedIds)
  return modelIds.every((id) => available.has(id) || saved.has(id))
}
