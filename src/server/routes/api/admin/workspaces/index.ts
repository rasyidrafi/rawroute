import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { createWorkspace, listWorkspaces } from "@/server/workspace-repository"

export async function GET() {
  return Response.json({ workspaces: await listWorkspaces() })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { name?: unknown } | null
  try {
    const workspace = await createWorkspace(body?.name)
    writeLog("info", "admin", "Workspace created", { workspaceId: workspace.id }, workspace.id)
    return Response.json({ workspace })
  } catch (error) {
    writeLog("error", "admin", "Workspace create failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to create workspace.", 400)
  }
}
