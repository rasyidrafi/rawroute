import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { listApiKeys } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const apiKeys = await listApiKeys()
  return Response.json({ endpoint: "/v1", apiKeys })
}