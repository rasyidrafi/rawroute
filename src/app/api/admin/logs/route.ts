import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { clearLogs, readLogs, writeLog } from "@/lib/logger"


async function authorize() {
  try { await requireAdmin(); return true } catch { return false }
}

export async function GET() {
  if (!(await authorize())) return jsonError("Unauthorized", 401)
  return Response.json({ logs: readLogs() })
}

export async function DELETE() {
  if (!(await authorize())) return jsonError("Unauthorized", 401)
  clearLogs()
  writeLog("info", "admin", "Console logs cleared")
  return Response.json({ ok: true })
}
