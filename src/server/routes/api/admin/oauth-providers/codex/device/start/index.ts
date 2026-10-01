import { withManagementMutation } from "@/server/cliproxy/mutations"
import { randomUUID } from "node:crypto"

import { deletePendingCliProxyCodexLogin, reservePendingCliProxyCodexLogin, savePendingCliProxyCodexLogin } from "@/lib/codex/cli-login"
import { cancelCliProxyCodexLogin, startCliProxyCodexLogin } from "@/lib/codex/cliproxy"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { currentWorkspaceId } from "@/lib/workspace/context"

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
      if (login) await cancelCliProxyCodexLogin(login.state).catch(() => undefined)
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
