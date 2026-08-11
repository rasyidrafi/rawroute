import { beforeEach, describe, expect, test } from "vitest"

import { listShareTargets, listSharedModelsForRecipient, resolveSharedModelForRecipient, resetModelSharesForTests, setModelShareTargets } from "@/lib/model-shares"
import { _resetMemoryBackend, upsertModel, upsertProvider } from "@/lib/store"
import { runInWorkspace } from "@/lib/workspace-context"
import { createWorkspace, listWorkspaces, resetWorkspacesForTests } from "@/lib/workspaces"

beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
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
})
