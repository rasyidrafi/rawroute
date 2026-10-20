import { withManagementMutation } from "../../../../../../../cliproxy/mutations"
import { deletePendingCliProxyCodexLogin, settlePendingCliProxyCodexLogin, takePendingCliProxyCodexLogin } from "../../../../../../../codex/cli-login"
import { cancelCliProxyCodexLogin } from "../../../../../../../codex/cliproxy"
import { jsonError } from "@rawroute/observability/contracts/http"

import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"

export function POST(request: Request) { return withManagementMutation(() => post(request)) }

async function post(request: Request) {
  const body = await request.json().catch(() => null) as { loginId?: unknown } | null
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim() : ""
  if (!loginId) return jsonError("CLIProxy login ID is required.", 400)
  const login = await takePendingCliProxyCodexLogin(loginId)
  if (!login) return Response.json({ ok: true })
  if (login.workspaceId !== currentWorkspaceId()) return jsonError("Codex login belongs to another workspace.", 403)
  try {
    await cancelCliProxyCodexLogin(login.state)
    await settlePendingCliProxyCodexLogin(loginId)
  } finally {
    await deletePendingCliProxyCodexLogin(loginId)
  }
  return Response.json({ ok: true })
}
