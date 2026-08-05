import { requireAdmin } from "@/lib/auth"
import { deleteModelPricing, upsertModelPricing } from "@/lib/analytics"
import { jsonError } from "@/lib/http"


export async function PATCH(request: Request, context: { params: Promise<{ pricingId: string }> }) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const id = (await context.params).pricingId
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const number = (key: string, fallback = 0) => Number.isSafeInteger(Number(body?.[key])) ? Number(body?.[key]) : fallback
  return Response.json({ pricing: await upsertModelPricing({ id, modelId: String(body?.modelId || ""), provider: String(body?.provider || ""), gatewayModelId: String(body?.gatewayModelId || ""), upstreamModel: String(body?.upstreamModel || ""), inputMicrosPerMillion: number("inputMicrosPerMillion"), outputMicrosPerMillion: number("outputMicrosPerMillion"), cacheReadMicrosPerMillion: number("cacheReadMicrosPerMillion"), cacheCreationMicrosPerMillion: number("cacheCreationMicrosPerMillion"), enabled: body?.enabled !== false }) })
}

export async function DELETE(_request: Request, context: { params: Promise<{ pricingId: string }> }) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  await deleteModelPricing((await context.params).pricingId)
  return Response.json({ ok: true })
}
