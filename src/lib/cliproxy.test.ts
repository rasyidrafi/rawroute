import { afterEach, beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authenticateProxyKey: vi.fn(),
  getBudgetRequestState: vi.fn(),
  reserveBudgetAdmission: vi.fn(),
  releaseBudgetReservation: vi.fn(),
  createGatewayUsageEvent: vi.fn(),
  recordUsageEvent: vi.fn(),
  listAliases: vi.fn(),
  listModels: vi.fn(),
  listProviders: vi.fn(),
  writeLog: vi.fn(),
}))

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
vi.mock("@/lib/logger", () => ({ writeLog: mocks.writeLog }))
vi.mock("@/lib/store", () => ({
  listAliases: mocks.listAliases,
  listModels: mocks.listModels,
  listProviders: mocks.listProviders,
}))
vi.mock("@/lib/workspace-context", () => ({
  currentWorkspaceId: () => "default",
  runInWorkspace: (_workspace: unknown, callback: () => unknown) => callback(),
}))

import { BudgetDeniedError } from "@/lib/analytics"
import { proxyGatewayRequest } from "@/lib/cliproxy"

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticateProxyKey.mockResolvedValue({
    workspace: { id: "default", storageMode: "scoped" },
    apiKey: { id: "gateway-key", name: "Gateway" },
  })
  mocks.getBudgetRequestState.mockResolvedValue({ admission: undefined, usageContext: undefined })
  mocks.reserveBudgetAdmission.mockResolvedValue(undefined)
  mocks.releaseBudgetReservation.mockResolvedValue(undefined)
  mocks.createGatewayUsageEvent.mockResolvedValue({ id: "usage-event" })
  mocks.recordUsageEvent.mockResolvedValue(undefined)
  mocks.listAliases.mockResolvedValue([])
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
  expect(messages).toContain("POST PROVIDER:Codex MODEL:codex/gpt-5 -> gpt-5 FMT:openai-responses ACC:Gateway THINK:low MSG:2 TOOL:2")
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
