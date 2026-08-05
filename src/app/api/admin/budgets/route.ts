import { requireAdmin } from "@/lib/auth"
import { getBudgetAdminData, upsertBudget } from "@/lib/analytics"
import { jsonError } from "@/lib/http"


export async function GET() {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
return Response.json(await getBudgetAdminData())
}

export async function POST(request: Request) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const apiKeyId = typeof body?.apiKeyId === "string" ? body.apiKeyId : ""
  const weeklyLimitUsd = Number(body?.weeklyLimitUsd)
  if (!apiKeyId || !Number.isFinite(weeklyLimitUsd) || weeklyLimitUsd <= 0) return jsonError("A positive weeklyLimitUsd and apiKeyId are required.", 400)
  try { return Response.json({ budget: await upsertBudget({ apiKeyId, weeklyLimitMicros: Math.round(weeklyLimitUsd * 1_000_000), enabled: body?.enabled !== false }) }) }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Unable to save budget.", 400) }
}
