import { browserEvents, browserEventScope, type BrowserEvent } from "@/lib/logging/browser-events"
import { jsonError } from "@/lib/http"
import { runInWorkspace } from "@/lib/workspace/context"
import { getWorkspace } from "@/server/workspace-repository"
import { requestContext } from "@/server/request-context"
import { logs } from "./store"
import { assertLogOrigin } from "./http"

let windowStart = 0
let reportCount = 0

async function readReport(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) return null
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 1024) { await reader.cancel(); return null }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch { return null } finally { reader.releaseLock() }
}

export async function reportBrowserEvent(request: Request) {
  const rejected = assertLogOrigin(request)
  if (rejected) return rejected
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return jsonError("Expected application/json.", 415)
  if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); reportCount = 0 }
  if (++reportCount > 120) return jsonError("Too many log reports.", 429)
  const body = await readReport(request)
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Invalid log report.", 400)
  const data = body as Record<string, unknown>
  if (Object.keys(data).some(key => key !== "event" && key !== "page") || typeof data.event !== "string" || !Object.hasOwn(browserEvents, data.event)) return jsonError("Unknown log event.", 400)
  const event = data.event as BrowserEvent
  const scope = browserEventScope(event, data.page)
  if (!scope) return jsonError("Invalid event scope.", 400)
  const record = () => {
    logs.record({ event, source: "dashboard", message: browserEvents[event], level: event === "dashboard.error" || event === "dashboard.rejection" ? "error" : event === "dashboard.copy-failed" ? "warn" : "info", origin: "browser", requestId: requestContext().requestId, details: typeof data.page === "string" ? { page: data.page } : {} }, requestContext().logScope)
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } })
  }
  if (scope === "global") return record()
  const workspaceId = request.headers.get("x-rawroute-workspace-id")?.trim()
  if (!workspaceId || !/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId)) return jsonError("Workspace is required.", 400)
  const workspace = await getWorkspace(workspaceId)
  if (!workspace) return jsonError("Workspace not found.", 404)
  if (workspace.status !== "active") return jsonError("Workspace is unavailable.", 409)
  return runInWorkspace(workspace, record)
}
