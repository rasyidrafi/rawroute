import { createSession } from "../../../../runtime"
import { jsonError } from "@rawroute/observability/contracts/http"

import { recordLog } from "@rawroute/observability/server/recorder"
import { readMeta } from "../../../../runtime"
import { verifyPassword } from "../../../../identity"
import { runWithAuditIdentity } from "@rawroute/observability/server/audit-context"
import { appendAudit } from "../../../../audit"
import { requestContext } from "@rawroute/observability/server/request-context"

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body) || !("password" in body) || typeof body.password !== "string" || !body.password) {
    await appendAudit({ action: "auth.login", resource: "administrator", result: "failure" })
    return jsonError("Password is required.", 400)
  }
  const data = await readMeta()
  if (!verifyPassword(body.password, data.admin.passwordHash)) {
    await appendAudit({ action: "auth.login", resource: "administrator", result: "failure" })
    recordLog("auth.login.rejected", {}, { level: "warn" })
    return jsonError("Invalid password.", 401)
  }
  const cookie = await createSession(request)
  await runWithAuditIdentity("administrator", requestContext().requestId || crypto.randomUUID(), () => appendAudit({ action: "auth.login", resource: "administrator", result: "success" }))
  recordLog("auth.login.succeeded", {}, { level: "info" })
  return Response.json({ ok: true, mustChangePassword: data.admin.mustChangePassword }, { headers: { "set-cookie": cookie, "cache-control": "no-store" } })
}
