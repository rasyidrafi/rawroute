import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { DEFAULT_ADMIN_PASSWORD } from "@/lib/auth-defaults"
import { createSession } from "@/lib/auth"
import { _resetMemoryBackend, hashPassword, updateMeta } from "@/server/store"
import { GET as bootstrap } from "@/server/routes/api/auth/bootstrap"
import { apiRoutes } from "@/server/routes"

let server: Server<undefined>
let cookie: string
beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  process.env.SESSION_SECRET = "bootstrap-tests-private-session-secret"
  delete process.env.DEFAULT_ADMIN_PASSWORD
  delete process.env.AUTH_SHOW_DEFAULT_PASSWORD_HINT
  _resetMemoryBackend()
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: apiRoutes })
  cookie = (await createSession(new Request(server.url))).split(";", 1)[0]!
})
afterEach(async () => { await server.stop(true) })

async function change(body: unknown) {
  return fetch(new URL("/api/admin/account/password", server.url), { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })
}

test("fresh installs accept the documented password and show its hint on loopback hosts only", async () => {
  const response = await fetch(new URL("/api/auth/login", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: DEFAULT_ADMIN_PASSWORD }) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, mustChangePassword: true })
  for (const host of ["localhost", "127.0.0.1", "[::1]", "example.com", "localhost.example.com", "192.168.1.10"]) {
    const result = await bootstrap(new Request(`http://${host}/api/auth/bootstrap`))
    expect(result.headers.get("cache-control")).toContain("no-store")
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(host)
    expect(await result.json()).toEqual({ isDefaultPassword: true, defaultPasswordHint: local ? DEFAULT_ADMIN_PASSWORD : null })
  }
})

test("custom initial credentials are never exposed, and disabling hints retains onboarding state", async () => {
  process.env.AUTH_SHOW_DEFAULT_PASSWORD_HINT = "false"
  expect(await (await bootstrap(new Request(server.url))).json()).toEqual({ isDefaultPassword: true, defaultPasswordHint: null })
  delete process.env.AUTH_SHOW_DEFAULT_PASSWORD_HINT
  process.env.DEFAULT_ADMIN_PASSWORD = "private-bootstrap-secret"
  await updateMeta(meta => { meta.admin.passwordHash = hashPassword("private-bootstrap-secret") })
  expect(await (await bootstrap(new Request(server.url))).json()).toEqual({ isDefaultPassword: true, defaultPasswordHint: null })
})

test("administration stays blocked until a different password is saved and the hint disappears", async () => {
  for (const path of ["/api/admin/workspaces", "/api/admin/cliproxy/status", "/api/admin/providers"]) {
    expect((await fetch(new URL(path, server.url), { headers: { cookie, "x-rawroute-workspace-id": "default" } })).status).toBe(403)
  }
  expect((await change({ password: DEFAULT_ADMIN_PASSWORD })).status).toBe(400)
  expect((await change({ password: "short" })).status).toBe(400)
  expect((await change({ password: "new-private-password" })).status).toBe(200)
  expect(await (await bootstrap(new Request(server.url))).json()).toEqual({ isDefaultPassword: false, defaultPasswordHint: null })
  expect((await fetch(new URL("/api/admin/workspaces", server.url), { headers: { cookie } })).status).toBe(200)
  expect((await change({ password: "bypassed-private-password" })).status).toBe(400)
  expect((await change({ currentPassword: "new-private-password", newPassword: DEFAULT_ADMIN_PASSWORD, confirmPassword: DEFAULT_ADMIN_PASSWORD })).status).toBe(400)
})
