import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { _resetMemoryBackend, createApiKey, upsertCombo, upsertModel, upsertProvider } from "@/server/store"
import { getBudgetRequestState, getBudgetRows, recordGatewayUsage, resetAnalyticsForTests, setBudgetBeyondLimitsSettings, setBudgetBypassEnabled, setBudgetUnlimitedSettings, upsertBudget } from "@/lib/analytics"
import { proxyGatewayRequest } from "@/lib/cliproxy/gateway"
import { listPricingVersions, savePricingVersion, syncModelPricingGroups } from "@/lib/model-pricing"
import { createWorkspace, listWorkspaces, resetWorkspacesForTests } from "@/server/workspace-repository"
import { listSharedModelsForRecipient, resetModelSharesForTests, setModelShareTargets } from "@/lib/workspace/model-shares"
import { runInWorkspace } from "@/lib/workspace/context"

const fetchTarget: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis
let upstream = spyOn(fetchTarget, "fetch")
beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  resetAnalyticsForTests()
  resetModelSharesForTests()
  await resetWorkspacesForTests()
  upstream = spyOn(fetchTarget, "fetch")
  upstream.mockClear()
  upstream.mockImplementation(async () => Response.json({ id: "response", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }))
})
afterEach(() => upstream.mockRestore())

async function pricedModel(id: string) {
  const provider = await upsertProvider({ name: id, prefix: id, baseUrl: "https://example.test/v1", protocol: "openai-responses", authType: "none", enabled: true })
  const model = await upsertModel(provider.id, { name: id, gatewayModelId: `${id}/model`, upstreamModel: id, enabled: true })
  const group = (await syncModelPricingGroups()).find((entry) => entry.memberModelIds.includes(model.id))!
  await savePricingVersion({ groupId: group.id, mode: (await listPricingVersions(group.id)).length ? "replace" : "new", rates: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 }, contextTiers: [] })
  return model
}
async function exhaust(keyId: string, model: Awaited<ReturnType<typeof pricedModel>>) {
  await upsertBudget({ apiKeyId: keyId, weeklyLimitMicros: 1, enabled: true })
  await recordGatewayUsage({ gatewayKeyId: keyId, providerModelId: model.id, gatewayModelId: model.gatewayModelId, protocol: "openai-responses", startedAt: new Date().toISOString(), status: 200, durationMs: 1, metrics: { input: 2 } })
}
function request(key: string, model: string) {
  return new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, input: "Hello" }) })
}

test("real admission skips a denied member, allows the selected fallback, and counts its usage", async () => {
  const first = await pricedModel("expensive")
  const second = await pricedModel("cheap")
  const key = await createApiKey("Combo key")
  await upsertCombo({ combo: "coding", name: "Coding", members: [{ modelId: first.gatewayModelId }, { modelId: second.gatewayModelId }] })
  await exhaust(key.id, first)
  await setBudgetBeyondLimitsSettings({ enabled: true, modelIds: [second.gatewayModelId] })
  expect((await proxyGatewayRequest(request(key.key, "coding"))).status).toBe(200)
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body)).model).toBe("cheap")
  expect((await getBudgetRows()).find((row) => row.apiKeyId === key.id)?.spentMicros).toBe(5)
  await setBudgetBeyondLimitsSettings({ enabled: false, modelIds: [] })
  await expect(getBudgetRequestState(key.id, second.gatewayModelId, second.id)).rejects.toThrow("budget")
})

test("allowing a combo does not allow direct member requests, and Unlimited exclusions still block it", async () => {
  const model = await pricedModel("local")
  const key = await createApiKey("Combo key")
  await upsertCombo({ combo: "coding", name: "Coding", members: [{ modelId: model.gatewayModelId }] })
  await exhaust(key.id, model)
  await setBudgetBeyondLimitsSettings({ enabled: true, modelIds: ["coding"] })
  expect((await proxyGatewayRequest(request(key.key, "coding"))).status).toBe(200)
  expect((await proxyGatewayRequest(request(key.key, model.gatewayModelId))).status).toBe(429)
  await setBudgetUnlimitedSettings({ excludedModelIds: [model.gatewayModelId] })
  await setBudgetBypassEnabled(true)
  expect((await proxyGatewayRequest(request(key.key, "coding"))).status).toBe(403)
  expect(upstream).toHaveBeenCalledTimes(1)
})

test("a recipient combo exception cannot bypass the shared owner's budget or Unlimited exclusions", async () => {
  const owner = (await listWorkspaces())[0]
  const recipient = await createWorkspace("Recipient")
  const model = await runInWorkspace(owner, () => pricedModel("shared"))
  await runInWorkspace(owner, async () => {
    await setModelShareTargets(model.id, [recipient.id])
    await exhaust(`shared-workspace:${recipient.id}`, model)
  })
  const key = await runInWorkspace(recipient, async () => {
    const [share] = await listSharedModelsForRecipient()
    await upsertCombo({ combo: "coding", name: "Coding", members: [{ modelId: share.qualifiedModelId, sharedModelId: share.id }] })
    await setBudgetBeyondLimitsSettings({ enabled: true, modelIds: ["coding"] })
    return createApiKey("Recipient key")
  })
  expect((await proxyGatewayRequest(request(key.key, "coding"))).status).toBe(429)
  expect(upstream).not.toHaveBeenCalled()
  await runInWorkspace(owner, () => setBudgetBeyondLimitsSettings({ enabled: true, modelIds: [model.gatewayModelId] }))
  expect((await proxyGatewayRequest(request(key.key, "coding"))).status).toBe(200)
  await runInWorkspace(owner, async () => {
    await setBudgetUnlimitedSettings({ excludedModelIds: [model.gatewayModelId] })
    await setBudgetBypassEnabled(true)
  })
  expect((await proxyGatewayRequest(request(key.key, "coding"))).status).toBe(403)
  expect(upstream).toHaveBeenCalledTimes(1)
})
