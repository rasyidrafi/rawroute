import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { cliproxyManagement, cliproxyManagementJson } from "@/lib/cliproxy/management"
import { reservePendingCliProxyCodexLogin, savePendingCliProxyCodexLogin, deletePendingCliProxyCodexLogin } from "@/lib/codex/cli-login"
import { localRedisGet, localRedisSet, localRedisDelete } from "@/lib/local-redis"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { globalManagement } from "./admin"
import { boundedObject } from "./request"
import { redact } from "./redaction"

const providers = z.enum(["anthropic", "codex", "antigravity", "kimi", "xai"])
const sessionSchema = z.object({ id: z.string(), provider: providers })
function sessionKey(state: string) { return `rawroute:cliproxy-global-oauth:${createHash("sha256").update(state).digest("hex")}` }
async function session(state: string) {
  const raw = await localRedisGet(sessionKey(state))
  if (typeof raw !== "string") return undefined
  const parsed = sessionSchema.safeParse(JSON.parse(raw))
  return parsed.success ? parsed.data : undefined
}
async function finish(state: string, entry: z.infer<typeof sessionSchema>) {
  if (entry.provider === "codex") await deletePendingCliProxyCodexLogin(entry.id)
  await localRedisDelete(sessionKey(state))
}

export function startOauth(request: Request, params: { provider: string }) { return globalManagement(request, true, async () => {
  const provider = providers.safeParse(params.provider)
  if (!provider.success) return jsonError("Unsupported OAuth provider.", 400)
  const id = `global-${randomUUID()}`
  if (provider.data === "codex") await reservePendingCliProxyCodexLogin(id)
  let state: string | undefined
  try {
    const { response, data } = await cliproxyManagementJson<Record<string, unknown>>(`/v0/management/${provider.data}-auth-url${provider.data === "codex" ? "?is_webui=true" : ""}`)
    state = typeof data?.state === "string" ? data.state : undefined
    if (!response.ok || !state) throw new Error("OAuth could not be started.")
    if (provider.data === "codex") await savePendingCliProxyCodexLogin(id, { state, workspaceId: "__global__", authFiles: {} })
    if (!await localRedisSet(sessionKey(state), JSON.stringify({ id, provider: provider.data }), 300_000)) throw new Error("Unable to persist OAuth state.")
    recordLog("admin.cliproxy.oauth.login.started", { action: provider.data })
    return Response.json(redact(data))
  } catch (error) {
    if (state) await cliproxyManagement(`/v0/management/oauth-session?state=${encodeURIComponent(state)}`, { method: "DELETE" }).catch(() => undefined)
    if (provider.data === "codex") await deletePendingCliProxyCodexLogin(id)
    throw error
  }
}) }

export function oauthStatus(request: Request) { return globalManagement(request, false, async () => {
  const state = new URL(request.url).searchParams.get("state") || ""
  const entry = state && await session(state)
  if (!entry) return jsonError("Global OAuth session expired or belongs to a workspace.", 410)
  const { response, data } = await cliproxyManagementJson<{ status?: string }>(`/v0/management/get-auth-status?state=${encodeURIComponent(state)}`)
  if (!response.ok) return jsonError("OAuth status is unavailable.", response.status)
  if (["ok", "error", "failed", "cancelled", "canceled", "expired"].includes(data?.status || "")) await finish(state, entry)
  return Response.json(redact(data))
}) }
export function cancelOauth(request: Request) { return globalManagement(request, true, async () => {
  const state = new URL(request.url).searchParams.get("state") || ""
  const entry = state && await session(state)
  if (!entry) return jsonError("Global OAuth session expired or belongs to a workspace.", 410)
  const response = await cliproxyManagement(`/v0/management/oauth-session?state=${encodeURIComponent(state)}`, { method: "DELETE" })
  if (!response.ok) return jsonError("OAuth cancellation failed.", response.status)
  await finish(state, entry)
  recordLog("admin.cliproxy.oauth.login.cancelled")
  return Response.json({ ok: true })
}) }
export function oauthCallback(request: Request, params: { provider: string }) { return globalManagement(request, true, async () => {
  const input = z.strictObject({ state: z.string().min(1).max(512), code: z.string().max(4096).optional(), error: z.string().max(512).optional() }).safeParse(await boundedObject(request).catch(() => null))
  if (!input.success || !input.data.code && !input.data.error) return jsonError("Provide OAuth state and code or error.", 400)
  const entry = await session(input.data.state)
  if (!entry || entry.provider !== params.provider) return jsonError("OAuth session does not match this provider.", 409)
  const response = await cliproxyManagement("/v0/management/oauth-callback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: entry.provider, ...input.data }) })
  return response.ok ? Response.json({ ok: true }) : jsonError("OAuth callback failed.", response.status)
}) }
