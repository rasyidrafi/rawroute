import { beforeEach, describe, expect, test } from "vitest"

import { getDashboardPayload, recordGatewayUsage, resetAnalyticsForTests, upsertBudget } from "@/lib/analytics"
import { authenticateProxyKey } from "@/lib/auth"
import { clearLogs, readLogs, writeLog } from "@/lib/logger"
import { listPricingVersions, savePricingVersion, syncModelPricingGroups } from "@/lib/model-pricing"
import { _deleteMemoryApiKeyIndex, _resetMemoryBackend, createApiKey, findIndexedApiKeyByValue, listApiKeys, listModels, listProviders, upsertModel, upsertProvider } from "@/lib/store"
import { runInWorkspace } from "@/lib/workspace-context"
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, renameWorkspace, resetWorkspacesForTests } from "@/lib/workspaces"

async function configureWorkspacePricing(gatewayModelId: string, upstreamModel: string, inputMicrosPerMillion: number, outputMicrosPerMillion: number) {
  const prefix = gatewayModelId.slice(0, gatewayModelId.indexOf("/"))
  const provider = (await listProviders()).find((entry) => entry.prefix === prefix)
    || await upsertProvider({ name: prefix, prefix, baseUrl: "https://example.test/v1", protocol: "openai-chat", authType: "none", headers: {}, enabled: true })
  const existing = (await listModels()).find((model) => model.providerId === provider.id && model.gatewayModelId === gatewayModelId)
  const model = await upsertModel(provider.id, {
    ...(existing ? { originalId: existing.id } : {}),
    gatewayModelId,
    name: upstreamModel,
    upstreamModel,
    enabled: true,
  })
  const group = (await syncModelPricingGroups()).find((entry) => entry.memberModelIds.includes(model.id))
  if (!group) throw new Error(`Missing pricing group for ${gatewayModelId}`)
  const versions = await listPricingVersions(group.id)
  await savePricingVersion({
    groupId: group.id,
    mode: versions.length ? "replace" : "new",
    rates: { inputMicrosPerMillion, outputMicrosPerMillion, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 },
    contextTiers: [],
  })
}

beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
  await resetWorkspacesForTests()
})

describe("workspace isolation", () => {
  test("creates an immutable Default workspace and empty additional workspaces", async () => {
    const defaultWorkspace = (await listWorkspaces())[0]
    expect(defaultWorkspace).toMatchObject({ id: "default", name: "Default", isDefault: true })

    const workspace = await createWorkspace("Research")
    expect(await runInWorkspace(workspace, () => listApiKeys())).toEqual([])
    await expect(renameWorkspace("default", "Primary")).rejects.toThrow("cannot be renamed")
    await expect(deleteWorkspace("default", "Default")).rejects.toThrow("cannot be deleted")
    await expect(createWorkspace(" research ")).rejects.toThrow("already in use")
  })

  test("isolates configuration while enforcing global gateway key uniqueness", async () => {
    const defaultWorkspace = (await listWorkspaces())[0]
    const workspace = await createWorkspace("Research")

    await runInWorkspace(defaultWorkspace, async () => {
      await upsertProvider({ name: "Default provider", prefix: "shared", baseUrl: "https://default.example/v1", protocol: "openai-chat", authType: "none", headers: {}, enabled: true })
      await createApiKey("Shared", "same-secret")
    })
    await runInWorkspace(workspace, async () => {
      expect(await listProviders()).toEqual([])
      await upsertProvider({ name: "Research provider", prefix: "shared", baseUrl: "https://research.example/v1", protocol: "openai-chat", authType: "none", headers: {}, enabled: true })
      await expect(createApiKey("Conflict", "same-secret")).rejects.toThrow("already in use")
      await createApiKey("Research", "research-secret")
    })

    expect((await runInWorkspace(defaultWorkspace, () => listProviders()))[0]?.name).toBe("Default provider")
    expect((await runInWorkspace(workspace, () => listProviders()))[0]?.name).toBe("Research provider")
    expect((await findIndexedApiKeyByValue("research-secret"))?.workspaceId).toBe(workspace.id)
  })

  test("isolates usage dashboards and removes non-Default workspaces", async () => {
    const defaultWorkspace = (await listWorkspaces())[0]
    const workspace = await createWorkspace("Research")
    const completedAt = new Date().toISOString()
    const defaultKey = await runInWorkspace(defaultWorkspace, () => createApiKey("Default usage", "default-usage-secret"))
    const researchKey = await runInWorkspace(workspace, () => createApiKey("Research usage", "research-usage-secret"))
    await runInWorkspace(workspace, () => expect(upsertBudget({ apiKeyId: defaultKey.id, weeklyLimitMicros: 1_000_000, enabled: true })).rejects.toThrow("selected workspace"))

    await runInWorkspace(defaultWorkspace, () => recordGatewayUsage({ gatewayKeyId: defaultKey.id, gatewayModelId: "shared/model", protocol: "openai-chat", startedAt: completedAt, status: 200, durationMs: 10, metrics: { input: 10, output: 5 } }))
    await runInWorkspace(workspace, () => recordGatewayUsage({ gatewayKeyId: researchKey.id, gatewayModelId: "shared/model", protocol: "openai-chat", startedAt: completedAt, status: 200, durationMs: 10, metrics: { input: 20, output: 10 } }))

    const defaultDashboard = await runInWorkspace(defaultWorkspace, () => getDashboardPayload({ preset: "all" }))
    const researchDashboard = await runInWorkspace(workspace, () => getDashboardPayload({ preset: "all" }))
    expect(defaultDashboard.summary.tokens).toBe(15)
    expect(researchDashboard.summary.tokens).toBe(30)
    expect(defaultDashboard.keys.map((key) => key.label)).toContain("Default usage")
    expect(defaultDashboard.keys.map((key) => key.label)).not.toContain("Research usage")
    expect(researchDashboard.keys.map((key) => key.label)).toContain("Research usage")
    expect(researchDashboard.keys.map((key) => key.label)).not.toContain("Default usage")

    await renameWorkspace(workspace.id, "Research Lab")
    await deleteWorkspace(workspace.id, "Research Lab")
    expect(await getWorkspace(workspace.id)).toBeUndefined()
  })

  test("routes authentication, pricing, and logs through the key workspace", async () => {
    const defaultWorkspace = (await listWorkspaces())[0]
    const workspace = await createWorkspace("Routing")
    await runInWorkspace(defaultWorkspace, async () => {
      clearLogs()
      await configureWorkspacePricing("shared/model", "default-upstream", 1, 2)
      writeLog("info", "admin", "default-only")
    })
    await runInWorkspace(workspace, async () => {
      await createApiKey("Routing key", "routing-secret")
      await configureWorkspacePricing("shared/model", "routing-upstream", 10, 20)
      writeLog("info", "admin", "routing-only")
    })

    const authenticated = await authenticateProxyKey(new Request("https://gateway.test/v1/models", { headers: { authorization: "Bearer routing-secret" } }))
    expect(authenticated?.workspace.id).toBe(workspace.id)
    await runInWorkspace(authenticated!.workspace, async () => {
      expect((await listModels()).find((model) => model.gatewayModelId === "shared/model")?.upstreamModel).toBe("routing-upstream")
      expect(readLogs().map((entry) => entry.message)).toContain("routing-only")
      expect(readLogs().map((entry) => entry.message)).not.toContain("default-only")
    })

    await deleteWorkspace(workspace.id, workspace.name)
    await runInWorkspace(defaultWorkspace, () => createApiKey("Reused", "routing-secret"))
  })

  test("repairs a missing gateway-key index in every canonical workspace", async () => {
    const defaultWorkspace = (await listWorkspaces())[0]
    const workspace = await createWorkspace("Repair")
    const defaultKey = await runInWorkspace(defaultWorkspace, () => createApiKey("Default repair", "default-repair-secret"))
    const scopedKey = await runInWorkspace(workspace, () => createApiKey("Scoped repair", "scoped-repair-secret"))

    _deleteMemoryApiKeyIndex(defaultKey.key)
    _deleteMemoryApiKeyIndex(scopedKey.key)

    await expect(createApiKey("Duplicate while index is missing", defaultKey.key)).rejects.toThrow("already in use")
    await expect(findIndexedApiKeyByValue(defaultKey.key)).resolves.toMatchObject({
      workspaceId: defaultWorkspace.id,
      workspaceStorageMode: "scoped",
      apiKey: { id: defaultKey.id, name: defaultKey.name, key: defaultKey.key },
    })
    await expect(findIndexedApiKeyByValue(scopedKey.key)).resolves.toMatchObject({
      workspaceId: workspace.id,
      workspaceStorageMode: "scoped",
      apiKey: { id: scopedKey.id, name: scopedKey.name, key: scopedKey.key },
    })

    expect((await authenticateProxyKey(new Request("https://gateway.test/v1/models", { headers: { authorization: `Bearer ${defaultKey.key}` } })))?.workspace.id).toBe(defaultWorkspace.id)
    expect((await authenticateProxyKey(new Request("https://gateway.test/v1/models", { headers: { authorization: `Bearer ${scopedKey.key}` } })))?.workspace.id).toBe(workspace.id)
  })
})
