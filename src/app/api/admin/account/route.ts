import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { readMeta } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const meta = await readMeta()
  return Response.json({
    username: meta.admin.username,
    mustChangePassword: meta.admin.mustChangePassword,
  })
}