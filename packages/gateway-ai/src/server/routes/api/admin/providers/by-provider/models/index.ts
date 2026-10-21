import { CliProxyProviderSyncError, syncNonCodexProviderProjection } from "../../../../../../cliproxy/provider-sync"
import { jsonError } from "@rawroute/observability/contracts/http"
import { gatewayModelId } from "../../../../../../model-identifiers"
import { recordLog } from "../../../../../../logging"
import { getProvider, listProviderModels, upsertModel } from "../../../../../../store"
import type { Model } from "../../../../../../../contracts/domain"
import { validateServiceTierCapability } from "../../../../../../../contracts/service-tier"

export async function POST(request: Request, params: { providerId: string }) {
  const { providerId } = params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const input = body.model as (Partial<Model> & { originalId?: string }) | undefined
  if (!input) return jsonError("Model payload is required.", 400)

  try {
    const provider = await getProvider(providerId)
    if (!provider) throw new Error("Provider is missing.")
    const existing = input.originalId ? (await listProviderModels(providerId)).find((model) => model.id === input.originalId) : undefined
    const serviceTierCapability = validateServiceTierCapability(input.serviceTierCapability)
    if (existing?.source === "discovered") {
      if (input.enabled !== undefined && typeof input.enabled !== "boolean" || Object.keys(input).some((key) => !["originalId", "enabled", "serviceTierCapability"].includes(key))) throw new Error("Only enabled state and service tiers can be changed for discovered models.")
      await upsertModel(providerId, { originalId: existing.id, enabled: input.enabled, serviceTierCapability })
      return Response.json({ ok: true })
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
    const reasoningCapability = input.reasoningCapability
    if (reasoningCapability && !["auto", "enabled", "disabled"].includes(reasoningCapability.mode)) throw new Error("Model reasoning capability is invalid.")
    if (reasoningCapability?.supportedEfforts && (!Array.isArray(reasoningCapability.supportedEfforts) || reasoningCapability.supportedEfforts.some((effort) => typeof effort !== "string" || !effort.trim() || effort.trim().length > 64))) throw new Error("Supported reasoning efforts are invalid.")
    const modelInput: Partial<Model> & { originalId?: string } = {
      originalId: input.originalId,
      gatewayModelId: normalizedGatewayModelId,
      name,
      upstreamModel,
      enabled: input.enabled,
      source: existing?.source || "custom",
      serviceTierCapability,
      reasoningCapability: reasoningCapability ? { mode: reasoningCapability.mode, supportedEfforts: [...new Set(reasoningCapability.supportedEfforts?.map((effort) => effort.trim().toLowerCase()) || [])] } : undefined,
    }
    await upsertModel(providerId, modelInput)
    if (provider.prefix !== "codex") await syncNonCodexProviderProjection(providerId)
    recordLog("admin.model.saved", { providerId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.model.save.failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save model.", error instanceof CliProxyProviderSyncError ? error.status : 400)
  }
}
