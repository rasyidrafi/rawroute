import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteAlias } from "@/lib/store"


export async function DELETE(_request: Request, context: { params: Promise<{ aliasId: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { aliasId } = await context.params
  try {
    await deleteAlias(aliasId)
    writeLog("info", "admin", "Alias deleted", { aliasId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Alias delete failed", { aliasId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete alias.", 400)
  }
}
