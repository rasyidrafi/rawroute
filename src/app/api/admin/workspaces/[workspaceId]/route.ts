import { isAuthenticated } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { deleteWorkspace, renameWorkspace } from "@/lib/workspaces"

export async function PATCH(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const body = await request.json().catch(() => null) as { name?: unknown } | null
  const { workspaceId } = await context.params
  try {
    return Response.json({ workspace: await renameWorkspace(workspaceId, body?.name) })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to rename workspace.", 400)
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const body = await request.json().catch(() => null) as { confirmation?: unknown } | null
  const { workspaceId } = await context.params
  try {
    await deleteWorkspace(workspaceId, body?.confirmation)
    return Response.json({ ok: true })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to delete workspace.", 400)
  }
}
