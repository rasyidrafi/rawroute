import { requireAdmin } from "@/lib/auth"
import { listModels } from "@/lib/store"
import { jsonError } from "@/lib/http"


export async function GET() {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  return Response.json({ models: await listModels() })
}
