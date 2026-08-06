import { requireAdmin } from "@/lib/auth"
import { listCodexAccounts } from "@/lib/codex"
import { jsonError } from "@/lib/http"


function publicAccount(account: Awaited<ReturnType<typeof listCodexAccounts>>["accounts"][number]) {
  return {
    id: account.id,
    providerId: account.providerId,
    name: account.name,
    email: account.email,
    accountId: account.accountId,
    planType: account.planType,
    enabled: account.enabled,
    expiresAt: account.expiresAt,
    lastRefresh: account.lastRefresh,
    rpmLimit: account.rpmLimit,
    maxConcurrency: account.maxConcurrency,
    priority: account.priority,
    createdAt: account.createdAt,
  }
}

export async function GET() {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const result = await listCodexAccounts()
  return Response.json({
    provider: result.provider ? { id: result.provider.id, name: result.provider.name, prefix: result.provider.prefix, baseUrl: result.provider.baseUrl } : null,
    accounts: result.accounts.map(publicAccount),
  })
}
