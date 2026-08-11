import { beforeEach, describe, expect, test } from "vitest"

import { getDashboardPayload, recordUsageEvent, resetAnalyticsForTests } from "@/lib/analytics"
import { listShareTargets, listSharedModelsForRecipient, resolveSharedModelForRecipient, resetModelSharesForTests, setModelShareTargets } from "@/lib/model-shares"
import { _resetMemoryBackend, createApiKey, upsertAlias, upsertModel, upsertProvider } from "@/lib/store"
import { runInWorkspace } from "@/lib/workspace-context"
import { createWorkspace, listWorkspaces, resetWorkspacesForTests } from "@/lib/workspaces"

beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
  resetModelSharesForTests()
  await resetWorkspacesForTests()
})

describe("model shares", () => {
  test("shares only enabled source models and resolves them in the recipient workspace", async () => {
    const owner = (await listWorkspaces())[0]
    const recipient = await createWorkspace("Recipient")
    const model = await runInWorkspace(owner, async () => {
      const provider = await upsertProvider({ name: "Codex", prefix: "codex", baseUrl: "https://example.test", protocol: "openai-responses", authType: "none", headers: {}, enabled: true })
      return upsertModel(provider.id, { gatewayModelId: "codex/gpt-5.3-codex-spark", name: "Spark", upstreamModel: "gpt-5.3-codex-spark", enabled: true })
    })
    await runInWorkspace(owner, () => setModelShareTargets(model.id, [recipient.id]))
    await expect(runInWorkspace(owner, () => listShareTargets(model.id))).resolves.toContainEqual({ id: recipient.id, name: recipient.name, shared: true })
    const shared = await runInWorkspace(recipient, () => listSharedModelsForRecipient())
    expect(shared).toMatchObject([{ ownerWorkspaceId: owner.id, sourceModelId: model.id, status: "active", qualifiedModelId: `${owner.id}/codex/gpt-5.3-codex-spark` }])
    await expect(runInWorkspace(recipient, () => resolveSharedModelForRecipient(shared[0].id))).resolves.toMatchObject({ owner: { id: owner.id }, model: { id: model.id } })
  })

  test("revocation makes an existing recipient reference unavailable", async () => {
    const owner = (await listWorkspaces())[0]
    const recipient = await createWorkspace("Recipient")
    const model = await runInWorkspace(owner, async () => {
      const provider = await upsertProvider({ name: "Provider", prefix: "provider", baseUrl: "https://example.test", protocol: "openai-chat", authType: "none", headers: {}, enabled: true })
      return upsertModel(provider.id, { gatewayModelId: "provider/model", name: "Model", upstreamModel: "model", enabled: true })
    })
    await runInWorkspace(owner, () => setModelShareTargets(model.id, [recipient.id]))
    const id = (await runInWorkspace(recipient, () => listSharedModelsForRecipient()))[0].id
    await runInWorkspace(owner, () => setModelShareTargets(model.id, []))
    expect((await runInWorkspace(recipient, () => listSharedModelsForRecipient()))[0].status).toBe("revoked")
    await expect(runInWorkspace(recipient, () => resolveSharedModelForRecipient(id))).resolves.toBeUndefined()
  })

  test("labels owner usage from a recipient workspace without a synthetic API key", async () => {
    const owner = (await listWorkspaces())[0]
    const recipient = await createWorkspace("Recipient")
    await runInWorkspace(owner, async () => {
      await recordUsageEvent({ id: "owner-shared-usage", gatewayKeyId: `shared-workspace:${recipient.id}`, gatewayModelId: "long/longcat-2.0", protocol: "openai-chat", startedAt: "2026-08-11T00:00:00.000Z", completedAt: "2026-08-11T00:00:01.000Z", status: 200, durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2, costMicros: 10, pricingConfidence: "exact", usageAvailable: true })
      const usage = await getDashboardPayload({ preset: "all" })
      expect(usage.keys).toEqual(expect.arrayContaining([expect.objectContaining({ id: `shared-workspace:${recipient.id}`, label: "Shared Workspace: Recipient" })]))
    })
  })

  test("labels aliases with their resolved source model names so usage stays grouped", async () => {
    const owner = (await listWorkspaces())[0]
    const recipient = await createWorkspace("Recipient")
    const model = await runInWorkspace(owner, async () => {
      const provider = await upsertProvider({ name: "Long", prefix: "long", baseUrl: "https://example.test", protocol: "openai-chat", authType: "none", headers: {}, enabled: true })
      return upsertModel(provider.id, { gatewayModelId: "long/longcat-2.0", name: "LongCat 2.0", upstreamModel: "longcat-2.0", enabled: true })
    })
    await runInWorkspace(owner, () => setModelShareTargets(model.id, [recipient.id]))
    await runInWorkspace(recipient, async () => {
      const shared = (await listSharedModelsForRecipient())[0]
      const key = await createApiKey("Recipient key")
      await upsertAlias({ alias: "my-longcat", name: "My LongCat", targetModelId: shared.qualifiedModelId, sharedModelId: shared.id })
      const localProvider = await upsertProvider({ name: "Codex", prefix: "cx", baseUrl: "https://example.test", protocol: "openai-responses", authType: "none", headers: {}, enabled: true })
      const localModel = await upsertModel(localProvider.id, { gatewayModelId: "cx/gpt-5.6-sol", name: "GPT 5.6 Sol", upstreamModel: "gpt-5.6-sol", enabled: true })
      await upsertAlias({ alias: "my-sol", name: "Anything custom", targetModelId: localModel.gatewayModelId })
      const event = (id: string, gatewayModelId: string) => recordUsageEvent({ id, gatewayKeyId: key.id, gatewayModelId, protocol: "openai-chat", startedAt: "2026-08-11T00:00:00.000Z", completedAt: "2026-08-11T00:00:01.000Z", status: 200, durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2, costMicros: 0, pricingConfidence: "exact", usageAvailable: true })
      await event("shared-alias", "my-longcat")
      await event("shared-qualified", shared.qualifiedModelId)
      await event("local-alias", "my-sol")
      await event("unknown", "unknown-model")
      const usage = await getDashboardPayload({ preset: "all" })
      expect(usage.models.map((entry) => entry.model)).toEqual(expect.arrayContaining(["LongCat 2.0", "GPT 5.6 Sol", "unknown-model"]))
      expect(usage.models.map((entry) => entry.model)).not.toContain("My LongCat")
      expect(usage.models.map((entry) => entry.model)).not.toContain("Anything custom")
    })
  })
})
