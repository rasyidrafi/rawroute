import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { deleteWorkspace, renameWorkspace } from "@/server/workspace-repository"

export async function PATCH(request: Request, params: { workspaceId: string }) {
  const body = await request.json().catch(() => null) as { name?: unknown } | null
  const { workspaceId } = params
  try {
    const workspace = await renameWorkspace(workspaceId, body?.name)
    writeLog("info", "admin", "Workspace renamed", { workspaceId }, workspaceId)
    return Response.json({ workspace })
  } catch (error) {
    writeLog("error", "admin", "Workspace rename failed", { workspaceId, error: error instanceof Error ? error.message : "Unknown error" }, workspaceId)
    return jsonError(error instanceof Error ? error.message : "Unable to rename workspace.", 400)
  }
}

export async function DELETE(request: Request, params: { workspaceId: string }) {
  const body = await request.json().catch(() => null) as { confirmation?: unknown } | null
  const { workspaceId } = params
  try {
    await deleteWorkspace(workspaceId, body?.confirmation)
    writeLog("info", "admin", "Workspace deleted", { workspaceId }, workspaceId)
    return Response.json({ ok: true })
  } catch (error) {
    writeLog("error", "admin", "Workspace delete failed", { workspaceId, error: error instanceof Error ? error.message : "Unknown error" }, workspaceId)
    return jsonError(error instanceof Error ? error.message : "Unable to delete workspace.", 400)
  }
}
