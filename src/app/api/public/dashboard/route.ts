import { getDashboardPayload } from "@/lib/analytics"
import { parseDashboardQuery } from "@/lib/dashboard-query"
import { runInWorkspace, DEFAULT_WORKSPACE_ID } from "@/lib/workspace-context"
import { getWorkspace } from "@/lib/workspaces"


export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get("workspace") || DEFAULT_WORKSPACE_ID
    const workspace = await getWorkspace(workspaceId)
    if (!workspace || workspace.status !== "active") return Response.json({ error: { message: "Workspace not found." } }, { status: 404 })
    const payload = await runInWorkspace(workspace, () => getDashboardPayload(parseDashboardQuery(url.searchParams), true))
    return Response.json(payload, { headers: { "cache-control": "public, max-age=15, s-maxage=15, stale-while-revalidate=60" } })
  } catch {
    return Response.json({ error: { message: "Public dashboard data is unavailable." } }, { status: 503, headers: { "cache-control": "no-store" } })
  }
}
