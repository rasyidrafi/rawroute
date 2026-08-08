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
  listCliProxyCatalog: vi.fn(),
  writeLog: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authenticateProxyKey: mocks.authenticateProxyKey }))
vi.mock("@/lib/analytics", () => ({
  BudgetDeniedError: class BudgetDeniedError extends Error {
    status = 429
    retryAfterSeconds = 1
  },
  createGatewayUsageEvent: mocks.createGatewayUsageEvent,
  getBudgetRequestState: mocks.getBudgetRequestState,
  recordUsageEvent: mocks.recordUsageEvent,
  releaseBudgetReservation: mocks.releaseBudgetReservation,
  reserveBudgetAdmission: mocks.reserveBudgetAdmission,
}))
vi.mock("@/lib/cliproxy-catalog", () => ({ listCliProxyCatalog: mocks.listCliProxyCatalog }))
vi.mock("@/lib/logger", () => ({ writeLog: mocks.writeLog }))
vi.mock("@/lib/store", () => ({
  listAliases: mocks.listAliases,
  listModels: mocks.listModels,
  listProviders: mocks.listProviders,
}))
vi.mock("@/lib/workspace-context", () => ({ runInWorkspace: (_workspace: unknown, callback: () => unknown) => callback() }))

import { proxyGatewayRequest } from "@/lib/cliproxy"

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticateProxyKey.mockResolvedValue({
    workspace: { id: "default", storageMode: "legacy" },
    apiKey: { id: "gateway-key", name: "Gateway" },
  })
  mocks.getBudgetRequestState.mockResolvedValue({ admission: undefined, usageContext: undefined })
  mocks.reserveBudgetAdmission.mockResolvedValue(undefined)
  mocks.releaseBudgetReservation.mockResolvedValue(undefined)
  mocks.createGatewayUsageEvent.mockResolvedValue({ id: "usage-event" })
  mocks.recordUsageEvent.mockResolvedValue(undefined)
  mocks.listAliases.mockResolvedValue([])
  mocks.listModels.mockResolvedValue([{
    id: "cx/codex",
    providerId: "cx",
    gatewayModelId: "cx/codex",
    name: "Codex",
    upstreamModel: "gpt-upstream",
    enabled: true,
    createdAt: new Date().toISOString(),
  }])
  mocks.listProviders.mockResolvedValue([{ id: "cx", name: "Codex", enabled: true }])
  mocks.listCliProxyCatalog.mockResolvedValue({ providers: [], models: [] })
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
      model: "cx/codex",
      input: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }],
      tools: [{ type: "function", name: "first" }, { type: "function", name: "second" }],
      reasoning: { effort: "low" },
    }),
  }))
  await response.text()

  const messages = mocks.writeLog.mock.calls.map((call) => call[2])
  expect(messages).toContain("POST PROVIDER:Codex MODEL:cx/codex -> gpt-upstream FMT:openai-responses ACC:Gateway THINK:low MSG:2 TOOL:2")
  expect(messages.some((message) => typeof message === "string" && /^DONE \d+ms/.test(message))).toBe(true)
})

test("logs invalid gateway authentication failures", async () => {
  mocks.authenticateProxyKey.mockResolvedValue(undefined)

  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer invalid", "content-type": "application/json" },
    body: JSON.stringify({ model: "cx/codex", input: "hello" }),
  }))

  expect(response.status).toBe(401)
  expect(mocks.writeLog).toHaveBeenCalledWith("warn", "gateway", "Request rejected: invalid API key", { protocol: "openai-responses" })
})

test("normalizes legacy reasoning_effort before forwarding Responses requests", async () => {
  const response = await proxyGatewayRequest(new Request("http://gateway/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "cx/codex",
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
