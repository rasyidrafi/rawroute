import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../../logging"
import {
  CodexLoginExpiredError,
  completeCodexLogin,
  takePendingCodexLogin,
} from "../../../../../../../codex/login"

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { loginId?: unknown; redirectUrl?: unknown } | null
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim() : ""
  const redirectUrl = typeof body?.redirectUrl === "string" ? body.redirectUrl.trim() : ""
  if (!loginId || !redirectUrl) return jsonError("Login ID and callback URL are required.", 400)

  const login = await takePendingCodexLogin(loginId)
  if (!login) return jsonError("Codex login has expired. Start it again.", 410)
  if (login.workspaceId !== currentWorkspaceId()) return jsonError("Codex login belongs to another workspace.", 403)

  let callback: URL
  try { callback = new URL(redirectUrl) } catch { return jsonError("Paste the complete localhost callback URL from your browser.", 400) }
  if (callback.protocol !== "http:" || callback.hostname !== "localhost" || callback.port !== "1455" || callback.pathname !== "/auth/callback") {
    return jsonError("Callback URL must start with http://localhost:1455/auth/callback.", 400)
  }
  // PKCE state: the callback must answer this login's own authorize request.
  if (callback.searchParams.get("state") !== login.state) return jsonError("Callback URL does not match this Codex login.", 400)
  const code = callback.searchParams.get("code")?.trim()
  const error = callback.searchParams.get("error")?.trim() || callback.searchParams.get("error_description")?.trim()
  if (!code && !error) return jsonError("Callback URL has no authorization code.", 400)

  try {
    await completeCodexLogin(loginId, login, { ...(code ? { code } : { error }) })
    return Response.json({ ok: true })
  } catch (error) {
    if (error instanceof CodexLoginExpiredError) return jsonError(error.message, 410)
    recordLog("admin.codex.login.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to finish Codex login.", 502)
  }
}
