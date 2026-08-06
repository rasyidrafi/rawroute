import { requireAdminWorkspace } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { clearLogs, logVersion, readLogs, writeLog } from "@/lib/logger"


async function authorize(request: Request) {
  try { return await requireAdminWorkspace(request) } catch { return undefined }
}

export async function GET(request: Request) {
  const workspace = await authorize(request)
  if (!workspace) return jsonError("Unauthorized", 401)
  const etag = `W/"${logVersion()}"`
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } })
  }
  return Response.json({ logs: readLogs(workspace.id) }, { headers: { etag, "cache-control": "private, no-cache" } })
}

export async function DELETE(request: Request) {
  const workspace = await authorize(request)
  if (!workspace) return jsonError("Unauthorized", 401)
  clearLogs(workspace.id)
  writeLog("info", "admin", "Console logs cleared", undefined, workspace.id)
  return Response.json({ ok: true })
}
