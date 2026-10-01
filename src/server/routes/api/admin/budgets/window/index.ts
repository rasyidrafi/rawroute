import { getBudgetWindow, updateBudgetWindow } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

export async function GET() {
  return Response.json({ window: await getBudgetWindow() })
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const anchor = body?.anchor === "codex" || body?.anchor === "custom" ? body.anchor : undefined
  const start = typeof body?.start === "string" ? new Date(body.start) : undefined
  const end = typeof body?.end === "string" ? new Date(body.end) : undefined
  if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime())) || (start && end && end <= start)) return jsonError("Invalid budget window.", 400)
  if (anchor === "codex" && body?.codexAccountId !== undefined && typeof body.codexAccountId !== "string") return jsonError("A valid Codex account is required.", 400)
  try {
    const window = await updateBudgetWindow({ ...(anchor ? { anchor } : {}), ...(typeof body?.codexAccountId === "string" ? { codexAccountId: body.codexAccountId } : {}), ...(start ? { start: start.toISOString() } : {}), ...(end ? { end: end.toISOString() } : {}) })
    recordLog("admin.budget.window.updated", { anchor: window.anchor }, { level: "info" })
    return Response.json({ window })
  } catch (error) {
    recordLog("admin.budget.window.update.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update budget window.", 400)
  }
}
