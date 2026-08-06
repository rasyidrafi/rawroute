import { requireAdmin } from "@/lib/auth"
import { getCodexUsageForAccount } from "@/lib/codex-usage"
import { listCodexAccounts } from "@/lib/codex"
import { jsonError } from "@/lib/http"


export async function GET() {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const result = await listCodexAccounts()
  const accounts = await Promise.all(result.accounts.map(async (account) => ({ id: account.id, name: account.name, email: account.email, planType: account.planType, enabled: account.enabled, priority: account.priority || 0, usage: await getCodexUsageForAccount(account) })))
  return Response.json({ provider: result.provider ? { id: result.provider.id, name: result.provider.name } : null, accounts })
}
