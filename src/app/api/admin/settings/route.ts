import { cliproxyManagementJson, redactSecrets } from "@/lib/cliproxy"
import { isAuthenticated } from "@/lib/auth"
import { errorMessage, jsonError } from "@/lib/http"

const editable: Record<string, string> = {
  debug: "debug",
  loggingToFile: "logging-to-file",
  usageStatisticsEnabled: "usage-statistics-enabled",
  requestRetry: "request-retry",
  maxRetryInterval: "max-retry-interval",
  routingStrategy: "routing/strategy",
}

export async function GET() {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const { response, data } = await cliproxyManagementJson<Record<string, unknown>>("/v0/management/config")
  if (!response.ok) return jsonError("CLIProxy settings are unavailable.", response.status)
  const config = redactSecrets(data) as Record<string, unknown>
  const routing = config.routing && typeof config.routing === "object" ? config.routing as Record<string, unknown> : {}
  return Response.json({
    debug: config.debug,
    loggingToFile: config["logging-to-file"],
    usageStatisticsEnabled: config["usage-statistics-enabled"],
    requestRetry: config["request-retry"],
    maxRetryInterval: config["max-retry-interval"],
    routingStrategy: routing.strategy,
  })
}

export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid settings payload.", 400)
  try {
    for (const [key, value] of Object.entries(body)) {
      const endpoint = editable[key]
      if (!endpoint) continue
      const { response } = await cliproxyManagementJson(`/v0/management/${endpoint}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) })
      if (!response.ok) return jsonError(`CLIProxy setting ${key} could not be updated.`, response.status)
    }
    return Response.json({ ok: true })
  } catch (error) { return jsonError(errorMessage(error, "CLIProxy settings could not be updated."), 502) }
}
