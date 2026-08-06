import { beforeEach, describe, expect, test } from "vitest"

import { getDashboardPayload, listModelPricing, recordGatewayUsage, resetAnalyticsForTests, upsertBudget, upsertModelPricing } from "@/lib/analytics"
import { authenticateProxyKey } from "@/lib/auth"
import { clearLogs, readLogs, writeLog } from "@/lib/logger"
import { _resetMemoryBackend, createApiKey, findIndexedApiKeyByValue, listApiKeys, listProviders, upsertProvider } from "@/lib/store"
import { runInWorkspace } from "@/lib/workspace-context"
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, renameWorkspace, resetWorkspacesForTests } from "@/lib/workspaces"

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
      await upsertModelPricing({ modelId: "same-model", provider: "default", gatewayModelId: "shared/model", upstreamModel: "default-upstream", inputMicrosPerMillion: 1, outputMicrosPerMillion: 2, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
      writeLog("info", "admin", "default-only")
    })
    await runInWorkspace(workspace, async () => {
      await createApiKey("Routing key", "routing-secret")
      await upsertModelPricing({ modelId: "same-model", provider: "routing", gatewayModelId: "shared/model", upstreamModel: "routing-upstream", inputMicrosPerMillion: 10, outputMicrosPerMillion: 20, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0, enabled: true })
      writeLog("info", "admin", "routing-only")
    })

    const authenticated = await authenticateProxyKey(new Request("https://gateway.test/v1/models", { headers: { authorization: "Bearer routing-secret" } }))
    expect(authenticated?.workspace.id).toBe(workspace.id)
    await runInWorkspace(authenticated!.workspace, async () => {
      expect((await listModelPricing())[0]?.upstreamModel).toBe("routing-upstream")
      expect(readLogs().map((entry) => entry.message)).toContain("routing-only")
      expect(readLogs().map((entry) => entry.message)).not.toContain("default-only")
    })

    await deleteWorkspace(workspace.id, workspace.name)
    await runInWorkspace(defaultWorkspace, () => createApiKey("Reused", "routing-secret"))
  })
})
