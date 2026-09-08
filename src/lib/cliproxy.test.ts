import { afterEach, beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authenticateProxyKey: vi.fn(),
  getBudgetRequestState: vi.fn(),
  reserveBudgetAdmission: vi.fn(),
  releaseBudgetReservation: vi.fn(),
  createGatewayUsageEvent: vi.fn(),
  recordUsageEvent: vi.fn(),
  listAliases: vi.fn(),
  listCombos: vi.fn(),
  listModels: vi.fn(),
  listProviders: vi.fn(),
  writeLog: vi.fn(),
  ensureNonCodexProviderProjection: vi.fn(),
  acquireComboCircuit: vi.fn(),
  settleComboCircuit: vi.fn(),
  recoverCodexQuota: vi.fn(),
}))
vi.mock("@/lib/combo-circuit", () => ({ acquireComboCircuit: mocks.acquireComboCircuit, settleComboCircuit: mocks.settleComboCircuit }))
vi.mock("@/lib/codex-recovery", () => ({ recoverCodexQuota: mocks.recoverCodexQuota }))

vi.mock("@/lib/auth", () => ({ authenticateProxyKey: mocks.authenticateProxyKey }))
vi.mock("@/lib/analytics", () => ({
  BudgetDeniedError: class BudgetDeniedError extends Error {
    status = 429
    retryAfterSeconds = 1
  },
  BudgetPricingUnavailableError: class BudgetPricingUnavailableError extends Error {
    status = 503
  },
  createGatewayUsageEvent: mocks.createGatewayUsageEvent,
  getBudgetRequestState: mocks.getBudgetRequestState,
  recordUsageEvent: mocks.recordUsageEvent,
  releaseBudgetReservation: mocks.releaseBudgetReservation,
  reserveBudgetAdmission: mocks.reserveBudgetAdmission,
}))
vi.mock("@/lib/cliproxy-codex", () => ({ codexWorkspacePrefix: (workspaceId: string) => `rr-codex-${workspaceId}` }))
vi.mock("@/lib/cliproxy-provider-sync", () => ({
  ensureNonCodexProviderProjection: mocks.ensureNonCodexProviderProjection,
  nonCodexProviderPrefix: (workspaceId: string, providerId: string) => `rr-ws-${workspaceId}-p-${providerId}`,
}))
vi.mock("@/lib/logger", () => ({ writeLog: mocks.writeLog }))
vi.mock("@/lib/store", () => ({
  listAliases: mocks.listAliases,
  listCombos: mocks.listCombos,
  listModels: mocks.listModels,
  listProviders: mocks.listProviders,
}))
vi.mock("@/lib/workspace-context", () => ({
  currentWorkspaceId: () => "default",
  runInWorkspace: (_workspace: unknown, callback: () => unknown) => callback(),
}))

import { BudgetDeniedError } from "@/lib/analytics"
import { collectStreamUsage, isTerminalStreamEvent, proxyGatewayRequest } from "@/lib/cliproxy"

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.clearAllMocks()
  mocks.acquireComboCircuit.mockResolvedValue({ allowed: true, probe: false })
  mocks.settleComboCircuit.mockResolvedValue(undefined)
  mocks.authenticateProxyKey.mockResolvedValue({
    workspace: { id: "default", storageMode: "scoped" },
    apiKey: { id: "gateway-key", name: "Gateway" },
  })
  mocks.getBudgetRequestState.mockResolvedValue({ admission: undefined, usageContext: undefined })
  mocks.reserveBudgetAdmission.mockResolvedValue(undefined)
  mocks.releaseBudgetReservation.mockResolvedValue(undefined)
  mocks.createGatewayUsageEvent.mockResolvedValue({ id: "usage-event" })
  mocks.recordUsageEvent.mockResolvedValue(undefined)
  mocks.ensureNonCodexProviderProjection.mockResolvedValue(undefined)
  mocks.listAliases.mockResolvedValue([])
  mocks.listCombos.mockResolvedValue([])
  mocks.listModels.mockResolvedValue([{
    id: "codex-model",
    providerId: "codex",
    gatewayModelId: "codex/gpt-5",
    name: "Codex",
    upstreamModel: "gpt-5",
    source: "builtin",
    enabled: true,
    createdAt: new Date().toISOString(),
  }])
  mocks.listProviders.mockResolvedValue([{ id: "codex", name: "Codex", prefix: "codex", enabled: true }])
  globalThis.fetch = vi.fn(async () => Response.json({ id: "response-1" })) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("restores the pre-rewrite request and completion console logs", async () => {
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex/gpt-5",
      input: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }],
      tools: [{ type: "function", name: "first" }, { type: "function", name: "second" }],
      reasoning: { effort: "low" },
    }),
  }))
  await response.text()

  const messages = mocks.writeLog.mock.calls.map((call) => call[2])
  expect(messages).toContain("POST PROVIDER:Codex MODEL:codex/gpt-5 -> gpt-5 FMT:openai-responses -> openai-responses KEY:Gateway THINK:low MSG:2 TOOL:2")
  expect(messages.some((message) => typeof message === "string" && /^DONE \d+ms/.test(message))).toBe(true)
})

test("logs invalid gateway authentication failures", async () => {
  mocks.authenticateProxyKey.mockResolvedValue(undefined)

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer invalid", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))

  expect(response.status).toBe(401)
  expect(mocks.writeLog).toHaveBeenCalledWith("warn", "gateway", "Request rejected: invalid API key", { protocol: "openai-responses" })
})

test("cooling combo members are skipped without executing an upstream request", async () => {
  mocks.listCombos.mockResolvedValue([{ combo: "fallback", memberModelIds: ["codex/gpt-5", "codex/gpt-5"] }])
  mocks.acquireComboCircuit.mockResolvedValueOnce({ allowed: false, retryAt: Date.now() + 60_000 })
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST", headers: { authorization: "Bearer key" }, body: JSON.stringify({ model: "fallback", input: "hello" }),
  }))
  expect(response.status).toBe(200)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
})

test("all cooling members return a retry deadline without upstream traffic", async () => {
  mocks.listCombos.mockResolvedValue([{ combo: "fallback", memberModelIds: ["codex/gpt-5"] }])
  mocks.acquireComboCircuit.mockResolvedValue({ allowed: false, retryAt: Date.now() + 60_000 })
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST", headers: { authorization: "Bearer key" }, body: JSON.stringify({ model: "fallback" }),
  }))
  expect(response.status).toBe(503)
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

test("half-open Codex member checks recovery before its inference probe", async () => {
  mocks.listCombos.mockResolvedValue([{ combo: "fallback", memberModelIds: ["codex/gpt-5"] }])
  mocks.acquireComboCircuit.mockResolvedValue({ allowed: true, probe: true, retryAt: Date.now() + 60_000 })
  mocks.recoverCodexQuota.mockResolvedValue(true)
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST", headers: { authorization: "Bearer key" }, body: JSON.stringify({ model: "fallback" }),
  }))
  expect(response.status).toBe(200)
  expect(mocks.recoverCodexQuota).toHaveBeenCalledWith("codex", "gpt-5")
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
})

test("returns 429 when budget reservation is denied", async () => {
  mocks.reserveBudgetAdmission.mockRejectedValue(new BudgetDeniedError("Weekly budget exceeded.", 1))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))

  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("1")
  await expect(response.json()).resolves.toEqual({ error: { message: "Weekly budget exceeded." } })
  expect(mocks.writeLog).toHaveBeenCalledWith("warn", "gateway", "Budget admission denied", {
    apiKeyId: "gateway-key",
    error: "Weekly budget exceeded.",
  })
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

test("tries combo members in order after an upstream failure", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([
    { id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true, createdAt: new Date().toISOString() },
    { id: "b", providerId: "p", gatewayModelId: "p/b", name: "B", upstreamModel: "b", enabled: true, createdAt: new Date().toISOString() },
  ])
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "coding-fallback", name: "Coding fallback", memberModelIds: ["p/a", "p/b"], createdAt: new Date().toISOString() }])
  globalThis.fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: { message: "rate limited" } }, { status: 429 }))
    .mockResolvedValueOnce(Response.json({ id: "response-from-b" })) as typeof fetch

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "coding-fallback", messages: [{ role: "user", content: "hello" }] }),
  }))

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ id: "response-from-b" })
  const forwardedModels = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)
  expect(forwardedModels).toEqual(["rr-ws-default-p-p/a", "rr-ws-default-p-p/b"])
})

test("skips an unavailable combo member and does not expose its internal retry marker", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([
    { id: "b", providerId: "p", gatewayModelId: "p/b", name: "B", upstreamModel: "b", enabled: true, createdAt: new Date().toISOString() },
  ])
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "coding-fallback", name: "Coding fallback", memberModelIds: ["p/disabled", "p/b"], createdAt: new Date().toISOString() }])
  globalThis.fetch = vi.fn().mockResolvedValue(Response.json({ id: "response-from-b" })) as typeof fetch

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "coding-fallback", messages: [{ role: "user", content: "hello" }] }),
  }))

  expect(response.status).toBe(200)
  expect(response.headers.has("x-rawroute-combo-member-unavailable")).toBe(false)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
})

test("does not expose the unavailable-member marker outside a combo", async () => {
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "missing/model", messages: [{ role: "user", content: "hello" }] }),
  }))

  expect(response.status).toBe(400)
  expect(response.headers.has("x-rawroute-combo-member-unavailable")).toBe(false)
})

test("normalizes reasoning_effort before forwarding Responses requests", async () => {
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex/gpt-5",
      input: "hello",
      reasoning_effort: " high ",
      max_tokens: 123,
    }),
  }))
  await response.text()

  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body)) as Record<string, unknown>
  expect(forwarded.reasoning_effort).toBeUndefined()
  expect(forwarded.reasoning).toEqual({ effort: "high" })
  expect(forwarded.max_output_tokens).toBe(123)
  expect(forwarded.max_tokens).toBeUndefined()
})

test("strips Expect before forwarding a request to CLIProxy", async () => {
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json", expect: "100-continue" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))
  await response.text()

  const forwardedHeaders = new Headers((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers)
  expect(forwardedHeaders.has("expect")).toBe(false)
})

test("accepts terminal stream events even when usage is missing", async () => {
  expect(isTerminalStreamEvent("message_stop", {})).toBe(true)
  expect(isTerminalStreamEvent("", { type: "response.completed" })).toBe(true)

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"type\":\"response.completed\"}\n\n"))
      controller.close()
    },
  })
  await expect(collectStreamUsage(stream)).resolves.toMatchObject({ completedNormally: true, terminalEventSeen: true, usage: undefined })
})

test("merges Anthropic input and cache usage from separate stream events", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        "event: message_start",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_creation_input_tokens":30,"cache_read_input_tokens":850}}}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","usage":{"output_tokens":4}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
      ].join("\n")))
      controller.close()
    },
  })

  await expect(collectStreamUsage(stream)).resolves.toMatchObject({
    completedNormally: true,
    terminalEventSeen: true,
    usage: { input: 1_000, cached: 850, cacheCreation: 30, output: 4 },
  })
})

test("marks a stream without a terminal event as incomplete", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n"))
      controller.close()
    },
  })
  await expect(collectStreamUsage(stream)).resolves.toMatchObject({ completedNormally: false, terminalEventSeen: false })
})

test("routes Codex models through the authenticated workspace namespace", async () => {
  const provider = { id: "codex", name: "Codex", prefix: "codex", enabled: true }
  const model = {
    id: "codex-model",
    providerId: "codex",
    gatewayModelId: "codex/gpt-5",
    name: "gpt-5",
    upstreamModel: "gpt-5",
    source: "builtin",
    enabled: true,
    createdAt: "2026-08-08T00:00:00.000Z",
  }
  mocks.listProviders.mockResolvedValue([provider])
  mocks.listModels.mockResolvedValue([model])

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))
  await response.text()

  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body)) as Record<string, unknown>
  expect(forwarded.model).toBe("rr-codex-default/gpt-5")
})

test("routes non-Codex models through a workspace/provider namespace", async () => {
  const provider = { id: "provider-a", name: "Bynara", prefix: "bynara", protocol: "openai-chat", authType: "bearer", enabled: true }
  const model = {
    id: "model-a",
    providerId: provider.id,
    gatewayModelId: "bynara/model-a",
    name: "Model A",
    upstreamModel: "upstream-a",
    enabled: true,
    createdAt: "2026-08-08T00:00:00.000Z",
  }
  mocks.listProviders.mockResolvedValue([provider])
  mocks.listModels.mockResolvedValue([model])

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "bynara/model-a", messages: [{ role: "user", content: "hello" }] }),
  }))
  await response.text()

  expect(mocks.ensureNonCodexProviderProjection).toHaveBeenCalledWith(provider.id)
  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body)) as Record<string, unknown>
  expect(forwarded.model).toBe("rr-ws-default-p-provider-a/model-a")
})

test("logs the received protocol and the saved provider protocol", async () => {
  const provider = { id: "provider-a", name: "Nara", prefix: "nara", protocol: "openai-chat", authType: "bearer", enabled: true }
  mocks.listProviders.mockResolvedValue([provider])
  mocks.listModels.mockResolvedValue([{
    id: "model-a",
    providerId: provider.id,
    gatewayModelId: "nara/grok-4.5",
    name: "Grok 4.5",
    upstreamModel: "grok-4.5",
    enabled: true,
    createdAt: "2026-08-08T00:00:00.000Z",
  }])

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "nara/grok-4.5", max_tokens: 32, messages: [{ role: "user", content: "hello" }] }),
  }))
  await response.text()

  const messages = mocks.writeLog.mock.calls.map((call) => call[2])
  expect(messages).toContain("POST PROVIDER:Nara MODEL:nara/grok-4.5 -> grok-4.5 FMT:anthropic-messages -> openai-chat KEY:Gateway MSG:1")
})

test("lets CLIProxy translate every supported client/provider protocol direction", async () => {
  const cases = [
    { name: "openai-responses to openai-chat", providerProtocol: "openai-chat" as const, path: "/v1/responses", body: { model: "bynara/model-a", input: "hello" } },
    { name: "openai-chat to openai-responses", providerProtocol: "openai-responses" as const, path: "/v1/chat/completions", body: { model: "bynara/model-a", messages: [{ role: "user", content: "hello" }] } },
    { name: "openai-responses to anthropic-messages", providerProtocol: "anthropic-messages" as const, path: "/v1/responses", body: { model: "bynara/model-a", input: "hello" } },
    { name: "anthropic-messages to openai-responses", providerProtocol: "openai-responses" as const, path: "/v1/messages", body: { model: "bynara/model-a", max_tokens: 32, messages: [{ role: "user", content: "hello" }] } },
    { name: "openai-chat to anthropic-messages", providerProtocol: "anthropic-messages" as const, path: "/v1/chat/completions", body: { model: "bynara/model-a", messages: [{ role: "user", content: "hello" }] } },
    { name: "anthropic-messages to openai-chat", providerProtocol: "openai-chat" as const, path: "/v1/messages", body: { model: "bynara/model-a", max_tokens: 32, messages: [{ role: "user", content: "hello" }] } },
  ]

  for (const scenario of cases) {
    vi.clearAllMocks()
    const provider = { id: "provider-a", name: "Bynara", prefix: "bynara", protocol: scenario.providerProtocol, authType: "bearer", enabled: true }
    mocks.listProviders.mockResolvedValue([provider])
    mocks.listModels.mockResolvedValue([{
      id: "model-a",
      providerId: provider.id,
      gatewayModelId: "bynara/model-a",
      name: "Model A",
      upstreamModel: "upstream-a",
      enabled: true,
      createdAt: "2026-08-08T00:00:00.000Z",
    }])
    const fetchMock = vi.fn(async () => Response.json({ id: "response-1" })) as typeof fetch
    globalThis.fetch = fetchMock

    const response = await proxyGatewayRequest(new Request(`http://gateway${scenario.path}`, {
      method: "POST",
      headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
      body: JSON.stringify(scenario.body),
    }))

    expect(response.status, scenario.name).toBe(200)
    await response.text()
    expect(mocks.ensureNonCodexProviderProjection, scenario.name).toHaveBeenCalledWith(provider.id)
    const fetchCalls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(String(fetchCalls[0]?.[0]), scenario.name).toContain(scenario.path)
    const forwarded = JSON.parse(String(fetchCalls[0]?.[1]?.body)) as Record<string, unknown>
    expect(forwarded.model, scenario.name).toBe("rr-ws-default-p-provider-a/model-a")
  }
})

test("rejects unknown runtime models before calling the backend", async () => {
  const provider = { id: "codex", name: "Codex", prefix: "codex", enabled: true }
  mocks.listProviders.mockResolvedValue([provider])
  mocks.listModels.mockResolvedValue([])

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/old", input: "hello" }),
  }))

  expect(response.status).toBe(400)
  expect(globalThis.fetch).not.toHaveBeenCalled()
})
