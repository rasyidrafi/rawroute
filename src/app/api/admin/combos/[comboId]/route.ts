import { requireAdmin } from "@/lib/auth"
import { invalidateDashboardPresentation } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteCombo } from "@/lib/store"

export async function DELETE(_request: Request, context: { params: Promise<{ comboId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const { comboId } = await context.params
  try {
    await deleteCombo(comboId)
    invalidateDashboardPresentation()
    writeLog("info", "admin", "Combo deleted", { comboId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Combo delete failed", { comboId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete combo.", 400)
  }
}
