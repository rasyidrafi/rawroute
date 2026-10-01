import { deleteBudget, upsertBudget } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

export async function PATCH(request: Request, params: { apiKeyId: string }) {
  const { apiKeyId } = params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const limit = Number(body?.weeklyLimitUsd)
  if (!Number.isFinite(limit) || limit <= 0) return jsonError("weeklyLimitUsd must be positive.", 400)
  try {
    const budget = await upsertBudget({ apiKeyId, weeklyLimitMicros: Math.round(limit * 1_000_000), enabled: body?.enabled !== false })
    recordLog("admin.budget.saved", { apiKeyId }, { level: "info" })
    return Response.json({ budget })
  } catch (error) {
    recordLog("admin.budget.save.failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save budget.", 400)
  }
}

export async function DELETE(_request: Request, params: { apiKeyId: string }) {
  const apiKeyId = params.apiKeyId
  try {
    await deleteBudget(apiKeyId)
    recordLog("admin.budget.deleted", { apiKeyId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.budget.delete.failed", { apiKeyId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete budget.", 400)
  }
}
