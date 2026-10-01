import { invalidateDashboardPresentation } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { deleteCombo } from "@/server/store"

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
