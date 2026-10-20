import "../../apps/console/src/server/composition"
import { beforeEach, expect, test } from "bun:test"
import { testsInWorkspace } from "../helpers/workspace-test"
const workspaceTest = testsInWorkspace("routing-tests")
import { POST } from "../../packages/gateway-ai/src/server/routes/api/admin/combos/index"
import { _resetMemoryBackend, listCombos, upsertModel, upsertProvider } from "../../packages/gateway-ai/src/server/store"
import { createWorkspace, listWorkspaces, resetWorkspacesForTests } from "../../packages/platform/src/server/runtime"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"
import { listSharedModelsForRecipient, resetModelSharesForTests, setModelShareTargets } from "../../packages/gateway-ai/src/server/model-shares"
import { resolveGatewayModel } from "../../packages/gateway-ai/src/server/cliproxy/model-resolution"
import { catalogModels } from "../../packages/gateway-ai/src/contracts/catalog"
import type { ComboMember, ModelCombo } from "../../packages/gateway-ai/src/contracts/domain"

beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetModelSharesForTests()
  await resetWorkspacesForTests()
})

function save(members: ComboMember[], originalId?: string) {
  return POST(new Request("http://localhost/api/admin/combos", { method: "POST", body: JSON.stringify({ combo: { combo: "my-model", name: "My model", members, originalId } }) }))
}

workspaceTest("one-model aliases can grow into fallback combos and reject empty membership", async () => {
  const provider = await upsertProvider({ name: "Test", prefix: "test", baseUrl: "https://example.test", protocol: "openai-chat", authType: "none", enabled: true })
  const first = await upsertModel(provider.id, { name: "First", gatewayModelId: "test/first", upstreamModel: "first", enabled: true })
  const second = await upsertModel(provider.id, { name: "Second", gatewayModelId: "test/second", upstreamModel: "second", enabled: true })
  const response = await save([{ modelId: first.gatewayModelId }])
  expect(response.status).toBe(200)
  const { combo } = await response.json() as { combo: ModelCombo }
  expect(combo.members).toHaveLength(1)
  expect((await save([{ modelId: first.gatewayModelId }, { modelId: second.gatewayModelId }], combo.id)).status).toBe(200)
  expect((await listCombos())[0].members).toHaveLength(2)
  expect((await save([], combo.id)).status).toBe(400)
  expect((await listCombos())[0].members).toHaveLength(2)
})

test("shared-only combos resolve and appear in the catalog only with an active recipient grant", async () => {
  const owner = (await listWorkspaces())[0]
  const recipient = await createWorkspace("Recipient")
  const stranger = await createWorkspace("Stranger")
  const model = await runInWorkspace(owner, async () => {
    const provider = await upsertProvider({ name: "Codex", prefix: "codex", baseUrl: "https://example.test", protocol: "openai-responses", authType: "none", enabled: true })
    return upsertModel(provider.id, { name: "Shared", gatewayModelId: "codex/shared", upstreamModel: "shared", enabled: true })
  })
  await runInWorkspace(owner, () => setModelShareTargets(model.id, [recipient.id]))
  const [shared] = await runInWorkspace(recipient, listSharedModelsForRecipient)
  const member = { modelId: shared.qualifiedModelId, sharedModelId: shared.id }
  await runInWorkspace(recipient, async () => {
    expect((await save([member])).status).toBe(200)
    expect(await resolveGatewayModel(member.modelId, member.sharedModelId)).toMatchObject({ shared: { consumerWorkspaceId: recipient.id, ownerWorkspaceId: owner.id } })
    expect(catalogModels([], [], [], await listCombos(), [shared]).map((entry) => entry.id)).toEqual(["my-model"])
  })
  await runInWorkspace(stranger, async () => {
    expect((await save([member])).status).toBe(400)
    await expect(resolveGatewayModel(member.modelId, member.sharedModelId)).rejects.toThrow("Shared model is no longer available")
  })
  await runInWorkspace(owner, () => setModelShareTargets(model.id, []))
  await runInWorkspace(recipient, async () => {
    expect((await save([member])).status).toBe(400)
    await expect(resolveGatewayModel(member.modelId, member.sharedModelId)).rejects.toThrow("Shared model is no longer available")
    expect(catalogModels([], [], [], await listCombos(), await listSharedModelsForRecipient())).toEqual([])
  })
})
