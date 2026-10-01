import { workspaceContext } from "@/lib/workspace/context"
import { clearLogs, logVersion, readLogs, writeLog } from "@/lib/logger"

export async function GET(request: Request) {
  const workspace = workspaceContext()
  const etag = `W/"${logVersion()}"`
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } })
  }
  return Response.json({ logs: readLogs(workspace.id) }, { headers: { etag, "cache-control": "private, no-cache" } })
}

export async function DELETE() {
  const workspace = workspaceContext()
  clearLogs(workspace.id)
  writeLog("info", "admin", "Console logs cleared", undefined, workspace.id)
  return Response.json({ ok: true })
}
