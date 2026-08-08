import { requireAdmin } from "@/lib/auth"
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
  const input = body.provider as Partial<Provider> & { originalId?: string } | undefined
  if (!input) return jsonError("Provider payload is required.", 400)

  try {
    const prefix = cleanId(input.prefix || "")
    const name = typeof input.name === "string" ? input.name.trim() : ""
    const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/$/, "") : ""
    if (!prefix || !name || !baseUrl || !input.protocol) throw new Error("Provider fields are incomplete.")
    if (prefix === "codex" || prefix === "cliproxy") throw new Error("This provider prefix is reserved by RawRoute.")
    if (!["openai-chat", "openai-responses", "anthropic-messages"].includes(input.protocol)) throw new Error("Invalid provider protocol.")
    if (input.authType !== undefined && !["bearer", "x-api-key", "custom-header", "none"].includes(input.authType)) throw new Error("Invalid provider authentication type.")
    new URL(baseUrl)
    const provider = await upsertProvider({
      originalId: input.originalId,
      name,
      prefix,
      baseUrl,
      protocol: input.protocol as Protocol,
      authType: input.authType || "bearer",
      authHeader: typeof input.authHeader === "string" ? input.authHeader.trim() : "",
      headers: validateProviderHeaders(input.headers || {}),
      enabled: input.enabled !== false,
    })
    writeLog("info", "admin", "Provider saved", { providerId: provider.id })
    return Response.json({ ok: true, providerId: provider.id })
  } catch (error) {
    writeLog("error", "admin", "Provider save failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save provider.", 400)
  }
}
