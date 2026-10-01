import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { createSession } from "@/lib/auth"
import { updateMeta, _resetMemoryBackend } from "@/server/store"
import { apiRoutes } from "@/server/routes"
import { logs } from "@/server/logging/store"

let upstream: Server<undefined>
let server: Server<undefined>
let cookie: string
let failSetting: string | undefined
const writes: Array<{ path: string; value: unknown }> = []
beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  await updateMeta(meta => { meta.admin.mustChangePassword = false })
  logs.clear()
  writes.length = 0
  failSetting = undefined
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === "PUT") {
      writes.push({ path, value: await request.json() })
      return Response.json({ ok: true }, { status: path.endsWith(failSetting ?? "never") ? 503 : 200 })
    }
    return Response.json({ debug: false, "request-retry": 2, "api-keys": ["private-key"], routing: { strategy: "fill-first" } })
  } })
  process.env.CLIPROXY_URL = upstream.url.origin
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: apiRoutes })
  cookie = (await createSession(new Request(server.url))).split(";", 1)[0]
})
afterEach(async () => { await server.stop(true); await upstream.stop(true) })
function patch(body: unknown) {
  return fetch(new URL("/api/admin/cliproxy/settings", server.url), { method: "PATCH", headers: { cookie, "content-type": "application/json", "x-rawroute-workspace-id": "ignored-global-header" }, body: JSON.stringify(body) })
}

test("global settings normalize the upstream config and save only validated fields", async () => {
  const response = await fetch(new URL("/api/admin/cliproxy/settings", server.url), { headers: { cookie } })
  expect(await response.json()).toEqual({ debug: false, loggingToFile: false, usageStatisticsEnabled: false, requestRetry: 2, maxRetryInterval: 0, routingStrategy: "fill-first" })
  expect((await patch({ debug: true, requestRetry: 4 })).status).toBe(200)
  expect(writes).toEqual([
    { path: "/v0/management/debug", value: { value: true } },
    { path: "/v0/management/request-retry", value: { value: 4 } },
  ])
  expect(logs.snapshot().entries.some(entry => entry.event === "admin.cliproxy.settings.updated")).toBe(true)
})

test("invalid settings are rejected before any upstream write", async () => {
  for (const input of [null, {}, { debug: "true" }, { debug: true, unknown: 1 }, { requestRetry: -1 }, { requestRetry: 1.5 }, { maxRetryInterval: 3601 }, { routingStrategy: "round-robin" }]) {
    expect((await patch(input)).status).toBe(400)
  }
  expect(writes).toHaveLength(0)
})

test("partial upstream failure stops saving and explains that earlier fields may have applied", async () => {
  failSetting = "request-retry"
  const response = await patch({ debug: true, requestRetry: 4, maxRetryInterval: 5 })
  expect(response.status).toBe(503)
  expect((await response.json()).error.message).toContain("Earlier fields may already have been applied")
  expect(writes).toHaveLength(2)
})
