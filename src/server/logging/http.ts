import { jsonError } from "@/lib/http"
import { logs } from "./store"
import { requestContext } from "@/server/request-context"
import { recordLog } from "./recorder"

export function assertLogOrigin(request: Request) {
  try {
    const origin = request.headers.get("origin")
    const expected = process.env.RAWROUTE_PUBLIC_URL || new URL(request.url).origin
    if (request.headers.get("sec-fetch-site") === "cross-site" || !origin || origin !== new URL(expected).origin) return jsonError("Invalid request origin.", 403)
  } catch { return jsonError("Invalid request origin.", 403) }
}

export function logSnapshot() {
  return Response.json(logs.snapshot(requestContext().logScope), { headers: { "cache-control": "private, no-store" } })
}

export function clearLogHistory(request: Request) {
  const rejected = assertLogOrigin(request)
  if (rejected) return rejected
  const scope = requestContext().logScope
  logs.clear(scope)
  recordLog("logs.cleared")
  return logSnapshot()
}
