import { after } from "next/server"

import { requireAdmin } from "@/lib/auth"
import { upsertModelPricing } from "@/lib/analytics"
import { findModelsDevCanonicalModel, searchModelsDevCanonicalModels } from "@/lib/models-dev"
import { createPricingGroup, deletePricingGroup, getPricingAdminData, runPricingJob, savePricingVersion, syncModelPricingGroups, updatePricingGroup } from "@/lib/model-pricing"
import { jsonError } from "@/lib/http"
import type { PricingCanonicalSource } from "@/lib/types"


export async function GET(request: Request) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
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
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const action = typeof body?.action === "string" ? body.action : "legacy"
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
    if (action === "sync") return Response.json({ groups: await syncModelPricingGroups() })
    if (action === "create-group") return Response.json({ group: await createPricingGroup(String(body?.name || ""), Array.isArray(body?.modelIds) ? body.modelIds.filter((value): value is string => typeof value === "string") : [], canonical) })
    if (action === "update-group") return Response.json({ group: await updatePricingGroup(String(body?.groupId || ""), Array.isArray(body?.modelIds) ? body.modelIds.filter((value): value is string => typeof value === "string") : [], canonical, typeof body?.name === "string" ? body.name : undefined) })
    if (action === "delete-group") { await deletePricingGroup(String(body?.groupId || "")); return Response.json({ ok: true }) }
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
      if (job) after(() => runPricingJob(job.id))
      return Response.json(result)
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update model pricing.", 400)
  }
  const text = (key: string) => typeof body?.[key] === "string" ? String(body[key]).trim() : ""
  const number = (key: string) => Number(body?.[key])
  const modelId = text("modelId")
  if (!modelId || !text("gatewayModelId") || !text("upstreamModel") || !Number.isSafeInteger(number("inputMicrosPerMillion")) || !Number.isSafeInteger(number("outputMicrosPerMillion"))) return jsonError("Model and integer token rates are required.", 400)
  try {
    return Response.json({ pricing: await upsertModelPricing({ modelId, provider: text("provider"), gatewayModelId: text("gatewayModelId"), upstreamModel: text("upstreamModel"), inputMicrosPerMillion: number("inputMicrosPerMillion"), outputMicrosPerMillion: number("outputMicrosPerMillion"), cacheReadMicrosPerMillion: Number.isSafeInteger(number("cacheReadMicrosPerMillion")) ? number("cacheReadMicrosPerMillion") : 0, cacheCreationMicrosPerMillion: Number.isSafeInteger(number("cacheCreationMicrosPerMillion")) ? number("cacheCreationMicrosPerMillion") : 0, enabled: body?.enabled !== false }) })
  } catch (error) { return jsonError(error instanceof Error ? error.message : "Unable to save model pricing.", 400) }
}
