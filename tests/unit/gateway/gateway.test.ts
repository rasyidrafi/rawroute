import { afterEach, beforeEach, expect, test, mock, spyOn } from "bun:test"

const fetchTarget: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis

const mocks = {
  authenticateProxyKey: mock(),
  getBudgetRequestState: mock(),
  getBudgetWindow: mock(),
  assertUnlimitedModelsAllowed: mock(),
  reserveBudgetAdmission: mock(),
  releaseBudgetReservation: mock(),
  createGatewayUsageEvent: mock(),
  recordUsageEvent: mock(),
  listAliases: mock(),
  listCombos: mock(),
  listModels: mock(),
  listProviders: mock(),
  listProviderApiKeys: mock(),
  recordLog: mock(),
}

mock.module("../../../packages/gateway-ai/src/server/auth", () => ({ authenticateProxyKey: mocks.authenticateProxyKey }))
mock.module("../../../packages/gateway-ai/src/server/analytics", () => ({
  assertUnlimitedModelsAllowed: mocks.assertUnlimitedModelsAllowed,
  BudgetDeniedError: class BudgetDeniedError extends Error {
    status = 429
    retryAfterSeconds: number
    constructor(message: string, retryAfterSeconds: number) { super(message); this.retryAfterSeconds = retryAfterSeconds }
  },
  BudgetPricingUnavailableError: class BudgetPricingUnavailableError extends Error {
    status = 503
  },
  BudgetModelExcludedError: class BudgetModelExcludedError extends Error {
    status = 403
    code = "model_excluded_in_unlimited_mode"
  },
  createGatewayUsageEvent: mocks.createGatewayUsageEvent,
  getBudgetRequestState: mocks.getBudgetRequestState,
  getBudgetWindow: mocks.getBudgetWindow,
  recordUsageEvent: mocks.recordUsageEvent,
  releaseBudgetReservation: mocks.releaseBudgetReservation,
  reserveBudgetAdmission: mocks.reserveBudgetAdmission,
}))
mock.module("../../../packages/gateway-ai/src/server/logging", () => ({ recordLog: mocks.recordLog }))
mock.module("../../../packages/gateway-ai/src/server/codex/model-refresh", () => ({ scheduleCodexModelRefresh: mock() }))
mock.module("../../../packages/gateway-ai/src/server/store", () => ({
  isMemoryBackend: () => true,
  listAliases: mocks.listAliases,
  listCombos: mocks.listCombos,
  listModels: mocks.listModels,
  listProviders: async () => (await mocks.listProviders()).map((provider: Record<string, unknown>) => ({
    id: "p", name: "Provider", prefix: "provider", baseUrl: "https://provider.test/v1", protocol: "openai-chat", authType: "none", headers: {}, enabled: true,
    ...provider,
    ...(provider.prefix === "codex" ? { prefix: "test-codex" } : {}),
  })),
  listProviderApiKeys: mocks.listProviderApiKeys,
}))
mock.module("../../../packages/platform/src/server/workspace-context", () => ({
  currentWorkspaceId: () => "default",
  workspaceContext: () => ({ id: "default", storageMode: "scoped" }),
  runInWorkspace: (_workspace: unknown, callback: () => unknown) => callback(),
}))
mock.module("../../../packages/platform/src/server/runtime", () => ({
  getWorkspace: async (id: string) => ({ id, status: "active", storageMode: "scoped" }),
  listWorkspaces: async () => [],
}))

const { BudgetDeniedError, BudgetModelExcludedError } = await import("../../../packages/gateway-ai/src/server/analytics")
const { collectStreamUsage, isTerminalStreamEvent, proxyGatewayRequest, sharedUsageEventCopies, testComboMemberPolicy } = await import("../../../packages/gateway-ai/src/server/gateway/gateway")
const { drainBackgroundTasks } = await import("../../../packages/platform/src/server/background-tasks")
const { resolveGatewayModel } = await import("../../../packages/gateway-ai/src/server/gateway/model-resolution")

test("confirmed unavailable Codex models and their aliases cannot reach inference", async () => {
  mocks.listModels.mockResolvedValue([{ id: "removed", providerId: "codex", gatewayModelId: "codex/gpt-5.5", upstreamModel: "gpt-5.5", name: "Retired", enabled: true, source: "discovered", discovery: { stale: true, accountIds: [] } }])
  mocks.listAliases.mockResolvedValue([{ alias: "saved-alias", targetModelId: "removed" }])
  await expect(resolveGatewayModel("codex/gpt-5.5")).rejects.toMatchObject({ code: "model_not_found" })
  await expect(resolveGatewayModel("saved-alias")).rejects.toMatchObject({ code: "model_not_found" })
  expect(fetchTarget.fetch).not.toHaveBeenCalled()
})

beforeEach(() => {
  mock.clearAllMocks()
  mocks.authenticateProxyKey.mockResolvedValue({
    workspace: { id: "default", storageMode: "scoped" },
    apiKey: { id: "gateway-key", name: "Gateway" },
  })
  mocks.getBudgetRequestState.mockResolvedValue({ admission: undefined, usageContext: undefined })
  mocks.getBudgetWindow.mockResolvedValue({ bypassLimits: false })
  mocks.assertUnlimitedModelsAllowed.mockResolvedValue(undefined)
  mocks.reserveBudgetAdmission.mockResolvedValue(undefined)
  mocks.releaseBudgetReservation.mockResolvedValue(undefined)
  mocks.createGatewayUsageEvent.mockResolvedValue({ id: "usage-event" })
  mocks.recordUsageEvent.mockResolvedValue(undefined)
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
  mocks.listProviders.mockResolvedValue([{ id: "codex", name: "Codex", prefix: "provider", baseUrl: "https://provider.test/v1", protocol: "openai-responses", authType: "none", headers: {}, supportPromptCacheKey: true, enabled: true }])
  mocks.listProviderApiKeys.mockResolvedValue([])
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async () => Response.json({ id: "response-1" })))
})

afterEach(async () => {
  await drainBackgroundTasks()
  mock.restore()
})

test("OpenAI-compatible providers forward stable scoped cache keys through normalization and combo fallback", async () => {
  mocks.listModels.mockResolvedValue(["a", "b"].map(id => ({ id, providerId: "codex", gatewayModelId: `codex/${id}`, upstreamModel: id, name: id, enabled: true })))
  mocks.listCombos.mockResolvedValue([{ id: "combo", combo: "coding", name: "Coding", members: [{ modelId: "codex/a" }, { modelId: "codex/b" }] }])
  const sent: Record<string, unknown>[] = []
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    sent.push(body)
    return body.model === "a" ? Response.json({ error: { message: "Unavailable" } }, { status: 503 }) : Response.json({ id: "ok" })
  }))
  for (const input of ["first", "first and second"]) {
    const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", { method: "POST", headers: { authorization: "Bearer secret", "x-session-id": "conversation" }, body: JSON.stringify({ model: "coding", input, max_tokens: 10 }) }))
    expect(response.status).toBe(200)
  }
  expect(sent).toHaveLength(4)
  expect(sent[0]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/)
  expect(new Set(sent.map(body => body.prompt_cache_key)).size).toBe(1)
  expect(sent[3]).toMatchObject({ input: "first and second", max_output_tokens: 10 })
})

test("Responses providers honor the cache setting and preserve client keys in the sent body", async () => {
  const sent: Record<string, unknown>[] = []
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({ id: "ok" }) }))
  mocks.listModels.mockResolvedValue([{ id: "m", providerId: "p", gatewayModelId: "p/model", upstreamModel: "model", name: "Model", enabled: true }])
  for (const enabled of [false, true]) {
    mocks.listProviders.mockResolvedValue([{ id: "p", prefix: "p", name: "Provider", baseUrl: "https://provider.test", protocol: "openai-responses", authType: "none", supportPromptCacheKey: enabled, enabled: true }])
    await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer secret", "x-session-id": "conversation" }, body: JSON.stringify({ model: "p/model", messages: [{ role: "user", content: "hello" }] }) }))
  }
  expect(sent[0]).not.toHaveProperty("prompt_cache_key")
  expect(sent[1]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/)
  expect(sent[1]).toMatchObject({ input: [{ role: "user", content: "hello" }] })
  expect(sent[1]).not.toHaveProperty("messages")
  await proxyGatewayRequest(new Request("http://gateway/v1/responses", { method: "POST", headers: { authorization: "Bearer secret", "x-session-id": "conversation" }, body: JSON.stringify({ model: "p/model", input: "hello", prompt_cache_key: "client-owned" }) }))
  expect(sent[2]?.prompt_cache_key).toBe("client-owned")
})

test("advertises and routes a discovered model unknown to the bundled catalog", async () => {
  mocks.listModels.mockResolvedValue([{ id: "discovered", providerId: "codex", gatewayModelId: "codex/future-model", upstreamModel: "future-model", name: "Future", source: "discovered", enabled: true, createdAt: new Date().toISOString() }])
  const catalog = await proxyGatewayRequest(new Request("http://gateway/v1/models", { headers: { authorization: "Bearer gateway-secret" } }))
  expect((await catalog.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: "codex/future-model" })]))
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", { method: "POST", headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "codex/future-model", input: "Hello" }) }))
  expect(response.status).toBe(200)
  const calls = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls
  expect(calls.some((call) => call[1]?.body && JSON.parse(String(call[1].body)).model === "future-model")).toBe(true)
})

test("fallback attempts retain client tier, account for each sent override and collect actual served tier", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", baseUrl: "https://api.example.com", protocol: "openai-responses", authType: "none", headers: {}, enabled: true }])
  mocks.listModels.mockResolvedValue(["a", "b"].map(id => ({ id, providerId: "p", gatewayModelId: `p/${id}`, name: id, upstreamModel: id, enabled: true })))
  mocks.listCombos.mockResolvedValue([{ id: "c", combo: "combo", name: "Combo", members: [{ modelId: "p/a", customPayload: { service_tier: "priority" } }, { modelId: "p/b", customPayload: { service_tier: "ultrafast" } }] }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async (_url, init) => JSON.parse(String(init?.body)).model === "a"
    ? Response.json({ error: { message: "Unavailable" } }, { status: 503 })
    : Response.json({ service_tier: "default", usage: { input_tokens: 10, output_tokens: 1 } })))
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", { method: "POST", headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "combo", input: "hello", service_tier: "flex" }) }))
  expect(response.status).toBe(200)
  const attempts = mocks.createGatewayUsageEvent.mock.calls.map(call => call[0])
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toMatchObject({ requestedServiceTier: "flex", sentServiceTier: "priority", attemptIndex: 0 })
  expect(attempts[1]).toMatchObject({ requestedServiceTier: "flex", sentServiceTier: "ultrafast", attemptIndex: 1, metrics: { effectiveServiceTier: "default" } })
  expect(mocks.getBudgetRequestState.mock.calls.map(call => call[3].service_tier)).toEqual(["priority", "ultrafast"])
})

for (const [protocol, path, reported, expected] of [
  ["openai-responses", "/v1/responses", { service_tier: "fast" }, "priority"],
  ["openai-responses", "/v1/responses", { service_tier: "ultrafast" }, "ultrafast"],
  ["anthropic-messages", "/v1/messages", { usage: { speed: "fast", input_tokens: 10, output_tokens: 1 } }, "fast"],
] as const) {
  test(`automatically records ${expected} from ${protocol} without model tier settings`, async () => {
    mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", baseUrl: "https://api.example.com", protocol, authType: "none", headers: {}, enabled: true }])
    mocks.listModels.mockResolvedValue([{ id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true }])
    spyOn(fetchTarget, "fetch").mockImplementation(mock(async () => Response.json({ usage: { input_tokens: 10, output_tokens: 1 }, ...reported })))
    const response = await proxyGatewayRequest(new Request(`http://gateway${path}`, { method: "POST", headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "p/a", input: "hello", messages: [{ role: "user", content: "hello" }], max_tokens: 10 }) }))
    expect(response.status).toBe(200)
    await response.text()
    await drainBackgroundTasks()
    expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ requestedServiceTier: undefined, metrics: { effectiveServiceTier: expected, input: 10, output: 1 } })
  })
}

test("tests combo member policies with a streaming probe", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", baseUrl: "https://api.example.com", protocol: "openai-responses", authType: "bearer", headers: {}, enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true, createdAt: new Date().toISOString() }])
  mocks.listProviderApiKeys.mockResolvedValue([{ id: "key", providerId: "p", name: "Key", key: "secret", enabled: true, createdAt: new Date().toISOString() }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async () => new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })))

  const result = await testComboMemberPolicy({ modelId: "p/a", reasoning: { mode: "inherit" }, customPayload: { diffusing: true } })

  expect(result.status).toBe("verified")
  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body))
  expect(forwarded).toMatchObject({ model: "a", input: [{ role: "user", content: "Reply with OK." }], diffusing: true, stream: true })
})

test("records structured request and completion events", async () => {
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

  const events = mocks.recordLog.mock.calls.map((call) => call[0])
  expect(mocks.recordLog).toHaveBeenCalledWith("gateway.request.started", expect.objectContaining({ model: "codex/gpt-5", protocol: "openai-responses", reasoningEffort: "low", messageCount: 2, toolCount: 2, apiKeyId: "gateway-key" }))
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ reasoningEffort: "low", toolCount: 2 })
  expect(events).toContain("gateway.request.completed")
})

test("request metadata is retained on upstream fetch failures", async () => {
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async () => { throw new Error("upstream unavailable") }))
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello", reasoning: { effort: "medium" }, tools: [] }),
  }))

  expect(response.status).toBe(502)
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ reasoningEffort: "medium", toolCount: 0 })
})

test("keeps absent tool metadata distinct from an explicitly empty tool list", async () => {
  const request = (body: Record<string, unknown>) => new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "Hello", ...body }),
  })

  const absentResponse = await proxyGatewayRequest(request({}))
  await absentResponse.text()
  const absentStarted = mocks.recordLog.mock.calls.find((call) => call[0] === "gateway.request.started")
  expect(absentStarted?.[1]).not.toHaveProperty("toolCount")
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).not.toHaveProperty("toolCount")

  const emptyResponse = await proxyGatewayRequest(request({ tools: [] }))
  await emptyResponse.text()
  const emptyStarted = mocks.recordLog.mock.calls.filter((call) => call[0] === "gateway.request.started").at(-1)
  expect(emptyStarted?.[1]).toMatchObject({ toolCount: 0 })
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ toolCount: 0 })

  const nestedResponse = await proxyGatewayRequest(request({ extra_body: { tools: [{}, {}] } }))
  await nestedResponse.text()
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ toolCount: 2 })

  const directResponse = await proxyGatewayRequest(request({ tools: [{}], extra_body: { tools: [{}, {}] } }))
  await directResponse.text()
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ toolCount: 1 })

  const unsafeResponse = await proxyGatewayRequest(request({ reasoning_effort: "secret=hidden-value" }))
  await unsafeResponse.text()
  const unsafeStarted = mocks.recordLog.mock.calls.filter((call) => call[0] === "gateway.request.started").at(-1)
  expect(unsafeStarted?.[1]).not.toHaveProperty("reasoningEffort")
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).not.toHaveProperty("reasoningEffort")

  const ordinaryResponse = await proxyGatewayRequest(request({ reasoning_effort: "customer-private-value" }))
  await ordinaryResponse.text()
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).not.toHaveProperty("reasoningEffort")

  const conflictingResponse = await proxyGatewayRequest(request({ reasoning: { effort: "high" }, reasoning_effort: "low" }))
  await conflictingResponse.text()
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).not.toHaveProperty("reasoningEffort")
})

test("shared event copies preserve validated reasoning and declared-tool metadata", () => {
  const event = {
    id: "shared-metadata",
    gatewayKeyId: "key",
    gatewayModelId: "provider/model",
    protocol: "openai-chat" as const,
    startedAt: "2026-10-15T12:00:00.000Z",
    completedAt: "2026-10-15T12:00:01.000Z",
    status: 200,
    durationMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 2,
    costMicros: 10,
    pricingConfidence: "exact" as const,
    usageAvailable: true,
    reasoningEffort: "high" as const,
    toolCount: 0,
  }
  const shared = {
    id: "share",
    ownerWorkspaceId: "owner",
    ownerWorkspaceName: "Owner",
    consumerWorkspaceId: "consumer",
    consumerWorkspaceName: "Consumer",
    sourceGatewayModelId: "provider/model",
    sourceModelId: "model-id",
  }

  const copies = sharedUsageEventCopies(event, shared)
  expect(copies.consumerEvent).toMatchObject({ reasoningEffort: "high", toolCount: 0, sharedUsage: { role: "consumer" } })
  expect(copies.ownerEvent).toMatchObject({ reasoningEffort: "high", toolCount: 0, sharedUsage: { role: "owner" } })
})

test("logs invalid gateway authentication failures", async () => {
  mocks.authenticateProxyKey.mockResolvedValue(undefined)

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer invalid", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))

  expect(response.status).toBe(401)
  expect(mocks.recordLog).toHaveBeenCalledWith("gateway.authentication.rejected", { protocol: "openai-responses" }, { level: "warn" })
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
  expect(mocks.recordLog).toHaveBeenCalledWith("gateway.budget.admission.denied", {
    apiKeyId: "gateway-key",
    status: 429,
    retryAfter: 1,
  }, { level: "warn" })
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

test("tries combo members in order after an upstream failure", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([
    { id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true, createdAt: new Date().toISOString() },
    { id: "b", providerId: "p", gatewayModelId: "p/b", name: "B", upstreamModel: "b", enabled: true, createdAt: new Date().toISOString() },
  ])
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "coding-fallback", name: "Coding fallback", members: ["p/a", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })), createdAt: new Date().toISOString() }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock()
    .mockResolvedValueOnce(Response.json({ error: { message: "rate limited" } }, { status: 429 }))
    .mockResolvedValueOnce(Response.json({ id: "response-from-b" })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "coding-fallback", messages: [{ role: "user", content: "hello" }] }),
  }))

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ id: "response-from-b" })
  const forwardedModels = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)
  expect(forwardedModels).toEqual(["a", "b"])
})

test("does not try another combo member after a streaming response is exposed", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", authType: "none", enabled: true }])
  mocks.listModels.mockResolvedValue(["a", "b"].map((id) => ({ id, providerId: "p", gatewayModelId: `p/${id}`, name: id, upstreamModel: id, enabled: true })))
  mocks.listCombos.mockResolvedValue([{ id: "combo", combo: "streaming", name: "Streaming", members: [{ modelId: "p/a" }, { modelId: "p/b" }] }])
  const calls: string[] = []
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async (_url, init) => {
    calls.push(String(JSON.parse(String(init?.body)).model))
    return new Response('data: {"id":"chunk","object":"chat.completion.chunk","created":1,"model":"a","choices":[{"index":0,"delta":{"content":"started"},"finish_reason":null}]}\n\n', { headers: { "content-type": "text/event-stream" } })
  }))
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "streaming", messages: [{ role: "user", content: "hello" }], stream: true }),
  }))
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("started")
  await reader.cancel()
  expect(calls).toEqual(["a"])
  await drainBackgroundTasks()
})

test("sends combo reasoning overrides in the request body without suffixing projected model IDs", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([
    { id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a-upstream", enabled: true, createdAt: new Date().toISOString() },
  ])
  mocks.listCombos.mockResolvedValue([{
    id: "combo-1",
    combo: "reasoning-combo",
    name: "Reasoning combo",
    members: [{ modelId: "p/a", reasoning: { mode: "override", effort: "max" } }],
    createdAt: new Date().toISOString(),
  }])

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "reasoning-combo", messages: [{ role: "user", content: "hello" }], reasoning_effort: "low" }),
  }))

  expect(response.status).toBe(200)
  await response.text()
  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body))
  expect(forwarded).toMatchObject({ model: "a-upstream", reasoning_effort: "max" })
  expect(forwarded.model).not.toContain("(max)")
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ reasoningEffort: "max" })
})

test("does not record a custom combo effort outside the reviewed vocabulary", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true, createdAt: new Date().toISOString() }])
  mocks.listCombos.mockResolvedValue([{
    id: "combo-1",
    combo: "custom-reasoning-combo",
    name: "Custom reasoning combo",
    members: [{ modelId: "p/a", reasoning: { mode: "override", effort: "customer-private-value" } }],
    createdAt: new Date().toISOString(),
  }])

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "custom-reasoning-combo", messages: [{ role: "user", content: "hello" }] }),
  }))
  await response.text()

  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).not.toHaveProperty("reasoningEffort")
  const started = mocks.recordLog.mock.calls.find((call) => call[0] === "gateway.request.started")
  expect(started?.[1]).not.toHaveProperty("reasoningEffort")
})

test("deep merges a combo member custom payload and keeps the routed model", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a-upstream", enabled: true, createdAt: new Date().toISOString() }])
  mocks.listCombos.mockResolvedValue([{
    id: "combo-1",
    combo: "custom-combo",
    name: "Custom combo",
    members: [{ modelId: "p/a", reasoning: { mode: "inherit" }, customPayload: { temperature: 0.2, response_format: { json_schema: { name: "answer" } } } }],
    createdAt: new Date().toISOString(),
  }])

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "custom-combo", messages: [{ role: "user", content: "hello" }], temperature: 1, response_format: { type: "json_schema" } }),
  }))

  expect(response.status).toBe(200)
  await response.text()
  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body))
  expect(forwarded).toMatchObject({ model: "a-upstream", temperature: 0.2, response_format: { type: "json_schema", json_schema: { name: "answer" } } })
  expect(forwarded.messages).toEqual([{ role: "user", content: "hello" }])
})

test("falls back after a non-terminal provider error regardless of status class", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([
    { id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true, createdAt: new Date().toISOString() },
    { id: "b", providerId: "p", gatewayModelId: "p/b", name: "B", upstreamModel: "b", enabled: true, createdAt: new Date().toISOString() },
  ])
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "coding-fallback", name: "Coding fallback", members: ["p/a", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })), createdAt: new Date().toISOString() }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock()
    .mockResolvedValueOnce(Response.json({ error: { message: "credential rejected" } }, { status: 403, headers: { "retry-after": "3700" } }))
    .mockResolvedValueOnce(Response.json({ id: "response-from-b" })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "coding-fallback", messages: [{ role: "user", content: "hello" }] }),
  }))

  expect(response.status).toBe(200)
  expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  const recorded = mocks.createGatewayUsageEvent.mock.calls.map(call => call[0])
  expect(recorded).toHaveLength(2)
  expect(recorded[0]).toMatchObject({ requestedModel: "coding-fallback", gatewayModelId: "p/a", attemptIndex: 0, requestFinal: false, status: 403 })
  expect(recorded[1]).toMatchObject({ requestedModel: "coding-fallback", gatewayModelId: "p/b", attemptIndex: 1, requestFinal: true, status: 200 })
  expect(recorded[0].requestId).toBeString()
  expect(recorded[0].requestId).toBe(recorded[1].requestId)
  expect(recorded[0].id).not.toBe(recorded[1].id)
})

test("treats provider model cooldown as an immediate fallback signal", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([
    { id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true, createdAt: new Date().toISOString() },
    { id: "b", providerId: "p", gatewayModelId: "p/b", name: "B", upstreamModel: "b", enabled: true, createdAt: new Date().toISOString() },
  ])
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "coding-fallback", name: "Coding fallback", members: ["p/a", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })), createdAt: new Date().toISOString() }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock()
    .mockResolvedValueOnce(Response.json({ error: { code: "model_cooldown", message: "All credentials for model p/a are cooling down" } }, { status: 429, headers: { "retry-after": "3700" } }))
    .mockResolvedValueOnce(Response.json({ id: "response-from-b" })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "coding-fallback", messages: [{ role: "user", content: "hello" }] }),
  }))

  expect(response.status).toBe(200)
  expect(response.headers.has("retry-after")).toBe(false)
  expect(globalThis.fetch).toHaveBeenCalledTimes(2)
})

test("does not expose a synthetic cooldown or non-limit Retry-After to clients", async () => {
  spyOn(fetchTarget, "fetch").mockImplementation(mock().mockResolvedValue(Response.json({
    error: { code: "model_cooldown", message: "All credentials for model codex/gpt-5 are cooling down" },
  }, { status: 429, headers: { "retry-after": "3700" } })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))

  expect(response.status).toBe(503)
  expect(response.headers.has("retry-after")).toBe(false)
  await expect(response.json()).resolves.toEqual({ error: { code: "upstream_unavailable", message: "Upstream routing is temporarily unavailable." } })
})

test("does not expose Codex cooldown retry instructions", async () => {
  spyOn(fetchTarget, "fetch").mockImplementation(mock().mockResolvedValue(Response.json({
    error: { code: "codex_cooldown", message: "Codex cooldown is still active." },
  }, { status: 429, headers: { "retry-after": "3700" } })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))

  expect(response.status).toBe(503)
  expect(response.headers.has("retry-after")).toBe(false)
  await expect(response.json()).resolves.toMatchObject({ error: { code: "upstream_unavailable" } })
})

test("preserves Retry-After only for an upstream rate limit", async () => {
  spyOn(fetchTarget, "fetch").mockImplementation(mock().mockResolvedValue(Response.json({
    error: { code: "rate_limit_exceeded", message: "Requests per minute exceeded" },
  }, { status: 429, headers: { "retry-after": "12" } })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))

  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("12")
})

test("does not trust an unclassified upstream 429 as proof of exhausted usage", async () => {
  spyOn(fetchTarget, "fetch").mockImplementation(mock().mockResolvedValue(Response.json({
    error: { code: "upstream_error", message: "Temporary provider failure" },
  }, { status: 429, headers: { "retry-after": "3700" } })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))

  expect(response.status).toBe(503)
  expect(response.headers.has("retry-after")).toBe(false)
})

test("skips an unavailable combo member and does not expose its internal retry marker", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([
    { id: "b", providerId: "p", gatewayModelId: "p/b", name: "B", upstreamModel: "b", enabled: true, createdAt: new Date().toISOString() },
  ])
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "coding-fallback", name: "Coding fallback", members: ["p/disabled", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })), createdAt: new Date().toISOString() }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock().mockResolvedValue(Response.json({ id: "response-from-b" })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "coding-fallback", messages: [{ role: "user", content: "hello" }] }),
  }))

  expect(response.status).toBe(200)
  expect(response.headers.has("x-rawroute-combo-member-unavailable")).toBe(false)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
})

test("blocks an excluded combo before trying its members", async () => {
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "expensive-combo", name: "Expensive combo", members: ["codex/gpt-5"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })), createdAt: new Date().toISOString() }])
  mocks.assertUnlimitedModelsAllowed.mockRejectedValueOnce(new BudgetModelExcludedError("This model is excluded while Unlimited Mode is active."))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "expensive-combo", input: "hello" }),
  }))

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ error: { code: "model_excluded_in_unlimited_mode" } })
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

test("skips an excluded combo member and tries the next model", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue([
    { id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true, createdAt: new Date().toISOString() },
    { id: "b", providerId: "p", gatewayModelId: "p/b", name: "B", upstreamModel: "b", enabled: true, createdAt: new Date().toISOString() },
  ])
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "coding-fallback", name: "Coding fallback", members: ["p/a", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })), createdAt: new Date().toISOString() }])
  mocks.getBudgetRequestState.mockRejectedValueOnce(new BudgetModelExcludedError("This model is excluded while Unlimited Mode is active.")).mockResolvedValueOnce({ admission: undefined, usageContext: undefined })
  spyOn(fetchTarget, "fetch").mockImplementation(mock().mockResolvedValue(Response.json({ id: "response-from-b" })))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "coding-fallback", messages: [{ role: "user", content: "hello" }] }),
  }))

  expect(response.status).toBe(200)
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

  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body)) as Record<string, unknown>
  expect(forwarded.reasoning_effort).toBeUndefined()
  expect(forwarded.reasoning).toEqual({ effort: "high" })
  expect(forwarded.max_output_tokens).toBe(123)
  expect(forwarded.max_tokens).toBeUndefined()
})

test("strips Expect before forwarding a provider request", async () => {
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json", expect: "100-continue" },
    body: JSON.stringify({ model: "codex/gpt-5", input: "hello" }),
  }))
  await response.text()

  const forwardedHeaders = new Headers((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.headers)
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

  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body)) as Record<string, unknown>
  expect(forwarded.model).toBe("gpt-5")
})

test("routes non-Codex models directly to the configured upstream model", async () => {
  const provider = { id: "provider-a", name: "Bynara", prefix: "bynara", protocol: "openai-chat", authType: "none", enabled: true }
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

  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body)) as Record<string, unknown>
  expect(forwarded.model).toBe("upstream-a")
})

test("forwards external Responses providers directly and preserves xhigh", async () => {
  const provider = { id: "provider-a", name: "Halotec", prefix: "ht", baseUrl: "https://api.example.test/v1/", protocol: "openai-responses", authType: "bearer", headers: { "x-tenant": "rawroute" }, enabled: true }
  mocks.listProviders.mockResolvedValue([provider])
  mocks.listProviderApiKeys.mockResolvedValue([{ id: "key-a", key: "provider-secret", enabled: true, priority: 1, createdAt: "2026-01-01T00:00:00.000Z" }])
  mocks.listModels.mockResolvedValue([{ id: "model-a", providerId: provider.id, gatewayModelId: "ht/gpt-5.6-luna", name: "Luna", upstreamModel: "gpt-5.6-luna", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" }])

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "ht/gpt-5.6-luna", input: [{ role: "user", content: "hello" }], reasoning: { effort: "xhigh", summary: "auto" }, include: ["reasoning.encrypted_content"], stream: false }),
  }))
  await response.text()

  const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]
  expect(String(call[0])).toBe("https://api.example.test/v1/responses")
  const forwarded = JSON.parse(String(call[1]?.body)) as Record<string, unknown>
  expect(forwarded).toMatchObject({ model: "gpt-5.6-luna", reasoning: { effort: "xhigh", summary: "auto" }, include: ["reasoning.encrypted_content"] })
  expect(forwarded).not.toHaveProperty("reasoning_effort")
  expect(mocks.recordLog).toHaveBeenCalledWith("gateway.request.started", expect.objectContaining({ model: "ht/gpt-5.6-luna", reasoningEffort: "xhigh", messageCount: 1 }))
})

test("translates Chat ingress once before calling a Responses provider", async () => {
  const provider = { id: "provider-a", name: "Responses", prefix: "r", baseUrl: "https://api.example.test", protocol: "openai-responses", authType: "none", headers: {}, enabled: true }
  mocks.listProviders.mockResolvedValue([provider])
  mocks.listModels.mockResolvedValue([{ id: "model-a", providerId: provider.id, gatewayModelId: "r/model-a", name: "A", upstreamModel: "model-a", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" }])
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "r/model-a", messages: [{ role: "user", content: "hello" }], reasoning_effort: "xhigh" }) }))
  await response.text()
  const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]
  expect(String(call[0])).toBe("https://api.example.test/v1/responses")
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ model: "model-a", input: [{ role: "user", content: "hello" }], reasoning: { effort: "xhigh" } })
})

test("streams native Responses SSE while collecting terminal usage", async () => {
  const provider = { id: "provider-a", name: "Responses", prefix: "r", baseUrl: "https://api.example.test/v1", protocol: "openai-responses", authType: "none", headers: {}, enabled: true }
  mocks.listProviders.mockResolvedValue([provider])
  mocks.listModels.mockResolvedValue([{ id: "model-a", providerId: provider.id, gatewayModelId: "r/model-a", name: "A", upstreamModel: "model-a", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ reasoning: { effort: "xhigh" }, stream: true })
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'))
        controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n'))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } })
  }))

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "r/model-a", input: "hello", reasoning_effort: "xhigh", stream: true }),
  }))
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain("response.output_text.delta")
  while (!(await reader.read()).done) {}
  await drainBackgroundTasks()
  expect(mocks.createGatewayUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ metrics: { input: 3, output: 1 }, status: 200, reasoningEffort: "xhigh", requestedModel: "r/model-a", requestId: expect.any(String), attemptIndex: 0, requestFinal: true }), undefined)
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

  const events = mocks.recordLog.mock.calls.map((call) => call[0])
  expect(events).toContain("gateway.request.started")
  expect(mocks.recordLog).toHaveBeenCalledWith("gateway.request.started", expect.objectContaining({ model: "nara/grok-4.5", protocol: "anthropic-messages", upstreamProtocol: "openai-chat" }))
})

test("routes every supported client/provider protocol direction", async () => {
  const cases = [
    { name: "openai-responses to openai-chat", providerProtocol: "openai-chat" as const, path: "/v1/responses", body: { model: "bynara/model-a", input: "hello" } },
    { name: "openai-chat to openai-responses", providerProtocol: "openai-responses" as const, path: "/v1/chat/completions", body: { model: "bynara/model-a", messages: [{ role: "user", content: "hello" }] } },
    { name: "openai-responses to anthropic-messages", providerProtocol: "anthropic-messages" as const, path: "/v1/responses", body: { model: "bynara/model-a", input: "hello" } },
    { name: "anthropic-messages to openai-responses", providerProtocol: "openai-responses" as const, path: "/v1/messages", body: { model: "bynara/model-a", max_tokens: 32, messages: [{ role: "user", content: "hello" }] } },
    { name: "openai-chat to anthropic-messages", providerProtocol: "anthropic-messages" as const, path: "/v1/chat/completions", body: { model: "bynara/model-a", messages: [{ role: "user", content: "hello" }] } },
    { name: "anthropic-messages to openai-chat", providerProtocol: "openai-chat" as const, path: "/v1/messages", body: { model: "bynara/model-a", max_tokens: 32, messages: [{ role: "user", content: "hello" }] } },
  ]

  for (const scenario of cases) {
    mock.clearAllMocks()
    const provider = { id: "provider-a", name: "Bynara", prefix: "bynara", baseUrl: "https://api.example.test/v1", protocol: scenario.providerProtocol, authType: "none", headers: {}, enabled: true }
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
    const fetchMock = mock(async () => {
      if (scenario.providerProtocol === "openai-chat") return Response.json({ id: "chat-1", object: "chat.completion", created: 1, model: "upstream-a", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      if (scenario.providerProtocol === "openai-responses") return Response.json({ id: "resp-1", object: "response", created_at: 1, status: "completed", model: "upstream-a", output: [{ id: "msg-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
      return Response.json({ id: "msg-1", type: "message", role: "assistant", model: "upstream-a", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    })
    spyOn(fetchTarget, "fetch").mockImplementation(fetchMock)

    const response = await proxyGatewayRequest(new Request(`http://gateway${scenario.path}`, {
      method: "POST",
      headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
      body: JSON.stringify(scenario.body),
    }))

    expect(response.status, scenario.name).toBe(200)
    await response.text()
    const fetchCalls = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls
    expect(String(fetchCalls[0]?.[0]), scenario.name).toContain(scenario.providerProtocol === "openai-responses" ? "/v1/responses" : scenario.providerProtocol === "anthropic-messages" ? "/v1/messages" : "/v1/chat/completions")
    const forwarded = JSON.parse(String(fetchCalls[0]?.[1]?.body)) as Record<string, unknown>
    expect(forwarded.model, scenario.name).toBe("upstream-a")
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

test("rejects unsupported cross-protocol Responses continuation before budget admission or upstream I/O", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", authType: "none", enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "a", providerId: "p", gatewayModelId: "p/a", name: "A", upstreamModel: "a", enabled: true }])
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "p/a", previous_response_id: "prior", input: "follow up" }),
  }))
  expect(response.status).toBe(400)
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(mocks.getBudgetRequestState).not.toHaveBeenCalled()
})

test("rejects JSON-object response mode for Anthropic before budget reservation or upstream I/O", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "anthropic", name: "Anthropic", prefix: "a", baseUrl: "https://anthropic.test", protocol: "anthropic-messages", authType: "none", enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "a-model", providerId: "anthropic", gatewayModelId: "a/model", name: "Model", upstreamModel: "model", enabled: true }])
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "a/model", messages: [{ role: "user", content: "hello" }], response_format: { type: "json_object" } }),
  }))
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: "unsupported_protocol_conversion" } })
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(mocks.getBudgetRequestState).not.toHaveBeenCalled()
  expect(mocks.reserveBudgetAdmission).not.toHaveBeenCalled()
})

test("rejects unsupported Responses allowed-tool entries before budget reservation or upstream I/O", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", baseUrl: "https://provider.test/v1", protocol: "openai-chat", authType: "none", enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "m", providerId: "p", gatewayModelId: "p/model", name: "Model", upstreamModel: "model", enabled: true }])
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "p/model",
      input: "hello",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "mcp", server_label: "docs" }] },
    }),
  }))
  expect(response.status).toBe(400)
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(mocks.getBudgetRequestState).not.toHaveBeenCalled()
  expect(mocks.reserveBudgetAdmission).not.toHaveBeenCalled()
})

test("preserves an Anthropic rate-limit classification and Retry-After across Chat conversion", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "anthropic", name: "Anthropic", prefix: "a", baseUrl: "https://anthropic.test", protocol: "anthropic-messages", authType: "none", enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "a-model", providerId: "anthropic", gatewayModelId: "a/model", name: "Model", upstreamModel: "model", enabled: true }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Please wait before trying again." } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "8" },
  })))
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "a/model", messages: [{ role: "user", content: "hello" }] }),
  }))
  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("8")
  await expect(response.json()).resolves.toMatchObject({ error: { type: "rate_limit_error", message: "Please wait before trying again." } })
})

function chatUpstreamUsageStream() {
  return [
    'data: {"id":"chat-usage","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    'data: {"id":"chat-usage","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"chat-usage","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":3,"cache_write_tokens":2}}}\n\n',
    "data: [DONE]\n\n",
  ].join("")
}

test("requests upstream Chat usage for settlement without exposing an unsolicited Chat usage chunk", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", baseUrl: "https://provider.test/v1", protocol: "openai-chat", authType: "none", headers: {}, enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "m", providerId: "p", gatewayModelId: "p/model", name: "Model", upstreamModel: "upstream-chat", enabled: true }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async (_url, init) => {
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(sent.stream_options).toMatchObject({ include_usage: true })
    return new Response(chatUpstreamUsageStream(), { headers: { "content-type": "text/event-stream" } })
  }))
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "p/model", messages: [{ role: "user", content: "hello" }], stream: true }),
  }))
  expect(response.status).toBe(200)
  const clientStream = await response.text()
  await drainBackgroundTasks()
  expect(clientStream).toContain("ok")
  expect(clientStream).not.toContain('"usage":')
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ metrics: { input: 10, output: 2, cached: 3, cacheCreation: 2 }, status: 200 })
})

test("requests upstream Chat usage and returns usage in a Responses completion", async () => {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", baseUrl: "https://provider.test/v1", protocol: "openai-chat", authType: "none", headers: {}, enabled: true }])
  mocks.listModels.mockResolvedValue([{ id: "m", providerId: "p", gatewayModelId: "p/model", name: "Model", upstreamModel: "upstream-chat", enabled: true }])
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream_options: { include_usage: true } })
    return new Response(chatUpstreamUsageStream(), { headers: { "content-type": "text/event-stream" } })
  }))
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "p/model", input: "hello", stream: true }),
  }))
  expect(response.status).toBe(200)
  const clientStream = await response.text()
  await drainBackgroundTasks()
  expect(clientStream).toContain("response.completed")
  expect(clientStream).toContain('"cached_tokens":3')
  expect(mocks.createGatewayUsageEvent.mock.calls.at(-1)?.[0]).toMatchObject({ metrics: { input: 10, output: 2, cached: 3, cacheCreation: 2 }, status: 200 })
})

test("does not claim wildcard Gemini or Codex proxy coverage", async () => {
  for (const path of ["/v1beta/models/gemini:generateContent", "/backend-api/codex/anything-else"]) {
    const response = await proxyGatewayRequest(new Request(`http://gateway${path}`, {
      method: "POST",
      headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "p/a", contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
    }))
    expect(response.status).toBe(404)
  }
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(mocks.getBudgetRequestState).not.toHaveBeenCalled()
})

function budgetComboFixture() {
  mocks.listProviders.mockResolvedValue([{ id: "p", name: "Provider", prefix: "p", protocol: "openai-chat", enabled: true }])
  mocks.listModels.mockResolvedValue(["a", "b"].map((id) => ({ id, providerId: "p", gatewayModelId: `p/${id}`, name: id, upstreamModel: id, enabled: true, createdAt: new Date().toISOString() })))
  mocks.listCombos.mockResolvedValue([{ id: "combo-1", combo: "budget-fallback", name: "Budget fallback", members: ["p/a", "p/b"].map(modelId => ({ modelId })), createdAt: new Date().toISOString() }])
  return new Request("http://gateway/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "budget-fallback", messages: [{ role: "user", content: "hello" }] }) })
}

test("falls back after a member budget denial and retains the requested combo for admission", async () => {
  const request = budgetComboFixture()
  mocks.getBudgetRequestState.mockRejectedValueOnce(new BudgetDeniedError("Weekly budget exceeded.", 60))
  const response = await proxyGatewayRequest(request)
  expect(response.status).toBe(200)
  expect(mocks.getBudgetRequestState).toHaveBeenCalledTimes(2)
  expect(mocks.getBudgetRequestState.mock.calls.map((call) => [call[1], call[6]])).toEqual([["p/a", "budget-fallback"], ["p/b", "budget-fallback"]])
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body)).model).toBe("b")
  expect(response.headers.has("x-rawroute-combo-member-unavailable")).toBe(false)
})

test("all budget-denied combo members return the budget error without calling upstream", async () => {
  const request = budgetComboFixture()
  mocks.getBudgetRequestState.mockRejectedValue(new BudgetDeniedError("Weekly budget exceeded.", 60))
  const response = await proxyGatewayRequest(request)
  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("60")
  expect(response.headers.has("x-rawroute-combo-member-unavailable")).toBe(false)
  expect(response.headers.has("x-rawroute-combo-terminal")).toBe(false)
  expect(globalThis.fetch).not.toHaveBeenCalled()
  // Restore the default implementation for subsequent tests.
  mocks.getBudgetRequestState.mockResolvedValue({ admission: undefined, usageContext: undefined })
})
