import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { jsonError } from "@rawroute/observability/contracts/http"

import { cancelCodexLogin, observeCodexLogin } from "../../../../../../../codex/login"

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { loginId?: unknown } | null
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim() : ""
  if (!loginId) return jsonError("Codex login ID is required.", 400)
  // Observe the login coherently: a login mid-exchange has no pending session
  // left, but its exchanging outcome is visible, so the cancellation still
  // reaches the running exchange instead of becoming a silent no-op.
  const observation = await observeCodexLogin(loginId)
  if (observation.kind === "unknown") return Response.json({ ok: true })
  if (observation.workspaceId !== currentWorkspaceId()) return jsonError("Codex login belongs to another workspace.", 403)
  const result = await cancelCodexLogin(loginId, observation.workspaceId)
  // The registration committed before the cancellation took effect; the
  // cancellation must not claim it cancelled the now-connected account.
  if (!result.cancelled) return jsonError("The Codex account was connected before the cancellation took effect.", 409)
  return Response.json({ ok: true })
}
