import { requireAdmin } from "@/lib/auth"
import { deletePendingCliProxyCodexLogin, takePendingCliProxyCodexLogin } from "@/lib/codex-cli-login"
import { completeCliProxyCodexLogin, registerCliProxyCodexAccount } from "@/lib/cliproxy-codex"
import { ensureCodexProvider } from "@/lib/codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { currentWorkspaceId } from "@/lib/workspace-context"

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as { loginId?: unknown; name?: unknown } | null
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim() : ""
  if (!loginId) return jsonError("CLIProxy login ID is required.", 400)
  const login = takePendingCliProxyCodexLogin(loginId)
  if (!login) {
    return jsonError("CLIProxy login has expired. Start it again.", 410)
  }
  try {
    const completed = await completeCliProxyCodexLogin(login.authFiles, currentWorkspaceId(), typeof body?.name === "string" ? body.name : undefined)
    if (!completed) return Response.json({ status: "pending" }, { status: 202 })
    const provider = await ensureCodexProvider()
    const account = await registerCliProxyCodexAccount(provider, { name: completed.name, authFile: completed.file })
    deletePendingCliProxyCodexLogin(loginId)
    writeLog("info", "admin", "CLIProxy Codex account mapped", { accountId: account.id })
    return Response.json({ status: "authorized", account: { id: account.id, name: account.name, email: account.email, accountId: account.accountId, planType: account.planType, providerId: provider.id } })
  } catch (error) {
    writeLog("error", "admin", "CLIProxy Codex login failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to finish Codex login.", 502)
  }
}
