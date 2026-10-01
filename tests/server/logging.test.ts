import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { createSession } from "@/lib/auth"
import { runInWorkspace } from "@/lib/workspace/context"
import { _resetMemoryBackend, createApiKey } from "@/server/store"
import { createWorkspace, deleteWorkspace, resetWorkspacesForTests } from "@/server/workspace-repository"
import { recordLog } from "@/server/logging/recorder"
import { logs } from "@/server/logging/store"
import { requestContext } from "@/server/request-context"
import { apiRoutes } from "@/server/routes"
import { apiRoute } from "@/server/http"
import { drainBackgroundTasks } from "@/lib/background-tasks"

let server: Server<undefined>
let cookie: string
let base: URL
beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  process.env.DEFAULT_ADMIN_PASSWORD = "logging-test-password"
  _resetMemoryBackend()
  await resetWorkspacesForTests()
  logs.clear({ kind: "global" })
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { ...apiRoutes, "/test/failure": apiRoute({ GET: () => { throw new Error("secret-error") } }, "workspace") } })
  base = server.url
  process.env.RAWROUTE_PUBLIC_URL = base.origin
  cookie = (await createSession(new Request(base))).split(";", 1)[0]
})
afterEach(async () => { await server.stop(true); await drainBackgroundTasks() })
function call(path: string, workspaceId?: string, method = "GET", body?: unknown) {
  return fetch(new URL(path, base), { method, headers: { cookie, origin: base.origin, "content-type": "application/json", ...(workspaceId ? { "x-rawroute-workspace-id": workspaceId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

test("global activity never appears in Default and global APIs ignore workspace headers", async () => {
  const login = await call("/api/auth/login", undefined, "POST", { password: "logging-test-password" })
  expect(login.status).toBe(200)
  await login.body?.cancel()
  const global = await (await call("/api/admin/logs/global", "nonexistent")).json()
  expect(global.scope).toBe("global")
  expect(global.entries.some((entry: { event: string }) => entry.event === "auth.login.succeeded")).toBe(true)
  const local = await (await call("/api/admin/logs", "default")).json()
  expect(local.entries.some((entry: { event: string }) => entry.event === "auth.login.succeeded")).toBe(false)
  expect((await call("/api/admin/logs")).status).toBe(400)
  expect((await call("/api/admin/logs", "absent")).status).toBe(404)
})

test("read and clear operate on exactly one scope and polling does not log itself", async () => {
  const a = await createWorkspace("Log Alpha"), b = await createWorkspace("Log Beta")
  runInWorkspace(a, () => recordLog("gateway.request.completed", { status: 200 }))
  runInWorkspace(b, () => recordLog("gateway.request.failed", { status: 502 }))
  recordLog("system.started")
  const before = await (await call("/api/admin/logs", a.id)).json()
  const again = await (await call("/api/admin/logs", a.id)).json()
  expect(again).toEqual(before)
  const cleared = await (await call("/api/admin/logs", a.id, "DELETE")).json()
  expect(cleared.entries.map((entry: { event: string }) => entry.event)).toEqual(["logs.cleared"])
  expect((await (await call("/api/admin/logs", b.id)).json()).entries[0].event).toBe("gateway.request.failed")
  expect((await (await call("/api/admin/logs/global")).json()).entries[0].event).toBe("system.started")
  await call("/api/admin/logs/global", a.id, "DELETE")
  expect((await (await call("/api/admin/logs", b.id)).json()).entries).toHaveLength(1)
})

test("request failures retain workspace and generated request ID without free-form errors", async () => {
  const a = await createWorkspace("Failure workspace")
  const response = await call("/test/failure", a.id)
  expect(response.status).toBe(500)
  const entry = logs.snapshot({ kind: "workspace", workspaceId: a.id }).entries[0]!
  expect(entry.event).toBe("http.request.failed")
  expect(entry.requestId).toBe(response.headers.get("x-request-id"))
  expect(JSON.stringify(entry)).not.toContain("secret-error")
})

test("late completion and nested work cannot recreate a deleted workspace log", async () => {
  const a = await createWorkspace("Deleted logs")
  await runInWorkspace(a, async () => {
    recordLog("gateway.request.started")
    const admission = requestContext().logScope
    await deleteWorkspace(a.id, a.name)
    expect(recordLog("gateway.request.completed")).toBe(false)
    expect(runInWorkspace(a, () => recordLog("gateway.request.completed"))).toBe(false)
    expect(logs.snapshot(admission).entries).toHaveLength(0)
  })
})

test("gateway authentication uses the key workspace, never the supplied workspace header", async () => {
  const a = await createWorkspace("Gateway logs")
  await runInWorkspace(a, () => createApiKey("Gateway", "scoped-key"))
  const response = await fetch(new URL("/v1/models", base), { headers: { authorization: "Bearer scoped-key", "x-rawroute-workspace-id": "spoofed" } })
  expect(response.status).toBe(200)
  await response.body?.cancel()
  const invalid = await fetch(new URL("/v1/models", base), { headers: { authorization: "Bearer invalid", "x-rawroute-workspace-id": a.id } })
  expect(invalid.status).toBe(401)
  await invalid.body?.cancel()
  expect(logs.snapshot({ kind: "workspace", workspaceId: a.id }).entries.some(entry => entry.event === "gateway.catalog.served")).toBe(true)
  expect(logs.snapshot().entries.some(entry => entry.event === "gateway.authentication.rejected")).toBe(true)
  expect(logs.snapshot({ kind: "workspace", workspaceId: a.id }).entries.some(entry => entry.event === "gateway.authentication.rejected")).toBe(false)
})

test("browser telemetry validates event/page scope, content, session and origin", async () => {
  const a = await createWorkspace("Browser logs")
  expect((await call("/api/admin/logs/events", a.id, "POST", { event: "logs.copied", page: "logs" })).status).toBe(200)
  expect(logs.snapshot({ kind: "workspace", workspaceId: a.id }).entries[0]?.origin).toBe("browser")
  expect((await call("/api/admin/logs/events", a.id, "POST", { event: "dashboard.error" })).status).toBe(200)
  expect(logs.snapshot().entries[0]?.event).toBe("dashboard.error")
  for (const body of [{ event: "logs.copied", page: "providers" }, { event: "arbitrary" }, { event: "dashboard.error", password: "secret" }, { event: "dashboard.error", page: "x".repeat(2000) }]) {
    expect((await call("/api/admin/logs/events", a.id, "POST", body)).status).toBe(400)
  }
  expect((await call("/api/admin/logs/events", undefined, "POST", { event: "logs.copied", page: "logs" })).status).toBe(400)
  expect((await fetch(new URL("/api/admin/logs/events", base), { method: "POST" })).status).toBe(401)
  expect((await fetch(new URL("/api/admin/logs/global", base), { method: "DELETE", headers: { cookie, origin: "https://other.example" } })).status).toBe(403)
})
