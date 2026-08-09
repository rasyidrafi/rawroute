import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cliproxyManagement: vi.fn(),
  cliproxyManagementJson: vi.fn(),
  localRedisDelete: vi.fn(),
  localRedisGet: vi.fn(),
  localRedisSet: vi.fn(),
  localRedisSetIfAbsent: vi.fn(),
  writeLog: vi.fn(),
  getProvider: vi.fn(),
  listProviderApiKeys: vi.fn(),
  listProviderModels: vi.fn(),
  currentWorkspaceId: vi.fn(),
}))

vi.mock("@/lib/cliproxy-management", () => ({
  cliproxyManagement: mocks.cliproxyManagement,
  cliproxyManagementJson: mocks.cliproxyManagementJson,
}))
vi.mock("@/lib/local-redis", () => ({
  localRedisDelete: mocks.localRedisDelete,
  localRedisGet: mocks.localRedisGet,
  localRedisSet: mocks.localRedisSet,
  localRedisSetIfAbsent: mocks.localRedisSetIfAbsent,
}))
vi.mock("@/lib/logger", () => ({ writeLog: mocks.writeLog }))
vi.mock("@/lib/store", () => ({
  getProvider: mocks.getProvider,
  listProviderApiKeys: mocks.listProviderApiKeys,
  listProviderModels: mocks.listProviderModels,
}))
vi.mock("@/lib/workspace-context", () => ({ currentWorkspaceId: mocks.currentWorkspaceId }))

import { ensureNonCodexProviderProjection, nonCodexProviderPrefix, syncNonCodexProviderProjection } from "@/lib/cliproxy-provider-sync"

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
    if (path.endsWith("/routing/strategy")) return { response: successfulResponse(), data: { strategy } }
    if (path.endsWith("/openai-compatibility")) return { response: successfulResponse(), data: { "openai-compatibility": openai } }
    if (path.endsWith("/claude-api-key")) return { response: successfulResponse(), data: { "claude-api-key": claude } }
    throw new Error(`unexpected management GET ${path}`)
  })
  mocks.cliproxyManagement.mockImplementation(async (path: string, init: RequestInit = {}) => {
    if (path.endsWith("/openai-compatibility") && init.method === "PUT") openai = JSON.parse(String(init.body))
    if (path.endsWith("/claude-api-key") && init.method === "PUT") claude = JSON.parse(String(init.body))
    return successfulResponse()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CLIPROXY_MANAGEMENT_KEY = "management-secret"
  mocks.currentWorkspaceId.mockReturnValue("workspace-a")
  mocks.localRedisGet.mockResolvedValue(undefined)
  mocks.localRedisDelete.mockResolvedValue(true)
  mocks.localRedisSet.mockResolvedValue(true)
  mocks.localRedisSetIfAbsent.mockResolvedValue(undefined)
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
  expect(managed[0]["api-key-entries"]).toEqual([{ "api-key": "secret-primary" }])
  expect(managed[1]).not.toHaveProperty("priority")
  expect(managed[1]["api-key-entries"]).toEqual([{ "api-key": "secret-backup" }])
  expect(mocks.writeLog).toHaveBeenCalledWith("info", "admin", "CLIProxy provider projection reconciled", expect.objectContaining({ providerId: "provider-a", projectedCredentials: 2, projectedModels: 1 }))
  expect(JSON.stringify(mocks.writeLog.mock.calls)).not.toContain("secret-primary")
  expect(JSON.stringify(mocks.writeLog.mock.calls)).not.toContain("secret-backup")
})

test("separates the same RawRoute prefix across workspaces", async () => {
  expect(nonCodexProviderPrefix("workspace-a", "provider-a")).not.toBe(nonCodexProviderPrefix("workspace-b", "provider-a"))
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

  const claudePut = mocks.cliproxyManagement.mock.calls.find(([path, init]) => path.endsWith("/claude-api-key") && init.method === "PUT")
  if (!claudePut) throw new Error("Anthropic PUT was not sent")
  const entries = JSON.parse(String(claudePut[1].body)) as Array<Record<string, unknown>>
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({
    "api-key": "secret-primary",
    priority: 1,
    prefix: nonCodexProviderPrefix("workspace-a", "provider-a"),
    models: [{ name: "upstream-a", alias: "model-a", "force-mapping": true }],
  })
  expect(entries[1]["api-key"]).toBe("secret-backup")
  expect(mocks.cliproxyManagement).toHaveBeenCalledWith("/v0/management/routing/strategy", expect.objectContaining({ method: "PUT", body: JSON.stringify({ value: "fill-first" }) }))
})

test("surfaces management failures without logging credentials", async () => {
  mocks.cliproxyManagementJson.mockImplementation(async (path: string) => ({ response: new Response(null, { status: path.endsWith("openai-compatibility") ? 503 : 200 }), data: path.endsWith("claude-api-key") ? { "claude-api-key": [] } : { "openai-compatibility": [] } }))

  await expect(syncNonCodexProviderProjection("provider-a")).rejects.toThrow("CLIProxy OpenAI-compatible configuration read failed (503).")
  expect(JSON.stringify(mocks.writeLog.mock.calls)).not.toContain("secret-primary")
  expect(mocks.localRedisDelete).toHaveBeenCalledWith("rawroute:cliproxy-provider-sync:v1:state:workspace-a:provider-a")
})

test("uses local projection state on the hot request path", async () => {
  await ensureNonCodexProviderProjection("provider-cache")
  const readsAfterReconcile = mocks.getProvider.mock.calls.length + mocks.listProviderApiKeys.mock.calls.length + mocks.listProviderModels.mock.calls.length

  await ensureNonCodexProviderProjection("provider-cache")

  expect(mocks.getProvider.mock.calls.length + mocks.listProviderApiKeys.mock.calls.length + mocks.listProviderModels.mock.calls.length).toBe(readsAfterReconcile)
})
