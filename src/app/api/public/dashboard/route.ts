import { getDashboardPayload } from "@/lib/analytics"
import { parseDashboardQuery } from "@/lib/dashboard-query"
import { runInWorkspace, DEFAULT_WORKSPACE_ID } from "@/lib/workspace-context"
import { getPublicWorkspace } from "@/lib/workspaces"

const configuredPublicDashboardRangeDays = Number(process.env.PUBLIC_DASHBOARD_MAX_CUSTOM_RANGE_DAYS || 366)
const publicDashboardRangeDays = Number.isSafeInteger(configuredPublicDashboardRangeDays) && configuredPublicDashboardRangeDays > 0
  ? configuredPublicDashboardRangeDays
  : 366

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get("workspace") || DEFAULT_WORKSPACE_ID
    const workspace = await getPublicWorkspace(workspaceId)
    if (!workspace || workspace.status !== "active") return Response.json({ error: { message: "Workspace not found." } }, { status: 404 })
    const payload = await runInWorkspace(workspace, () => getDashboardPayload(parseDashboardQuery(url.searchParams, { maxCustomRangeDays: publicDashboardRangeDays }), true))
    return Response.json(payload, { headers: { "cache-control": "public, max-age=30, s-maxage=30, stale-while-revalidate=120" } })
  } catch {
    return Response.json({ error: { message: "Public dashboard data is unavailable." } }, { status: 503, headers: { "cache-control": "no-store" } })
  }
}
