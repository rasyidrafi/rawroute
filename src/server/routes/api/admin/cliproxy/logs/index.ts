import { cliproxyManagement } from "@/lib/cliproxy/gateway"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

export async function GET(request: Request) {
  const response = await cliproxyManagement(`/v0/management/logs${new URL(request.url).search}`)
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json" } })
}

export async function DELETE() {
  const response = await cliproxyManagement("/v0/management/logs", { method: "DELETE" })
  if (!response.ok) return jsonError("CLIProxy logs could not be cleared.", response.status)
  recordLog("admin.cliproxy.logs.cleared", {}, { level: "info" })
  return Response.json({ ok: true })
}
