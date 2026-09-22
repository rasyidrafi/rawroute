import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authenticateProxyKey: vi.fn(),
  writeLog: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authenticateProxyKey: mocks.authenticateProxyKey }))
vi.mock("@/lib/logger", () => ({ writeLog: mocks.writeLog }))

import { executorPathFromRequest, getToolGatewayStatus, proxyExecutorRequest } from "@/lib/executor"

const originalFetch = globalThis.fetch
const originalUpstream = process.env.EXECUTOR_UPSTREAM_URL
const originalApiKey = process.env.EXECUTOR_UPSTREAM_API_KEY

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://rawroute.test${path}`, init)
}

function fetchCalls() {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.EXECUTOR_UPSTREAM_URL = "http://executor:4788"
  process.env.EXECUTOR_UPSTREAM_API_KEY = "executor-secret"
  mocks.authenticateProxyKey.mockResolvedValue({
    workspace: { id: "default", status: "active" },
    apiKey: { id: "gateway-key", name: "Gateway" },
  })
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalUpstream === undefined) delete process.env.EXECUTOR_UPSTREAM_URL
  else process.env.EXECUTOR_UPSTREAM_URL = originalUpstream
  if (originalApiKey === undefined) delete process.env.EXECUTOR_UPSTREAM_API_KEY
  else process.env.EXECUTOR_UPSTREAM_API_KEY = originalApiKey
})

describe("Executor HTTP proxy", () => {
  test("reports the integration as disabled when no upstream credential is configured", async () => {
    delete process.env.EXECUTOR_UPSTREAM_API_KEY

    await expect(getToolGatewayStatus()).resolves.toEqual({ state: "disabled" })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("reports Executor as available after a successful health check", async () => {
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch

    await expect(getToolGatewayStatus()).resolves.toEqual({ state: "available" })
    const [url, init] = fetchCalls()[0] || []
    expect(String(url)).toBe("http://executor:4788/api/health")
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bearer executor-secret")
  })

  test("reports Executor as unavailable for failed health checks", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ status: "degraded" }, { status: 503 })) as typeof fetch

    await expect(getToolGatewayStatus()).resolves.toEqual({ state: "unavailable" })
  })

  test("authenticates before forwarding a GET and preserves the query string", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ tools: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch

    const response = await proxyExecutorRequest(request(
      "/executor/api/tools/schema?address=https%3A%2F%2Fexample.test%2Fopenapi.json&address=second",
      { headers: { authorization: "Bearer client-key", "x-request-id": "req-123" } },
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ tools: [] })
    expect(mocks.authenticateProxyKey).toHaveBeenCalledTimes(1)
    expect(String(fetchCalls()[0]?.[0])).toBe(
      "http://executor:4788/api/tools/schema?address=https%3A%2F%2Fexample.test%2Fopenapi.json&address=second",
    )
  })

  test("replaces client credentials and strips sensitive headers", async () => {
    const response = await proxyExecutorRequest(request("/executor/api/tools", {
      method: "POST",
      headers: {
        authorization: "Bearer client-key",
        cookie: "session=secret",
        "x-api-key": "client-key",
        "x-management-key": "management-secret",
        "x-rawroute-workspace-id": "other-workspace",
        "x-workspace-id": "other-workspace",
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "rawroute-test",
        "x-request-id": "req-456",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      body: JSON.stringify({ address: "https://example.test" }),
    }))

    expect(response.status).toBe(200)
    const init = fetchCalls()[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get("authorization")).toBe("Bearer executor-secret")
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("x-api-key")).toBeNull()
    expect(headers.get("x-management-key")).toBeNull()
    expect(headers.get("x-rawroute-workspace-id")).toBeNull()
    expect(headers.get("x-workspace-id")).toBeNull()
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("user-agent")).toBe("rawroute-test")
    expect(headers.get("x-request-id")).toBe("req-456")
    expect(headers.get("traceparent")).toContain("00-4bf92f")
    await expect(new Response(init.body).json()).resolves.toEqual({ address: "https://example.test" })
  })

  test.each(["PATCH", "DELETE"]) ("preserves %s request methods and bodies", async (method) => {
    const body = JSON.stringify({ id: "tool-1", enabled: false })
    await proxyExecutorRequest(request("/executor/api/tools/tool-1", {
      method,
      headers: { "content-type": "application/json" },
      body,
    }))

    const call = fetchCalls()[0]
    const init = call?.[1] as RequestInit
    expect(init.method).toBe(method)
    await expect(new Response(init.body).text()).resolves.toBe(body)
  })

  test("passes through upstream status, content type, and body unchanged", async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"error":"denied"}', {
      status: 403,
      headers: { "content-type": "application/problem+json", "x-upstream": "executor" },
    })) as typeof fetch

    const response = await proxyExecutorRequest(request("/executor/api/executions", { method: "POST", body: "{}" }))

    expect(response.status).toBe(403)
    expect(response.headers.get("content-type")).toBe("application/problem+json")
    expect(response.headers.get("x-upstream")).toBe("executor")
    await expect(response.text()).resolves.toBe('{"error":"denied"}')
  })

  test.each([401, 403, 429, 500])("passes through upstream HTTP error %s", async (status) => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: { status } }, { status })) as typeof fetch
    const response = await proxyExecutorRequest(request("/executor/api/tools"))
    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error: { status } })
  })

  test("returns a stable 502 when Executor is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("connect failed") }) as typeof fetch

    const response = await proxyExecutorRequest(request("/executor/api/tools", {
      headers: { authorization: "Bearer client-key", "x-request-id": "req-down" },
    }))

    expect(response.status).toBe(502)
    expect(response.headers.get("x-request-id")).toBe("req-down")
    await expect(response.json()).resolves.toEqual({
      error: { code: "executor_unavailable", message: "Executor is unavailable." },
    })
    expect(JSON.stringify(mocks.writeLog.mock.calls)).not.toContain("executor-secret")
  })

  test("returns the upstream stream without buffering it", async () => {
    let releaseSecond: (() => void) | undefined
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first\n"))
        void new Promise<void>((resolve) => { releaseSecond = resolve }).then(() => {
          controller.enqueue(new TextEncoder().encode("second\n"))
          controller.close()
        })
      },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch

    const response = await proxyExecutorRequest(request("/executor/api/executions"))
    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toMatchObject({ done: false })
    releaseSecond?.()
    await expect(reader.read()).resolves.toMatchObject({ done: false })
    await expect(reader.read()).resolves.toMatchObject({ done: true })
  })

  test("rejects traversal and malformed paths before contacting Executor", async () => {
    for (const path of [
      "/executor/api/%2e%2e/secrets",
      "/executor/api/%ZZ",
      "/executor/api//tools",
      "/executor/api/auth/sign-in/email",
    ]) {
      const response = await proxyExecutorRequest(request(path))
      expect(response.status, path).toBe(400)
      expect(executorPathFromRequest(request(path)), path).toBeUndefined()
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("returns a stable error when Executor configuration is missing", async () => {
    delete process.env.EXECUTOR_UPSTREAM_API_KEY

    const response = await proxyExecutorRequest(request("/executor/api/tools"))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: { code: "executor_not_configured", message: "Executor integration is not configured." },
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("does not proxy an unauthenticated request", async () => {
    mocks.authenticateProxyKey.mockResolvedValue(undefined)

    const response = await proxyExecutorRequest(request("/executor/api/tools", {
      headers: { authorization: "Bearer invalid" },
    }))

    expect(response.status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
