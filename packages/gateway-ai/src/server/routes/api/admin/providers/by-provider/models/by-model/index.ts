import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../../logging"
import { deleteModel, listProviderModels } from "../../../../../../../store"
import { codexRemovalBlockers } from "../../../../../../../codex/model-removal"

export async function DELETE(_request: Request, params: { providerId: string; modelId: string }) {
    const { providerId, modelId } = params
  try {
    const id = decodeURIComponent(modelId)
    const model = (await listProviderModels(providerId)).find(entry => entry.id === id)
    const blockers = model ? await codexRemovalBlockers(model) : []
    if (blockers.length) return jsonError(`Remove this model from ${blockers.join(", ")} first.`, 409)
    await deleteModel(providerId, id)
    recordLog("admin.model.deleted", { providerId, modelId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.model.delete.failed", { providerId, modelId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete model.", 400)
  }
}
