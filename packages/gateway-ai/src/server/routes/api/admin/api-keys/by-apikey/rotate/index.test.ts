import { afterEach, beforeEach, expect, test } from "bun:test"

import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { closeLocalDatabase } from "@rawroute/platform/server/database"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"

import { createApiKey, findApiKeyByValue, _resetMemoryBackend } from "../../../../../../store"
import { POST } from "./index"

beforeEach(async () => {
  await closeLocalDatabase()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  globalThis.__rawrouteMemoryAudit = []
  _resetMemoryBackend()
})

afterEach(async () => { await closeLocalDatabase() })

function request(value: unknown) {
  return new Request("http://rawroute.test/api/admin/api-keys/key-a/rotate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  })
}

test("rotation route accepts a custom token and returns the preserved key identity", async () => {
  await runInWorkspace({ id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" }, async () => {
    const original = await createApiKey("Route key", "route-old-token")
    const response = await POST(request({ key: " route-new-token " }), { apiKeyId: original.id })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, apiKey: { id: original.id, name: original.name, createdAt: original.createdAt, key: "route-new-token" } })
    expect(await findApiKeyByValue(original.key)).toBeUndefined()
    expect(await findApiKeyByValue("route-new-token")).toMatchObject({ id: original.id })
  })
})

test("rotation route rejects malformed values and conflicts without exposing a token", async () => {
  await runInWorkspace({ id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" }, async () => {
    const original = await createApiKey("Route key", "route-current-token")
    const invalidBody = await POST(request("random"), { apiKeyId: original.id })
    const invalidType = await POST(request({ key: 42 }), { apiKeyId: original.id })
    const sameValue = await POST(request({ key: original.key }), { apiKeyId: original.id })
    const blank = await POST(request({ key: "   " }), { apiKeyId: original.id })

    expect(invalidBody.status).toBe(400)
    expect(invalidType.status).toBe(400)
    expect(sameValue.status).toBe(409)
    expect(blank.status).toBe(400)
    expect(JSON.stringify(await sameValue.json())).not.toContain(original.key)
    expect(await findApiKeyByValue(original.key)).toMatchObject({ id: original.id })
  })
})
