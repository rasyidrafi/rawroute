import { afterEach, beforeEach, expect, test } from "bun:test"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { closeLocalDatabase } from "@rawroute/platform/server/database"
import { configurePlatformServer, createWorkspace, resetWorkspacesForTests } from "@rawroute/platform/server/runtime"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { _resetMemoryBackend, deleteProviderApiKey, listProviderApiKeys, upsertCombo, upsertModel, upsertProvider, upsertProviderApiKey } from "../store"
import { resetModelSharesForTests, setModelShareTargets } from "../model-shares"
import { normalizeRoutingFailure, proxyGatewayRequestInWorkspace, setGatewayRetryOptionsForTests, testComboMemberPolicy } from "./gateway"
import { resumeGatewayExecutions } from "./admission"
import { providerCredentialScheduler } from "./provider-credential-scheduler"
import { listUsageEvents, resetAnalyticsForTests } from "../analytics"

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
  resetAnalyticsForTests()
  configurePlatformServer({ identity: { initialize: () => {}, changed: () => {} }, participants: [] })
  await resetWorkspacesForTests()
  resetModelSharesForTests()
  resumeGatewayExecutions()
})

afterEach(async () => {
  setGatewayRetryOptionsForTests()
  globalThis.fetch = originalFetch
  resumeGatewayExecutions()
  await closeLocalDatabase()
  resetModelSharesForTests()
  await resetWorkspacesForTests()
  _resetMemoryBackend()
})

function instantRetries() {
  let now = 0
  setGatewayRetryOptionsForTests({ now: () => now, random: () => 0, wait: async ms => { now += ms } })
}

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

test("classifies original provider failures before conversion and tries combo alternatives", async () => {
  await runInWorkspace(workspace, async () => {
    const first = await providerModel("Classified retry first")
    await upsertProviderApiKey(first.provider.id, { name: "Quota key", key: "quota-synthetic-key", enabled: true })
    const second = await providerModel("Classified retry second")
    await upsertCombo({ combo: "classified-retry-combo", name: "Classified retry", members: [{ modelId: first.modelId }, { modelId: second.modelId }] })
  })
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`)
    if (calls.length === 1) return Response.json({ error: { code: "rate_limit_exceeded", message: "Per-minute usage limit reached. Retry in 1 second." } }, { status: 429 })
    if (calls.length === 2) return Response.json({ error: { type: "insufficient_quota" } }, { status: 429 })
    return chatResponse()
  }) as unknown as typeof fetch
  const response = await comboRequest("classified-retry-combo")
  expect(response.status).toBe(200)
  expect(calls).toHaveLength(3)
  expect(calls[0]).toContain("classified-retry-first.synthetic.invalid")
  expect(calls[1]).toContain("classified-retry-first.synthetic.invalid")
  expect(calls[0]).not.toBe(calls[1])
  expect(calls[2]).toContain("classified-retry-second.synthetic.invalid")
})

test("preserves a cross-protocol quota failure when no alternative succeeds", async () => {
  instantRetries()
  const model = await runInWorkspace(workspace, async () => {
    const provider = await upsertProvider({ name: "Anthropic quota", prefix: "anthropic-quota", baseUrl: "https://quota.synthetic.invalid", protocol: "anthropic-messages", authType: "bearer", headers: {}, enabled: true })
    await upsertProviderApiKey(provider.id, { name: "key", key: "synthetic-key", enabled: true })
    await upsertModel(provider.id, { gatewayModelId: "quota/model", name: "Quota", upstreamModel: "quota-model", enabled: true })
    await upsertCombo({ combo: "quota-combo", name: "Quota", members: [{ modelId: "quota/model" }] })
    return "quota-combo"
  })
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json({ error: { type: "billing_error", message: "See billing", details: { error_code: "usage_limit_reached" } } }, { status: 429 })
  }) as unknown as typeof fetch
  const response = await comboRequest(model)
  expect(response.status).toBe(429)
  expect(calls).toBe(24)
  expect(await response.json()).toMatchObject({ error: { message: "See billing" } })
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

for (const combo of [false, true]) test(`${combo ? "combo" : "direct"} settles when its only credential is removed during backoff`, async () => {
  const target = await runInWorkspace(workspace, async () => {
    const target = await providerModel("Removed credential")
    if (combo) await upsertCombo({ combo: "removed-combo", name: "Removed", members: [{ modelId: target.modelId }] })
    return target
  })
  let now = 0
  let waits = 0
  setGatewayRetryOptionsForTests({ now: () => now, random: () => 0, wait: async ms => {
    if (++waits === 1) await runInWorkspace(workspace, () => deleteProviderApiKey(target.provider.id, target.credential.id))
    now += ms
  } })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "unavailable" } }, { status: 503 }) }) as unknown as typeof fetch
  const model = combo ? "removed-combo" : target.modelId
  const response = await comboRequest(model)
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { message: "unavailable" } })
  expect(calls).toBe(1)
  expect(waits).toBe(1)
  const events = await runInWorkspace(workspace, () => listUsageEvents())
  expect(events.filter(event => event.requestedModel === model).map(event => ({ final: event.requestFinal, status: event.status }))).toEqual([{ final: true, status: 503 }])
})

test("combo retires a removed target while another member remains concurrency blocked", async () => {
  const { first, second } = await runInWorkspace(workspace, async () => {
    const first = await providerModel("Removed primary")
    const second = await providerModel("Blocked fallback", { maxConcurrency: 1 })
    await upsertCombo({ combo: "removed-and-blocked", name: "Removed and blocked", members: [{ modelId: first.modelId }, { modelId: second.modelId }] })
    return { first, second }
  })
  const lease = providerCredentialScheduler.acquire({ ownerWorkspaceId: workspace.id, providerId: second.provider.id, credentials: [second.credential] })
  expect(lease.ok).toBe(true)
  if (!lease.ok) throw new Error("Expected a held concurrency slot.")
  lease.markDispatched()
  let now = 0
  const waits: number[] = []
  setGatewayRetryOptionsForTests({ now: () => now, random: () => 0, wait: async ms => {
    waits.push(ms)
    if (waits.length === 1) await runInWorkspace(workspace, () => deleteProviderApiKey(first.provider.id, first.credential.id))
    now += ms
  } })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "unavailable" } }, { status: 503 }) }) as unknown as typeof fetch
  try {
    const response = await comboRequest("removed-and-blocked")
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { message: "unavailable" } })
    expect(calls).toBe(1)
    expect(waits).toEqual([250, 250, 500, 1000])
    const events = await runInWorkspace(workspace, () => listUsageEvents())
    expect(events.filter(event => event.requestedModel === "removed-and-blocked").map(event => ({ final: event.requestFinal, status: event.status }))).toEqual([{ final: true, status: 503 }])
  } finally { lease.release() }
})

for (const combo of [false, true]) for (const afterFailure of [false, true]) test(`${combo ? "combo" : "direct"} settles a cancelled dispatched fetch${afterFailure ? " after a failure" : ""}`, async () => {
  instantRetries()
  const target = await runInWorkspace(workspace, async () => {
    const target = await providerModel("Cancelled fetch")
    if (combo) await upsertCombo({ combo: "cancelled-combo", name: "Cancelled", members: [{ modelId: target.modelId }] })
    return target
  })
  const controller = new AbortController()
  let started!: () => void
  const pendingFetch = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    if (afterFailure && calls === 1) return Response.json({ error: { message: "unavailable" } }, { status: 503 })
    started()
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))
  }) as typeof fetch
  const model = combo ? "cancelled-combo" : target.modelId
  const request = runInWorkspace(workspace, () => proxyGatewayRequestInWorkspace(new Request("http://rawroute.test/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  }), "/v1/chat/completions", { id: "synthetic-gateway-key" }))
  await pendingFetch
  controller.abort()
  await expect(request).rejects.toThrow()
  expect(calls).toBe(afterFailure ? 2 : 1)
  const events = await runInWorkspace(workspace, () => listUsageEvents())
  expect(events.filter(event => event.requestedModel === model).sort((a, b) => (a.attemptIndex ?? 0) - (b.attemptIndex ?? 0)).map(event => ({ final: event.requestFinal, status: event.status }))).toEqual(afterFailure ? [{ final: false, status: 503 }, { final: true, status: 502 }] : [{ final: true, status: 502 }])
})

test("marks an exhausted combo as failed and bounds same-target dispatches", async () => {
  instantRetries()
  await runInWorkspace(workspace, async () => {
    const target = await providerModel("Retry exhausted")
    await upsertCombo({ combo: "retry-exhausted", name: "Retry", members: [{ modelId: target.modelId }] })
  })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "unavailable" } }, { status: 503 }) }) as unknown as typeof fetch
  const response = await comboRequest("retry-exhausted")
  expect(response.status).toBe(503)
  expect(calls).toBe(24)
  expect(await response.json()).toMatchObject({ error: { message: "unavailable" } })
  const events = await runInWorkspace(workspace, () => listUsageEvents())
  expect(events.filter(event => event.requestedModel === "retry-exhausted").map(event => event.requestFinal)).toEqual([...Array(23).fill(false), true])
}, 15_000)

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

test("records both attempts when cancellation interrupts the next dispatch", async () => {
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
  expect(events.filter(event => event.requestedModel === target.modelId).sort((a, b) => (a.attemptIndex ?? 0) - (b.attemptIndex ?? 0)).map(event => ({ final: event.requestFinal, status: event.status }))).toEqual([{ final: false, status: 503 }, { final: true, status: 502 }])
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

test("retries after concurrency admission clears without recording local poll attempts", async () => {
  const target = await runInWorkspace(workspace, () => providerModel("Polled concurrency", { maxConcurrency: 1 }))
  const lease = providerCredentialScheduler.acquire({ ownerWorkspaceId: workspace.id, providerId: target.provider.id, credentials: [target.credential] })
  expect(lease.ok).toBe(true)
  if (!lease.ok) throw new Error("Expected a held concurrency slot.")
  lease.markDispatched()
  let calls = 0
  globalThis.fetch = (async () => { calls++; return chatResponse() }) as unknown as typeof fetch
  try {
    const pending = comboRequest(target.modelId)
    setTimeout(() => lease.release(), 50)
    const response = await pending
    expect(response.status).toBe(200)
    expect(calls).toBe(1)
    const events = await runInWorkspace(workspace, () => listUsageEvents())
    expect(events.filter(event => event.requestedModel === target.modelId).map(event => event.status)).toEqual([200])
  } finally {
    lease.release()
  }
})

test("shapes an exhausted unclassified 429 as a public 503", async () => {
  instantRetries()
  const target = await runInWorkspace(workspace, () => providerModel("Unclassified failure"))
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "temporary failure" } }, { status: 429, headers: { "retry-after": "120" } }) }) as unknown as typeof fetch
  const response = await normalizeRoutingFailure(await runInWorkspace(workspace, () => proxyGatewayRequestInWorkspace(new Request("http://rawroute.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: target.modelId, messages: [{ role: "user", content: "hello" }] }),
  }), "/v1/chat/completions", { id: "synthetic-gateway-key" })))
  expect(response.status).toBe(503)
  expect(calls).toBe(24)
  expect(response.headers.has("retry-after")).toBe(false)
  const events = await runInWorkspace(workspace, () => listUsageEvents())
  expect(events.filter(event => event.requestedModel === target.modelId).map(event => event.requestFinal)).toEqual([...Array(23).fill(false), true])
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
