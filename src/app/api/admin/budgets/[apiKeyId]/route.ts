import { requireAdmin } from "@/lib/auth"
import { deleteBudget, upsertBudget } from "@/lib/analytics"
import { jsonError } from "@/lib/http"


export async function PATCH(request: Request, context: { params: Promise<{ apiKeyId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const { apiKeyId } = await context.params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const limit = Number(body?.weeklyLimitUsd)
  if (!Number.isFinite(limit) || limit <= 0) return jsonError("weeklyLimitUsd must be positive.", 400)
  return Response.json({ budget: await upsertBudget({ apiKeyId, weeklyLimitMicros: Math.round(limit * 1_000_000), enabled: body?.enabled !== false }) })
}

export async function DELETE(_request: Request, context: { params: Promise<{ apiKeyId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  await deleteBudget((await context.params).apiKeyId)
  return Response.json({ ok: true })
}
