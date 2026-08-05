import { getDashboardPayload } from "@/lib/analytics"
import { parseDashboardQuery } from "@/lib/dashboard-query"


export async function GET(request: Request) {
  try {
    const payload = await getDashboardPayload(parseDashboardQuery(new URL(request.url).searchParams), true)
    return Response.json(payload, { headers: { "cache-control": "public, max-age=5, s-maxage=5, stale-while-revalidate=30" } })
  } catch {
    return Response.json({ error: { message: "Public dashboard data is unavailable." } }, { status: 503, headers: { "cache-control": "no-store" } })
  }
}
