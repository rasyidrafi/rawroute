import { requireAdmin } from "@/lib/auth"
import { redeemCodexReset } from "@/lib/codex-reset"
import { listCodexAccounts } from "@/lib/codex"
import { jsonError } from "@/lib/http"


export async function POST(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const accountId = (await context.params).accountId
  const body = await request.json().catch(() => null) as { confirmation?: unknown } | null
  const result = await listCodexAccounts()
  const account = result.accounts.find((entry) => entry.id === accountId)
  if (!account) return jsonError("Codex account not found.", 404)
  try { return Response.json(await redeemCodexReset(account, typeof body?.confirmation === "string" ? body.confirmation : "")) }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Unable to redeem Codex reset credit.", 400) }
}
