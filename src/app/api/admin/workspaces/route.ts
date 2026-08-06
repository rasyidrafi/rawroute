import { isAuthenticated } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { createWorkspace, listWorkspaces } from "@/lib/workspaces"

export async function GET() {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  return Response.json({ workspaces: await listWorkspaces() })
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const body = await request.json().catch(() => null) as { name?: unknown } | null
  try {
    return Response.json({ workspace: await createWorkspace(body?.name) })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create workspace.", 400)
  }
}
