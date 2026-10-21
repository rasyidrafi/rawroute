import { afterEach, beforeEach, expect, test, mock, spyOn } from "bun:test"

const fetchTarget: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis

const mocks = {
  authenticateProxyKey: mock(),
  getBudgetRequestState: mock(),
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
  ensureNonCodexProviderProjection: mock(),
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
  recordUsageEvent: mocks.recordUsageEvent,
  releaseBudgetReservation: mocks.releaseBudgetReservation,
  reserveBudgetAdmission: mocks.reserveBudgetAdmission,
}))
mock.module("../../../packages/gateway-ai/src/server/codex/cliproxy", () => ({ codexWorkspacePrefix: (workspaceId: string) => `rr-codex-${workspaceId}` }))
mock.module("../../../packages/gateway-ai/src/server/cliproxy/provider-sync", () => ({
  ensureNonCodexProviderProjection: mocks.ensureNonCodexProviderProjection,
  nonCodexProviderPrefix: (workspaceId: string, providerId: string) => `rr-ws-${workspaceId}-p-${providerId}`,
}))
mock.module("../../../packages/gateway-ai/src/server/logging", () => ({ recordLog: mocks.recordLog }))
mock.module("../../../packages/gateway-ai/src/server/codex/model-refresh", () => ({ scheduleCodexModelRefresh: mock() }))
mock.module("../../../packages/gateway-ai/src/server/store", () => ({
  isMemoryBackend: () => true,
  listAliases: mocks.listAliases,
  listCombos: mocks.listCombos,
  listModels: mocks.listModels,
  listProviders: mocks.listProviders,
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
const { collectStreamUsage, isTerminalStreamEvent, proxyGatewayRequest, sharedUsageEventCopies, testComboMemberPolicy } = await import("../../../packages/gateway-ai/src/server/cliproxy/gateway")
const { drainBackgroundTasks } = await import("../../../packages/platform/src/server/background-tasks")

beforeEach(() => {
  process.env.CLIPROXY_MODE = "external"
  mock.clearAllMocks()
  mocks.authenticateProxyKey.mockResolvedValue({
    workspace: { id: "default", storageMode: "scoped" },
    apiKey: { id: "gateway-key", name: "Gateway" },
  })
  mocks.getBudgetRequestState.mockResolvedValue({ admission: undefined, usageContext: undefined })
  mocks.assertUnlimitedModelsAllowed.mockResolvedValue(undefined)
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
  mocks.listProviderApiKeys.mockResolvedValue([])
  spyOn(fetchTarget, "fetch").mockImplementation(mock(async () => Response.json({ id: "response-1" })))
})

afterEach(async () => {
  await drainBackgroundTasks()
  mock.restore()
})

test("advertises and routes a discovered model unknown to the bundled catalog", async () => {
  mocks.listModels.mockResolvedValue([{ id: "discovered", providerId: "codex", gatewayModelId: "codex/future-model", upstreamModel: "future-model", name: "Future", source: "discovered", enabled: true, createdAt: new Date().toISOString() }])
  const catalog = await proxyGatewayRequest(new Request("http://gateway/v1/models", { headers: { authorization: "Bearer gateway-secret" } }))
  expect((await catalog.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: "codex/future-model" })]))
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", { method: "POST", headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "codex/future-model", input: "Hello" }) }))
  expect(response.status).toBe(200)
  const calls = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls
  expect(calls.some((call) => call[1]?.body && JSON.parse(String(call[1].body)).model === "rr-codex-default/future-model")).toBe(true)
})

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
  expect(forwardedModels).toEqual(["rr-ws-default-p-p/a", "rr-ws-default-p-p/b"])
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
  expect(forwarded).toMatchObject({ model: "rr-ws-default-p-p/a", reasoning_effort: "max" })
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
  expect(forwarded).toMatchObject({ model: "rr-ws-default-p-p/a", temperature: 0.2, response_format: { type: "json_schema", json_schema: { name: "answer" } } })
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

test("treats CLIProxy model cooldown as an immediate fallback signal", async () => {
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

test("strips Expect before forwarding a request to CLIProxy", async () => {
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
  const forwarded = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body)) as Record<string, unknown>
  expect(forwarded.model).toBe("rr-ws-default-p-provider-a/model-a")
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

  expect(mocks.ensureNonCodexProviderProjection).not.toHaveBeenCalled()
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
    const provider = { id: "provider-a", name: "Bynara", prefix: "bynara", baseUrl: "https://api.example.test/v1", protocol: scenario.providerProtocol, authType: scenario.providerProtocol === "openai-responses" ? "none" : "bearer", headers: {}, enabled: true }
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
    const fetchMock = mock(async () => Response.json({ id: "response-1" }))
    spyOn(fetchTarget, "fetch").mockImplementation(fetchMock)

    const response = await proxyGatewayRequest(new Request(`http://gateway${scenario.path}`, {
      method: "POST",
      headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
      body: JSON.stringify(scenario.body),
    }))

    expect(response.status, scenario.name).toBe(200)
    await response.text()
    if (scenario.providerProtocol === "openai-responses") expect(mocks.ensureNonCodexProviderProjection, scenario.name).not.toHaveBeenCalled()
    else expect(mocks.ensureNonCodexProviderProjection, scenario.name).toHaveBeenCalledWith(provider.id)
    const fetchCalls = (fetchMock as unknown as ReturnType<typeof mock>).mock.calls
    expect(String(fetchCalls[0]?.[0]), scenario.name).toContain(scenario.providerProtocol === "openai-responses" ? "/v1/responses" : scenario.path)
    const forwarded = JSON.parse(String(fetchCalls[0]?.[1]?.body)) as Record<string, unknown>
    expect(forwarded.model, scenario.name).toBe(scenario.providerProtocol === "openai-responses" ? "upstream-a" : "rr-ws-default-p-provider-a/model-a")
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
  expect(JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]?.[1]?.body)).model).toBe("rr-ws-default-p-p/b")
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
