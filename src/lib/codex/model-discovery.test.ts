import { beforeEach, expect, test, vi } from "vitest"
const mocks = vi.hoisted(() => ({ files: vi.fn(), management: vi.fn(), cache: new Map<string, string>() }))
vi.mock("@/lib/local-redis", () => ({
  localRedisGet: async (key: string) => mocks.cache.get(key),
  localRedisSet: async (key: string, value: string) => { mocks.cache.set(key, value); return true },
  localRedisSetIfAbsent: async () => true,
  localRedisCompareAndDelete: async () => true,
  localRedisDelete: async () => true,
}))
vi.mock("@/lib/codex/cliproxy", () => ({
  codexWorkspacePrefix: (id: string) => `rr-${id}`,
  listCliProxyCodexAuthFiles: mocks.files,
  cliproxyManagement: mocks.management,
}))
import { parseCodexModels, refreshCodexModels } from "@/lib/codex/model-discovery"
import { ensureCodexProvider } from "@/lib/codex/oauth"
import { _resetMemoryBackend, listProviderModels, reconcileDiscoveredModel, upsertModel, upsertProviderApiKey, deleteModel, upsertAlias, listAliases } from "@/lib/store"
import { runInWorkspace } from "@/lib/workspace/context"

beforeEach(() => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  mocks.cache.clear()
  vi.clearAllMocks()
  mocks.files.mockResolvedValue([{ name: "account.json", prefix: "rr-default", disabled: false }])
  mocks.management.mockImplementation(async () => Response.json({ models: [{ id: "rr-default/future-model", display_name: "Future model" }, { id: "future-model" }, { id: "rr-other/private-model" }] }))
})

async function setup() {
  const provider = await ensureCodexProvider()
  await upsertProviderApiKey(provider.id, { name: "Account", key: "", credentialKind: "codex-cli-proxy", cliProxyAuthFile: "account.json", enabled: true })
  return provider
}

test("discovers unknown models, ignores bare/foreign routes, and preserves disabled state", async () => {
  const provider = await setup()
  expect(await listProviderModels(provider.id)).toEqual([])
  expect(await refreshCodexModels()).toMatchObject({ added: 1 })
  const [model] = await listProviderModels(provider.id)
  expect(model).toMatchObject({ gatewayModelId: "codex/future-model", upstreamModel: "future-model", source: "discovered", enabled: true, discovery: { stale: false } })
  await upsertModel(provider.id, { originalId: model.id, enabled: false })
  await refreshCodexModels(true)
  expect(await listProviderModels(provider.id)).toMatchObject([{ id: model.id, enabled: false }])
  await expect(deleteModel(provider.id, model.id)).rejects.toThrow("disable")
  await expect(upsertModel(provider.id, { originalId: model.id, upstreamModel: "changed" })).rejects.toThrow("managed automatically")
})

test("preserves a custom ID collision, including the internal writer's ownership check", async () => {
  const provider = await setup()
  const custom = await upsertModel(provider.id, { gatewayModelId: "codex/future-model", name: "My mapping", upstreamModel: "alternate", source: "custom", enabled: false })
  expect(await refreshCodexModels(true)).toMatchObject({ skipped: 1, added: 0 })
  expect(await listProviderModels(provider.id)).toEqual([custom])
  await expect(reconcileDiscoveredModel(provider.id, { gatewayModelId: custom.gatewayModelId, name: "Future", upstreamModel: "future-model", discovery: { accountIds: [], stale: false } })).rejects.toThrow("Custom model owns")
})

test("migrates built-ins without breaking aliases and retains absent records", async () => {
  const provider = await setup()
  const old = await upsertModel(provider.id, { gatewayModelId: "codex/old-model", name: "Old", upstreamModel: "old-model", source: "builtin", enabled: false })
  await upsertAlias({ name: "Stable", alias: "stable", targetModelId: old.gatewayModelId })
  await refreshCodexModels(true)
  expect((await listProviderModels(provider.id)).find((entry) => entry.id === old.id)).toMatchObject({ source: "discovered", enabled: false, discovery: { stale: true } })
  expect(await listAliases()).toMatchObject([{ targetModelId: old.gatewayModelId }])
})

test.each([{}, { models: [] }, { models: [{ id: 42 }] }])("keeps last-good data on invalid/empty catalogs: %j", async (payload) => {
  const provider = await setup()
  await refreshCodexModels(true)
  mocks.management.mockResolvedValue(Response.json(payload))
  expect((await refreshCodexModels(true)).error).toBeTruthy()
  expect(await listProviderModels(provider.id)).toMatchObject([{ gatewayModelId: "codex/future-model", discovery: { stale: true } }])
})

test("unions mapped accounts and never imports another workspace's accounts", async () => {
  const provider = await setup()
  await upsertProviderApiKey(provider.id, { name: "Second", key: "", credentialKind: "codex-cli-proxy", cliProxyAuthFile: "second.json" })
  mocks.files.mockResolvedValue([{ name: "account.json", prefix: "rr-default", disabled: false }, { name: "second.json", prefix: "rr-default", disabled: false }, { name: "foreign.json", prefix: "rr-other", disabled: false }])
  mocks.management.mockImplementation(async (url: string) => Response.json({ models: [{ id: url.includes("second.json") ? "rr-default/second-model" : "rr-default/future-model" }] }))
  await refreshCodexModels(true)
  expect(await listProviderModels(provider.id)).toHaveLength(2)
  await runInWorkspace({ id: "other" }, async () => {
    const other = await ensureCodexProvider()
    await refreshCodexModels(true)
    expect(await listProviderModels(other.id)).toEqual([])
  })
  expect(mocks.management).toHaveBeenCalledTimes(2)
})

test("coalesces concurrent refreshes and respects freshness", async () => {
  await setup()
  await Promise.all([refreshCodexModels(), refreshCodexModels()])
  await refreshCodexModels()
  expect(mocks.management).toHaveBeenCalledTimes(1)
})

test("disabled accounts stop contributing availability without deleting models", async () => {
  const provider = await setup()
  await refreshCodexModels(true)
  mocks.files.mockResolvedValue([{ name: "account.json", prefix: "rr-default", disabled: true }])
  await refreshCodexModels(true)
  expect(await listProviderModels(provider.id)).toMatchObject([{ enabled: true, discovery: { accountIds: [], stale: true } }])
  expect(mocks.management).toHaveBeenCalledTimes(1)
})

test("rejects a catalog if account ownership changes during the fetch", async () => {
  const provider = await setup()
  mocks.management.mockImplementation(async () => {
    mocks.files.mockResolvedValue([{ name: "account.json", prefix: "rr-other", disabled: false }])
    return Response.json({ models: [{ id: "rr-default/future-model" }] })
  })
  expect((await refreshCodexModels(true)).error).toContain("accounts changed")
  expect(await listProviderModels(provider.id)).toEqual([])
})

test("network failures retain last-good models and report refresh failure", async () => {
  const provider = await setup()
  await refreshCodexModels(true)
  mocks.management.mockRejectedValue(new Error("Request timed out"))
  const result = await refreshCodexModels(true)
  expect(result.error).toContain("timed out")
  expect(result.succeededAt).toBeTruthy()
  expect(await listProviderModels(provider.id)).toMatchObject([{ gatewayModelId: "codex/future-model", enabled: true }])
})

test("rejects malformed workspace IDs", () => {
  expect(() => parseCodexModels({ models: [{ id: "rr-default/bad id" }] }, "rr-default")).toThrow("Invalid")
})
