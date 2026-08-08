import { isAuthenticated } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { createWorkspace, listWorkspaces } from "@/lib/workspaces"

export async function GET() {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  return Response.json({ workspaces: await listWorkspaces() })
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
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
