import { afterEach, beforeEach, expect, test } from "bun:test"
import { apiRoutes } from "../../apps/console/src/server/routes"
import { createWorkspace, resetWorkspacesForTests } from "../../packages/platform/src/server/runtime"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"
import { _resetMemoryBackend, createApiKey, upsertModel, upsertProvider } from "../../packages/gateway-ai/src/server/store"
import type { Server } from "bun"

let server: Server<undefined>
beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  await resetWorkspacesForTests()
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: apiRoutes })
})
afterEach(async () => { await server.stop(true) })

async function fixture(name: string) {
  const workspace = await createWorkspace(name)
  const key = await runInWorkspace(workspace, async () => {
    const provider = await upsertProvider({ id: "catalog-provider", name: "Catalog", protocol: "openai-chat", baseUrl: "https://example.invalid", enabled: true })
    await upsertModel(provider.id, { id: name, name, upstreamModel: name, enabled: true })
    return createApiKey(name)
  })
  return { workspace, key }
}

test("native catalog responses are uncacheable and scoped to the key owner, not the dashboard header", async () => {
  const a = await fixture("catalog-a"), b = await fixture("catalog-b")
  for (const [owner, other] of [[a, b], [b, a]] as const) {
    const response = await fetch(new URL("/v1/models", server.url), { headers: { authorization: `Bearer ${owner.key.key}`, "x-rawroute-workspace-id": other.workspace.id } })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.text()
    expect(body).toContain(owner.key.name)
    expect(body).not.toContain(other.key.name)
  }
})

test("native catalog cannot borrow a selected workspace without a verified key", async () => {
  const { workspace } = await fixture("catalog-private")
  const response = await fetch(new URL("/v1/models", server.url), { headers: { "x-rawroute-workspace-id": workspace.id } })
  expect(response.status).toBe(401)
  expect(await response.text()).not.toContain("catalog-private")
})
