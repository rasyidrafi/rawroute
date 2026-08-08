import { requireAdmin } from "@/lib/auth"
import { codexDeviceRedirectUri, exchangeCodexAuthorizationCode, pollCodexDeviceCode, saveCodexAccount } from "@/lib/codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"


export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as { deviceAuthId?: unknown; userCode?: unknown; name?: unknown } | null
  const deviceAuthId = typeof body?.deviceAuthId === "string" ? body.deviceAuthId.trim() : ""
  const userCode = typeof body?.userCode === "string" ? body.userCode.trim() : ""
  if (!deviceAuthId || !userCode) return jsonError("Device authentication values are required.", 400)
  try {
    const result = await pollCodexDeviceCode(deviceAuthId, userCode)
    if (result.status === "pending") return Response.json({ status: "pending" }, { status: 202 })
    const token = await exchangeCodexAuthorizationCode(result.code, result.verifier, codexDeviceRedirectUri())
    const saved = await saveCodexAccount(token, typeof body?.name === "string" ? body.name : undefined)
    writeLog("info", "admin", "Codex account authorized", { accountId: saved.account.id })
    return Response.json({ status: "authorized", account: {
      id: saved.account.id,
      name: saved.account.name,
      email: saved.account.email,
      accountId: saved.account.accountId,
      planType: saved.account.planType,
      providerId: saved.provider.id,
    } })
  } catch (error) {
    writeLog("error", "admin", "Codex device login failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to finish Codex device login.", 502)
  }
}
