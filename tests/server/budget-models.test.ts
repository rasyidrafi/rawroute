import { beforeEach, expect, test } from "bun:test"
import { budgetModelOptions } from "@/server/budget-models"
import { _resetMemoryBackend, listAliases, listCombos, listModels, listProviders, upsertCombo, upsertModel, upsertProvider } from "@/server/store"
import { getBudgetBeyondLimitsSettings, getBudgetUnlimitedSettings, resetAnalyticsForTests, setBudgetBeyondLimitsSettings, setBudgetUnlimitedSettings } from "@/lib/analytics"
import { catalogModels } from "@/lib/catalog"
import { PATCH as saveBeyond } from "@/server/routes/api/admin/budgets/beyond-limits"
import { PATCH as saveUnlimited } from "@/server/routes/api/admin/budgets/unlimited"
import { resetModelSharesForTests, setModelShareTargets, listSharedModelsForRecipient } from "@/lib/workspace/model-shares"
import { createWorkspace, listWorkspaces, resetWorkspacesForTests } from "@/server/workspace-repository"
import { runInWorkspace } from "@/lib/workspace/context"

beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
  resetModelSharesForTests()
  await resetWorkspacesForTests()
})

function request(body: unknown) { return new Request("http://localhost/api/admin/budgets", { method: "PATCH", body: JSON.stringify(body) }) }
async function fixture() {
  const provider = await upsertProvider({ name: "Budget test", prefix: "budget", baseUrl: "https://example.test", protocol: "openai-chat", authType: "none", enabled: true })
  const model = await upsertModel(provider.id, { name: "Test model", gatewayModelId: "budget/model", upstreamModel: "model", enabled: true })
  await upsertCombo({ combo: "budget-combo", name: "Budget combo", members: [{ modelId: model.gatewayModelId }] })
  return { provider, model }
}

test("both budget APIs accept the same available combo advertised by the gateway", async () => {
  await fixture()
  const options = await budgetModelOptions()
  const catalog = catalogModels(await listProviders(), await listModels(), await listAliases(), await listCombos())
  expect(options.filter((entry) => entry.available).map((entry) => entry.id).sort()).toEqual(catalog.map((entry) => entry.id).sort())
  expect((await saveBeyond(request({ enabled: true, modelIds: ["budget-combo"] }))).status).toBe(200)
  expect((await saveUnlimited(request({ excludedModelIds: ["budget-combo"] }))).status).toBe(200)
  expect(await getBudgetBeyondLimitsSettings()).toMatchObject({ modelIds: ["budget-combo"] })
})

test("disabled selections stay visible and can be retained or removed without blocking settings", async () => {
  const { provider, model } = await fixture()
  await setBudgetBeyondLimitsSettings({ enabled: true, modelIds: [model.gatewayModelId] })
  await setBudgetUnlimitedSettings({ excludedModelIds: [model.gatewayModelId, "removed-model"] })
  await upsertModel(provider.id, { ...model, originalId: model.id, enabled: false })
  expect((await budgetModelOptions()).find((entry) => entry.id === model.gatewayModelId)).toMatchObject({ available: false, unavailableReason: "Model disabled" })
  expect((await budgetModelOptions()).find((entry) => entry.id === "budget-combo")).toMatchObject({ available: false, unavailableReason: "No available members" })
  expect((await saveBeyond(request({ enabled: false, modelIds: [model.gatewayModelId] }))).status).toBe(200)
  expect((await saveUnlimited(request({ excludedModelIds: [model.gatewayModelId] }))).status).toBe(200)
  expect((await saveUnlimited(request({ excludedModelIds: [] }))).status).toBe(200)
  expect(await getBudgetUnlimitedSettings()).toMatchObject({ excludedModelIds: [] })
  // Once removed, an unavailable model cannot be newly selected.
  expect((await saveUnlimited(request({ excludedModelIds: [model.gatewayModelId] }))).status).toBe(400)
  expect((await saveBeyond(request({ enabled: true, modelIds: ["budget-combo"] }))).status).toBe(400)
})

test("shared-only combo availability follows its grant and identifies the budget owner", async () => {
  const owner = (await listWorkspaces())[0]
  const recipient = await createWorkspace("Recipient")
  const { model } = await runInWorkspace(owner, fixture)
  await runInWorkspace(owner, () => setModelShareTargets(model.id, [recipient.id]))
  await runInWorkspace(recipient, async () => {
    const [share] = await listSharedModelsForRecipient()
    await upsertCombo({ combo: "shared-budget-combo", name: "Shared", members: [{ modelId: share.qualifiedModelId, sharedModelId: share.id }] })
    const option = (await budgetModelOptions()).find((entry) => entry.id === "shared-budget-combo")
    expect(option).toMatchObject({ available: true, kind: "combo" })
    expect(option?.members[0]).toContain(`budget: ${owner.name}`)
    expect((await saveBeyond(request({ enabled: true, modelIds: ["shared-budget-combo"] }))).status).toBe(200)
  })
  await runInWorkspace(owner, () => setModelShareTargets(model.id, []))
  await runInWorkspace(recipient, async () => {
    expect((await budgetModelOptions()).find((entry) => entry.id === "shared-budget-combo")).toMatchObject({ available: false })
    expect(catalogModels([], [], [], await listCombos(), await listSharedModelsForRecipient())).toEqual([])
  })
})
