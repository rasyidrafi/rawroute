import { redeemCodexReset } from "@/lib/codex/reset"
import { listCodexAccounts } from "@/lib/codex/oauth"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

export async function POST(request: Request, params: { accountId: string }) {
  const accountId = params.accountId
  const body = await request.json().catch(() => null) as { confirmation?: unknown } | null
  const result = await listCodexAccounts()
  const account = result.accounts.find((entry) => entry.id === accountId)
  if (!account) return jsonError("Codex account not found.", 404)
  try {
    return Response.json(await redeemCodexReset(account, typeof body?.confirmation === "string" ? body.confirmation : ""))
  } catch (error) {
    recordLog("admin.codex.reset.credit.redemption.failed", { accountId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to redeem Codex reset credit.", 400)
  }
}
