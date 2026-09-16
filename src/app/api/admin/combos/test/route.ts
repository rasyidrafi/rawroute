import { requireAdmin } from "@/lib/auth"
import { testComboMemberReasoning } from "@/lib/cliproxy"
import { jsonError } from "@/lib/http"
import type { ComboMember } from "@/lib/types"

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as { member?: ComboMember } | null
  if (!body?.member?.modelId) return jsonError("Combo member is required.", 400)
  return Response.json({ result: await testComboMemberReasoning(body.member) })
}
