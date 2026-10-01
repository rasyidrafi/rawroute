import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { createWorkspace, listWorkspaces } from "@/server/workspace-repository"

export async function GET() {
  return Response.json({ workspaces: await listWorkspaces() })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { name?: unknown } | null
  try {
    const workspace = await createWorkspace(body?.name)
    recordLog("workspace.created", { workspaceId: workspace.id }, { level: "info" })
    return Response.json({ workspace })
  } catch (error) {
    recordLog("admin.workspace.create.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to create workspace.", 400)
  }
}
