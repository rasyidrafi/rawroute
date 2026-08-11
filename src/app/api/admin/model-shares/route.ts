import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { listModelSharesForSourceModel, listShareTargets, setModelShareTargets } from "@/lib/model-shares"

export async function GET(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const modelId = new URL(request.url).searchParams.get("modelId")?.trim() || ""
  if (!modelId) return jsonError("Model ID is required.", 400)
  try {
    const [targets, shares] = await Promise.all([listShareTargets(modelId), listModelSharesForSourceModel(modelId)])
    return Response.json({ targets, shares })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load model sharing.", 400)
  }
}

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : ""
  const recipientWorkspaceIds = Array.isArray(body?.recipientWorkspaceIds)
    ? body.recipientWorkspaceIds.filter((value): value is string => typeof value === "string")
    : []
  if (!modelId) return jsonError("Model ID is required.", 400)
  try {
    const shares = await setModelShareTargets(modelId, recipientWorkspaceIds)
    writeLog("info", "admin", "Model sharing updated", { modelId, recipientCount: recipientWorkspaceIds.length })
    return Response.json({ shares })
  } catch (error) {
    writeLog("error", "admin", "Model sharing update failed", { modelId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update model sharing.", 400)
  }
}
