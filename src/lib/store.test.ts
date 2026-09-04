import { beforeEach, describe, expect, test } from "vitest"

import {
  _memorySnapshot,
  _resetMemoryBackend,
  assertProductionBootstrap,
  createApiKey,
  deleteApiKey,
  deleteProvider,
  deleteProviderApiKey,
  getProvider,
  hashPassword,
  listApiKeys,
  listIndexedApiKeyNames,
  listProviderApiKeys,
  listProviderModels,
  readMeta,
  stripUndefined,
  updateApiKeyName,
  updateMeta,
  upsertModel,
  upsertProvider,
  upsertProviderApiKey,
  validatePasswordUpdate,
  verifyPassword,
} from "@/lib/store"

import type { Model, Provider } from "@/lib/types"

beforeEach(() => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
})

function providerInput(id = "openai"): Partial<Provider> {
  return {
    id,
    name: id === "openai" ? "OpenAI" : id,
    prefix: id,
    baseUrl: "https://api.example.com/v1",
    protocol: "openai-chat",
    authType: "bearer",
    headers: {},
    enabled: true,
  }
}

describe("admin passwords", () => {
  test("stores a salted hash rather than the password", () => {
    const hash = hashPassword("a-strong-test-password")
    expect(hash).not.toContain("a-strong-test-password")
    expect(verifyPassword("a-strong-test-password", hash)).toBe(true)
  })

  test("rejects the wrong password", () => {
    const hash = hashPassword("correct-password")
    expect(verifyPassword("wrong-password", hash)).toBe(false)
  })

  test("validates current password and matching replacement", () => {
    const hash = hashPassword("current-password")
    expect(() => validatePasswordUpdate("wrong-password", "new-password-123", "new-password-123", hash)).toThrow("Current password is incorrect.")
    expect(() => validatePasswordUpdate("current-password", "new-password-123", "different-password", hash)).toThrow("New passwords do not match.")
    expect(() => validatePasswordUpdate("current-password", "new-password-123", "new-password-123", hash)).not.toThrow()
  })
})

describe("configuration storage", () => {
  test("removes undefined optional fields before Firestore writes", () => {
    const data = stripUndefined({
      providers: [{ id: "openai", secret: undefined }],
      models: [{ id: "oa/test", staleField: undefined }],
      nested: { keep: "value", omit: undefined },
    })

    expect(data as unknown).toEqual({
      providers: [{ id: "openai" }],
      models: [{ id: "oa/test" }],
      nested: { keep: "value" },
    })
  })

  test("persists metadata through the canonical store API", async () => {
    const before = await readMeta()
    await updateMeta((meta) => { meta.admin.username = "test-admin" })
    const after = await readMeta()
    expect(after.admin.username).toBe("test-admin")
    after.admin.username = "mutated-copy"
    expect((await readMeta()).admin.username).toBe("test-admin")
    await updateMeta((meta) => { meta.admin.username = before.admin.username })
  })

  test("maintains provider counters for API keys and models", async () => {
    const provider = await upsertProvider(providerInput())
    expect(await getProvider(provider.id)).toMatchObject({
      apiKeyCount: 0,
      enabledApiKeyCount: 0,
      modelCount: 0,
      enabledModelCount: 0,
    })

    await upsertProviderApiKey(provider.id, { name: "Enabled", key: "enabled-key", enabled: true })
    await upsertProviderApiKey(provider.id, { name: "Disabled", key: "disabled-key", enabled: false })
    const firstModel = await upsertModel(provider.id, { id: "openai/first", name: "First", upstreamModel: "first", enabled: true })
    await upsertModel(provider.id, { id: "openai/second", name: "Second", upstreamModel: "second", enabled: false })

    expect(await getProvider(provider.id)).toMatchObject({
      apiKeyCount: 2,
      enabledApiKeyCount: 1,
      modelCount: 2,
      enabledModelCount: 1,
    })

    await upsertModel(provider.id, { originalId: firstModel.id, name: "First", upstreamModel: "first", enabled: false })
    expect(await getProvider(provider.id)).toMatchObject({ modelCount: 2, enabledModelCount: 0 })
  })

  test("assigns generated document IDs while preserving gateway identifiers", async () => {
    const provider = await upsertProvider({ ...providerInput(), id: "user-supplied-provider-id" })
    const apiKey = await upsertProviderApiKey(provider.id, { id: "user-supplied-key-id", name: "Primary", key: "provider-key" })
    const model = await upsertModel(provider.id, { id: "openai/chat", name: "Chat", upstreamModel: "upstream-chat" })

    expect(provider.id).not.toBe("user-supplied-provider-id")
    expect(apiKey.id).not.toBe("user-supplied-key-id")
    expect(model.id).not.toBe("openai/chat")
    expect(model.gatewayModelId).toBe("openai/chat")
  })

  test("keeps provider subcollections when provider details change", async () => {
    const provider = await upsertProvider(providerInput("renamed"))
    await upsertProviderApiKey(provider.id, { name: "Primary", key: "provider-key", enabled: true })
    await upsertModel(provider.id, { id: "renamed/chat", name: "Chat", upstreamModel: "upstream-chat", enabled: true })

    await upsertProvider({ originalId: provider.id, prefix: "current", name: "Current", baseUrl: "https://api.example.com/v2", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })

    expect(await getProvider(provider.id)).toMatchObject({ id: provider.id, prefix: "current", apiKeyCount: 1, modelCount: 1 })
    expect(await listProviderApiKeys(provider.id)).toMatchObject([{ providerId: provider.id, key: "provider-key" }])
    expect(await listProviderModels(provider.id)).toMatchObject([{ providerId: provider.id, gatewayModelId: "current/chat" }])
    expect(_memorySnapshot().providerApiKeys.has(provider.id)).toBe(true)
    expect(_memorySnapshot().models.has(provider.id)).toBe(true)
  })

  test("deleting a provider cascades its API keys and models", async () => {
    const provider = await upsertProvider(providerInput())
    await upsertProviderApiKey(provider.id, { name: "Primary", key: "provider-key", enabled: true })
    await upsertModel(provider.id, { id: "openai/chat", name: "Chat", upstreamModel: "upstream-chat", enabled: true })

    await deleteProvider(provider.id)

    expect(await getProvider(provider.id)).toBeUndefined()
    expect(await listProviderApiKeys(provider.id)).toEqual([])
    expect(await listProviderModels(provider.id)).toEqual([])
    expect(_memorySnapshot().providers.has(provider.id)).toBe(false)
    expect(_memorySnapshot().providerApiKeys.has(provider.id)).toBe(false)
    expect(_memorySnapshot().models.has(provider.id)).toBe(false)
  })

  test("tracks enabled provider API keys across updates and deletes", async () => {
    const provider = await upsertProvider(providerInput())
    const apiKey = await upsertProviderApiKey(provider.id, { name: "Rotating", key: "provider-key", enabled: false })
    expect(await getProvider(provider.id)).toMatchObject({ apiKeyCount: 1, enabledApiKeyCount: 0 })

    await upsertProviderApiKey(provider.id, { originalId: apiKey.id, name: "Rotating", key: "provider-key", enabled: true })
    expect(await getProvider(provider.id)).toMatchObject({ apiKeyCount: 1, enabledApiKeyCount: 1 })

    await upsertProviderApiKey(provider.id, { originalId: apiKey.id, name: "Rotating", key: "provider-key", enabled: false })
    await deleteProviderApiKey(provider.id, apiKey.id)
    expect(await getProvider(provider.id)).toMatchObject({ apiKeyCount: 0, enabledApiKeyCount: 0 })
  })

  test("stores CLIProxy Codex mappings without an API key value", async () => {
    const provider = await upsertProvider(providerInput("codex"))
    const account = await upsertProviderApiKey(provider.id, {
      name: "Codex account",
      key: "",
      credentialKind: "codex-cli-proxy",
      cliProxyAuthFile: "codex-account.json",
      cliProxyAuthIndex: "auth-index-1",
      enabled: true,
    })

    expect(account).toMatchObject({
      credentialKind: "codex-cli-proxy",
      key: "",
      cliProxyAuthFile: "codex-account.json",
      cliProxyAuthIndex: "auth-index-1",
    })
  })

  test("persists only canonical model fields", async () => {
    const provider = await upsertProvider(providerInput())
    const model = await upsertModel(provider.id, {
      gatewayModelId: "openai/chat",
      name: "Chat",
      upstreamModel: "upstream-chat",
      unexpectedField: true,
    } as Partial<Model> & { unexpectedField: boolean })

    const updated = await upsertModel(provider.id, {
      originalId: model.id,
      gatewayModelId: "openai/chat",
      name: "Chat",
      upstreamModel: "upstream-chat",
    })

    expect(updated).not.toHaveProperty("unexpectedField")
    expect(updated).not.toHaveProperty("protocol")
  })

  test("persists only canonical provider fields", async () => {
    const provider = await upsertProvider({
      ...providerInput(),
      unexpectedField: true,
    } as Partial<Provider> & { unexpectedField: boolean })

    expect(provider).not.toHaveProperty("unexpectedField")
  })

  test("rejects invalid provider API key configuration", async () => {
    const provider = await upsertProvider(providerInput())
    await expect(upsertProviderApiKey(provider.id, { name: "", key: "" })).rejects.toThrow("API key name is required.")
    await expect(upsertProviderApiKey(provider.id, { name: "Primary", key: "key", rpmLimit: 0 })).rejects.toThrow("RPM limit")
  })

  test("allows a workspace to delete its final gateway API key", async () => {
    const onlyKey = (await listApiKeys())[0]
    if (!onlyKey) throw new Error("Memory backend did not seed a gateway API key.")
    await deleteApiKey(onlyKey.id)
    expect(await listApiKeys()).toEqual([])

    const extraKey = await createApiKey("Extra")
    expect((await listApiKeys()).map((apiKey) => apiKey.id)).toEqual([extraKey.id])
  })

  test("supports custom gateway key values and preserves generated keys", async () => {
    const generated = await createApiKey("Generated")
    const custom = await createApiKey("Custom", "  client-secret  ")
    expect(generated.key).toMatch(/^sk-rr-/)
    expect(custom.key).toBe("client-secret")
  })

  test("updates a gateway API key name without changing its value", async () => {
    const apiKey = await createApiKey("Original", "client-secret")
    const updated = await updateApiKeyName(apiKey.id, " Renamed ")
    expect(updated).toMatchObject({ id: apiKey.id, name: "Renamed", key: "client-secret" })
    expect((await listApiKeys()).find((entry) => entry.id === apiKey.id)).toMatchObject({ name: "Renamed", key: "client-secret" })
  })

  test("resolves API-key names from every workspace index", async () => {
    const defaultKey = await createApiKey("Default name", "default-name-secret")
    const scopedKey = await createApiKey("Scoped name", "scoped-name-secret")
    expect((await listIndexedApiKeyNames()).get(defaultKey.id)).toBe("Default name")
    expect((await listIndexedApiKeyNames()).get(scopedKey.id)).toBe("Scoped name")
  })

  test("enforces case-sensitive uniqueness against the bootstrap key and cleans indexes on delete", async () => {
    const bootstrap = (await listApiKeys())[0]
    if (!bootstrap) throw new Error("Memory backend did not seed a gateway API key.")
    await expect(createApiKey("Duplicate", bootstrap.key)).rejects.toThrow("already in use")
    const lower = await createApiKey("Lower", "Case-Sensitive")
    const upper = await createApiKey("Upper", "case-sensitive")
    expect(lower.key).not.toBe(upper.key)
    await deleteApiKey(lower.id)
    const recreated = await createApiKey("Recreated", lower.key)
    expect(recreated.key).toBe(lower.key)
  })

  test("rejects empty and oversized custom values", async () => {
    await expect(createApiKey("Empty", "   ")).rejects.toThrow("value is required")
    await expect(createApiKey("Long", "x".repeat(257))).rejects.toThrow("256 characters")
  })

  test("allows the canonical API to remove the final gateway key", async () => {
    const key = (await listApiKeys())[0]
    if (!key) throw new Error("Memory backend did not seed a gateway API key.")
    await deleteApiKey(key.id)
    expect(await listApiKeys()).toEqual([])
  })
})

describe("production bootstrap", () => {
  test("rejects missing or documented default credentials", () => {
    expect(() => assertProductionBootstrap({})).toThrow()
    expect(() => assertProductionBootstrap({
      DEFAULT_ADMIN_PASSWORD: "change-me-now",
      DEFAULT_PROXY_API_KEY: "sk-local-change-me",
      SESSION_SECRET: "01234567890123456789012345678901",
    })).toThrow()
  })

  test("accepts explicitly configured non-default secrets", () => {
    expect(() => assertProductionBootstrap({
      DEFAULT_ADMIN_PASSWORD: "a-private-admin-password",
      DEFAULT_PROXY_API_KEY: "sk-private-gateway-key",
      SESSION_SECRET: "01234567890123456789012345678901",
    })).not.toThrow()
  })
})
