import { afterEach, beforeEach, expect, test, mock } from "bun:test"
import type { BunRequest, Server } from "bun"
import type { RouteOptions } from "../../packages/platform/src/contracts/http"

import { identity, createSession, isAuthenticated, readMeta, updateMeta } from "../../packages/platform/src/server/runtime"
import { drainBackgroundTasks, scheduleWorkspaceTask } from "../../packages/platform/src/server/background-tasks"
import { _resetMemoryBackend } from "../../packages/gateway-ai/src/server/store"
import { currentWorkspaceId, runInWorkspace } from "../../packages/platform/src/server/workspace-context"
import { createWorkspace, resetWorkspacesForTests } from "../../packages/platform/src/server/runtime"
import { apiRoute } from "../../packages/platform/src/server/http"
import { apiRoutes } from "../../apps/console/src/server/routes"
import { hashPassword } from "../../packages/platform/src/server/identity"

let server: Server<undefined> | undefined

beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  identity.reset()
  await updateMeta(meta => { meta.admin.passwordHash = hashPassword("http-test-password"); meta.admin.mustChangePassword = false })
  await resetWorkspacesForTests()
})

afterEach(async () => {
  await server?.stop(true)
  server = undefined
  await drainBackgroundTasks()
})

function start(routes: Parameters<typeof Bun.serve<undefined>>[0]["routes"]) {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, routes, fetch: () => new Response(null, { status: 404 }) })
  return server.url
}

test.each(["", "{", "null", "[]", '"password"', "42", "true", "{}", '{"username":"admin"}', '{"password":null}', '{"password":123}', '{"password":true}', '{"password":[]}', '{"password":{}}', '{"password":""}'])("login rejects malformed or missing passwords: %s", async (body) => {
  const base = start(apiRoutes)
  const response = await fetch(new URL("/api/auth/login", base), {
    method: "POST", headers: { "content-type": "application/json" }, body,
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: { message: "Password is required." } })
  expect(response.headers.get("set-cookie")).toBeNull()
})

test("login rejects incorrect passwords without creating a session", async () => {
  const base = start(apiRoutes)
  const response = await fetch(new URL("/api/auth/login", base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "incorrect-password" }),
  })
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: { message: "Invalid password." } })
  expect(response.headers.get("set-cookie")).toBeNull()
})

test("password-only login preserves existing credentials", async () => {
  const base = start(apiRoutes)
  await updateMeta((meta) => { meta.admin.mustChangePassword = false })
  const saved = await readMeta()
  process.env.DEFAULT_ADMIN_PASSWORD = "changed-bootstrap-password"
  for (const body of [{ password: "http-test-password" }]) {
    const response = await fetch(new URL("/api/auth/login", base), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, mustChangePassword: false })
    const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]
    const account = await fetch(new URL("/api/admin/account", base), { headers: { cookie } })
    expect(account.status).toBe(200)
    expect(await account.json()).toEqual({ mustChangePassword: false })
  }
  expect(await readMeta()).toEqual(saved)
})

test("initial password change keeps the session and accepts only the new password on subsequent login", async () => {
  await updateMeta(meta => { meta.admin.mustChangePassword = true })
  const base = start(apiRoutes)
  const login = (password: string) => fetch(new URL("/api/auth/login", base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  })
  const initialLogin = await login("http-test-password")
  expect(initialLogin.status).toBe(200)
  expect(await initialLogin.json()).toEqual({ ok: true, mustChangePassword: true })
  const cookie = initialLogin.headers.get("set-cookie")!.split(";", 1)[0]
  const changed = await fetch(new URL("/api/admin/account/password", base), {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ password: "new-private-password" }),
  })
  expect(changed.status).toBe(200)
  expect(await changed.json()).toEqual({ ok: true, mustChangePassword: false })
  const session = await fetch(new URL("/api/auth/session", base), { headers: { cookie } })
  expect(await session.json()).toEqual({ authenticated: true })
  const rejected = await login("http-test-password")
  expect(rejected.status).toBe(401)
  await rejected.body?.cancel()
  const accepted = await login("new-private-password")
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toEqual({ ok: true, mustChangePassword: false })
})

test("initial-password exceptions are declared options, not inferred from canonical account URLs", async () => {
  await updateMeta(meta => { meta.admin.mustChangePassword = true })
  const base = start({
    "/api/admin/account": apiRoute({ GET: () => Response.json({ allowed: true }) }, "session"),
    "/rotation": apiRoute({ GET: () => Response.json({ allowed: true }) }, "session", "/rotation", { allowInitialPassword: true }),
  })
  const cookie = (await createSession(new Request(base))).split(";", 1)[0]
  const blocked = await fetch(new URL("/api/admin/account", base), { headers: { cookie } })
  expect(blocked.status).toBe(403)
  await blocked.body?.cancel()
  const allowed = await fetch(new URL("/rotation", base), { headers: { cookie } })
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toEqual({ allowed: true })
})

test("long-running request timeouts follow concrete options and methods, not CLIProxy or workspace paths", async () => {
  const timeout = mock(() => undefined)
  const transport = { timeout } as unknown as Server<undefined>
  async function call(path: string, method: string, options?: RouteOptions) {
    const response = await apiRoute({ GET: () => new Response(), DELETE: () => new Response() }, "public", path, options)(new Request(`http://localhost${path}`, { method }) as BunRequest<string>, transport)
    expect(response.status).toBe(200)
  }
  await call("/api/admin/cliproxy/versions", "GET")
  await call("/api/admin/cliproxy/service/restart", "GET")
  await call("/api/admin/workspaces/example", "DELETE")
  expect(timeout).not.toHaveBeenCalled()
  await call("/declared-long-running", "GET", { idleTimeout: 0 })
  expect(timeout).toHaveBeenCalledTimes(1)
  await call("/declared-drain", "GET", { idleTimeout: 0, idleTimeoutMethods: ["DELETE"] })
  expect(timeout).toHaveBeenCalledTimes(1)
  await call("/declared-drain", "DELETE", { idleTimeout: 0, idleTimeoutMethods: ["DELETE"] })
  expect(timeout).toHaveBeenCalledTimes(2)
})

test("session cookies are explicit, signed, expiring, and removed on logout", async () => {
  const base = start(apiRoutes)
  const login = await fetch(new URL("/api/auth/login", base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "http-test-password" }),
  })
  expect(login.status).toBe(200)
  const setCookie = login.headers.get("set-cookie")!
  expect(setCookie).toMatch(/HttpOnly/i)
  expect(setCookie).toMatch(/SameSite=Lax/i)
  expect(setCookie).toMatch(/Path=\//i)
  const cookie = setCookie.split(";", 1)[0]
  expect(await isAuthenticated(new Request(base, { headers: { cookie } }))).toBe(true)
  expect(await isAuthenticated(new Request(base, { headers: { cookie: `${cookie}corrupt` } }))).toBe(false)
  const secured = await createSession(new Request(base, { headers: { "x-forwarded-proto": "https" } }))
  expect(secured).toMatch(/Secure/i)
  const logout = await fetch(new URL("/api/auth/logout", base), { method: "POST", headers: { cookie } })
  expect(logout.headers.get("set-cookie")).toMatch(/Max-Age=0/i)
})

test("every registered administration method rejects unauthenticated requests", async () => {
  const base = start(apiRoutes)
  const paths = Object.keys(apiRoutes).filter((path) => path.startsWith("/api/admin/"))
  for (const path of paths) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const url = path.replace(/:[^/]+/g, "unknown")
      const response = await fetch(new URL(url, base), { method })
      expect([401, 405], `${method} ${url}`).toContain(response.status)
      await response.body?.cancel()
    }
  }
})

test("native routing preserves encoded IDs, static precedence, HEAD, OPTIONS and 405", async () => {
  const base = start({
    "/items/:id": apiRoute({ GET: (_request, params: { id: string }) => Response.json(params) }, "public"),
    "/items/fixed": apiRoute({ GET: () => Response.json({ fixed: true }) }, "public"),
  })
  expect(await (await fetch(new URL("/items/provider%2Fmodel", base))).json()).toEqual({ id: "provider/model" })
  expect(await (await fetch(new URL("/items/fixed", base))).json()).toEqual({ fixed: true })
  const head = await fetch(new URL("/items/fixed", base), { method: "HEAD" })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe("")
  const options = await fetch(new URL("/items/fixed", base), { method: "OPTIONS" })
  expect(options.status).toBe(204)
  expect(options.headers.get("allow")).toBe("GET, HEAD, OPTIONS")
  const post = await fetch(new URL("/items/fixed", base), { method: "POST" })
  expect(post.status).toBe(405)
  expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS")
})

test("concurrent requests and deferred jobs retain their own workspace", async () => {
  const first = await createWorkspace("First")
  const second = await createWorkspace("Second")
  const jobs: string[] = []
  const base = start({
    "/scoped": apiRoute({ GET: async () => {
      const before = currentWorkspaceId()
      await new Promise((resolve) => setTimeout(resolve, before === first.id ? 10 : 1))
      void scheduleWorkspaceTask("record", async () => { jobs.push(currentWorkspaceId()) })
      return Response.json({ before, after: currentWorkspaceId() })
    } }, "workspace"),
    "/explicit": apiRoute({ GET: () => Response.json({ workspace: currentWorkspaceId() }) }, "explicit-workspace"),
  })
  const cookie = (await createSession(new Request(base))).split(";", 1)[0]
  const responses = await Promise.all([first, second].map(async (workspace) => {
    const response = await fetch(new URL("/scoped", base), { headers: { cookie, "x-rawroute-workspace-id": workspace.id } })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    return response.json()
  }))
  expect(responses).toEqual([{ before: first.id, after: first.id }, { before: second.id, after: second.id }])
  await drainBackgroundTasks()
  expect(jobs.sort()).toEqual([first.id, second.id].sort())
  expect(() => currentWorkspaceId()).toThrow("Workspace scope is required")
  expect((await fetch(new URL("/explicit", base), { headers: { cookie } })).status).toBe(400)
  expect((await fetch(new URL("/scoped", base), { headers: { cookie, "x-rawroute-workspace-id": "deleted" } })).status).toBe(404)
})

test("background work deduplicates within a workspace and drains before shutdown", async () => {
  const workspace = await createWorkspace("Jobs")
  const run = mock(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  runInWorkspace(workspace, () => {
    void scheduleWorkspaceTask("same-job", run)
    void scheduleWorkspaceTask("same-job", run)
  })
  await drainBackgroundTasks()
  expect(run).toHaveBeenCalledTimes(1)
})

test("gateway responses stream incrementally and a disconnect aborts the request", async () => {
  const disconnected = Promise.withResolvers<void>()
  const base = start({
    "/stream": apiRoute({ GET: (request) => {
      request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")) },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    } }, "gateway"),
  })
  const controller = new AbortController()
  const response = await fetch(new URL("/stream", base), { signal: controller.signal })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n")
  controller.abort()
  await reader.cancel().catch(() => undefined)
  await disconnected.promise
})
