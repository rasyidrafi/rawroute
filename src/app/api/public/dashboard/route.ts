import { getDashboardPayload } from "@/lib/analytics"
import { parseDashboardQuery } from "@/lib/dashboard-query"


export async function GET(request: Request) {
  try {
    const payload = await getDashboardPayload(parseDashboardQuery(new URL(request.url).searchParams), true)
    return Response.json(payload)
  } catch {
    return Response.json({ error: { message: "Public dashboard data is unavailable." } }, { status: 503 })
  }
}
