import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { proxyRequest } from "@/lib/proxy"
import { clearLogs, readLogs } from "@/lib/logger"
import { RedisRoutingStateStore, setRoutingStateStoreForTests, type RoutingRedis } from "@/lib/routing-state"
import { _resetMemoryBackend, readData, updateData } from "@/lib/store"

const originalFetch = globalThis.fetch

class ProxyTestRedis implements RoutingRedis {
  affinity = new Map<string, string>()
  responseMappings = new Map<string, string>()
  failBookkeeping = false

  async eval(script: string, keys: string[], args: Array<string | number>) {
    if (script.includes("local affinity")) {
      const hard = String(args[2]) === "1"
      const responseCredential = keys[1] ? this.responseMappings.get(keys[1]) : undefined
      if (hard && keys[1] && !responseCredential) return ["hard-missing"]
      const pinned = this.affinity.get(keys[0])
      const selected = responseCredential || pinned || testProviderKeyId || String(args[6] || "provider-key")
      this.affinity.set(keys[0], selected)
      return ["ok", selected, responseCredential || pinned ? "sticky" : "new"]
    }
    if (this.failBookkeeping) throw new Error("Redis unavailable")
    return ["ok"]
  }

  async get<T = string>(key: string) { return (this.responseMappings.get(key) as T | undefined) || null }
  async set(key: string, value: string) {
    if (this.failBookkeeping) throw new Error("Redis unavailable")
    this.responseMappings.set(key, value)
    return "OK"
  }
}

let testRedis: ProxyTestRedis
let testProviderKeyId = "provider-key"

afterEach(() => { globalThis.fetch = originalFetch; setRoutingStateStoreForTests(undefined) })

beforeEach(async () => {
  testRedis = new ProxyTestRedis()
  setRoutingStateStoreForTests(new RedisRoutingStateStore(testRedis, { prefix: "proxy-test" }))
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
  await updateData((data) => {
    data.apiKeys = [{ id: "key", name: "Test", key: "sk-test", createdAt: new Date().toISOString() }]
    data.providers = [{
      id: "cx", name: "Codex", prefix: "cx", baseUrl: "https://upstream.example/v1",
      protocol: "openai-responses", authType: "bearer",
      headers: { "x-static": "yes" }, enabled: true, createdAt: new Date().toISOString(),
      apiKeyCount: 0, enabledApiKeyCount: 0, modelCount: 0, enabledModelCount: 0,
    }]
    data.providerApiKeys = [{
      id: "provider-key", providerId: "cx", name: "Primary", key: "provider-secret",
      enabled: true, createdAt: new Date().toISOString(),
    }]
    data.models = [{
      id: "cx/codex", providerId: "cx", gatewayModelId: "cx/codex", name: "codex", upstreamModel: "gpt-upstream",
      enabled: true, createdAt: new Date().toISOString(),
    }]
  })
  testProviderKeyId = (await readData()).providerApiKeys[0]?.id || "provider-key"
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
    }) as unknown as typeof fetch

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
    expect(captured.headers?.get("x-rawroute-session-id")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("x-rawroute-provider-key")).toBe(testProviderKeyId)
    expect(await response.text()).toBe("event: done\ndata: ok\n\n")
    expect(readLogs().find((entry) => entry.message.startsWith("POST "))?.message).toMatch(/^POST PROVIDER:[^ ]+ MODEL:cx\/codex -> gpt-upstream FMT:openai-responses ACC:Primary MSG:1$/)
    expect(readLogs()[0]?.message).toMatch(/^DONE \d+ms TTFT:\d+ms$/)
  })

  test("forwards Codex OAuth requests as native Responses with account headers", async () => {
    await updateData((data) => {
      const provider = data.providers[0]
      if (!provider) throw new Error("provider missing")
      provider.baseUrl = "https://chatgpt.com/backend-api/codex"
      const providerApiKey = data.providerApiKeys[0]
      if (!providerApiKey) throw new Error("credential missing")
      Object.assign(providerApiKey, {
        credentialKind: "codex-oauth",
        key: "codex-access",
        refreshToken: "codex-refresh",
        accountId: "acct-1",
        email: "one@example.com",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
      data.models[0]!.upstreamModel = "gpt-5.4-codex"
    })
    let captured: { body?: Record<string, unknown>; headers?: Headers; url?: string } = {}
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: input.toString(), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) }
      return new Response("data: {\"type\":\"response.completed\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch
    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json", "x-rawroute-session-id": "session-a" },
      body: JSON.stringify({ model: "cx/codex", input: "hello", stream: false, temperature: 0.4 }),
    }), "openai-responses")
    expect(response.status).toBe(200)
    expect(captured.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(captured.body).toMatchObject({ model: "gpt-5.4-codex", stream: true, store: false, include: ["reasoning.encrypted_content"], instructions: "" })
    expect(captured.body?.temperature).toBeUndefined()
    expect(captured.headers?.get("authorization")).toBe("Bearer codex-access")
    expect(captured.headers?.get("chatgpt-account-id")).toBe("acct-1")
    expect(captured.headers?.get("originator")).toBe("codex_cli_rs")
  })

  test("refreshes a Codex account once and retries the same request after 401", async () => {
    await updateData((data) => {
      const provider = data.providers[0]!
      provider.baseUrl = "https://chatgpt.com/backend-api/codex"
      const account = data.providerApiKeys[0]!
      Object.assign(account, {
        credentialKind: "codex-oauth",
        key: "expired-access",
        refreshToken: "codex-refresh",
        accountId: "acct-1",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
    })
    let upstreamCalls = 0
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith("/oauth/token")) {
        expect(String(init?.body)).toContain("refresh_token=codex-refresh")
        return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }), { status: 200 })
      }
      upstreamCalls += 1
      if (upstreamCalls === 1) return new Response(JSON.stringify({ error: "expired" }), { status: 401, headers: { "content-type": "application/json" } })
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-access")
      return new Response("data: {\"type\":\"response.completed\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch
    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello", stream: true }),
    }), "openai-responses")
    expect(response.status).toBe(200)
    expect(upstreamCalls).toBe(2)
  })

  test("returns 503 without contacting upstream when an authenticated provider has no enabled API keys", async () => {
    await updateData((data) => { data.providerApiKeys = [] })
    const upstream = mock(() => Promise.resolve(new Response()))
    globalThis.fetch = upstream as unknown as typeof fetch

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
    globalThis.fetch = upstream as unknown as typeof fetch
    const response = await proxyRequest(new Request("http://gateway/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", messages: [] }),
    }), "openai-chat")
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  test("requests usage in streamed OpenAI-compatible chat responses", async () => {
    await updateData((data) => {
      const provider = data.providers.find((entry) => entry.prefix === "cx")
      if (provider) provider.protocol = "openai-chat"
    })
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch

    await proxyRequest(new Request("http://gateway/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", messages: [], stream: true, stream_options: { continuous_usage_stats: true } }),
    }), "openai-chat")

    expect(capturedBody?.stream_options).toEqual({ continuous_usage_stats: true, include_usage: true })
  })

  test("does not inject stream options into providers that may not support them", async () => {
    await updateData((data) => {
      const provider = data.providers.find((entry) => entry.prefix === "cx")
      if (provider) provider.protocol = "openai-chat"
    })
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch

    await proxyRequest(new Request("http://gateway/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", messages: [], stream: true }),
    }), "openai-chat")

    expect(capturedBody?.stream_options).toBeUndefined()
  })

  test("deep merges configured model request overrides before proxying", async () => {
    clearLogs()
    await updateData((data) => {
      const model = data.models.find((entry) => (entry.gatewayModelId || entry.id) === "cx/codex")
      if (model) model.requestOverrides = { reasoning: { effort: "none" }, temperature: 0 }
    })
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch

    await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello", reasoning: { effort: "high", summary: "auto" }, temperature: 1 }),
    }), "openai-responses")

    expect(capturedBody).toEqual({ model: "gpt-upstream", input: "hello", reasoning: { effort: "none", summary: "auto" }, temperature: 0 })
    expect(readLogs()[0]?.message).toContain("THINK:none")
    await updateData((data) => {
      const model = data.models.find((entry) => (entry.gatewayModelId || entry.id) === "cx/codex")
      if (model) delete model.requestOverrides
    })
  })

  test("logs message and tool totals in the compact request summary", async () => {
    clearLogs()
    globalThis.fetch = mock(async () => Response.json({ id: "resp_summary" })) as unknown as typeof fetch

    await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({
        model: "cx/codex",
        input: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }],
        tools: [{ type: "function", name: "first" }, { type: "function", name: "second" }],
        reasoning: { effort: "low" },
        stream: true,
      }),
    }), "openai-responses")

    expect(readLogs()[0]?.message).toMatch(/^POST PROVIDER:[^ ]+ MODEL:cx\/codex -> gpt-upstream FMT:openai-responses ACC:Primary THINK:low MSG:2 TOOL:2$/)
  })

  test("logs completion timing and token usage after a streamed response finishes", async () => {
    clearLogs()
    globalThis.fetch = mock(async () => new Response([
      'data: {"type":"response.created","response":{"id":"resp_usage"}}',
      'data: {"type":"response.completed","response":{"id":"resp_usage","usage":{"input_tokens":139054,"input_tokens_details":{"cached_tokens":137728},"output_tokens":2719}}}',
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch

    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello", stream: true }),
    }), "openai-responses")
    await response.text()

    expect(readLogs()[0]?.message).toMatch(/^DONE \d+ms TTFT:\d+ms IN:139054 \(CACHE ↻137728\) OUT:2719$/)
  })

  test("returns a controlled error for a legacy malformed provider header", async () => {
    await updateData((data) => {
      const provider = data.providers.find((entry) => entry.prefix === "cx")
      if (provider) provider.headers = { "bad header": "value" }
    })
    const upstream = mock(() => Promise.resolve(new Response()))
    globalThis.fetch = upstream as unknown as typeof fetch
    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello" }),
    }), "openai-responses")
    expect(response.status).toBe(502)
    expect(upstream).not.toHaveBeenCalled()
  })

  test("keeps requests with the same explicit session on the same provider key", async () => {
    await updateData((data) => {
      const provider = data.providers.find((entry) => entry.prefix === "cx")
      if (provider) data.providerApiKeys.push({
        id: "provider-key-b", providerId: provider.id, name: "Secondary", key: "provider-secret-b",
        enabled: true, createdAt: new Date().toISOString(),
      })
    })
    const selected: string[] = []
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      selected.push(new Headers(init?.headers).get("authorization") || "")
      return Response.json({ id: `resp_${selected.length}` })
    }) as unknown as typeof fetch
    const makeRequest = () => new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json", "x-rawroute-session-id": "subagent-1" },
      body: JSON.stringify({ model: "cx/codex", input: "hello" }),
    })

    await (await proxyRequest(makeRequest(), "openai-responses")).text()
    await (await proxyRequest(makeRequest(), "openai-responses")).text()

    expect(selected).toEqual(["Bearer provider-secret", "Bearer provider-secret"])
  })

  test("maps response IDs back to their credential for hard-affinity continuations", async () => {
    globalThis.fetch = mock(async () => Response.json({ id: "resp_parent", output: [] })) as unknown as typeof fetch
    const first = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello" }),
    }), "openai-responses")
    await first.text()

    expect([...testRedis.responseMappings.entries()].some(([key, value]) => key.endsWith(":resp_parent") && value === testProviderKeyId)).toBe(true)
  })

  test("does not corrupt a successful response when Redis bookkeeping fails", async () => {
    testRedis.failBookkeeping = true
    globalThis.fetch = mock(async () => Response.json({ id: "resp_success", output: [{ text: "delivered" }] })) as unknown as typeof fetch

    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", input: "hello" }),
    }), "openai-responses")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "resp_success", output: [{ text: "delivered" }] })
  })

  test("rejects an unknown previous_response_id instead of failing over", async () => {
    const upstream = mock(() => Promise.resolve(Response.json({})))
    globalThis.fetch = upstream as unknown as typeof fetch
    const response = await proxyRequest(new Request("http://gateway/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "cx/codex", previous_response_id: "resp_missing", input: "continue" }),
    }), "openai-responses")
    expect(response.status).toBe(409)
    expect(upstream).not.toHaveBeenCalled()
  })

  test("rejects a declared body larger than the configured maximum", async () => {
    process.env.MAX_PROXY_BODY_BYTES = "32"
    const upstream = mock(() => Promise.resolve(new Response()))
    globalThis.fetch = upstream as unknown as typeof fetch
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
