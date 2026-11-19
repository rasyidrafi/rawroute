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
import { listUsageEvents } from "../analytics"

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

test("tries alternate credentials and combo members before repeating a failed target", async () => {
  await runInWorkspace(workspace, async () => {
    const first = await providerModel("Retry first")
    await upsertProviderApiKey(first.provider.id, { name: "Second key", key: "second-synthetic-key", enabled: true })
    const second = await providerModel("Retry second")
    await upsertCombo({ combo: "retry-combo", name: "Retry", members: [{ modelId: first.modelId }, { modelId: second.modelId }] })
  })
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`)
    return calls.length < 3
      ? Response.json({ error: { message: "unavailable" } }, { status: 503, headers: { "retry-after": "3600", "x-rawroute-combo-terminal": "1" } })
      : chatResponse()
  }) as unknown as typeof fetch
  const response = await comboRequest("retry-combo")
  expect(response.status).toBe(200)
  expect(calls).toHaveLength(3)
  expect(calls[0]).toContain("retry-first.synthetic.invalid")
  expect(calls[1]).toContain("retry-first.synthetic.invalid")
  expect(calls[0]).not.toBe(calls[1])
  expect(calls[2]).toContain("retry-second.synthetic.invalid")
})

test("retries a single target after a transient 403", async () => {
  const target = await runInWorkspace(workspace, () => providerModel("Retry single"))
  let calls = 0
  globalThis.fetch = (async () => ++calls === 1
    ? Response.json({ error: { message: "permission denied" } }, { status: 403 })
    : chatResponse()) as unknown as typeof fetch
  const response = await comboRequest(target.modelId)
  expect(response.status).toBe(200)
  expect(calls).toBe(2)
  const events = await runInWorkspace(workspace, () => listUsageEvents())
  expect(events.filter(event => event.requestedModel === target.modelId).map(event => event.requestFinal)).toEqual([false, true])
})

test("marks an exhausted combo as failed and bounds same-target dispatches", async () => {
  await runInWorkspace(workspace, async () => {
    const target = await providerModel("Retry exhausted")
    await upsertCombo({ combo: "retry-exhausted", name: "Retry", members: [{ modelId: target.modelId }] })
  })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "unavailable" } }, { status: 503 }) }) as unknown as typeof fetch
  const response = await comboRequest("retry-exhausted")
  expect(response.status).toBe(503)
  expect(calls).toBe(3)
  const events = await runInWorkspace(workspace, () => listUsageEvents())
  expect(events.filter(event => event.requestedModel === "retry-exhausted").map(event => event.requestFinal)).toEqual([false, false, true])
})

test("retries a pinned Responses continuation only on its original credential", async () => {
  const target = await runInWorkspace(workspace, async () => {
    const provider = await upsertProvider({ name: "Pinned", prefix: "pinned", baseUrl: "https://pinned.synthetic.invalid", protocol: "openai-responses", authType: "bearer", headers: {}, enabled: true })
    await upsertProviderApiKey(provider.id, { name: "one", key: "pinned-one", enabled: true })
    await upsertProviderApiKey(provider.id, { name: "two", key: "pinned-two", enabled: true })
    await upsertModel(provider.id, { gatewayModelId: "pinned/model", name: "Pinned", upstreamModel: "pinned/model", enabled: true })
    return "pinned/model"
  })
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers).get("authorization") || "")
    if (calls.length === 2) return Response.json({ error: { message: "temporary" } }, { status: 503 })
    return Response.json({ id: calls.length === 1 ? "pinned-response" : "pinned-next", output: [] })
  }) as unknown as typeof fetch
  const send = (payload: Record<string, unknown>) => runInWorkspace(workspace, () => proxyGatewayRequestInWorkspace(new Request("http://rawroute.test/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: target, ...payload }) }), "/v1/responses", { id: "pinned-gateway-key" }))
  expect((await send({ input: "hello" })).status).toBe(200)
  expect((await send({ previous_response_id: "pinned-response", input: "continue" })).status).toBe(200)
  expect(calls).toHaveLength(3)
  expect(new Set(calls).size).toBe(1)
})

test("records a completed upstream failure when the client cancels during backoff", async () => {
  const target = await runInWorkspace(workspace, () => providerModel("Retry cancelled"))
  const controller = new AbortController()
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    setTimeout(() => controller.abort(), 10)
    return Response.json({ error: { message: "unavailable" } }, { status: 503, headers: { "retry-after": "2" } })
  }) as unknown as typeof fetch
  const request = new Request("http://rawroute.test/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: target.modelId, messages: [{ role: "user", content: "hello" }] }), signal: controller.signal })
  await expect(runInWorkspace(workspace, () => proxyGatewayRequestInWorkspace(request, "/v1/chat/completions", { id: "synthetic-gateway-key" }))).rejects.toBeDefined()
  expect(calls).toBe(1)
  const events = await runInWorkspace(workspace, () => listUsageEvents())
  expect(events.filter(event => event.requestedModel === target.modelId).map(event => event.requestFinal)).toEqual([true])
})

test("records the preceding failure when cancellation interrupts the next dispatch", async () => {
  const target = await runInWorkspace(workspace, () => providerModel("Retry interrupted"))
  const controller = new AbortController()
  let calls = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (++calls === 1) return Response.json({ error: { message: "unavailable" } }, { status: 503 })
    controller.abort()
    throw init?.signal?.reason
  }) as unknown as typeof fetch
  const request = new Request("http://rawroute.test/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: target.modelId, messages: [{ role: "user", content: "hello" }] }), signal: controller.signal })
  await expect(runInWorkspace(workspace, () => proxyGatewayRequestInWorkspace(request, "/v1/chat/completions", { id: "synthetic-gateway-key" }))).rejects.toBeDefined()
  expect(calls).toBe(2)
  const events = await runInWorkspace(workspace, () => listUsageEvents())
  expect(events.filter(event => event.requestedModel === target.modelId).map(event => event.requestFinal)).toEqual([true])
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
