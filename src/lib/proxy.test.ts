import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { proxyRequest } from "@/lib/proxy"
import { clearLogs, readLogs } from "@/lib/logger"
import { updateData } from "@/lib/store"

const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch })

beforeEach(async () => {
  process.env.STORAGE_BACKEND = "memory"
  await updateData((data) => {
    data.apiKeys = [{ id: "key", name: "Test", key: "sk-test", createdAt: new Date().toISOString() }]
    data.providers = [{
      id: "cx", name: "Codex", prefix: "cx", baseUrl: "https://upstream.example/v1",
      protocol: "openai-responses", authType: "bearer",
      headers: { "x-static": "yes" }, enabled: true, createdAt: new Date().toISOString(),
    }]
    data.providerApiKeys = [{
      id: "provider-key", providerId: "cx", name: "Primary", key: "provider-secret",
      enabled: true, createdAt: new Date().toISOString(),
    }]
    data.models = [{
      id: "cx/codex", providerId: "cx", name: "codex", upstreamModel: "gpt-upstream",
      enabled: true, createdAt: new Date().toISOString(),
    }]
  })
})

describe("proxy request", () => {
  test("rewrites only the model field and pipes the upstream response", async () => {
    let captured: { url?: string; body?: Record<string, unknown>; headers?: Headers } = {}
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: input.toString(),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      }
      return new Response("event: done\ndata: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "evil=true" } })
    }) as typeof fetch

    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json", cookie: "rawroute_session=secret" },
      body: JSON.stringify({ model: "cx/codex", input: "hello", stream: true, custom: { untouched: true } }),
    }), "openai-responses")

    expect(captured.url).toBe("https://upstream.example/v1/responses")
    expect(captured.body).toEqual({ model: "gpt-upstream", input: "hello", stream: true, custom: { untouched: true } })
    expect(captured.headers?.get("authorization")).toBe("Bearer provider-secret")
    expect(captured.headers?.get("x-static")).toBe("yes")
    expect(captured.headers?.get("cookie")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("x-rawroute-provider-key")).toBe("provider-key")
    expect(await response.text()).toBe("event: done\ndata: ok\n\n")
  })

  test("returns 503 without contacting upstream when an authenticated provider has no enabled API keys", async () => {
    await updateData((data) => { data.providerApiKeys = [] })
    const upstream = mock(() => Promise.resolve(new Response()))
    globalThis.fetch = upstream as typeof fetch

    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello" }),
    }), "openai-responses")

    expect(response.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  test("rejects the wrong native endpoint before calling upstream", async () => {
    const upstream = mock(() => Promise.resolve(new Response()))
    globalThis.fetch = upstream as typeof fetch
    const response = await proxyRequest(new Request("http://gateway/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", messages: [] }),
    }), "openai-chat")
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  test("deep merges configured model request overrides before proxying", async () => {
    clearLogs()
    await updateData((data) => {
      const model = data.models.find((entry) => entry.id === "cx/codex")
      if (model) model.requestOverrides = { reasoning: { effort: "none" }, temperature: 0 }
    })
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello", reasoning: { effort: "high", summary: "auto" }, temperature: 1 }),
    }), "openai-responses")

    expect(capturedBody).toEqual({ model: "gpt-upstream", input: "hello", reasoning: { effort: "none", summary: "auto" }, temperature: 0 })
    expect(readLogs()[0]?.details?.reasoningEffort).toBe("none")
    await updateData((data) => {
      const model = data.models.find((entry) => entry.id === "cx/codex")
      if (model) delete model.requestOverrides
    })
  })

  test("returns a controlled error for a legacy malformed provider header", async () => {
    await updateData((data) => {
      const provider = data.providers.find((entry) => entry.id === "cx")
      if (provider) provider.headers = { "bad header": "value" }
    })
    const upstream = mock(() => Promise.resolve(new Response()))
    globalThis.fetch = upstream as typeof fetch
    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello" }),
    }), "openai-responses")
    expect(response.status).toBe(502)
    expect(upstream).not.toHaveBeenCalled()
  })

  test("rejects a declared body larger than the configured maximum", async () => {
    process.env.MAX_PROXY_BODY_BYTES = "32"
    const upstream = mock(() => Promise.resolve(new Response()))
    globalThis.fetch = upstream as typeof fetch
    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json", "content-length": "33" },
      body: JSON.stringify({ model: "cx/codex" }),
    }), "openai-responses")
    expect(response.status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
    delete process.env.MAX_PROXY_BODY_BYTES
  })

  test("stops reading a streamed body after the configured maximum", async () => {
    process.env.MAX_PROXY_BODY_BYTES = "32"
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(33))); controller.close() } })
    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit), "openai-responses")
    expect(response.status).toBe(413)
    delete process.env.MAX_PROXY_BODY_BYTES
  })
})
