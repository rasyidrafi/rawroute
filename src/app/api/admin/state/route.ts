import { requireAdmin } from "@/lib/auth"
import { cleanId, gatewayModelId, jsonError } from "@/lib/http"
import { validateProviderHeaders } from "@/lib/provider-headers"
import { hashPassword, readData, updateData } from "@/lib/store"
import type { ApiKey, Model, Protocol, Provider } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function authorize() {
  try {
    await requireAdmin()
    return true
  } catch {
    return false
  }
}

export async function GET() {
  if (!(await authorize())) return jsonError("Unauthorized", 401)
  const data = await readData()
  return Response.json({
    admin: { username: data.admin.username, mustChangePassword: data.admin.mustChangePassword },
    providers: data.providers.map((provider) => ({
      ...provider,
      secret: provider.secret ? "__unchanged__" : "",
    })),
    models: data.models,
    apiKeys: data.apiKeys,
  })
}

export async function POST(request: Request) {
  if (!(await authorize())) return jsonError("Unauthorized", 401)
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.action !== "string") return jsonError("Invalid action.", 400)

  try {
    const data = await updateData(async (data) => {
      if (body.action === "change-password") {
        const password = String(body.password || "")
        if (password.length < 10) throw new Error("Password must be at least 10 characters.")
        data.admin.passwordHash = hashPassword(password)
        data.admin.mustChangePassword = false
        return
      }

      if (body.action === "save-provider") {
        const input = body.provider as Partial<Provider> & { originalId?: string }
        const id = cleanId(input.id || input.prefix || input.name || "")
        const prefix = cleanId(input.prefix || "")
        if (!id || !prefix || !input.name || !input.baseUrl || !input.protocol) throw new Error("Provider fields are incomplete.")
        new URL(input.baseUrl)
        if (data.providers.some((item) => item.prefix === prefix && item.id !== id)) throw new Error("Provider prefix is already in use.")
        const originalId = input.originalId
        const existing = originalId ? data.providers.find((item) => item.id === originalId) : undefined
        if (data.providers.some((item) => item.id === id && item.id !== originalId)) throw new Error("Provider ID is already in use.")
        const migratedModels = data.models.map((model) => {
          if (!originalId || model.providerId !== originalId) return model
          return { ...model, providerId: id, id: model.unprefixed ? model.id : gatewayModelId(prefix, model.id) }
        })
        const migratedIds = new Set<string>()
        for (const model of migratedModels) {
          if (migratedIds.has(model.id)) throw new Error(`Provider prefix would conflict with model ID ${model.id}.`)
          migratedIds.add(model.id)
        }
        const secret = input.secret === "__unchanged__" ? existing?.secret : input.secret?.trim()
        const provider: Provider = {
          id,
          name: input.name.trim(),
          prefix,
          baseUrl: input.baseUrl.replace(/\/$/, ""),
          protocol: input.protocol as Protocol,
          authType: input.authType || "bearer",
          ...(input.authHeader?.trim() ? { authHeader: input.authHeader.trim() } : {}),
          ...(secret ? { secret } : {}),
          headers: validateProviderHeaders(input.headers || {}),
          enabled: input.enabled !== false,
          createdAt: existing?.createdAt || new Date().toISOString(),
        }
        data.providers = [...data.providers.filter((item) => item.id !== originalId), provider]
        data.models = migratedModels
        return
      }

      if (body.action === "delete-provider") {
        const id = String(body.id)
        data.providers = data.providers.filter((item) => item.id !== id)
        data.models = data.models.filter((item) => item.providerId !== id)
        return
      }

      if (body.action === "save-model") {
        const input = body.model as Partial<Model> & { originalId?: string }
        const provider = data.providers.find((item) => item.id === input.providerId)
        if (!provider || !input.id || !input.name || !input.upstreamModel) throw new Error("Model fields are incomplete.")
        const originalId = input.originalId
        const id = gatewayModelId(provider.prefix, input.id, input.unprefixed === true)
        if (data.models.some((item) => item.id === id && item.id !== originalId)) throw new Error("Gateway model ID is already in use.")
        const existing = originalId ? data.models.find((item) => item.id === originalId) : undefined
        const model: Model = {
          id,
          providerId: provider.id,
          name: input.name.trim(),
          upstreamModel: input.upstreamModel.trim(),
          ...(input.protocol ? { protocol: input.protocol } : {}),
          ...(input.upstreamPath?.trim() ? { upstreamPath: input.upstreamPath.trim() } : {}),
          ...(input.unprefixed ? { unprefixed: true } : {}),
          enabled: input.enabled !== false,
          createdAt: existing?.createdAt || new Date().toISOString(),
        }
        data.models = [...data.models.filter((item) => item.id !== originalId), model]
        return
      }

      if (body.action === "delete-model") {
        data.models = data.models.filter((item) => item.id !== String(body.id))
        return
      }

      if (body.action === "create-api-key") {
        const key: ApiKey = {
          id: crypto.randomUUID(),
          name: String(body.name || "Gateway key"),
          key: `sk-rr-${crypto.randomUUID().replaceAll("-", "")}`,
          createdAt: new Date().toISOString(),
        }
        data.apiKeys.push(key)
        return
      }

      if (body.action === "delete-api-key") {
        if (data.apiKeys.length <= 1) throw new Error("At least one gateway API key is required.")
        data.apiKeys = data.apiKeys.filter((item) => item.id !== String(body.id))
        return
      }

      throw new Error("Unknown action.")
    })

    return Response.json({ ok: true, mustChangePassword: data.admin.mustChangePassword })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to save changes.", 400)
  }
}
