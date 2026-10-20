import { withManagementMutation } from "../../../../../../../cliproxy/mutations"
import { deletePendingCliProxyCodexLogin, settlePendingCliProxyCodexLogin, takePendingCliProxyCodexLogin } from "../../../../../../../codex/cli-login"
import { cancelCliProxyCodexLogin, completeCliProxyCodexLogin, registerCliProxyCodexAccount, setCliProxyCodexAccountPrefix } from "../../../../../../../codex/cliproxy"
import { ensureCodexProvider } from "../../../../../../../codex/oauth"
import { scheduleCodexModelRefresh } from "../../../../../../../codex/model-refresh"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../../logging"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"

export function POST(request: Request) { return withManagementMutation(() => post(request)) }

async function post(request: Request) {
  const body = await request.json().catch(() => null) as { loginId?: unknown; name?: unknown } | null
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim() : ""
  if (!loginId) return jsonError("CLIProxy login ID is required.", 400)
  const login = await takePendingCliProxyCodexLogin(loginId)
  if (!login) {
    return jsonError("CLIProxy login has expired. Start it again.", 410)
  }
  try {
    if (login.workspaceId !== currentWorkspaceId()) return jsonError("Codex login belongs to another workspace.", 403)
    const completed = await completeCliProxyCodexLogin(login.state, login.authFiles, login.workspaceId, typeof body?.name === "string" ? body.name : undefined)
    if (!completed) return Response.json({ status: "pending" }, { status: 202 })
    const provider = await ensureCodexProvider()
    let account: Awaited<ReturnType<typeof registerCliProxyCodexAccount>>
    try {
      account = await registerCliProxyCodexAccount(provider, { name: completed.name, authFile: completed.file })
    } catch (error) {
      await setCliProxyCodexAccountPrefix(completed.file.name, completed.previousPrefix).catch(() => undefined)
      throw error
    }
    await settlePendingCliProxyCodexLogin(loginId)
    scheduleCodexModelRefresh(true)
    recordLog("admin.cliproxy.codex.account.mapped", { accountId: account.id }, { level: "info" })
    return Response.json({ status: "authorized", account: { id: account.id, name: account.name, email: account.email, accountId: account.accountId, planType: account.planType, providerId: provider.id } })
  } catch (error) {
    await cancelCliProxyCodexLogin(login.state).then(() => settlePendingCliProxyCodexLogin(loginId)).catch(() => undefined)
    await deletePendingCliProxyCodexLogin(loginId)
    recordLog("admin.cliproxy.codex.login.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to finish Codex login.", 502)
  }
}
