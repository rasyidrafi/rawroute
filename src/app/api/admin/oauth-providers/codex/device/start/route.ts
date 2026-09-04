import { randomUUID } from "node:crypto"

import { requireAdmin } from "@/lib/auth"
import { savePendingCliProxyCodexLogin } from "@/lib/codex-cli-login"
import { startCliProxyCodexLogin } from "@/lib/cliproxy-codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"

function publicCallback(urlText: string, request: Request) {
  const url = new URL(urlText)
  const publicOrigin = process.env.RAWROUTE_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin
  url.searchParams.set("redirect_uri", `${publicOrigin}/codex/callback`)
  return url.toString()
}

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  try {
    const login = await startCliProxyCodexLogin()
    const loginId = randomUUID()
    savePendingCliProxyCodexLogin(loginId, { authFiles: login.existingAuthFiles, expiresAt: Date.now() + 5 * 60_000 })
    writeLog("info", "admin", "CLIProxy Codex login started")
    return Response.json({ loginId, authorizationUrl: publicCallback(login.url, request) })
  } catch (error) {
    writeLog("error", "admin", "CLIProxy Codex login start failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to start Codex login.", 502)
  }
}
