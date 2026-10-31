import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "../../../../../../../logging"
import { scheduleCodexModelRefresh } from "../../../../../../../codex/model-refresh"
import { getCodexCredential } from "../../../../../../../codex-credentials"
import {
  nameCodexLoginAccount,
  observeCodexLogin,
} from "../../../../../../../codex/login"

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { loginId?: unknown; name?: unknown } | null
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim() : ""
  if (!loginId) return jsonError("Codex login ID is required.", 400)
  const name = typeof body?.name === "string" ? body.name.trim() : ""

  const observation = await observeCodexLogin(loginId)
  if (observation.kind === "unknown") return jsonError("Codex login has expired. Start it again.", 410)
  if (observation.workspaceId !== currentWorkspaceId()) return jsonError("Codex login belongs to another workspace.", 403)
  if (observation.kind === "pending") return Response.json({ status: "pending" }, { status: 202 })

  const outcome = observation.outcome
  // The callback arrived and its code exchange is still running upstream.
  if (outcome.status === "exchanging") return Response.json({ status: "pending" }, { status: 202 })
  if (outcome.status === "denied") return jsonError("The Codex sign-in was declined.", 401)
  try {
    const account = await (name ? nameCodexLoginAccount(outcome.account, name) : getCodexCredential(outcome.account.providerId, outcome.account.id))
    if (!account) return jsonError("Codex account not found.", 404)
    scheduleCodexModelRefresh(true)
    recordLog("admin.codex.account.connected", { accountId: account.accountId ?? account.id }, { level: "info" })
    return Response.json({ status: "authorized", account: { id: account.id, name: account.name, email: account.email, accountId: account.accountId, planType: account.planType, providerId: account.providerId } })
  } catch (error) {
    recordLog("admin.codex.login.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to finish Codex login.", 502)
  }
}
