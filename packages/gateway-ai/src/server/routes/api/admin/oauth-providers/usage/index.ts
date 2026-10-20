import { getCodexUsageForAccount } from "../../../../../codex/usage"
import { listCodexAccounts } from "../../../../../codex/oauth"
import { jsonError } from "@rawroute/observability/contracts/http"


export async function GET() {
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
