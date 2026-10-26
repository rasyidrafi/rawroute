import { beforeEach, expect, test, mock } from "bun:test"

const mocks = {
  cliproxyManagement: mock(),
  cliproxyManagementJson: mock(),
  localCacheDelete: mock(),
  localCacheCompareAndDelete: mock(),
  localCacheGet: mock(),
  localCacheSet: mock(),
  localCacheSetIfAbsent: mock(),
  recordLog: mock(),
  getProvider: mock(),
  listProviderApiKeys: mock(),
  listProviderModels: mock(),
  currentWorkspaceId: mock(),
}

mock.module("../../../packages/gateway-ai/src/server/cliproxy/management", () => ({
  cliproxyManagement: mocks.cliproxyManagement,
  cliproxyManagementJson: mocks.cliproxyManagementJson,
}))
mock.module("../../../packages/platform/src/server/local-cache", () => ({
  localCacheCompareAndDelete: mocks.localCacheCompareAndDelete,
  localCacheDelete: mocks.localCacheDelete,
  localCacheGet: mocks.localCacheGet,
  localCacheSet: mocks.localCacheSet,
  localCacheSetIfAbsent: mocks.localCacheSetIfAbsent,
}))
mock.module("../../../packages/gateway-ai/src/server/logging", () => ({ recordLog: mocks.recordLog }))
mock.module("../../../packages/gateway-ai/src/server/store", () => ({
  getProvider: mocks.getProvider,
  listProviderApiKeys: mocks.listProviderApiKeys,
  listProviderModels: mocks.listProviderModels,
}))
mock.module("../../../packages/platform/src/server/workspace-context", () => ({ currentWorkspaceId: mocks.currentWorkspaceId }))

const { ensureNonCodexProviderProjection, nonCodexProviderPrefix, syncNonCodexProviderProjection } = await import("../../../packages/gateway-ai/src/server/cliproxy/provider-sync")

const successfulResponse = () => new Response(null, { status: 200 })

function setupManagement(strategy = "fill-first") {
  let openai: unknown[] = [{
    name: "unmanaged-openrouter",
    prefix: "external",
    "base-url": "https://unmanaged.example/v1",
    models: [{ name: "unmanaged", alias: "unmanaged" }],
  }]
  let claude: unknown[] = []
  mocks.cliproxyManagementJson.mockImplementation(async (path: string) => {
    if (path.endsWith("/routing/strategy")) return { response: successfulResponse(), data: strategy }
    if (path.endsWith("/openai-compatibility")) return { response: successfulResponse(), data: openai }
    if (path.endsWith("/claude")) return { response: successfulResponse(), data: claude }
    throw new Error(`unexpected management GET ${path}`)
  })
  mocks.cliproxyManagement.mockImplementation(async (path: string, init: RequestInit = {}) => {
    if (path.endsWith("/openai-compatibility") && init.method === "PUT") openai = JSON.parse(String(init.body))
    if (path.endsWith("/claude") && init.method === "PUT") claude = JSON.parse(String(init.body))
    return successfulResponse()
  })
}

beforeEach(() => {
  mock.clearAllMocks()
  process.env.CLIPROXY_MANAGEMENT_KEY = "management-secret"
  mocks.currentWorkspaceId.mockReturnValue("workspace-a")
  mocks.localCacheGet.mockResolvedValue(undefined)
  mocks.localCacheDelete.mockResolvedValue(true)
  mocks.localCacheCompareAndDelete.mockResolvedValue(true)
  mocks.localCacheSet.mockResolvedValue(true)
  mocks.localCacheSetIfAbsent.mockResolvedValue(undefined)
  mocks.getProvider.mockResolvedValue({
    id: "provider-a",
    name: "Bynara",
    prefix: "bynara",
    baseUrl: "https://api.bynara.example/v1",
    protocol: "openai-chat",
    authType: "bearer",
    headers: { "X-Tenant": "rawroute" },
    enabled: true,
  })
  mocks.listProviderApiKeys.mockResolvedValue([
    { id: "key-primary", name: "Primary", key: "secret-primary", enabled: true, priority: 1 },
    { id: "key-backup", name: "Backup", key: "secret-backup", enabled: true, priority: 0 },
  ])
  mocks.listProviderModels.mockResolvedValue([{
    id: "model-a",
    providerId: "provider-a",
    gatewayModelId: "bynara/model-a",
    name: "Model A",
    upstreamModel: "upstream-a",
    enabled: true,
  }])
  setupManagement()
})

test("projects OpenAI-compatible credentials and priority without deleting unmanaged config", async () => {
  await syncNonCodexProviderProjection("provider-a")

  const openaiPut = mocks.cliproxyManagement.mock.calls.find(([path, init]) => path.endsWith("/openai-compatibility") && init.method === "PUT")
  if (!openaiPut) throw new Error("OpenAI-compatible PUT was not sent")
  const entries = JSON.parse(String(openaiPut[1].body)) as Array<Record<string, unknown>>
  expect(entries[0]).toMatchObject({ name: "unmanaged-openrouter", prefix: "external" })

  const managed = entries.slice(1)
  expect(managed).toHaveLength(2)
  expect(managed[0]).toMatchObject({
    prefix: nonCodexProviderPrefix("workspace-a", "provider-a"),
    priority: 1,
    "base-url": "https://api.bynara.example/v1",
    models: [{ name: "upstream-a", alias: "model-a", "force-mapping": true }],
    headers: { "X-Tenant": "rawroute" },
  })
  expect(managed[0].keys).toEqual([{ "api-key": "secret-primary" }])
  expect(managed[1]).not.toHaveProperty("priority")
  expect(managed[1].keys).toEqual([{ "api-key": "secret-backup" }])
  expect(mocks.recordLog).toHaveBeenCalledWith("admin.cliproxy.provider.projection.reconciled", expect.objectContaining({ providerId: "provider-a", projectedCredentials: 2, projectedModels: 1 }), { level: "info" })
  expect(JSON.stringify(mocks.recordLog.mock.calls)).not.toContain("secret-primary")
  expect(JSON.stringify(mocks.recordLog.mock.calls)).not.toContain("secret-backup")
})

test("separates the same RawRoute prefix across workspaces", async () => {
  expect(nonCodexProviderPrefix("workspace-a", "provider-a")).not.toBe(nonCodexProviderPrefix("workspace-b", "provider-a"))
})

test("V8 omitted configuration paths are empty/default, but generic 404 responses are failures", async () => {
  mocks.cliproxyManagementJson.mockResolvedValue({ response: Response.json({ error: "not_found" }, { status: 404 }), data: { error: "not_found" } })
  await syncNonCodexProviderProjection("fresh-provider")
  expect(mocks.cliproxyManagement).toHaveBeenCalledWith("/v8/management/config/api-keys/openai-compatibility", expect.objectContaining({ method: "PUT" }))
  expect(mocks.cliproxyManagement).toHaveBeenCalledWith("/v8/management/config/routing/strategy", expect.objectContaining({ method: "PUT", body: '"fill-first"' }))
  mocks.cliproxyManagementJson.mockResolvedValue({ response: new Response("404 page not found", { status: 404 }), data: undefined })
  await expect(syncNonCodexProviderProjection("old-engine")).rejects.toThrow("configuration read failed (404)")
})

test("projects prompt cache key support only when the provider opts in", async () => {
  mocks.getProvider.mockResolvedValue({
    id: "provider-a",
    name: "Bynara",
    prefix: "bynara",
    baseUrl: "https://api.bynara.example/v1",
    protocol: "openai-chat",
    authType: "bearer",
    headers: {},
    supportPromptCacheKey: true,
    enabled: true,
  })

  await syncNonCodexProviderProjection("provider-a")

  const openaiPut = mocks.cliproxyManagement.mock.calls.find(([path, init]) => path.endsWith("/openai-compatibility") && init.method === "PUT")
  if (!openaiPut) throw new Error("OpenAI-compatible PUT was not sent")
  const entries = JSON.parse(String(openaiPut[1].body)) as Array<Record<string, unknown>>
  expect(entries.slice(1).every((entry) => entry["support-prompt-cache-key"] === true)).toBe(true)
})

test("removes a stale Chat projection when a provider changes to Responses", async () => {
  await syncNonCodexProviderProjection("provider-a")
  mocks.cliproxyManagement.mockClear()
  mocks.getProvider.mockResolvedValue({ id: "provider-a", name: "Bynara", prefix: "bynara", baseUrl: "https://api.bynara.example/v1", protocol: "openai-responses", authType: "bearer", headers: {}, enabled: true })

  await syncNonCodexProviderProjection("provider-a")

  const openaiPut = mocks.cliproxyManagement.mock.calls.find(([path, init]) => path.endsWith("/openai-compatibility") && init.method === "PUT")
  if (!openaiPut) throw new Error("stale OpenAI-compatible projection was not removed")
  const entries = JSON.parse(String(openaiPut[1].body)) as Array<Record<string, unknown>>
  expect(entries).toEqual([expect.objectContaining({ name: "unmanaged-openrouter" })])
})

test("projects Anthropic credentials with fill-first priority", async () => {
  mocks.getProvider.mockResolvedValue({
    id: "provider-a",
    name: "Anthropic pool",
    prefix: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic-messages",
    authType: "x-api-key",
    headers: {},
    enabled: true,
  })
  mocks.listProviderModels.mockResolvedValue([{
    id: "model-a",
    providerId: "provider-a",
    gatewayModelId: "anthropic/model-a",
    name: "Model A",
    upstreamModel: "upstream-a",
    enabled: true,
  }])
  setupManagement("round-robin")

  await syncNonCodexProviderProjection("provider-a")

  const claudePut = mocks.cliproxyManagement.mock.calls.find(([path, init]) => path.endsWith("/claude") && init.method === "PUT")
  if (!claudePut) throw new Error("Anthropic PUT was not sent")
  const entries = JSON.parse(String(claudePut[1].body)) as Array<Record<string, unknown>>
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({
    keys: [{ "api-key": "secret-primary" }],
    priority: 1,
    prefix: nonCodexProviderPrefix("workspace-a", "provider-a"),
    models: [{ name: "upstream-a", alias: "model-a", "force-mapping": true }],
  })
  expect(entries[1].keys).toEqual([{ "api-key": "secret-backup" }])
  expect(mocks.cliproxyManagement).toHaveBeenCalledWith("/v8/management/config/routing/strategy", expect.objectContaining({ method: "PUT", body: JSON.stringify("fill-first") }))
  // A second sync must recognize its own Claude groups, not report a namespace conflict.
  await syncNonCodexProviderProjection("provider-a")
})

test("surfaces management failures without logging credentials", async () => {
  mocks.cliproxyManagementJson.mockImplementation(async (path: string) => ({ response: new Response(null, { status: path.endsWith("openai-compatibility") ? 503 : 200 }), data: [] }))

  await expect(syncNonCodexProviderProjection("provider-a")).rejects.toThrow("CLIProxy OpenAI-compatible configuration read failed (503).")
  expect(JSON.stringify(mocks.recordLog.mock.calls)).not.toContain("secret-primary")
  expect(mocks.localCacheDelete).toHaveBeenCalledWith("rawroute:cliproxy-provider-sync:v1:state:workspace-a:provider-a")
})

test("uses local projection state on the hot request path", async () => {
  await ensureNonCodexProviderProjection("provider-cache")
  const readsAfterReconcile = mocks.getProvider.mock.calls.length + mocks.listProviderApiKeys.mock.calls.length + mocks.listProviderModels.mock.calls.length

  await ensureNonCodexProviderProjection("provider-cache")

  expect(mocks.getProvider.mock.calls.length + mocks.listProviderApiKeys.mock.calls.length + mocks.listProviderModels.mock.calls.length).toBe(readsAfterReconcile)
})

test("releases an acquired distributed projection lock", async () => {
  mocks.localCacheSetIfAbsent.mockResolvedValue(true)

  await syncNonCodexProviderProjection("provider-a")

  expect(mocks.localCacheCompareAndDelete).toHaveBeenCalledWith(
    "rawroute:cliproxy-provider-sync:v1:lock:workspace-a:provider-a",
    expect.any(String),
  )
})

test("an unknown lock result is cleaned up so the next provider edit can synchronize", async () => {
  let owner: string | undefined
  let first = true
  mocks.localCacheSetIfAbsent.mockImplementation(async (_key: string, token: string) => {
    if (owner) return false
    owner = token
    if (first) { first = false; return undefined }
    return true
  })
  mocks.localCacheCompareAndDelete.mockImplementation(async (_key: string, token: string) => {
    if (owner !== token) return false
    owner = undefined
    return true
  })

  await syncNonCodexProviderProjection("provider-a")
  expect(owner).toBeUndefined()
  await syncNonCodexProviderProjection("provider-a")
  expect(owner).toBeUndefined()
  expect(mocks.localCacheSetIfAbsent).toHaveBeenCalledTimes(2)
})
