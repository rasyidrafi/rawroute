import { requireAdmin } from "@/lib/auth"
import { getPricingJob } from "@/lib/model-pricing"
import { jsonError } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  const job = await getPricingJob((await context.params).jobId)
  if (!job) return jsonError("Pricing job not found.", 404)
  return Response.json({ job })
}
