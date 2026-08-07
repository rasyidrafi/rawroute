import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { listAliases, listModels, listProviders, upsertAlias } from "@/lib/store"
import type { ModelAlias } from "@/lib/types"


export async function GET() {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const [aliases, models, providers] = await Promise.all([listAliases(), listModels(), listProviders()])
  return Response.json({ aliases, models, providers })
}

export async function POST(request: Request) {
  try {
    (await requireAdmin())()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)
  const input = body.alias as Partial<ModelAlias> & { originalId?: string } | undefined
  if (!input) return jsonError("Alias payload is required.", 400)

  try {
    const alias = typeof input.alias === "string" ? input.alias.trim() : ""
    const name = typeof input.name === "string" ? input.name.trim() : ""
    const targetModelId = typeof input.targetModelId === "string" ? input.targetModelId.trim() : ""
    if (!alias || !name || !targetModelId) throw new Error("Alias fields are incomplete.")
    const models = await listModels()
    const target = models.find((model) => (model.gatewayModelId || model.id) === targetModelId)
    if (!target) throw new Error("Target model not found.")
    if (!target.enabled) throw new Error("Target model is disabled.")
    await upsertAlias({
      originalId: input.originalId,
      alias,
      name,
      targetModelId,
    })
    writeLog("info", "admin", "Alias saved", { alias })
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Alias save failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save alias.", 400)
  }
}
