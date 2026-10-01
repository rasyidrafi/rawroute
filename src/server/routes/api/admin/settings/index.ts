import { withManagementMutation } from "@/server/cliproxy/mutations"
import { instanceSettingsSchema } from "@/lib/instance-settings"
import { cliproxyManagementJson, redactSecrets } from "@/lib/cliproxy/gateway"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"

const editable: Record<string, string> = {
  debug: "debug",
  loggingToFile: "logging-to-file",
  usageStatisticsEnabled: "usage-statistics-enabled",
  requestRetry: "request-retry",
  maxRetryInterval: "max-retry-interval",
  routingStrategy: "routing/strategy",
}

export async function GET() {
  const { response, data } = await cliproxyManagementJson<Record<string, unknown>>("/v0/management/config")
  if (!response.ok) return jsonError("CLIProxy settings are unavailable.", response.status)
  const config = redactSecrets(data) as Record<string, unknown>
  const routing = config.routing && typeof config.routing === "object" ? config.routing as Record<string, unknown> : {}
  return Response.json({
    debug: config.debug === true,
    loggingToFile: config["logging-to-file"] === true,
    usageStatisticsEnabled: config["usage-statistics-enabled"] === true,
    requestRetry: Number(config["request-retry"] ?? 0),
    maxRetryInterval: Number(config["max-retry-interval"] ?? 0),
    routingStrategy: routing.strategy === "fill-first" ? "fill-first" : "round-robin",
  })
}

export function PATCH(request: Request) { return withManagementMutation(() => patch(request)) }

async function patch(request: Request) {
  const parsed = instanceSettingsSchema.partial().safeParse(await request.json().catch(() => null))
  if (!parsed.success || !Object.keys(parsed.data).length) return jsonError("Invalid settings payload.", 400)
  const body = parsed.data
  if (body.routingStrategy && body.routingStrategy !== "fill-first") return jsonError("RawRoute requires fill-first routing to preserve provider key priority.", 400)
  try {
    for (const [key, value] of Object.entries(body)) {
      const endpoint = editable[key]
      if (!endpoint) continue
      const { response } = await cliproxyManagementJson(`/v0/management/${endpoint}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) })
      if (!response.ok) {
        recordLog("admin.cliproxy.setting.update.failed", { setting: key, status: response.status }, { level: "warn" })
        return jsonError(`CLIProxy setting ${key} could not be updated. Earlier fields may already have been applied; reload to check.`, response.status)
      }
    }
    recordLog("admin.cliproxy.settings.updated", { count: Object.keys(body).length }, { level: "info" })
    return Response.json({ ok: true })
  } catch {
    recordLog("admin.cliproxy.settings.update.failed", {}, { level: "error" })
    return jsonError("CLIProxy settings could not be updated. Earlier fields may already have been applied; reload to check.", 502)
  }
}
