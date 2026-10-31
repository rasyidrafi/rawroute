import { resolveSharedModelForRecipient } from "../model-shares"
import { listAliases, listModels, listProviderApiKeys, listProviders } from "../store"
import type { AuthType, ModelReasoningCapability, Protocol, ProviderApiKey } from "../../contracts/domain"
import { currentWorkspaceId, runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { attachWorkspaceActivity } from "@rawroute/platform/server/workspace-activity"
import { getWorkspace } from "@rawroute/platform/server/runtime"
import { modelUnavailable } from "../../contracts/catalog"

export interface ResolvedGatewayModel {
  upstreamModel: string
  upstreamProtocol: Protocol
  pricingGatewayModelId: string
  modelName: string
  aliasName?: string
  providerModelId?: string
  providerId?: string
  providerName?: string
  providerPrefix: string
  promptCacheKey: boolean
  reasoningEffort?: string
  customPayload?: Record<string, unknown>
  reasoningCapability?: ModelReasoningCapability
  upstream?: {
    baseUrl: string
    protocol: Protocol
    authType: AuthType
    headers: Record<string, string>
    apiKeys: ProviderApiKey[]
    codex: boolean
  }
  shared?: { id: string; ownerWorkspaceId: string; ownerWorkspaceName: string; consumerWorkspaceId: string; consumerWorkspaceName: string; sourceGatewayModelId: string; sourceModelId: string }
}

export class GatewayModelResolutionError extends Error {
  readonly status: 400 | 503
  readonly code: "model_not_found" | "model_resolver_unavailable"

  constructor(message: string, status: 400 | 503, code: GatewayModelResolutionError["code"]) {
    super(message)
    this.name = "GatewayModelResolutionError"
    this.status = status
    this.code = code
  }
}

function modelGatewayId(model: { gatewayModelId?: string; id: string }) {
  return model.gatewayModelId || model.id
}

function activeModel(model: Awaited<ReturnType<typeof listModels>>[number], provider: Awaited<ReturnType<typeof listProviders>>[number] | undefined) {
  return Boolean(provider && provider.enabled !== false && model.enabled && !modelUnavailable(model))
}

function modelNotFound(model: string): never {
  throw new GatewayModelResolutionError(`Model ${model} is not configured or is unavailable.`, 400, "model_not_found")
}

async function resolveProvider(provider: Awaited<ReturnType<typeof listProviders>>[number], target: Awaited<ReturnType<typeof listModels>>[number]) {
  return {
    upstreamModel: target.upstreamModel || modelGatewayId(target),
    upstreamProtocol: provider.protocol,
    pricingGatewayModelId: modelGatewayId(target),
    modelName: target.name.trim() || modelGatewayId(target),
    providerModelId: target.id,
    providerId: provider.id,
    providerName: provider.name,
    providerPrefix: provider.prefix,
    promptCacheKey: provider.prefix === "codex" || provider.protocol !== "anthropic-messages" && provider.supportPromptCacheKey === true,
    reasoningCapability: target.reasoningCapability,
    upstream: {
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      authType: provider.authType,
      headers: provider.headers || {},
      apiKeys: await listProviderApiKeys(provider.id),
      codex: provider.prefix === "codex",
    },
  }
}

export async function resolveGatewayModel(model: string, sharedModelId?: string): Promise<ResolvedGatewayModel> {
  const [aliases, models, providers] = await Promise.all([listAliases(), listModels(), listProviders()])
  const providerIndex = new Map(providers.map((provider) => [provider.id, provider]))
  const availableModels = models.filter((candidate) => activeModel(candidate, providerIndex.get(candidate.providerId)))
  const alias = aliases.find((entry) => entry.alias === model)
  const shareId = sharedModelId || alias?.sharedModelId
  if (shareId) {
    const consumerWorkspaceId = currentWorkspaceId()
    const [shared, consumerWorkspace] = await Promise.all([resolveSharedModelForRecipient(shareId, consumerWorkspaceId), getWorkspace(consumerWorkspaceId)])
    if (!shared || !consumerWorkspace) throw new GatewayModelResolutionError("Shared model is no longer available.", 400, "model_not_found")
    attachWorkspaceActivity(shared.owner.id)
    return runInWorkspace(shared.owner, async () => {
      const target = shared.model
      const provider = shared.provider
      const resolved = await resolveProvider(provider, target)
      return {
        ...resolved,
        aliasName: alias ? alias.name.trim() || alias.alias : undefined,
        shared: {
          id: shared.share.id,
          ownerWorkspaceId: shared.owner.id,
          ownerWorkspaceName: shared.owner.name,
          consumerWorkspaceId,
          consumerWorkspaceName: consumerWorkspace.name,
          sourceGatewayModelId: modelGatewayId(target),
          sourceModelId: target.id,
        },
      }
    })
  }

  const target = alias
    ? availableModels.find((entry) => entry.id === alias.targetModelId || modelGatewayId(entry) === alias.targetModelId)
    : availableModels.find((entry) => entry.id === model || modelGatewayId(entry) === model)
      || (() => {
        if (model.includes("/")) return undefined
        const suffixMatches = availableModels.filter((entry) => entry.upstreamModel === model || modelGatewayId(entry).endsWith(`/${model}`))
        return suffixMatches.length === 1 ? suffixMatches[0] : undefined
      })()
  if (!target) return modelNotFound(model)

  const provider = providerIndex.get(target.providerId)
  if (!provider || provider.enabled === false) return modelNotFound(model)
  return {
    ...await resolveProvider(provider, target),
    aliasName: alias ? alias.name.trim() || alias.alias : undefined,
  }
}
