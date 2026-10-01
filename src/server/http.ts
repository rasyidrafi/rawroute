import type { BunRequest, Server } from "bun"

import { isAuthenticated } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { DEFAULT_WORKSPACE_ID, runInWorkspace } from "@/lib/workspace/context"
import { getWorkspace } from "@/server/workspace-repository"

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"
type Access = "public" | "session" | "workspace" | "explicit-workspace" | "gateway"
type Handler<Params> = (request: Request, params: Params) => Response | Promise<Response>

/** Every HTTP request gets its own async scope, including unauthenticated requests. */
export function apiRoute<Params extends Record<string, string>>(
  handlers: Partial<Record<Method, Handler<Params>>>,
  access: Access,
) {
  const allowed = new Set(Object.keys(handlers))
  if (handlers.GET) allowed.add("HEAD")
  allowed.add("OPTIONS")
  const allow = [...allowed].sort().join(", ")

  return (request: BunRequest<string>, server?: Server<undefined>): Promise<Response> => runInWorkspace(
    { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" },
    async () => {
      try {
        const method = request.method as Method
        if (!allowed.has(method)) return Response.json({ error: { message: "Method not allowed." } }, { status: 405, headers: { allow } })
        if (method === "OPTIONS" && !handlers.OPTIONS) return new Response(null, { status: 204, headers: { allow } })
        const handler = handlers[method] || (method === "HEAD" ? handlers.GET : undefined)
        if (!handler) return new Response(null, { status: 405, headers: { allow } })
        const invoke = () => handler(request, request.params as Params)

        let response: Response
        if (access === "session" || access === "workspace" || access === "explicit-workspace") {
          if (!(await isAuthenticated(request))) return jsonError("Unauthorized", 401)
          if (access === "session") {
            response = await invoke()
          } else {
            const selected = request.headers.get("x-rawroute-workspace-id")?.trim()
            if (!selected && access === "explicit-workspace") return jsonError("Unauthorized", 401)
            const workspace = await getWorkspace(selected || DEFAULT_WORKSPACE_ID)
            if (!workspace || workspace.status !== "active") return jsonError("Unauthorized", 401)
            response = await runInWorkspace(workspace, invoke)
          }
          if (!response.headers.has("cache-control")) response.headers.set("cache-control", "private, no-store")
        } else {
          // Provider streams may remain quiet while a model reasons. The upstream
          // request signal and stream collector still bound/cancel their work.
          if (access === "gateway") server?.timeout(request, 0)
          response = await invoke()
        }
        if (method === "HEAD" && !handlers.HEAD) {
          await response.body?.cancel()
          return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
        }
        return response
      } catch (error) {
        writeLog("error", "system", "HTTP request failed", { error: error instanceof Error ? error.message : "Unknown error" })
        return jsonError("Internal server error.", 500)
      }
    },
  )
}
