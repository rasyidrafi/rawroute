import { cliproxyManagementJson, maskSecret } from "@/lib/cliproxy/gateway"
import { errorMessage, jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

export async function GET() {
  const { response, data } = await cliproxyManagementJson<{ "api-keys"?: unknown[] }>("/v0/management/api-keys")
  if (!response.ok) return jsonError("CLIProxy API key management is unavailable.", response.status)
  return Response.json({ apiKeys: (data?.["api-keys"] || []).map((key) => ({ value: maskSecret(key), masked: true })) }, { headers: { "cache-control": "private, max-age=15" } })
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null) as { apiKeys?: unknown } | null
  if (!Array.isArray(body?.apiKeys) || !body.apiKeys.every((value) => typeof value === "string" && value.trim())) return jsonError("A non-empty API key list is required.", 400)
  try {
    const { response, data } = await cliproxyManagementJson("/v0/management/api-keys", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body.apiKeys) })
    recordLog(response.ok ? "admin.cliproxy.keys.updated" : "admin.cliproxy.keys.failed", { count: body.apiKeys.length, status: response.status }, { level: response.ok ? "info" : "warn" })
    return new Response(data ? JSON.stringify(data) : null, { status: response.status, headers: { "content-type": "application/json" } })
  } catch (error) {
    recordLog("admin.cliproxy.api.key.update.failed", { error: errorMessage(error, "Unknown error") }, { level: "error" })
    return jsonError(errorMessage(error, "Unable to update CLIProxy API keys."), 502)
  }
}
