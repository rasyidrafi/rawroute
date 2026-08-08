import { cliproxyManagementJson } from "@/lib/cliproxy"
import { isAuthenticated } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const state = new URL(request.url).searchParams.get("state")
  if (!state) return jsonError("OAuth state is required.", 400)
  const { response, data } = await cliproxyManagementJson(`/v0/management/oauth-session?state=${encodeURIComponent(state)}`, { method: "DELETE" })
  if (!response.ok) return jsonError("CLIProxy login could not be cancelled.", response.status)
  writeLog("info", "admin", "CLIProxy OAuth login cancelled")
  return Response.json(data || { status: "ok" })
}
