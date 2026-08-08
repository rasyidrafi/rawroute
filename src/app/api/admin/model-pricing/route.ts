import { after } from "next/server"

import { requireAdmin } from "@/lib/auth"
import { findModelsDevCanonicalModel, searchModelsDevCanonicalModels } from "@/lib/models-dev"
import { createPricingGroup, deletePricingGroup, getPricingAdminData, runPricingJob, savePricingVersion, syncModelPricingGroups, updatePricingGroup } from "@/lib/model-pricing"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import type { PricingCanonicalSource } from "@/lib/types"
import { runInWorkspace, workspaceContext } from "@/lib/workspace-context"


export async function GET(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  try {
    const url = new URL(request.url)
    const query = url.searchParams.get("q")?.trim() || ""
    const modelId = url.searchParams.get("modelId")?.trim() || ""
    if (url.searchParams.get("catalog") === "models.dev" || query || modelId) {
      if (modelId) {
        const model = await findModelsDevCanonicalModel(modelId)
        return Response.json({ models: model ? [model] : [] })
      }
      return Response.json({ models: await searchModelsDevCanonicalModels(query, Number(url.searchParams.get("limit") || 50)) })
    }
    return Response.json(await getPricingAdminData())
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load model pricing.", 500)
  }
}

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const action = typeof body?.action === "string" ? body.action : ""
  const canonical = body?.canonicalModelId && typeof body.canonicalModelId === "string"
    ? {
        id: body.canonicalModelId,
        source: body.canonicalSource === "custom" ? "custom" as PricingCanonicalSource : "models.dev" as PricingCanonicalSource,
        name: typeof body.canonicalModelName === "string" ? body.canonicalModelName : undefined,
        provider: typeof body.canonicalProvider === "string" ? body.canonicalProvider : undefined,
      }
    : body?.canonicalModelId === null
      ? null
      : undefined
  try {
    if (action === "sync") {
      const groups = await syncModelPricingGroups()
      writeLog("info", "admin", "Model pricing groups synced", { count: groups.length })
      return Response.json({ groups })
    }
    if (action === "create-group") {
      const group = await createPricingGroup(String(body?.name || ""), Array.isArray(body?.modelIds) ? body.modelIds.filter((value): value is string => typeof value === "string") : [], canonical)
      writeLog("info", "admin", "Model pricing group created", { groupId: group.id })
      return Response.json({ group })
    }
    if (action === "update-group") {
      const group = await updatePricingGroup(String(body?.groupId || ""), Array.isArray(body?.modelIds) ? body.modelIds.filter((value): value is string => typeof value === "string") : [], canonical, typeof body?.name === "string" ? body.name : undefined)
      writeLog("info", "admin", "Model pricing group updated", { groupId: group.id })
      return Response.json({ group })
    }
    if (action === "delete-group") {
      const groupId = String(body?.groupId || "")
      await deletePricingGroup(groupId)
      writeLog("info", "admin", "Model pricing group deleted", { groupId })
      return Response.json({ ok: true })
    }
    if (action === "save-version") {
      const rates = {
        inputMicrosPerMillion: Number(body?.inputMicrosPerMillion),
        outputMicrosPerMillion: Number(body?.outputMicrosPerMillion),
        cacheReadMicrosPerMillion: Number(body?.cacheReadMicrosPerMillion),
        cacheCreationMicrosPerMillion: Number(body?.cacheCreationMicrosPerMillion),
      }
      const contextTiers = Array.isArray(body?.contextTiers) ? body.contextTiers.map((tier) => {
        const value = tier as Record<string, unknown>
        return { id: typeof value.id === "string" ? value.id : crypto.randomUUID(), thresholdTokens: Number(value.thresholdTokens), inputMicrosPerMillion: Number(value.inputMicrosPerMillion), outputMicrosPerMillion: Number(value.outputMicrosPerMillion), cacheReadMicrosPerMillion: Number(value.cacheReadMicrosPerMillion), cacheCreationMicrosPerMillion: Number(value.cacheCreationMicrosPerMillion) }
      }) : []
      const result = await savePricingVersion({ groupId: String(body?.groupId || ""), rates, contextTiers, mode: body?.mode === "replace" ? "replace" : "new" })
      const job = result.job
      if (job) {
        const workspace = workspaceContext()
        after(() => runInWorkspace(workspace, () => runPricingJob(job.id)))
      }
      writeLog("info", "admin", "Model pricing version saved", { groupId: result.version.groupId, versionId: result.version.id })
      return Response.json(result)
    }
  } catch (error) {
    writeLog("error", "admin", "Model pricing update failed", { action, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update model pricing.", 400)
  }
  return jsonError("Unsupported model pricing action.", 400)
}
