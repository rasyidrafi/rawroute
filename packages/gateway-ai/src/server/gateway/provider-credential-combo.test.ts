import { afterEach, beforeEach, expect, test } from "bun:test"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { closeLocalDatabase } from "@rawroute/platform/server/database"
import { configurePlatformServer, createWorkspace, resetWorkspacesForTests } from "@rawroute/platform/server/runtime"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { _resetMemoryBackend, listProviderApiKeys, upsertCombo, upsertModel, upsertProvider, upsertProviderApiKey } from "../store"
import { resetModelSharesForTests, setModelShareTargets } from "../model-shares"
import { proxyGatewayRequestInWorkspace, testComboMemberPolicy } from "./gateway"
import { resumeGatewayExecutions } from "./admission"
import { providerCredentialScheduler } from "./provider-credential-scheduler"

const workspace = { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" as const }
const originalFetch = globalThis.fetch
let providerSequence = 0

async function providerModel(name: string, limits: { rpmLimit?: number; maxConcurrency?: number } = {}) {
  const provider = await upsertProvider({
    name,
    prefix: `combo${++providerSequence}`,
    baseUrl: `https://${name.toLowerCase().replaceAll(" ", "-")}.synthetic.invalid/v1`,
    protocol: "openai-chat",
    authType: "bearer",
    headers: {},
    enabled: true,
  })
  const credential = await upsertProviderApiKey(provider.id, { name: `${name} key`, key: `${name}-synthetic-key`, enabled: true, ...limits })
  const modelId = `${name.toLowerCase().replaceAll(" ", "-")}/model`
  const model = await upsertModel(provider.id, { gatewayModelId: modelId, name, upstreamModel: modelId, enabled: true })
  return { provider, modelId, model, credential }
}

async function comboRequest(model: string) {
  return runInWorkspace(workspace, () => proxyGatewayRequestInWorkspace(new Request("http://rawroute.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  }), "/v1/chat/completions", { id: "synthetic-gateway-key" }))
}

function chatResponse() {
  return Response.json({
    id: "chatcmpl-synthetic",
    object: "chat.completion",
    model: "synthetic/model",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

beforeEach(async () => {
  await closeLocalDatabase()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  _resetMemoryBackend()
  configurePlatformServer({ identity: { initialize: () => {}, changed: () => {} }, participants: [] })
  await resetWorkspacesForTests()
  resetModelSharesForTests()
  resumeGatewayExecutions()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  resumeGatewayExecutions()
  await closeLocalDatabase()
  resetModelSharesForTests()
  await resetWorkspacesForTests()
  _resetMemoryBackend()
})

test("combo routing retries local RPM capacity but stops on ambiguous provider outcomes", async () => {
  let concurrencyLease: ReturnType<typeof providerCredentialScheduler.acquire> | undefined
  await runInWorkspace(workspace, async () => {
    const first = await providerModel("Capacity primary", { rpmLimit: 1 })
    const second = await providerModel("Capacity fallback")
    await upsertCombo({ combo: "capacity-combo", name: "Capacity combo", members: [{ modelId: first.modelId }, { modelId: second.modelId }] })

    const busyPrimary = await providerModel("Concurrency primary", { maxConcurrency: 1 })
    const busyFallback = await providerModel("Concurrency fallback")
    await upsertCombo({ combo: "concurrency-combo", name: "Concurrency combo", members: [{ modelId: busyPrimary.modelId }, { modelId: busyFallback.modelId }] })
    concurrencyLease = providerCredentialScheduler.acquire({ ownerWorkspaceId: workspace.id, providerId: busyPrimary.provider.id, credentials: [busyPrimary.credential] })
    expect(concurrencyLease.ok).toBe(true)
    if (concurrencyLease.ok) concurrencyLease.markDispatched()

    const credential = (await listProviderApiKeys(first.provider.id))[0]!
    const used = providerCredentialScheduler.acquire({ ownerWorkspaceId: workspace.id, providerId: first.provider.id, credentials: [credential] })
    expect(used.ok).toBe(true)
    if (used.ok) { used.markDispatched(); used.release() }

    const outcomeOne = await providerModel("Ambiguous primary")
    const outcomeTwo = await providerModel("Ambiguous fallback")
    await upsertCombo({ combo: "ambiguous-combo", name: "Ambiguous combo", members: [{ modelId: outcomeOne.modelId }, { modelId: outcomeTwo.modelId }] })
  })

  const capacityCalls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capacityCalls.push(String(input))
    return chatResponse()
  }) as unknown as typeof fetch
  const capacityResponse = await comboRequest("capacity-combo")
  expect(capacityResponse.status).toBe(200)
  expect(capacityCalls).toHaveLength(1)
  expect(capacityCalls[0]).toContain("capacity-fallback.synthetic.invalid")

  const concurrencyCalls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    concurrencyCalls.push(String(input))
    return chatResponse()
  }) as unknown as typeof fetch
  try {
    const concurrencyResponse = await comboRequest("concurrency-combo")
    expect(concurrencyResponse.status).toBe(200)
    expect(concurrencyCalls).toHaveLength(1)
    expect(concurrencyCalls[0]).toContain("concurrency-fallback.synthetic.invalid")
  } finally {
    if (concurrencyLease?.ok) concurrencyLease.release()
  }

  let ambiguousCalls = 0
  globalThis.fetch = (async () => {
    ambiguousCalls++
    throw new Error("synthetic network outcome is unknown")
  }) as unknown as typeof fetch
  const ambiguousResponse = await comboRequest("ambiguous-combo")
  expect(ambiguousResponse.status).toBe(502)
  expect((await ambiguousResponse.json()).error.code).toBe("provider_request_outcome_unknown")
  expect(ambiguousCalls).toBe(1)
})

test("combo-member policy probes use provider admission without a caller identity", async () => {
  const target = await runInWorkspace(workspace, () => providerModel("Policy admission", { maxConcurrency: 1 }))
  const credential = (await runInWorkspace(workspace, () => listProviderApiKeys(target.provider.id)))[0]!
  const held = await runInWorkspace(workspace, () => providerCredentialScheduler.acquire({
    ownerWorkspaceId: workspace.id,
    providerId: target.provider.id,
    credentials: [credential],
  }))
  expect(held.ok).toBe(true)
  if (!held.ok) throw new Error("Expected to hold the synthetic provider credential.")
  held.markDispatched()

  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    return chatResponse()
  }) as unknown as typeof fetch
  try {
    const result = await runInWorkspace(workspace, () => testComboMemberPolicy({
      modelId: target.modelId,
      customPayload: { temperature: 0.25 },
    }))
    expect(result.status).toBe("unverified")
    expect(result.httpStatus).toBe(503)
    expect(fetchCalls).toBe(0)
  } finally {
    held.release()
  }
})

test("shared-model combo contention uses the resolved owner's credential pool", async () => {
  const [owner, recipient] = await runInWorkspace(workspace, async () => Promise.all([
    createWorkspace("Scheduler share owner"),
    createWorkspace("Scheduler share recipient"),
  ]))
  const target = await runInWorkspace(owner, () => providerModel("Shared owner provider", { maxConcurrency: 1 }))
  const [share] = await runInWorkspace(owner, () => setModelShareTargets(target.model.id, [recipient.id]))
  const credential = (await runInWorkspace(owner, () => listProviderApiKeys(target.provider.id)))[0]!
  const held = await runInWorkspace(owner, () => providerCredentialScheduler.acquire({
    ownerWorkspaceId: owner.id,
    providerId: target.provider.id,
    credentials: [credential],
  }))
  expect(held.ok).toBe(true)
  if (!held.ok) throw new Error("Expected to hold the owner's synthetic credential.")
  held.markDispatched()

  await runInWorkspace(recipient, () => upsertCombo({
    combo: "shared-capacity-combo",
    name: "Shared capacity combo",
    members: [{ modelId: target.modelId, sharedModelId: share!.id }],
  }))
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    return chatResponse()
  }) as unknown as typeof fetch
  try {
    const response = await runInWorkspace(recipient, () => proxyGatewayRequestInWorkspace(new Request("http://rawroute.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "shared-capacity-combo", messages: [{ role: "user", content: "hello" }] }),
    }), "/v1/chat/completions", { id: "synthetic-consumer-key" }))
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe("provider_credential_concurrency_limit")
    expect(fetchCalls).toBe(0)
  } finally {
    held.release()
  }
})
