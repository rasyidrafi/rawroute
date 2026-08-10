import { requireAdmin } from "@/lib/auth"
import { CliProxyProviderSyncError, syncNonCodexProviderProjection } from "@/lib/cliproxy-provider-sync"
import { gatewayModelId, jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { getProvider, listProviderModels, upsertModel } from "@/lib/store"
import type { Model } from "@/lib/types"

export async function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId } = await context.params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const input = body.model as (Partial<Model> & { originalId?: string }) | undefined
  if (!input) return jsonError("Model payload is required.", 400)

  try {
    const provider = await getProvider(providerId)
    if (!provider) throw new Error("Provider is missing.")
    const existing = input.originalId ? (await listProviderModels(providerId)).find((model) => model.id === input.originalId) : undefined
    if (existing?.source === "builtin") {
      throw new Error("Built-in Codex models are fixed and cannot be edited.")
    }
    const name = typeof input.name === "string" ? input.name.trim() : ""
    const upstreamModel = typeof input.upstreamModel === "string" ? input.upstreamModel.trim() : ""
    if (!name || !upstreamModel) throw new Error("Model fields are incomplete.")
    const requestedGatewayModelId = typeof input.gatewayModelId === "string"
      ? input.gatewayModelId.trim()
      : typeof input.id === "string" ? input.id.trim() : ""
    const normalizedGatewayModelId = gatewayModelId(provider.prefix, requestedGatewayModelId)
    if (!normalizedGatewayModelId) throw new Error("Gateway model ID is required.")
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new Error("Model enabled value must be a boolean.")
    }
    const modelInput: Partial<Model> & { originalId?: string } = {
      originalId: input.originalId,
      gatewayModelId: normalizedGatewayModelId,
      name,
      upstreamModel,
      enabled: input.enabled,
      source: existing?.source || "custom",
    }
    await upsertModel(providerId, modelInput)
    if (provider.prefix !== "codex") await syncNonCodexProviderProjection(providerId)
    writeLog("info", "admin", "Model saved", { providerId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Model save failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save model.", error instanceof CliProxyProviderSyncError ? error.status : 400)
  }
}
