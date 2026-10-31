import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../logging"
import { getProvider, upsertProviderApiKey } from "../../../../../../store"
import type { ProviderApiKeyInput } from "../../../../../../../contracts/domain"

function parseLimit(value: unknown, label: string): number | null | undefined {
  if (value === undefined || value === null) return value
  const text = typeof value === "string" ? value.trim() : undefined
  const parsed = typeof value === "number"
    ? value
    : text && /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive whole number.`)
  }
  return parsed
}

export async function POST(request: Request, params: { providerId: string }) {
  const { providerId } = params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const input = body.providerApiKey as ProviderApiKeyInput | undefined
  if (!input) return jsonError("Provider API key payload is required.", 400)

  try {
    const provider = await getProvider(providerId)
    if (!provider) throw new Error("Provider is missing.")
    if (provider.prefix === "codex") throw new Error("Codex accounts are managed from the Codex provider page.")
    if (provider.authType === "none") {
      throw new Error("This provider uses no API keys.")
    }
    const name = typeof input.name === "string" ? input.name.trim() : ""
    if (!name) throw new Error("API key name is required.")
    if (name.length > 80) throw new Error("API key name must be 80 characters or fewer.")
    const key = input.key === "__unchanged__"
      ? input.key
      : typeof input.key === "string" ? input.key.trim() : ""
    if (!key) throw new Error("API key value is required.")
    const rpmLimit = parseLimit(input.rpmLimit, "RPM limit")
    const maxConcurrency = parseLimit(input.maxConcurrency, "Maximum concurrency")
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Enabled value must be a boolean.")
    await upsertProviderApiKey(providerId, {
      originalId: input.originalId,
      name,
      key,
      enabled: input.enabled,
      rpmLimit,
      maxConcurrency,
    })
    recordLog("admin.provider.api.key.saved", { providerId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.provider.api.key.save.failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save provider API key.", 400)
  }
}
