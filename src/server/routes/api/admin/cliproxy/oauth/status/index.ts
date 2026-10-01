import { cliproxyManagementJson } from "@/lib/cliproxy/gateway"
import { jsonError } from "@/lib/http"

export async function GET(request: Request) {
  const query = new URL(request.url).search
  const { response, data } = await cliproxyManagementJson(`/v0/management/get-auth-status${query}`)
  if (!response.ok) return jsonError("CLIProxy login status is unavailable.", response.status)
  return Response.json(data || { status: "error" })
}
