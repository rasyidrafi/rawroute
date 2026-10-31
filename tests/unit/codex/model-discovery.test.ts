import { afterEach, beforeEach, expect, mock } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { testsInWorkspace } from "../../helpers/workspace-test"

const test = testsInWorkspace("default")
const mocks = { upstream: mock(), cache: new Map<string, string>() }
mock.module("../../../packages/platform/src/server/local-cache", () => ({
  localCacheGet: async (key: string) => mocks.cache.get(key),
  localCacheSet: async (key: string, value: string) => { mocks.cache.set(key, value); return true },
  localCacheSetIfAbsent: async (key: string, value: string) => { if (mocks.cache.has(key)) return false; mocks.cache.set(key, value); return true },
  localCacheCompareAndDelete: async (key: string, value: string) => mocks.cache.get(key) === value && mocks.cache.delete(key),
  localCacheDelete: async (...keys: string[]) => { keys.forEach(key => mocks.cache.delete(key)); return true },
}))

const { codexDiscoveryStatus, parseCodexModels, refreshCodexModels } = await import("../../../packages/gateway-ai/src/server/codex/model-discovery")
const { ensureCodexProvider } = await import("../../../packages/gateway-ai/src/server/codex/oauth")
const { registerCodexCredential, updateCodexCredential } = await import("../../../packages/gateway-ai/src/server/codex-credentials")
const { setCodexOAuthFetchForTests } = await import("../../../packages/gateway-ai/src/server/codex/login")
const { setCodexUpstreamFetchForTests } = await import("../../../packages/gateway-ai/src/server/codex/upstream")
const { _resetMemoryBackend, listProviderModels, reconcileDiscoveredModel, upsertModel, deleteModel, upsertAlias, listAliases } = await import("../../../packages/gateway-ai/src/server/store")
const { runInWorkspace } = await import("../../../packages/platform/src/server/workspace-context")
const { closeLocalDatabase } = await import("@rawroute/platform/server/database")

let temporaryDirectory: string | undefined

beforeEach(async () => {
  await closeLocalDatabase()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  _resetMemoryBackend()
  mocks.cache.clear()
  mock.clearAllMocks()
  mocks.upstream.mockImplementation(async () => Response.json({ models: [{ slug: "future-model", display_name: "Future model", visibility: "list", supported_in_api: true }] }))
  setCodexOAuthFetchForTests(undefined)
  setCodexUpstreamFetchForTests(mocks.upstream as unknown as typeof fetch)
})

afterEach(async () => {
  setCodexOAuthFetchForTests(undefined)
  setCodexUpstreamFetchForTests(undefined)
  await closeLocalDatabase()
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

async function useSqlite() {
  temporaryDirectory = await mkdtemp(join("/mnt/cache/bull/tmp/opencode", "codex-discovery-"))
  Object.assign(process.env, { STORAGE_BACKEND: "sqlite", SQLITE_PATH: join(temporaryDirectory, "test.sqlite") })
}

async function setup(options: { enabled?: boolean; expiresAt?: string; accountId?: string } = {}) {
  const provider = await ensureCodexProvider()
  const account = await registerCodexCredential(provider.id, {
    accountId: options.accountId || "acct-model-discovery",
    email: "codex@example.com",
    planType: "plus",
    name: "Account",
    secrets: {
      accessToken: "access-account-one",
      refreshToken: "refresh-account-one",
      idToken: "id-account-one",
      expiresAt: options.expiresAt || new Date(Date.now() + 60_000).toISOString(),
      lastRefresh: "2026-10-30T00:00:00.000Z",
    },
  })
  if (options.enabled === false) await updateCodexCredential(provider.id, account.id, { enabled: false })
  return { provider, account }
}

test("discovers direct Codex model slugs and preserves disabled model state", async () => {
  const { provider } = await setup()
  expect(await listProviderModels(provider.id)).toEqual([])
  expect(await refreshCodexModels()).toMatchObject({ added: 1 })
  const [model] = await listProviderModels(provider.id)
  expect(model).toMatchObject({ gatewayModelId: "codex/future-model", upstreamModel: "future-model", source: "discovered", enabled: true, discovery: { stale: false } })
  const [input, init] = mocks.upstream.mock.calls[0]!
  expect(new URL(String(input)).pathname).toBe("/backend-api/codex/models")
  expect(new URL(String(input)).searchParams.get("client_version")).toBeTruthy()
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-account-one")
  expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("acct-model-discovery")

  await upsertModel(provider.id, { originalId: model!.id, enabled: false })
  await refreshCodexModels(true)
  expect(await listProviderModels(provider.id)).toMatchObject([{ id: model!.id, enabled: false }])
  await expect(deleteModel(provider.id, model!.id)).rejects.toThrow("disable")
  await expect(upsertModel(provider.id, { originalId: model!.id, upstreamModel: "changed" })).rejects.toThrow("managed automatically")
})

test("filters models that are hidden or unsupported by the Codex API", () => {
  expect(parseCodexModels({ models: [
    { slug: "visible", display_name: "Visible", visibility: "list", supported_in_api: true },
    { slug: "hidden", visibility: "hidden", supported_in_api: true },
    { slug: "unsupported", visibility: "list", supported_in_api: false },
  ] })).toEqual(new Map([["visible", "Visible"]]))
})

test("preserves a custom ID collision, including the internal writer's ownership check", async () => {
  const { provider } = await setup()
  const custom = await upsertModel(provider.id, { gatewayModelId: "codex/future-model", name: "My mapping", upstreamModel: "alternate", source: "custom", enabled: false })
  expect(await refreshCodexModels(true)).toMatchObject({ skipped: 1, added: 0 })
  expect(await listProviderModels(provider.id)).toEqual([custom])
  await expect(reconcileDiscoveredModel(provider.id, { gatewayModelId: custom.gatewayModelId, name: "Future", upstreamModel: "future-model", discovery: { accountIds: [], stale: false } })).rejects.toThrow("Custom model owns")
})

test("retains absent discovered records without breaking aliases", async () => {
  const { provider } = await setup()
  const old = await reconcileDiscoveredModel(provider.id, { gatewayModelId: "codex/old-model", name: "Old", upstreamModel: "old-model", discovery: { accountIds: [], stale: true } })
  await upsertAlias({ name: "Stable", alias: "stable", targetModelId: old.gatewayModelId })
  await refreshCodexModels(true)
  expect((await listProviderModels(provider.id)).find(entry => entry.id === old.id)).toMatchObject({ source: "discovered", discovery: { stale: true } })
  expect(await listAliases()).toMatchObject([{ targetModelId: old.gatewayModelId }])
})

for (const payload of [{}, { models: [] }, { models: [{ slug: 42 }] }]) test(`keeps last-good data on invalid/empty catalogs: ${JSON.stringify(payload)}`, async () => {
  const { provider } = await setup()
  await refreshCodexModels(true)
  const saved = await listProviderModels(provider.id)
  mocks.upstream.mockResolvedValue(Response.json(payload))
  expect((await refreshCodexModels(true)).error).toBeTruthy()
  expect(await listProviderModels(provider.id)).toEqual(saved)
})

for (const backend of ["memory", "sqlite"] as const) test(`disabled accounts neither refresh nor invalidate discovery on ${backend}`, async () => {
  if (backend === "sqlite") await useSqlite()
  const { provider } = await setup({ enabled: false })
  const result = await refreshCodexModels(true)
  expect(result.error).toBeUndefined()
  expect(result.succeededAt).toBeTruthy()
  expect(mocks.upstream).not.toHaveBeenCalled()
  expect(await listProviderModels(provider.id)).toEqual([])
})

for (const backend of ["memory", "sqlite"] as const) test(`counts an expected expired-session refresh before discovery on ${backend}`, async () => {
  if (backend === "sqlite") await useSqlite()
  await setup({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
  setCodexOAuthFetchForTests((async () => Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", id_token: "fresh-id", expires_in: 3600 })) as unknown as typeof fetch)

  const result = await refreshCodexModels(true)

  expect(result.error).toBeUndefined()
  expect(result.added).toBe(1)
  const [, init] = mocks.upstream.mock.calls[0]!
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-access")
})

test("keeps workspace discovery isolated", async () => {
  const { provider } = await setup()
  await runInWorkspace({ id: "other" }, async () => {
    const otherProvider = await ensureCodexProvider()
    await registerCodexCredential(otherProvider.id, {
      accountId: "acct-other-workspace",
      secrets: { accessToken: "other-access", refreshToken: "other-refresh", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    })
    await refreshCodexModels(true)
    expect(await listProviderModels(otherProvider.id)).toHaveLength(1)
  })
  expect(await listProviderModels(provider.id)).toHaveLength(0)
  expect(mocks.upstream).toHaveBeenCalledTimes(1)
})

test("coalesces concurrent refreshes and respects freshness", async () => {
  await setup()
  await Promise.all([refreshCodexModels(), refreshCodexModels()])
  await refreshCodexModels()
  expect(mocks.upstream).toHaveBeenCalledTimes(1)
})

test("disabled accounts stop contributing availability without deleting models", async () => {
  const { provider, account } = await setup()
  await refreshCodexModels(true)
  await updateCodexCredential(provider.id, account.id, { enabled: false })
  await refreshCodexModels(true)
  expect(await listProviderModels(provider.id)).toMatchObject([{ enabled: true, discovery: { accountIds: [], stale: true } }])
  expect(mocks.upstream).toHaveBeenCalledTimes(1)

  await updateCodexCredential(provider.id, account.id, { enabled: true })
  mocks.upstream.mockResolvedValue(Response.json({ models: [{ slug: "hidden", visibility: "hidden" }] }))
  await refreshCodexModels(true)
  expect(await listProviderModels(provider.id)).toMatchObject([{ enabled: true, discovery: { accountIds: [], stale: true } }])
  expect(mocks.upstream).toHaveBeenCalledTimes(2)
})

for (const backend of ["memory", "sqlite"] as const) test(`rejects an account change during direct discovery on ${backend}`, async () => {
  if (backend === "sqlite") await useSqlite()
  const { provider, account } = await setup()
  mocks.upstream.mockImplementation(async () => {
    await updateCodexCredential(provider.id, account.id, { enabled: false })
    return Response.json({ models: [{ slug: "future-model" }] })
  })

  const result = await refreshCodexModels(true)

  expect(result.error).toContain("accounts changed")
  expect(await listProviderModels(provider.id)).toEqual([])
})

test("keeps last-good models and reports direct upstream failures", async () => {
  const { provider } = await setup()
  await refreshCodexModels(true)
  const saved = await listProviderModels(provider.id)
  mocks.upstream.mockRejectedValue(new Error("private upstream details"))
  const result = await refreshCodexModels(true)
  expect(result.error).toContain("Codex model discovery failed")
  expect(result.error).not.toContain("private upstream details")
  expect(result.succeededAt).toBeTruthy()
  expect(await listProviderModels(provider.id)).toMatchObject([{ gatewayModelId: "codex/future-model", enabled: true }])
  expect(await codexDiscoveryStatus()).toEqual(result)
  expect(await listProviderModels(provider.id)).toEqual(saved)
})

for (const backend of ["memory", "sqlite"] as const) test(`retains model associations for a failed account during partial discovery on ${backend}`, async () => {
  if (backend === "sqlite") await useSqlite()
  const { provider } = await setup()
  await registerCodexCredential(provider.id, {
    accountId: "acct-model-second",
    name: "Second account",
    secrets: { accessToken: "second-access", refreshToken: "second-refresh", expiresAt: new Date(Date.now() + 60_000).toISOString() },
  })
  mocks.upstream.mockImplementation(async (_input, init) => {
    const accountId = new Headers(init?.headers).get("chatgpt-account-id")
    return Response.json({ models: accountId === "acct-model-discovery"
      ? [{ slug: "shared-model" }, { slug: "first-only-model" }]
      : [{ slug: "shared-model" }] })
  })
  await refreshCodexModels(true)
  const initial = await listProviderModels(provider.id)
  const sharedInitially = initial.find(model => model.gatewayModelId === "codex/shared-model")!
  const firstOnly = initial.find(model => model.gatewayModelId === "codex/first-only-model")!
  const failedAccountId = firstOnly.discovery!.accountIds[0]!
  expect(sharedInitially.discovery?.accountIds).toHaveLength(2)
  expect(firstOnly.discovery).toMatchObject({ accountIds: [failedAccountId], stale: false })

  mocks.upstream.mockImplementation(async (_input, init) => {
    const accountId = new Headers(init?.headers).get("chatgpt-account-id")
    if (accountId === "acct-model-discovery") throw new Error("private upstream failure")
    return Response.json({ models: [{ slug: "shared-model" }] })
  })
  const partial = await refreshCodexModels(true)
  const models = await listProviderModels(provider.id)
  const shared = models.find(model => model.gatewayModelId === "codex/shared-model")!
  const retained = models.find(model => model.gatewayModelId === "codex/first-only-model")!
  expect(partial.error).toContain("failed for one account")
  expect(shared.discovery).toMatchObject({ accountIds: expect.arrayContaining([failedAccountId]), stale: false })
  expect(retained.discovery).toMatchObject({ accountIds: [failedAccountId], stale: true })
})

test("rejects malformed Codex model IDs", () => {
  expect(() => parseCodexModels({ models: [{ slug: "bad id" }] })).toThrow("Invalid")
})
