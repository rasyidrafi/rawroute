import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../../logging"
import { deleteModel } from "../../../../../../../store"

export async function DELETE(_request: Request, params: { providerId: string; modelId: string }) {
    const { providerId, modelId } = params
  try {
    await deleteModel(providerId, decodeURIComponent(modelId))
    recordLog("admin.model.deleted", { providerId, modelId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.model.delete.failed", { providerId, modelId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete model.", 400)
  }
}
