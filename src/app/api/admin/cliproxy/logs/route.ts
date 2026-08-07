import { cliproxyManagement } from "@/lib/cliproxy"
import { isAuthenticated } from "@/lib/auth"
import { jsonError } from "@/lib/http"

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const response = await cliproxyManagement(`/v0/management/logs${new URL(request.url).search}`)
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json" } })
}

export async function DELETE() {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const response = await cliproxyManagement("/v0/management/logs", { method: "DELETE" })
  if (!response.ok) return jsonError("CLIProxy logs could not be cleared.", response.status)
  return Response.json({ ok: true })
}

