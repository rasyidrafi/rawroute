import { requireAdmin } from "@/lib/auth"
import { getCodexUsageForAccount } from "@/lib/codex-usage"
import { listCodexAccounts } from "@/lib/codex"
import { jsonError } from "@/lib/http"


export async function GET() {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  try {
    const { accounts } = await listCodexAccounts()
    const entries = await Promise.all(accounts.map(async (account) => [
      account.id,
      await getCodexUsageForAccount(account),
    ] as const))
    return Response.json({ accounts: Object.fromEntries(entries) })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to load Codex usage.", 500)
  }
}
