import { requireAdmin } from "@/lib/auth"
import { listModelPricing, upsertModelPricing } from "@/lib/analytics"
import { jsonError } from "@/lib/http"


export async function GET() {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  return Response.json({ pricing: await listModelPricing() })
}

export async function POST(request: Request) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const text = (key: string) => typeof body?.[key] === "string" ? String(body[key]).trim() : ""
  const number = (key: string) => Number(body?.[key])
  const modelId = text("modelId")
  if (!modelId || !text("gatewayModelId") || !text("upstreamModel") || !Number.isSafeInteger(number("inputMicrosPerMillion")) || !Number.isSafeInteger(number("outputMicrosPerMillion"))) return jsonError("Model and integer token rates are required.", 400)
  try {
    return Response.json({ pricing: await upsertModelPricing({ modelId, provider: text("provider"), gatewayModelId: text("gatewayModelId"), upstreamModel: text("upstreamModel"), inputMicrosPerMillion: number("inputMicrosPerMillion"), outputMicrosPerMillion: number("outputMicrosPerMillion"), cacheReadMicrosPerMillion: Number.isSafeInteger(number("cacheReadMicrosPerMillion")) ? number("cacheReadMicrosPerMillion") : 0, cacheCreationMicrosPerMillion: Number.isSafeInteger(number("cacheCreationMicrosPerMillion")) ? number("cacheCreationMicrosPerMillion") : 0, enabled: body?.enabled !== false }) })
  } catch (error) { return jsonError(error instanceof Error ? error.message : "Unable to save model pricing.", 400) }
}
