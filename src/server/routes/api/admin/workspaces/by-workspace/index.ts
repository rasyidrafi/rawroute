import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { deleteWorkspace, renameWorkspace } from "@/server/workspace-repository"

export async function PATCH(request: Request, params: { workspaceId: string }) {
  const body = await request.json().catch(() => null) as { name?: unknown } | null
  const { workspaceId } = params
  try {
    const workspace = await renameWorkspace(workspaceId, body?.name)
    recordLog("workspace.renamed", { workspaceId }, { level: "info" })
    return Response.json({ workspace })
  } catch (error) {
    recordLog("admin.workspace.rename.failed", { workspaceId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to rename workspace.", 400)
  }
}

export async function DELETE(request: Request, params: { workspaceId: string }) {
  const body = await request.json().catch(() => null) as { confirmation?: unknown } | null
  const { workspaceId } = params
  try {
    await deleteWorkspace(workspaceId, body?.confirmation)
    recordLog("workspace.deleted", { workspaceId }, { level: "info" })
    return Response.json({ ok: true })
  } catch (error) {
    recordLog("admin.workspace.delete.failed", { workspaceId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to delete workspace.", 400)
  }
}
