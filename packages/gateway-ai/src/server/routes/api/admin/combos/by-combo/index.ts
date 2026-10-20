import { invalidateDashboardPresentation } from "../../../../../analytics"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../logging"
import { deleteCombo } from "../../../../../store"

export async function DELETE(_request: Request, params: { comboId: string }) {
  const { comboId } = params
  try {
    await deleteCombo(comboId)
    invalidateDashboardPresentation()
    recordLog("admin.combo.deleted", { comboId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.combo.delete.failed", { comboId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete combo.", 400)
  }
}
