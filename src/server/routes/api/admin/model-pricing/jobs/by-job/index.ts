import { getPricingJob } from "@/lib/model-pricing"
import { jsonError } from "@/lib/http"

export async function GET(_request: Request, params: { jobId: string }) {
  const job = await getPricingJob(params.jobId)
  if (!job) return jsonError("Pricing job not found.", 404)
  return Response.json({ job })
}
