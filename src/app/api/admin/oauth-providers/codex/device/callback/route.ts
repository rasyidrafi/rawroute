import { requireAdmin } from "@/lib/auth"
import { takePendingCliProxyCodexLogin } from "@/lib/codex-cli-login"
import { submitCliProxyCodexCallback } from "@/lib/cliproxy-codex"
import { jsonError } from "@/lib/http"
import { currentWorkspaceId } from "@/lib/workspace-context"

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as { loginId?: unknown; redirectUrl?: unknown } | null
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim() : ""
  const redirectUrl = typeof body?.redirectUrl === "string" ? body.redirectUrl.trim() : ""
  if (!loginId || !redirectUrl) return jsonError("Login ID and callback URL are required.", 400)

  const login = await takePendingCliProxyCodexLogin(loginId)
  if (!login) return jsonError("CLIProxy login has expired. Start it again.", 410)
  if (login.workspaceId !== currentWorkspaceId()) return jsonError("Codex login belongs to another workspace.", 403)

  let callback: URL
  try { callback = new URL(redirectUrl) } catch { return jsonError("Paste the complete localhost callback URL from your browser.", 400) }
  if (callback.protocol !== "http:" || callback.hostname !== "localhost" || callback.port !== "1455" || callback.pathname !== "/auth/callback") {
    return jsonError("Callback URL must start with http://localhost:1455/auth/callback.", 400)
  }
  if (callback.searchParams.get("state") !== login.state) return jsonError("Callback URL does not match this Codex login.", 400)
  const code = callback.searchParams.get("code")?.trim()
  const error = callback.searchParams.get("error")?.trim() || callback.searchParams.get("error_description")?.trim()
  if (!code && !error) return jsonError("Callback URL has no authorization code.", 400)

  try {
    await submitCliProxyCodexCallback({ state: login.state, ...(code ? { code } : { error }) })
    return Response.json({ ok: true })
  } catch (submitError) {
    return jsonError(submitError instanceof Error ? submitError.message : "Unable to submit Codex callback.", 502)
  }
}
