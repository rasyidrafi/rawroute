import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { clearLogs, logVersion, readLogs, writeLog } from "@/lib/logger"


async function authorize() {
  try { (await requireAdmin())(); return true } catch { return false }
}

export async function GET(request: Request) {
  if (!(await authorize())) return jsonError("Unauthorized", 401)
  const etag = `W/"${logVersion()}"`
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } })
  }
  return Response.json({ logs: readLogs() }, { headers: { etag, "cache-control": "private, no-cache" } })
}

export async function DELETE() {
  if (!(await authorize())) return jsonError("Unauthorized", 401)
  clearLogs()
  writeLog("info", "admin", "Console logs cleared")
  return Response.json({ ok: true })
}
