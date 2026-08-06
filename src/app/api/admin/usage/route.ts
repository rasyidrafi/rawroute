import { requireAdmin } from "@/lib/auth"
import { getDashboardPayload } from "@/lib/analytics"
import { parseDashboardQuery } from "@/lib/dashboard-query"
import { jsonError } from "@/lib/http"


export async function GET(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  try { return Response.json(await getDashboardPayload(parseDashboardQuery(new URL(request.url).searchParams))) }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Unable to load usage.", 500) }
}
