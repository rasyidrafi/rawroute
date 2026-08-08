import { requireAdmin } from "@/lib/auth"
import { deleteBudget, upsertBudget } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"


export async function PATCH(request: Request, context: { params: Promise<{ apiKeyId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const { apiKeyId } = await context.params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const limit = Number(body?.weeklyLimitUsd)
  if (!Number.isFinite(limit) || limit <= 0) return jsonError("weeklyLimitUsd must be positive.", 400)
  try {
    const budget = await upsertBudget({ apiKeyId, weeklyLimitMicros: Math.round(limit * 1_000_000), enabled: body?.enabled !== false })
    writeLog("info", "admin", "Budget saved", { apiKeyId })
    return Response.json({ budget })
  } catch (error) {
    writeLog("error", "admin", "Budget save failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save budget.", 400)
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ apiKeyId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const apiKeyId = (await context.params).apiKeyId
  try {
    await deleteBudget(apiKeyId)
    writeLog("info", "admin", "Budget deleted", { apiKeyId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Budget delete failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete budget.", 400)
  }
}
