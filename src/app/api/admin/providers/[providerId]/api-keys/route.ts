import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { upsertProviderApiKey } from "@/lib/store"
import type { ProviderApiKey } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function parseInteger(value: unknown, label: string, minimum: number, maximum?: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) {
    throw new Error(`${label} must be a valid whole number.`)
  }
  return parsed
}

export async function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const { providerId } = await context.params
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const input = body.providerApiKey as Partial<ProviderApiKey> & { originalId?: string } | undefined
  if (!input) return jsonError("Provider API key payload is required.", 400)

  try {
    const name = typeof input.name === "string" ? input.name.trim() : ""
    if (!name) throw new Error("API key name is required.")
    if (name.length > 80) throw new Error("API key name must be 80 characters or fewer.")
    const key = input.key === "__unchanged__"
      ? input.key
      : typeof input.key === "string" ? input.key.trim() : ""
    if (!key) throw new Error("API key value is required.")
    const rpmLimit = parseInteger(input.rpmLimit, "RPM limit", 1)
    const maxConcurrency = parseInteger(input.maxConcurrency, "Maximum concurrency", 1)
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Enabled value must be a boolean.")
    await upsertProviderApiKey(providerId, {
      originalId: input.originalId,
      name,
      key,
      enabled: input.enabled,
      rpmLimit,
      maxConcurrency,
    })
    writeLog("info", "admin", "Provider API key saved", { providerId })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Provider API key save failed", { providerId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save provider API key.", 400)
  }
}
