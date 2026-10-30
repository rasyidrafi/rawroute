import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../logging"
import { listModelSharesForSourceModel, listShareTargets, setModelShareTargets } from "../../../../model-shares"

export async function GET(request: Request) {
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
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : ""
  const recipientWorkspaceIds = Array.isArray(body?.recipientWorkspaceIds)
    ? body.recipientWorkspaceIds.filter((value): value is string => typeof value === "string")
    : []
  if (!modelId) return jsonError("Model ID is required.", 400)
  if (body?.unlimitedOnlyWorkspaceIds !== undefined && (!Array.isArray(body.unlimitedOnlyWorkspaceIds) || body.unlimitedOnlyWorkspaceIds.some(value => typeof value !== "string"))) return jsonError("Unlimited Mode targets must be workspace IDs.", 400)
  try {
    const shares = await setModelShareTargets(modelId, recipientWorkspaceIds, body?.unlimitedOnlyWorkspaceIds as string[] | undefined)
    recordLog("admin.model.sharing.updated", { modelId, recipientCount: recipientWorkspaceIds.length }, { level: "info" })
    return Response.json({ shares })
  } catch (error) {
    recordLog("admin.model.sharing.update.failed", { modelId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update model sharing.", 400)
  }
}
