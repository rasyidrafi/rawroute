import { destroySession, isAuthenticated } from "../../../../runtime"
import { recordLog } from "@rawroute/observability/server/recorder"
import { runWithAuditIdentity } from "@rawroute/observability/server/audit-context"
import { appendAudit } from "../../../../audit"
import { requestContext } from "@rawroute/observability/server/request-context"

export async function POST(request: Request) {
  await runWithAuditIdentity(await isAuthenticated(request) ? "administrator" : "anonymous", requestContext().requestId || crypto.randomUUID(), () => appendAudit({ action: "auth.logout", resource: "administrator", result: "success" }))
  recordLog("auth.logout", {}, { level: "info" })
  return Response.json({ ok: true }, { headers: { "set-cookie": destroySession(), "cache-control": "no-store" } })
}
