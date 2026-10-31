import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { queryAudit } from "@rawroute/platform/server/audit"
import { closeLocalCache } from "@rawroute/platform/server/local-cache"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { closeLocalDatabase } from "@rawroute/platform/server/database"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"

import { listProviderApiKeys, providerApiKeyRef, reorderProviderApiKeys, upsertProvider, _resetMemoryBackend } from "../../../../../../store"
import { POST } from "./index"

const workspace = { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" as const }
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

async function useSqlite() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "rawroute-provider-api-keys-"))
  Object.assign(process.env, { STORAGE_BACKEND: "sqlite", SQLITE_PATH: join(temporaryDirectory, "test.sqlite") })
}

function saveRequest(value: unknown) {
  return new Request("http://rawroute.test/api/admin/providers/provider-a/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerApiKey: value }),
  })
}

async function save(providerId: string, value: unknown) {
  return POST(saveRequest(value), { providerId })
}

async function createProvider(prefix: string, authType: "bearer" | "none" = "bearer") {
  return upsertProvider({
    name: prefix,
    prefix,
    baseUrl: "https://api.example.test/v1",
    protocol: "openai-chat",
    authType,
    headers: {},
    enabled: true,
  })
}

async function verifyLimitMutationSemantics() {
  const provider = await createProvider("limit-test")

  const omittedCreate = await save(provider.id, { name: "No limits", key: "no-limit-secret" })
  expect(omittedCreate.status).toBe(200)
  expect(JSON.stringify(await omittedCreate.json())).not.toContain("no-limit-secret")

  const blankCreate = await save(provider.id, { name: "Blank limits", key: "blank-limit-secret", rpmLimit: null, maxConcurrency: null })
  expect(blankCreate.status).toBe(200)

  const legacyCreate = await save(provider.id, { name: "Legacy limits", key: "legacy-limit-secret", rpmLimit: 60, maxConcurrency: 4 })
  expect(legacyCreate.status).toBe(200)
  expect(JSON.stringify(await legacyCreate.json())).not.toContain("legacy-limit-secret")

  let keys = await listProviderApiKeys(provider.id)
  const noLimit = keys.find((key) => key.name === "No limits")!
  const blank = keys.find((key) => key.name === "Blank limits")!
  const legacy = keys.find((key) => key.name === "Legacy limits")!
  expect(noLimit).not.toHaveProperty("rpmLimit")
  expect(noLimit).not.toHaveProperty("maxConcurrency")
  expect(blank).not.toHaveProperty("rpmLimit")
  expect(blank).not.toHaveProperty("maxConcurrency")
  expect(legacy).toMatchObject({ rpmLimit: 60, maxConcurrency: 4 })

  await reorderProviderApiKeys(provider.id, [noLimit.id, legacy.id, blank.id])
  const ordered = await listProviderApiKeys(provider.id)
  const legacyPriority = ordered.find((key) => key.id === legacy.id)!.priority
  const blankPriority = ordered.find((key) => key.id === blank.id)!.priority

  const omittedUpdate = await save(provider.id, {
    originalId: legacy.id,
    name: "Legacy updated",
    key: "__unchanged__",
    enabled: false,
  })
  expect(omittedUpdate.status).toBe(200)
  expect(JSON.stringify(await omittedUpdate.json())).not.toContain("legacy-limit-secret")
  keys = await listProviderApiKeys(provider.id)
  expect(keys.find((key) => key.id === legacy.id)).toMatchObject({
    name: "Legacy updated",
    key: "legacy-limit-secret",
    enabled: false,
    rpmLimit: 60,
    maxConcurrency: 4,
    priority: legacyPriority,
  })
  expect(keys.find((key) => key.id === blank.id)?.priority).toBe(blankPriority)

  const partialClear = await save(provider.id, { originalId: legacy.id, name: "Legacy updated", key: "__unchanged__", maxConcurrency: null })
  expect(partialClear.status).toBe(200)
  let updatedLegacy = (await listProviderApiKeys(provider.id)).find((key) => key.id === legacy.id)!
  expect(updatedLegacy.rpmLimit).toBe(60)
  expect(updatedLegacy).not.toHaveProperty("maxConcurrency")

  const stringUpdate = await save(provider.id, { originalId: legacy.id, name: "Legacy updated", key: "__unchanged__", maxConcurrency: "8" })
  expect(stringUpdate.status).toBe(200)
  expect((await listProviderApiKeys(provider.id)).find((key) => key.id === legacy.id)).toMatchObject({ rpmLimit: 60, maxConcurrency: 8 })

  const clear = await save(provider.id, { originalId: legacy.id, name: "Legacy updated", key: "__unchanged__", rpmLimit: null, maxConcurrency: null })
  expect(clear.status).toBe(200)
  updatedLegacy = (await listProviderApiKeys(provider.id)).find((key) => key.id === legacy.id)!
  expect(updatedLegacy).not.toHaveProperty("rpmLimit")
  expect(updatedLegacy).not.toHaveProperty("maxConcurrency")
  expect(updatedLegacy).toMatchObject({ key: "legacy-limit-secret", enabled: false, priority: legacyPriority })

  if (process.env.STORAGE_BACKEND === "sqlite") {
    const document = await providerApiKeyRef(provider.id, legacy.id).get()
    expect(document.data()).not.toHaveProperty("rpmLimit")
    expect(document.data()).not.toHaveProperty("maxConcurrency")
  }

  const audit = await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID })
  expect(audit.some((event) => event.resource === "provider-credential" && event.action === "credential.create")).toBe(true)
  expect(audit.some((event) => event.resource === "provider-credential" && event.action === "credential.update")).toBe(true)
  expect(JSON.stringify(audit)).not.toContain("legacy-limit-secret")
}

test("API key local limits distinguish omitted, clear, and set values in memory storage", async () => {
  await runInWorkspace(workspace, verifyLimitMutationSemantics)
})

test("API key local limits have the same mutation and audit semantics in SQLite", async () => {
  await useSqlite()
  await runInWorkspace(workspace, verifyLimitMutationSemantics)
})

test("API key limits reject non-positive, unsafe, non-integer, and blank values without partial updates", async () => {
  await runInWorkspace(workspace, async () => {
    const provider = await createProvider("invalid-limit-test")
    const created = await save(provider.id, { name: "Valid", key: "valid-limit-secret", rpmLimit: 60, maxConcurrency: 4 })
    expect(created.status).toBe(200)
    const key = (await listProviderApiKeys(provider.id))[0]!

    const invalid = [
      { rpmLimit: 0 },
      { rpmLimit: -1 },
      { rpmLimit: 1.5 },
      { rpmLimit: "1.5" },
      { rpmLimit: "" },
      { rpmLimit: Number.MAX_SAFE_INTEGER + 1 },
      { maxConcurrency: 0 },
      { maxConcurrency: -1 },
      { maxConcurrency: 1.5 },
      { maxConcurrency: "1.5" },
      { maxConcurrency: " " },
      { rpmLimit: null, maxConcurrency: 0 },
    ]
    for (const limits of invalid) {
      const response = await save(provider.id, { originalId: key.id, name: key.name, key: "__unchanged__", ...limits })
      expect(response.status).toBe(400)
    }

    expect((await listProviderApiKeys(provider.id))[0]).toMatchObject({ key: "valid-limit-secret", rpmLimit: 60, maxConcurrency: 4 })
  })
})

test("Codex and providers without authentication cannot save provider API keys", async () => {
  await runInWorkspace(workspace, async () => {
    const noAuth = await createProvider("no-auth-test", "none")
    const codex = await createProvider("codex")
    const codexProvider = await upsertProvider({ originalId: codex.id, prefix: "codex" })

    const noAuthResponse = await save(noAuth.id, { name: "Invalid", key: "no-auth-secret", rpmLimit: 60 })
    const codexResponse = await save(codexProvider.id, { name: "Invalid", key: "codex-secret", maxConcurrency: 4 })

    expect(noAuthResponse.status).toBe(400)
    expect(await noAuthResponse.json()).toMatchObject({ error: { message: "This provider uses no API keys." } })
    expect(codexResponse.status).toBe(400)
    expect(await codexResponse.json()).toMatchObject({ error: { message: "Codex accounts are managed from the Codex provider page." } })
  })
})
