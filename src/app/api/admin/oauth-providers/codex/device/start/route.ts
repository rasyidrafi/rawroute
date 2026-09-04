import { randomUUID } from "node:crypto"

import { requireAdmin } from "@/lib/auth"
import { deletePendingCliProxyCodexLogin, reservePendingCliProxyCodexLogin, savePendingCliProxyCodexLogin } from "@/lib/codex-cli-login"
import { cancelCliProxyCodexLogin, startCliProxyCodexLogin } from "@/lib/cliproxy-codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { currentWorkspaceId } from "@/lib/workspace-context"

export async function POST() {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
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
    writeLog("info", "admin", "CLIProxy Codex login started")
    return Response.json({ loginId, authorizationUrl: login.url })
  } catch (error) {
    writeLog("error", "admin", "CLIProxy Codex login start failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to start Codex login.", 502)
  }
}
