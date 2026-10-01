import { cliproxyManagementJson } from "@/lib/cliproxy/gateway"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

export async function POST(request: Request) {
  const state = new URL(request.url).searchParams.get("state")
  if (!state) return jsonError("OAuth state is required.", 400)
  const { response, data } = await cliproxyManagementJson(`/v0/management/oauth-session?state=${encodeURIComponent(state)}`, { method: "DELETE" })
  if (!response.ok) return jsonError("CLIProxy login could not be cancelled.", response.status)
  recordLog("admin.cliproxy.oauth.login.cancelled", {}, { level: "info" })
  return Response.json(data || { status: "ok" })
}
