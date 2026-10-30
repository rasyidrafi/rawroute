import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { queryAudit } from "@rawroute/platform/server/audit"
import { closeLocalCache } from "@rawroute/platform/server/local-cache"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { closeLocalDatabase } from "@rawroute/platform/server/database"

import { ApiKeyConflictError, createApiKey, findApiKeyByValue, listApiKeys, rotateApiKey, _resetMemoryBackend } from "./store"

const defaultWorkspace = { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" as const }
let temporaryDirectory: string | undefined

beforeEach(async () => {
  await closeLocalDatabase()
  await closeLocalCache()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  globalThis.__rawrouteMemoryAudit = []
  _resetMemoryBackend()
})

afterEach(async () => {
  await closeLocalDatabase()
  await closeLocalCache()
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

test("random rotation preserves the key identity and immediately invalidates the previous value", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const original = await createApiKey("Production client", "old-custom-token")
    expect(await findApiKeyByValue(original.key)).toMatchObject({ id: original.id, key: original.key })

    const rotated = await rotateApiKey(original.id)

    expect(rotated).toMatchObject({ id: original.id, name: original.name, createdAt: original.createdAt })
    expect(rotated.key).toMatch(/^sk-rr-[0-9a-f]{32}$/)
    expect(rotated.key).not.toBe(original.key)
    expect(await findApiKeyByValue(original.key)).toBeUndefined()
    expect(await findApiKeyByValue(rotated.key)).toMatchObject({ id: original.id, name: original.name, key: rotated.key })

    const audit = await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID })
    const rotationEvent = audit.find(event => event.resource === "gateway-key" && event.action === "credential.update")
    expect(rotationEvent).toMatchObject({ result: "success" })
    expect(JSON.stringify(rotationEvent)).not.toContain(original.key)
    expect(JSON.stringify(rotationEvent)).not.toContain(rotated.key)
  })
})

test("custom rotation uses creation validation and rejects current or globally-used values atomically", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const original = await createApiKey("First key", "first-original")
    const occupied = await createApiKey("Second key", "second-occupied")
    await expect(rotateApiKey(original.id, original.key)).rejects.toBeInstanceOf(ApiKeyConflictError)

    const rotated = await rotateApiKey(original.id, "  custom-replacement  ")
    expect(rotated.key).toBe("custom-replacement")
    expect(rotated).toMatchObject({ id: original.id, name: original.name, createdAt: original.createdAt })
    await expect(rotateApiKey(original.id, rotated.key)).rejects.toBeInstanceOf(ApiKeyConflictError)
    await expect(rotateApiKey(original.id, occupied.key)).rejects.toBeInstanceOf(ApiKeyConflictError)
    await expect(rotateApiKey(original.id, " \n ")).rejects.toThrow("API key value is required.")
    await expect(rotateApiKey(original.id, "x".repeat(257))).rejects.toThrow("API key value must be 256 characters or fewer.")

    expect(await findApiKeyByValue(original.key)).toBeUndefined()
    expect(await findApiKeyByValue(rotated.key)).toMatchObject({ id: original.id })
    expect(await findApiKeyByValue(occupied.key)).toMatchObject({ id: occupied.id })
  })
})

test("rotation cannot target a key from another workspace", async () => {
  const original = await runInWorkspace({ id: "rotation-owner", storageMode: "scoped" }, () => createApiKey("Owner key", "owner-token"))

  await expect(runInWorkspace({ id: "rotation-other", storageMode: "scoped" }, () => rotateApiKey(original.id, "attacker-token")))
    .rejects.toThrow("API key not found.")

  await runInWorkspace({ id: "rotation-owner", storageMode: "scoped" }, async () => {
    expect(await findApiKeyByValue(original.key)).toMatchObject({ id: original.id })
    expect(await findApiKeyByValue("attacker-token")).toBeUndefined()
  })
})

test("SQLite rotation persists the replacement, index swap, workspace boundary, and secret-free audit", async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "rawroute-api-key-rotation-"))
  Object.assign(process.env, { STORAGE_BACKEND: "sqlite", SQLITE_PATH: join(temporaryDirectory, "test.sqlite") })

  const original = await runInWorkspace({ id: "rotation-sqlite-owner", storageMode: "scoped" }, () => createApiKey("Persistent key", "sqlite-old-token"))
  await expect(runInWorkspace({ id: "rotation-sqlite-other", storageMode: "scoped" }, () => rotateApiKey(original.id, "sqlite-attacker-token")))
    .rejects.toThrow("API key not found.")

  const rotated = await runInWorkspace({ id: "rotation-sqlite-owner", storageMode: "scoped" }, () => rotateApiKey(original.id, "sqlite-new-token"))
  expect(rotated).toMatchObject({ id: original.id, name: original.name, createdAt: original.createdAt, key: "sqlite-new-token" })
  expect(await findApiKeyByValue(original.key)).toBeUndefined()
  expect(await findApiKeyByValue(rotated.key)).toMatchObject({ id: original.id })

  await closeLocalDatabase()
  const persisted = await runInWorkspace({ id: "rotation-sqlite-owner", storageMode: "scoped" }, async () => {
    const keys = await listApiKeys()
    return keys.find(apiKey => apiKey.id === original.id)
  })
  expect(persisted).toMatchObject({ id: original.id, name: original.name, createdAt: original.createdAt, key: "sqlite-new-token" })

  const audit = await queryAudit({ workspaceId: "rotation-sqlite-owner" })
  const rotationEvent = audit.find(event => event.resource === "gateway-key" && event.action === "credential.update")
  expect(rotationEvent).toMatchObject({ result: "success" })
  expect(JSON.stringify(rotationEvent)).not.toContain(original.key)
  expect(JSON.stringify(rotationEvent)).not.toContain(rotated.key)
})
