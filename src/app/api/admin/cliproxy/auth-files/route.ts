import { cliproxyManagement, cliproxyManagementJson } from "@/lib/cliproxy"
import { isAuthenticated } from "@/lib/auth"
import { errorMessage, jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"

export async function GET() {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const { response, data } = await cliproxyManagementJson<{ files?: unknown[] }>("/v0/management/auth-files")
  if (!response.ok) return jsonError("CLIProxy authentication status is unavailable.", response.status)
  return Response.json({ files: data?.files || [] }, { headers: { "cache-control": "private, max-age=10" } })
}

export async function DELETE(request: Request) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const query = new URL(request.url).search
  const response = await cliproxyManagement(`/v0/management/auth-files${query}`, { method: "DELETE" })
  if (!response.ok) return jsonError("CLIProxy authentication record could not be deleted.", response.status)
  writeLog("info", "admin", "CLIProxy authentication record deleted")
  return Response.json({ ok: true })
}

export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const body = await request.text()
  const response = await cliproxyManagement("/v0/management/auth-files/status", { method: "PATCH", headers: { "content-type": "application/json" }, body })
  if (!response.ok) return jsonError(errorMessage(await response.text(), "CLIProxy authentication record could not be updated."), response.status)
  writeLog("info", "admin", "CLIProxy authentication record updated")
  return Response.json({ ok: true })
}
