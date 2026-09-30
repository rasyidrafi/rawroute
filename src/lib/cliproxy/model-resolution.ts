import { codexWorkspacePrefix } from "@/lib/codex/cliproxy"
import { ensureNonCodexProviderProjection, nonCodexProviderPrefix } from "@/lib/cliproxy/provider-sync"
import { resolveSharedModelForRecipient } from "@/lib/workspace/model-shares"
import { listAliases, listModels, listProviderApiKeys, listProviders } from "@/lib/store"
import type { AuthType, ModelReasoningCapability, Protocol, ProviderApiKey } from "@/lib/types"
import { currentWorkspaceId, runInWorkspace } from "@/lib/workspace/context"
import { getWorkspace } from "@/lib/workspace/repository"

export interface ResolvedGatewayModel {
  forwardedModel: string
  upstreamModel: string
  upstreamProtocol: Protocol
  pricingGatewayModelId: string
  providerModelId?: string
  providerId?: string
  providerName?: string
  promptCacheKey: boolean
  reasoningEffort?: string
  customPayload?: Record<string, unknown>
  reasoningCapability?: ModelReasoningCapability
  nativeResponses?: { baseUrl: string; authType: AuthType; headers: Record<string, string>; apiKeys: ProviderApiKey[] }
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
  return Boolean(provider && provider.enabled !== false && model.enabled)
}

function modelNotFound(model: string): never {
  throw new GatewayModelResolutionError(`Model ${model} is not configured or is unavailable.`, 400, "model_not_found")
}

function providerModelSuffix(provider: Awaited<ReturnType<typeof listProviders>>[number], model: Awaited<ReturnType<typeof listModels>>[number]) {
  const gatewayModelId = modelGatewayId(model)
  const prefix = `${provider.prefix}/`
  if (!gatewayModelId.startsWith(prefix)) modelNotFound(gatewayModelId)
  const suffix = gatewayModelId.slice(prefix.length).trim()
  if (!suffix) modelNotFound(gatewayModelId)
  return suffix
}

export async function resolveGatewayModel(model: string): Promise<ResolvedGatewayModel> {
  const [aliases, models, providers] = await Promise.all([listAliases(), listModels(), listProviders()])
  const providerIndex = new Map(providers.map((provider) => [provider.id, provider]))
  const availableModels = models.filter((candidate) => activeModel(candidate, providerIndex.get(candidate.providerId)))
  const alias = aliases.find((entry) => entry.alias === model)
  if (alias?.sharedModelId) {
    const consumerWorkspaceId = currentWorkspaceId()
    const [shared, consumerWorkspace] = await Promise.all([resolveSharedModelForRecipient(alias.sharedModelId, consumerWorkspaceId), getWorkspace(consumerWorkspaceId)])
    if (!shared || !consumerWorkspace) throw new GatewayModelResolutionError("Shared model is no longer available.", 400, "model_not_found")
    return runInWorkspace(shared.owner, async () => {
      const target = shared.model
      const provider = shared.provider
      const upstreamModel = target.upstreamModel || modelGatewayId(target)
      const forwardedModel = provider.prefix === "codex"
        ? `${codexWorkspacePrefix(currentWorkspaceId())}/${upstreamModel}`
        : `${nonCodexProviderPrefix(currentWorkspaceId(), provider.id)}/${providerModelSuffix(provider, target)}`
      const nativeResponses = provider.prefix !== "codex" && provider.protocol === "openai-responses"
        ? { baseUrl: provider.baseUrl, authType: provider.authType, headers: provider.headers || {}, apiKeys: await listProviderApiKeys(provider.id) }
        : undefined
      if (provider.prefix !== "codex" && !nativeResponses) await ensureNonCodexProviderProjection(provider.id)
      return {
        forwardedModel,
        upstreamModel,
        upstreamProtocol: provider.protocol || (provider.prefix === "codex" ? "openai-responses" : "openai-chat"),
        pricingGatewayModelId: modelGatewayId(target),
        providerModelId: target.id,
        providerId: target.providerId,
        providerName: provider.name,
        promptCacheKey: provider.protocol !== "anthropic-messages" && provider.supportPromptCacheKey === true,
        reasoningCapability: target.reasoningCapability,
        nativeResponses,
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
  // The request endpoint is the client source format. The saved provider
  // protocol identifies the CLIProxy upstream executor; it is not an ingress
  // restriction because CLIProxy translates supported client formats.
  const upstreamModel = target.upstreamModel || modelGatewayId(target)
  let forwardedModel = upstreamModel

  if (provider.prefix === "codex") {
    // RawRoute has already selected the workspace from the global API-key
    // index. The namespace is an internal CLIProxy transport selector; it is
    // never stored as a provider or exposed in the RawRoute model catalog.
    forwardedModel = `${codexWorkspacePrefix(currentWorkspaceId())}/${upstreamModel}`
  } else {
    // RawRoute owns the external provider/model resolver. CLIProxy receives a
    // workspace/provider-scoped transport model only after this local lookup.
    if (provider.protocol !== "openai-responses") {
      await ensureNonCodexProviderProjection(provider.id)
      forwardedModel = `${nonCodexProviderPrefix(currentWorkspaceId(), provider.id)}/${providerModelSuffix(provider, target)}`
    }
  }

  return {
    forwardedModel,
    upstreamModel,
    upstreamProtocol: provider.protocol || (provider.prefix === "codex" ? "openai-responses" : "openai-chat"),
    pricingGatewayModelId: modelGatewayId(target),
    providerModelId: target.id,
    providerId: target.providerId,
    providerName: provider.name,
    promptCacheKey: provider.protocol !== "anthropic-messages" && provider.supportPromptCacheKey === true,
    reasoningCapability: target.reasoningCapability,
    ...(provider.prefix !== "codex" && provider.protocol === "openai-responses" ? {
      nativeResponses: { baseUrl: provider.baseUrl, authType: provider.authType, headers: provider.headers || {}, apiKeys: await listProviderApiKeys(provider.id) },
    } : {}),
  }
}
