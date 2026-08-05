import { requireAdmin } from "@/lib/auth"
import { gatewayModelId, jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { validateRequestOverrides } from "@/lib/request-overrides"
import { getProvider, upsertModel } from "@/lib/store"
import type { Model, Protocol } from "@/lib/types"


const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic-messages"]

export async function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId } = await context.params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const input = body.model as Partial<Model> & { originalId?: string } | undefined
  if (!input) return jsonError("Model payload is required.", 400)

  try {
    const provider = await getProvider(providerId)
    if (!provider) throw new Error("Provider is missing.")
    const name = typeof input.name === "string" ? input.name.trim() : ""
    const upstreamModel = typeof input.upstreamModel === "string" ? input.upstreamModel.trim() : ""
    const requestedProtocol = input.protocol as string | undefined
    if (!name || !upstreamModel) throw new Error("Model fields are incomplete.")
    const requestedGatewayModelId = typeof input.gatewayModelId === "string"
      ? input.gatewayModelId.trim()
      : typeof input.id === "string" ? input.id.trim() : ""
    const normalizedGatewayModelId = gatewayModelId(provider.prefix, requestedGatewayModelId)
    const requestOverrides = input.requestOverrides !== undefined
      ? validateRequestOverrides(input.requestOverrides)
      : undefined
    if (requestedProtocol !== undefined && requestedProtocol !== "inherit" && !protocols.includes(requestedProtocol as Protocol)) {
      throw new Error("Invalid model protocol.")
    }
    if (input.upstreamPath !== undefined && typeof input.upstreamPath !== "string") {
      throw new Error("Upstream path must be a string.")
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new Error("Model enabled value must be a boolean.")
    }
    const modelInput: Partial<Model> & { originalId?: string } = {
      originalId: input.originalId,
      gatewayModelId: normalizedGatewayModelId,
      name,
      upstreamModel,
      enabled: input.enabled,
    }
    if (requestedProtocol === "inherit") modelInput.protocol = undefined
    else if (requestedProtocol !== undefined) modelInput.protocol = requestedProtocol as Protocol
    if (input.upstreamPath !== undefined) modelInput.upstreamPath = input.upstreamPath.trim()
    if (input.requestOverrides !== undefined) modelInput.requestOverrides = requestOverrides
    await upsertModel(providerId, modelInput)
    writeLog("info", "admin", "Model saved", { providerId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Model save failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save model.", 400)
  }
}
