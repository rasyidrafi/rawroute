import { requireAdmin } from "@/lib/auth"
import { getBudgetWindow, updateBudgetWindow } from "@/lib/analytics"
import { jsonError } from "@/lib/http"


export async function GET() {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  return Response.json({ window: await getBudgetWindow() })
}

export async function PATCH(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const anchor = body?.anchor === "codex" || body?.anchor === "custom" ? body.anchor : undefined
  const start = typeof body?.start === "string" ? new Date(body.start) : undefined
  const end = typeof body?.end === "string" ? new Date(body.end) : undefined
  if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime())) || (start && end && end <= start)) return jsonError("Invalid budget window.", 400)
  if (anchor === "codex" && body?.codexAccountId !== undefined && typeof body.codexAccountId !== "string") return jsonError("A valid Codex account is required.", 400)
  try {
    return Response.json({ window: await updateBudgetWindow({ ...(anchor ? { anchor } : {}), ...(typeof body?.codexAccountId === "string" ? { codexAccountId: body.codexAccountId } : {}), ...(start ? { start: start.toISOString() } : {}), ...(end ? { end: end.toISOString() } : {}) }) })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update budget window.", 400)
  }
}
