import { testComboMemberPolicy } from "../../../../../gateway/gateway"
import { jsonError } from "@rawroute/observability/contracts/http"

import type { ComboMember } from "../../../../../../contracts/domain"

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { member?: ComboMember } | null
  if (!body?.member?.modelId) return jsonError("Combo member is required.", 400)
  return Response.json({ result: await testComboMemberPolicy(body.member) })
}
