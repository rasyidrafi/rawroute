import "../../apps/console/src/server/composition"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { testsInWorkspace } from "../helpers/workspace-test"
const workspaceTest = testsInWorkspace("default")
import { _resetMemoryBackend, createApiKey, upsertAlias, upsertCombo, upsertModel, upsertProvider } from "../../packages/gateway-ai/src/server/store"
import { getBudgetRequestState, getBudgetRows, listRequestLogs, recordGatewayUsage, resetAnalyticsForTests, setBudgetBeyondLimitsSettings, setBudgetBypassEnabled, setBudgetUnlimitedSettings, upsertBudget } from "../../packages/gateway-ai/src/server/analytics"
import { proxyGatewayRequest } from "../../packages/gateway-ai/src/server/cliproxy/gateway"
import { listPricingVersions, savePricingVersion, syncModelPricingGroups } from "../../packages/gateway-ai/src/server/model-pricing"
import { createWorkspace, listWorkspaces, resetWorkspacesForTests } from "../../packages/platform/src/server/runtime"
import { listSharedModelsForRecipient, resetModelSharesForTests, setModelShareTargets } from "../../packages/gateway-ai/src/server/model-shares"
import { groupRequestLogEvents } from "../../packages/gateway-ai/src/contracts/request-logs"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"

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

workspaceTest("real admission skips a denied member, allows the selected fallback, and counts its usage", async () => {
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

workspaceTest("allowing a combo does not allow direct member requests, and Unlimited exclusions still block it", async () => {
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

test("conditional sharing gates real requests and lets paused combo members fall through", async () => {
  const owner = (await listWorkspaces())[0]
  const recipient = await createWorkspace("Recipient")
  const source = await runInWorkspace(owner, () => pricedModel("conditional"))
  await runInWorkspace(owner, () => setModelShareTargets(source.id, [recipient.id], [recipient.id]))
  const key = await runInWorkspace(recipient, async () => {
    const [share] = await listSharedModelsForRecipient()
    const local = await pricedModel("fallback")
    await upsertAlias({ alias: "shared-direct", name: "Shared", targetModelId: share.qualifiedModelId, sharedModelId: share.id })
    await upsertCombo({ combo: "coding", name: "Coding", members: [{ modelId: share.qualifiedModelId, sharedModelId: share.id }, { modelId: local.gatewayModelId }] })
    await setBudgetBypassEnabled(true)
    return createApiKey("Recipient key")
  })
  expect((await proxyGatewayRequest(request(key.key, "shared-direct"))).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
  expect((await proxyGatewayRequest(request(key.key, "coding"))).status).toBe(200)
  expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body)).model).toBe("fallback")
  await runInWorkspace(owner, () => setBudgetBypassEnabled(true))
  expect((await proxyGatewayRequest(request(key.key, "coding"))).status).toBe(200)
  expect(JSON.parse(String(upstream.mock.calls[1]?.[1]?.body)).model).toBe("conditional")
  await runInWorkspace(owner, () => setBudgetUnlimitedSettings({ excludedModelIds: [source.gatewayModelId] }))
  expect((await proxyGatewayRequest(request(key.key, "shared-direct"))).status).toBe(403)
  expect(upstream).toHaveBeenCalledTimes(2)
  await runInWorkspace(owner, () => setBudgetBypassEnabled(false))
  expect((await proxyGatewayRequest(request(key.key, "shared-direct"))).status).toBe(400)
  expect(upstream).toHaveBeenCalledTimes(2)
})

test("turning owner Unlimited Mode off does not interrupt an admitted shared stream", async () => {
  const owner = (await listWorkspaces())[0]
  const recipient = await createWorkspace("Recipient")
  const source = await runInWorkspace(owner, () => pricedModel("stream-shared"))
  await runInWorkspace(owner, async () => {
    await setModelShareTargets(source.id, [recipient.id], [recipient.id])
    await setBudgetBypassEnabled(true)
  })
  const key = await runInWorkspace(recipient, async () => {
    const [share] = await listSharedModelsForRecipient()
    await upsertAlias({ alias: "shared-stream", name: "Shared", targetModelId: share.qualifiedModelId, sharedModelId: share.id })
    return createApiKey("Recipient key")
  })
  let controller!: ReadableStreamDefaultController<Uint8Array>
  upstream.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), { headers: { "content-type": "text/event-stream" } }))
  const response = await proxyGatewayRequest(new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "shared-stream", input: "Hello", stream: true }) }))
  expect(response.status).toBe(200)
  await runInWorkspace(owner, () => setBudgetBypassEnabled(false))
  controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":1}}}\n\n'))
  controller.close()
  expect(await response.text()).toContain("response.completed")
  expect((await proxyGatewayRequest(request(key.key, "shared-stream"))).status).toBe(400)
  expect(upstream).toHaveBeenCalledTimes(1)
})

const logQuery = () => ({ from: "2020-01-01T00:00:00.000Z", to: new Date(Date.now() + 60_000).toISOString(), status: "all" as const, model: "", key: "" })

workspaceTest("alias routing records the actual model and names before later configuration changes", async () => {
  const target = await pricedModel("astra")
  const alias = await upsertAlias({ alias: "A", name: "Clever", targetModelId: target.gatewayModelId })
  const key = await createApiKey("Alias key")
  expect((await proxyGatewayRequest(request(key.key, alias.alias))).status).toBe(200)
  await upsertAlias({ ...alias, originalId: alias.id, name: "Renamed alias" })
  await upsertModel(target.providerId, { ...target, originalId: target.id, name: "Renamed model" })
  const page = await listRequestLogs(logQuery())
  expect(page.events).toHaveLength(1)
  expect(page.events[0]).toMatchObject({ requestedModel: alias.alias, routing: { modelId: "astra/model", modelName: "astra", routeName: "Clever" } })
})

test("consumer fallback remains grouped while shared owner sees only its execution and unchanged cost", async () => {
  const owner = (await listWorkspaces())[0]!
  const consumer = await createWorkspace("HT Non SHI")
  const sharedTarget = await runInWorkspace(owner, () => pricedModel("owner-luna"))
  await runInWorkspace(owner, () => setModelShareTargets(sharedTarget.id, [consumer.id]))
  const key = await runInWorkspace(consumer, async () => {
    const local = await pricedModel("local-luna")
    const [share] = await listSharedModelsForRecipient()
    await upsertCombo({ combo: "gpt-6-luna", name: "Clever", members: [{ modelId: local.gatewayModelId }, { modelId: share!.qualifiedModelId, sharedModelId: share!.id }] })
    return createApiKey("Consumer key")
  })
  upstream.mockImplementationOnce(async () => Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 }))
  expect((await proxyGatewayRequest(request(key.key, "gpt-6-luna"))).status).toBe(200)
  expect(upstream).toHaveBeenCalledTimes(2)
  const consumerLogs = await runInWorkspace(consumer, () => listRequestLogs(logQuery()))
  expect(consumerLogs.events).toHaveLength(2)
  expect(groupRequestLogEvents(consumerLogs.events)).toHaveLength(1)
  expect(consumerLogs.events[1]).toMatchObject({ attemptIndex: 1, requestedModel: "gpt-6-luna", costMicros: 0, routing: { modelId: sharedTarget.gatewayModelId, modelName: "owner-luna", routeName: "Clever" }, sharedUsage: { role: "consumer" } })
  const ownerLogs = await runInWorkspace(owner, () => listRequestLogs(logQuery()))
  expect(ownerLogs.events).toHaveLength(1)
  expect(ownerLogs.events[0]).toMatchObject({ requestId: consumerLogs.events[1]!.requestId, attemptIndex: 1, status: 200, costMicros: 3, totalTokens: 3, sharedUsage: { role: "owner", peerWorkspaceName: "HT Non SHI" } })
  expect(await runInWorkspace(owner, () => listRequestLogs({ ...logQuery(), status: "recovered" }))).toMatchObject({ events: [] })
  expect((await runInWorkspace(consumer, () => listRequestLogs({ ...logQuery(), status: "recovered" }))).events).toHaveLength(2)
})
