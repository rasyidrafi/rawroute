import { cliproxyManagementJson } from "@/lib/cliproxy"
import { isAuthenticated } from "@/lib/auth"
import { jsonError } from "@/lib/http"

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const query = new URL(request.url).search
  const { response, data } = await cliproxyManagementJson(`/v0/management/get-auth-status${query}`)
  if (!response.ok) return jsonError("CLIProxy login status is unavailable.", response.status)
  return Response.json(data || { status: "error" })
}

