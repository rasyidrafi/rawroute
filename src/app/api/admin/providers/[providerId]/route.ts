import { requireAdmin } from "@/lib/auth"
import { CliProxyProviderSyncError, syncNonCodexProviderProjection } from "@/lib/cliproxy-provider-sync"
import { ensureCodexProvider } from "@/lib/codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteProvider, getProvider, listProviderApiKeys, listProviderModels } from "@/lib/store"


function stripUnprefixed<T>(value: T): Omit<T, "unprefixed"> {
  const { unprefixed, ...rest } = value as T & { unprefixed?: unknown }
  void unprefixed
  return rest
}

function maskApiKey(key: string): string {
  return key ? "__unchanged__" : ""
}

export async function GET(_request: Request, context: { params: Promise<{ providerId: string }> }) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId } = await context.params
  const provider = providerId === "codex" ? await ensureCodexProvider() : await getProvider(providerId)
  const resolvedId = provider?.id || providerId
  const [apiKeys, models] = await Promise.all([
    listProviderApiKeys(resolvedId),
    listProviderModels(resolvedId),
  ])
  if (!provider) return jsonError("Provider not found.", 404)
  return Response.json({
    provider,
    apiKeys: apiKeys.map((apiKey) => ({ ...apiKey, key: maskApiKey(apiKey.key) })),
    models: models.map(stripUnprefixed),
  })
}

export async function DELETE(_request: Request, context: { params: Promise<{ providerId: string }> }) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId } = await context.params
  try {
    const provider = await getProvider(providerId)
    if (provider?.prefix === "codex") throw new Error("The Codex provider is fixed and cannot be deleted.")
    await deleteProvider(providerId)
    await syncNonCodexProviderProjection(providerId)
    writeLog("info", "admin", "Provider deleted", { providerId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Provider delete failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete provider.", error instanceof CliProxyProviderSyncError ? error.status : 400)
  }
}
