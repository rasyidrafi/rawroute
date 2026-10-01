import { cliproxyManagementJson } from "@/lib/cliproxy/gateway"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

const endpoints: Record<string, string> = {
  anthropic: "anthropic-auth-url",
  codex: "codex-auth-url",
  antigravity: "antigravity-auth-url",
  kimi: "kimi-auth-url",
  xai: "xai-auth-url",
}

function rewriteCallbackUrl(value: unknown, provider: string, request: Request) {
  if (typeof value !== "string") return value
  try {
    const url = new URL(value)
    const publicOrigin = process.env.RAWROUTE_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin
    const callback = `${publicOrigin}/${provider}/callback`
    if (url.searchParams.has("redirect_uri")) url.searchParams.set("redirect_uri", callback)
    return url.toString()
  } catch { return value }
}

export async function GET(request: Request, params: { provider: string }) {
  const provider = params.provider
  const endpoint = endpoints[provider]
  if (!endpoint) return jsonError("Unsupported CLIProxy login provider.", 400)
  const { response, data } = await cliproxyManagementJson(`/v0/management/${endpoint}`)
  if (!response.ok) return jsonError("CLIProxy login could not be started.", response.status)
  recordLog("admin.cliproxy.oauth.login.started", { provider }, { level: "info" })
  return Response.json(data && typeof data === "object" ? { ...data as Record<string, unknown>, url: rewriteCallbackUrl((data as Record<string, unknown>).url, provider, request) } : { status: "ok" })
}
