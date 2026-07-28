import { requireAdmin } from "@/lib/auth"
import { cleanId, jsonError } from "@/lib/http"
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
        const input = body.provider as Partial<Provider>
        const id = cleanId(input.id || input.prefix || input.name || "")
        const prefix = cleanId(input.prefix || "")
        if (!id || !prefix || !input.name || !input.baseUrl || !input.protocol) throw new Error("Provider fields are incomplete.")
        new URL(input.baseUrl)
        if (data.providers.some((item) => item.prefix === prefix && item.id !== id)) throw new Error("Provider prefix is already in use.")
        const existing = data.providers.find((item) => item.id === id)
        const provider: Provider = {
          id,
          name: input.name.trim(),
          prefix,
          baseUrl: input.baseUrl.replace(/\/$/, ""),
          protocol: input.protocol as Protocol,
          authType: input.authType || "bearer",
          authHeader: input.authHeader?.trim() || undefined,
          secret: input.secret === "__unchanged__" ? existing?.secret : input.secret?.trim(),
          headers: validateProviderHeaders(input.headers || {}),
          enabled: input.enabled !== false,
          createdAt: existing?.createdAt || new Date().toISOString(),
        }
        data.providers = [...data.providers.filter((item) => item.id !== id), provider]
        return
      }

      if (body.action === "delete-provider") {
        const id = String(body.id)
        data.providers = data.providers.filter((item) => item.id !== id)
        data.models = data.models.filter((item) => item.providerId !== id)
        return
      }

      if (body.action === "save-model") {
        const input = body.model as Partial<Model>
        const provider = data.providers.find((item) => item.id === input.providerId)
        if (!provider || !input.name || !input.upstreamModel) throw new Error("Model fields are incomplete.")
        const id = `${provider.prefix}/${cleanId(input.name)}`
        const existing = data.models.find((item) => item.id === id)
        const model: Model = {
          id,
          providerId: provider.id,
          name: input.name.trim(),
          upstreamModel: input.upstreamModel.trim(),
          protocol: input.protocol || undefined,
          upstreamPath: input.upstreamPath?.trim() || undefined,
          enabled: input.enabled !== false,
          createdAt: existing?.createdAt || new Date().toISOString(),
        }
        data.models = [...data.models.filter((item) => item.id !== id), model]
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
