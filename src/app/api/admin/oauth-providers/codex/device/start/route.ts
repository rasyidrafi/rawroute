import { randomUUID } from "node:crypto"

import { requireAdmin } from "@/lib/auth"
import { deletePendingCliProxyCodexLogin, reservePendingCliProxyCodexLogin, savePendingCliProxyCodexLogin } from "@/lib/codex-cli-login"
import { cancelCliProxyCodexLogin, startCliProxyCodexLogin } from "@/lib/cliproxy-codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { currentWorkspaceId } from "@/lib/workspace-context"

function publicCallback(urlText: string, request: Request) {
  const url = new URL(urlText)
  const publicOrigin = process.env.RAWROUTE_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin
  url.searchParams.set("redirect_uri", `${publicOrigin}/codex/callback`)
  return url.toString()
}

export async function POST(request: Request) {
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
    return Response.json({ loginId, authorizationUrl: publicCallback(login.url, request) })
  } catch (error) {
    writeLog("error", "admin", "CLIProxy Codex login start failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to start Codex login.", 502)
  }
}
