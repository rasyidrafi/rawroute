import { requireAdmin } from "@/lib/auth"
import { CliProxyProviderSyncError, syncNonCodexProviderProjection } from "@/lib/cliproxy-provider-sync"
import { normalizeProviderBaseUrl, validateProviderCliProxyCompatibility } from "@/lib/cliproxy-provider-capabilities"
import { cleanId, jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { validateProviderHeaders } from "@/lib/provider-headers"
import { listProviders, upsertProvider } from "@/lib/store"
import type { Protocol, Provider } from "@/lib/types"


export async function GET() {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const providers = await listProviders()
  return Response.json({ providers })
}

export async function POST(request: Request) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const input = body.provider as (Partial<Provider> & { originalId?: string; authType?: string }) | undefined
  if (!input) return jsonError("Provider payload is required.", 400)

  try {
    const prefix = cleanId(input.prefix || "")
    const name = typeof input.name === "string" ? input.name.trim() : ""
    const rawBaseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/$/, "") : ""
    if (!prefix || !name || !rawBaseUrl || !input.protocol) throw new Error("Provider fields are incomplete.")
    if (prefix === "codex" || prefix === "cliproxy") throw new Error("This provider prefix is reserved by RawRoute.")
    if (!["openai-chat", "openai-responses", "anthropic-messages"].includes(input.protocol)) throw new Error("Invalid provider protocol.")
    if (input.authType !== undefined && !["bearer", "x-api-key", "none"].includes(input.authType)) throw new Error("Invalid provider authentication type.")
    if (input.supportPromptCacheKey !== undefined && typeof input.supportPromptCacheKey !== "boolean") throw new Error("supportPromptCacheKey must be a boolean.")
    new URL(rawBaseUrl)
    const baseUrl = normalizeProviderBaseUrl(input.protocol as Protocol, rawBaseUrl)
    const authType = (input.authType || "bearer") as Provider["authType"]
    const openAICompatible = input.protocol !== "anthropic-messages"
    validateProviderCliProxyCompatibility({ protocol: input.protocol as Protocol, baseUrl, authType })
    const provider = await upsertProvider({
      originalId: input.originalId,
      name,
      prefix,
      baseUrl,
      protocol: input.protocol as Protocol,
      authType,
      headers: validateProviderHeaders(input.headers || {}),
      supportPromptCacheKey: openAICompatible ? input.supportPromptCacheKey : false,
      enabled: input.enabled !== false,
    })
    if (provider.prefix !== "codex") await syncNonCodexProviderProjection(provider.id)
    writeLog("info", "admin", "Provider saved", { providerId: provider.id })
    return Response.json({ ok: true, providerId: provider.id })
  } catch (error) {
    writeLog("error", "admin", "Provider save failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save provider.", error instanceof CliProxyProviderSyncError ? error.status : 400)
  }
}
