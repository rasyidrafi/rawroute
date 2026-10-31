import { ensureCodexProvider } from "../../../../../codex/oauth"
import { codexDiscoveryStatus } from "../../../../../codex/model-discovery"
import { scheduleCodexModelRefresh } from "../../../../../codex/model-refresh"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../logging"
import { deleteProvider, getProvider, listProviderApiKeys, listProviderModels } from "../../../../../store"

function stripUnprefixed<T>(value: T): Omit<T, "unprefixed"> {
  const { unprefixed, ...rest } = value as T & { unprefixed?: unknown }
  void unprefixed
  return rest
}

function maskApiKey(key: string): string {
  return key ? "__unchanged__" : ""
}

export async function GET(_request: Request, params: { providerId: string }) {
  const { providerId } = params
  const provider = providerId === "codex" ? await ensureCodexProvider() : await getProvider(providerId)
  const resolvedId = provider?.id || providerId
  const [storedApiKeys, models] = await Promise.all([
    listProviderApiKeys(resolvedId),
    listProviderModels(resolvedId),
  ])
  if (!provider) return jsonError("Provider not found.", 404)
  const apiKeys = provider.prefix === "codex" ? storedApiKeys.filter((apiKey) => apiKey.credentialKind === "codex-oauth") : storedApiKeys
  if (provider.prefix === "codex") scheduleCodexModelRefresh()
  return Response.json({
    discovery: provider.prefix === "codex" ? await codexDiscoveryStatus() : undefined,
    provider,
    apiKeys: apiKeys.map((apiKey) => ({ ...apiKey, key: maskApiKey(apiKey.key) })),
    models: models.map(stripUnprefixed),
  })
}

export async function DELETE(_request: Request, params: { providerId: string }) {
  const { providerId } = params
  try {
    const provider = await getProvider(providerId)
    if (provider?.prefix === "codex") throw new Error("The Codex provider is fixed and cannot be deleted.")
    await deleteProvider(providerId)
    recordLog("admin.provider.deleted", { providerId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.provider.delete.failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete provider.", 400)
  }
}
