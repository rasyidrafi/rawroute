import { requireAdmin } from "@/lib/auth"
import { getBudgetWindow, updateBudgetWindow } from "@/lib/analytics"
import { jsonError } from "@/lib/http"


export async function GET() {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  return Response.json({ window: await getBudgetWindow() })
}

export async function PATCH(request: Request) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const start = typeof body?.start === "string" ? new Date(body.start) : undefined
  const end = typeof body?.end === "string" ? new Date(body.end) : undefined
  if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime())) || (start && end && end <= start)) return jsonError("Invalid budget window.", 400)
  return Response.json({ window: await updateBudgetWindow({ ...(start ? { start: start.toISOString() } : {}), ...(end ? { end: end.toISOString() } : {}) }) })
}
