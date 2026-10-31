import { startCodexLogin } from "../../../../../../../codex/login"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../../logging"

export async function POST() {
  try {
    const login = await startCodexLogin()
    recordLog("admin.codex.login.started", {}, { level: "info" })
    return Response.json({ loginId: login.loginId, authorizationUrl: login.authorizationUrl })
  } catch (error) {
    recordLog("admin.codex.login.start.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to start Codex login.", 502)
  }
}
