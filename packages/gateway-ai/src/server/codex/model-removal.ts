import { modelUnavailable } from "../../contracts/catalog"
import type { Model } from "../../contracts/domain"
import { listModelSharesForSourceModel } from "../model-shares"
import { listAliases, listCombos } from "../store"

export async function codexRemovalBlockers(model: Model) {
  if (!modelUnavailable(model)) return []
  const [aliases, combos, shares] = await Promise.all([listAliases(), listCombos(), listModelSharesForSourceModel(model.id)])
  return [...aliases.filter(alias => alias.targetModelId === model.gatewayModelId).map(alias => alias.alias),
    ...combos.filter(combo => combo.members.some(member => member.modelId === model.gatewayModelId)).map(combo => combo.combo),
    ...shares.filter(share => share.status === "active").map(share => `workspace ${share.recipientWorkspaceName}`)]
}
