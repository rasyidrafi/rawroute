import { readMeta } from "@/server/store"
import type { BunRequest, Server } from "bun"

import { isAuthenticated } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { runInWorkspace, runWithoutWorkspace } from "@/lib/workspace/context"
import { getWorkspace } from "@/server/workspace-repository"
import { runInRequest, requestContext } from "@/server/request-context"
import { recordLog } from "@/server/logging/recorder"

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"
type Access = "public" | "session" | "workspace" | "explicit-workspace" | "gateway"
type Handler<Params> = (request: Request, params: Params) => Response | Promise<Response>

/** Auth policy remains explicit at registration; global requests never inherit a workspace. */
export function apiRoute<Params extends Record<string, string>>(
  handlers: Partial<Record<Method, Handler<Params>>>, access: Access, route?: string,
) {
  const allowed = new Set(Object.keys(handlers))
  if (handlers.GET) allowed.add("HEAD")
  allowed.add("OPTIONS")
  const allow = [...allowed].sort().join(", ")

  return (request: BunRequest<string>, server?: Server<undefined>): Promise<Response> => runWithoutWorkspace(() => runInRequest(async () => {
    const method = request.method as Method
    const started = performance.now()
    const path = new URL(request.url).pathname
    // Polling and telemetry must not recursively generate their own history.
    const quiet = path.startsWith("/api/admin/logs") || (method === "GET" || method === "HEAD")
    const invoke = async () => {
      try {
        const handler = handlers[method] || (method === "HEAD" ? handlers.GET : undefined)
        if (!handler) return new Response(null, { status: 405, headers: { allow } })
        if (path.startsWith("/api/admin/cliproxy/service/") || path === "/api/admin/cliproxy/versions") server?.timeout(request, 0)
        const response = await handler(request, request.params as Params)
        if (access !== "gateway" && (!quiet || response.status >= 400) && !path.startsWith("/api/admin/logs")) {
          recordLog("http.request.completed", { route, method, status: response.status, durationMs: Math.round(performance.now() - started), succeeded: response.ok }, { level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info" })
        }
        return response
      } catch {
        recordLog("http.request.failed", { route, method, status: 500, durationMs: Math.round(performance.now() - started) }, { level: "error" })
        return jsonError("Internal server error.", 500)
      }
    }
    const reject = (message: string, status: number) => {
      if (!path.startsWith("/api/admin/logs")) recordLog("http.request.rejected", { route, status, method }, { level: "warn" })
      return jsonError(message, status)
    }
    try {
      if (!allowed.has(method)) return new Response(null, { status: 405, headers: { allow } })
      if (method === "OPTIONS" && !handlers.OPTIONS) return new Response(null, { status: 204, headers: { allow } })
      let response: Response
      if (access === "session" || access === "workspace" || access === "explicit-workspace") {
        if (!(await isAuthenticated(request))) return reject("Unauthorized", 401)
        if (path !== "/api/admin/account" && path !== "/api/admin/account/password" && (await readMeta()).admin.mustChangePassword) return reject("Change the initial administrator password first.", 403)
        if (access === "session") response = await invoke()
        else {
          const selected = request.headers.get("x-rawroute-workspace-id")?.trim()
          if (!selected || !/^[a-zA-Z0-9_-]{1,128}$/.test(selected)) return reject("A valid workspace is required.", 400)
          const workspace = await getWorkspace(selected)
          if (!workspace) return reject("Workspace not found.", 404)
          if (workspace.status !== "active") return reject("Workspace is unavailable.", 409)
          response = await runInWorkspace(workspace, invoke)
        }
        if (!response.headers.has("cache-control")) response.headers.set("cache-control", "private, no-store")
      } else {
        if (access === "gateway") server?.timeout(request, 0)
        response = await invoke()
      }
      if (access !== "gateway") response.headers.set("x-request-id", requestContext().requestId!)
      if (method === "HEAD" && !handlers.HEAD) {
        await response.body?.cancel()
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
      }
      return response
    } catch {
      recordLog("http.request.failed", { route, method, status: 500 }, { level: "error" })
      return jsonError("Internal server error.", 500)
    }
  }))
}
