import { getOverviewPayload } from "../../../../analytics"
import { parseOverviewRange } from "../../../../../contracts/overview"
import { jsonError } from "@rawroute/observability/contracts/http"


export async function GET(request: Request) {
  let range
  try { range = parseOverviewRange(new URL(request.url).searchParams) }
  catch { return jsonError("Invalid overview range. Select 24 hours, 7 days or 30 days.", 400) }
  try { return Response.json(await getOverviewPayload(range)) }
  catch { return jsonError("Unable to load overview.", 500) }
}
