import { invalidateDashboardPresentation } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { deleteAlias } from "@/server/store"

export async function DELETE(_request: Request, params: { aliasId: string }) {
  const { aliasId } = params
  try {
    await deleteAlias(aliasId)
    invalidateDashboardPresentation()
    recordLog("admin.alias.deleted", { aliasId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.alias.delete.failed", { aliasId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete alias.", 400)
  }
}
