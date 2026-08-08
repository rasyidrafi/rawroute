import { requireAdmin } from "@/lib/auth"
import { deleteModelPricing, upsertModelPricing } from "@/lib/analytics"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"


export async function PATCH(request: Request, context: { params: Promise<{ pricingId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const id = (await context.params).pricingId
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const number = (key: string, fallback = 0) => Number.isSafeInteger(Number(body?.[key])) ? Number(body?.[key]) : fallback
  try {
    const pricing = await upsertModelPricing({ id, modelId: String(body?.modelId || ""), provider: String(body?.provider || ""), gatewayModelId: String(body?.gatewayModelId || ""), upstreamModel: String(body?.upstreamModel || ""), inputMicrosPerMillion: number("inputMicrosPerMillion"), outputMicrosPerMillion: number("outputMicrosPerMillion"), cacheReadMicrosPerMillion: number("cacheReadMicrosPerMillion"), cacheCreationMicrosPerMillion: number("cacheCreationMicrosPerMillion"), enabled: body?.enabled !== false })
    writeLog("info", "admin", "Model pricing updated", { pricingId: id })
    return Response.json({ pricing })
  } catch (error) {
    writeLog("error", "admin", "Model pricing update failed", { pricingId: id, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update model pricing.", 400)
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ pricingId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const pricingId = (await context.params).pricingId
  try {
    await deleteModelPricing(pricingId)
    writeLog("info", "admin", "Model pricing deleted", { pricingId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Model pricing delete failed", { pricingId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete model pricing.", 400)
  }
}
