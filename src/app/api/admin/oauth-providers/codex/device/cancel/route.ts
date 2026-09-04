import { requireAdmin } from "@/lib/auth"
import { deletePendingCliProxyCodexLogin, takePendingCliProxyCodexLogin } from "@/lib/codex-cli-login"
import { cancelCliProxyCodexLogin } from "@/lib/cliproxy-codex"
import { jsonError } from "@/lib/http"
import { currentWorkspaceId } from "@/lib/workspace-context"

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as { loginId?: unknown } | null
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim() : ""
  if (!loginId) return jsonError("CLIProxy login ID is required.", 400)
  const login = await takePendingCliProxyCodexLogin(loginId)
  if (!login) return Response.json({ ok: true })
  if (login.workspaceId !== currentWorkspaceId()) return jsonError("Codex login belongs to another workspace.", 403)
  try {
    await cancelCliProxyCodexLogin(login.state)
  } finally {
    await deletePendingCliProxyCodexLogin(loginId)
  }
  return Response.json({ ok: true })
}
