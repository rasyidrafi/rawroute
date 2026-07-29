import { requireAdmin } from "@/lib/auth"
import { cleanId, gatewayModelId, jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { validateProviderHeaders } from "@/lib/provider-headers"
import { validateRequestOverrides } from "@/lib/request-overrides"
import { hashPassword, readData, updateData, validatePasswordUpdate } from "@/lib/store"
import type { ApiKey, Model, Protocol, Provider, ProviderApiKey } from "@/lib/types"

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
    providers: data.providers,
    providerApiKeys: data.providerApiKeys.map((apiKey) => ({
      ...apiKey,
      key: apiKey.key ? "__unchanged__" : "",
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

      if (body.action === "update-password") {
        const currentPassword = String(body.currentPassword || "")
        const newPassword = String(body.newPassword || "")
        const confirmPassword = String(body.confirmPassword || "")
        validatePasswordUpdate(currentPassword, newPassword, confirmPassword, data.admin.passwordHash)
        data.admin.passwordHash = hashPassword(newPassword)
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
        const provider: Provider = {
          id,
          name: input.name.trim(),
          prefix,
          baseUrl: input.baseUrl.replace(/\/$/, ""),
          protocol: input.protocol as Protocol,
          authType: input.authType || "bearer",
          ...(input.authHeader?.trim() ? { authHeader: input.authHeader.trim() } : {}),
          headers: validateProviderHeaders(input.headers || {}),
          enabled: input.enabled !== false,
          createdAt: existing?.createdAt || new Date().toISOString(),
        }
        data.providers = [...data.providers.filter((item) => item.id !== originalId), provider]
        if (originalId && originalId !== id) {
          data.providerApiKeys = data.providerApiKeys.map((apiKey) => apiKey.providerId === originalId ? { ...apiKey, providerId: id } : apiKey)
        }
        data.models = migratedModels
        return
      }

      if (body.action === "save-provider-api-key") {
        const input = body.providerApiKey as Partial<ProviderApiKey> & { originalId?: string }
        const providerId = String(input.providerId || "")
        if (!data.providers.some((provider) => provider.id === providerId)) throw new Error("Provider is missing.")
        const name = String(input.name || "").trim()
        if (!name) throw new Error("API key name is required.")
        if (name.length > 80) throw new Error("API key name must be 80 characters or fewer.")
        const existing = input.originalId ? data.providerApiKeys.find((apiKey) => apiKey.id === input.originalId) : undefined
        const key = input.key === "__unchanged__" ? existing?.key : String(input.key || "").trim()
        if (!key) throw new Error("API key value is required.")
        const rpmLimit = input.rpmLimit == null ? undefined : Number(input.rpmLimit)
        const maxConcurrency = input.maxConcurrency == null ? undefined : Number(input.maxConcurrency)
        const priority = input.priority == null ? undefined : Number(input.priority)
        if (rpmLimit !== undefined && (!Number.isSafeInteger(rpmLimit) || rpmLimit <= 0)) throw new Error("RPM limit must be a positive whole number.")
        if (maxConcurrency !== undefined && (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0)) throw new Error("Maximum concurrency must be a positive whole number.")
        if (priority !== undefined && (!Number.isSafeInteger(priority) || priority < 0 || priority > 100)) throw new Error("Priority must be a whole number from 0 to 100.")
        const providerApiKey: ProviderApiKey = {
          id: existing?.id || crypto.randomUUID(),
          providerId,
          name,
          key,
          enabled: input.enabled !== false,
          ...(rpmLimit !== undefined ? { rpmLimit } : {}),
          ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
          ...(priority !== undefined ? { priority } : {}),
          createdAt: existing?.createdAt || new Date().toISOString(),
        }
        data.providerApiKeys = [...data.providerApiKeys.filter((apiKey) => apiKey.id !== input.originalId), providerApiKey]
        return
      }

      if (body.action === "delete-provider-api-key") {
        data.providerApiKeys = data.providerApiKeys.filter((apiKey) => apiKey.id !== String(body.id))
        return
      }

      if (body.action === "delete-provider") {
        const id = String(body.id)
        data.providers = data.providers.filter((item) => item.id !== id)
        data.providerApiKeys = data.providerApiKeys.filter((item) => item.providerId !== id)
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
          ...(input.requestOverrides && Object.keys(input.requestOverrides).length ? { requestOverrides: validateRequestOverrides(input.requestOverrides) } : {}),
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
        const name = String(body.name || "").trim()
        if (!name) throw new Error("API key name is required.")
        if (name.length > 80) throw new Error("API key name must be 80 characters or fewer.")
        const key: ApiKey = {
          id: crypto.randomUUID(),
          name,
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

    writeLog("info", "admin", "Dashboard action completed", { action: body.action })
    return Response.json({ ok: true, mustChangePassword: data.admin.mustChangePassword })
  } catch (error) {
    writeLog("error", "admin", "Dashboard action failed", { action: body.action, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save changes.", 400)
  }
}
