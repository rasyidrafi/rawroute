import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteProvider, getProvider, listProviderApiKeys, listProviderModels } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId } = await context.params
  const [provider, apiKeys, models] = await Promise.all([
    getProvider(providerId),
    listProviderApiKeys(providerId),
    listProviderModels(providerId),
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
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId } = await context.params
  try {
    await deleteProvider(providerId)
    writeLog("info", "admin", "Provider deleted", { providerId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Provider delete failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete provider.", 400)
  }
}
