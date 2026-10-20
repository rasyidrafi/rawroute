import { withManagementMutation } from "../../../../../../../cliproxy/mutations"
import { randomUUID } from "node:crypto"

import { deletePendingCliProxyCodexLogin, reservePendingCliProxyCodexLogin, savePendingCliProxyCodexLogin, settlePendingCliProxyCodexLogin } from "../../../../../../../codex/cli-login"
import { cancelCliProxyCodexLogin, startCliProxyCodexLogin } from "../../../../../../../codex/cliproxy"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../../logging"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"

export function POST() { return withManagementMutation(post) }

async function post() {
  try {
    const loginId = randomUUID()
    await reservePendingCliProxyCodexLogin(loginId)
    let login: Awaited<ReturnType<typeof startCliProxyCodexLogin>> | undefined
    try {
      login = await startCliProxyCodexLogin()
      await savePendingCliProxyCodexLogin(loginId, { state: login.state, workspaceId: currentWorkspaceId(), authFiles: login.existingAuthFiles })
    } catch (error) {
      if (login) await cancelCliProxyCodexLogin(login.state).then(() => settlePendingCliProxyCodexLogin(loginId)).catch(() => undefined)
      await deletePendingCliProxyCodexLogin(loginId)
      throw error
    }
    if (!login) throw new Error("CLIProxy Codex login did not start.")
    recordLog("admin.cliproxy.codex.login.started", {}, { level: "info" })
    return Response.json({ loginId, authorizationUrl: login.url })
  } catch (error) {
    recordLog("admin.cliproxy.codex.login.start.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to start Codex login.", 502)
  }
}
