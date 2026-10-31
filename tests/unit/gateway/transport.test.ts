import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import type { Protocol } from "../../../packages/gateway-ai/src/contracts/domain"
import { prepareProviderRequest, proxyToProvider } from "../../../packages/gateway-ai/src/server/gateway/transport"
import type { ResolvedGatewayModel } from "../../../packages/gateway-ai/src/server/gateway/model-resolution"

const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic-messages"]
const model = "provider-model"
let originalFetch: typeof fetch
let fetchMock: ReturnType<typeof mock>

function resolved(protocol: Protocol, apiKeys: NonNullable<ResolvedGatewayModel["upstream"]>["apiKeys"] = []): ResolvedGatewayModel {
  return {
    upstreamModel: model,
    upstreamProtocol: protocol,
    pricingGatewayModelId: "provider/model",
    modelName: "Provider model",
    providerId: "provider",
    promptCacheKey: false,
    upstream: { baseUrl: "https://provider.test/v1", protocol, authType: apiKeys.length ? "bearer" : "none", headers: {}, apiKeys, codex: false },
  }
}

function clientRequest(protocol: Protocol, modelName = "client-model", stream = false) {
  const common = { model: modelName, stream }
  if (protocol === "openai-chat") return { ...common, messages: [{ role: "user", content: "hello" }], max_tokens: 16 }
  if (protocol === "openai-responses") return { ...common, input: "hello", max_output_tokens: 16 }
  return { ...common, messages: [{ role: "user", content: "hello" }], max_tokens: 16 }
}

function upstreamResponse(protocol: Protocol) {
  if (protocol === "openai-chat") return {
    id: "chatcmpl-1", object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } },
  }
  if (protocol === "openai-responses") return {
    id: "resp-1", object: "response", created_at: 1, status: "completed", model, output_text: "ok",
    output: [{ id: "msg-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 0 } },
  }
  return {
    id: "msg-1", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  }
}

function sourceStream(protocol: Protocol) {
  if (protocol === "openai-chat") {
    const chunks = [
      { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } } },
    ]
    return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
  }
  if (protocol === "anthropic-messages") {
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }],
    ] as const
    return events.map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`).join("")
  }
  const response = upstreamResponse("openai-responses")
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_text.done", item_id: "msg-1", output_index: 0, content_index: 0, text: "ok" },
    { type: "response.content_part.done", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "ok", annotations: [] } },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
    { type: "response.completed", response },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

function requestFor(protocol: Protocol, body: unknown) {
  const path = protocol === "openai-chat" ? "/v1/chat/completions" : protocol === "openai-responses" ? "/v1/responses" : "/v1/messages"
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer rawroute-gateway-secret", "x-api-key": "rawroute-gateway-secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchMock = mock(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean }
    const protocol = new URL(String(_input)).pathname.endsWith("/messages") ? "anthropic-messages" : new URL(String(_input)).pathname.endsWith("/responses") ? "openai-responses" : "openai-chat"
    if (body.stream) return new Response(sourceStream(protocol), { headers: { "content-type": "text/event-stream" } })
    return Response.json(upstreamResponse(protocol), { headers: { "x-upstream": "provider" } })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => { globalThis.fetch = originalFetch })

for (const client of protocols) for (const upstream of protocols) {
  test(`${client} to ${upstream} returns a native non-streaming response and native usage`, async () => {
    const target = resolved(upstream)
    const prepared = prepareProviderRequest(new TextEncoder().encode(JSON.stringify(clientRequest(client))), target, client)
    const { response, usage } = await proxyToProvider(requestFor(client, clientRequest(client)), target, prepared, client)
    expect(response.status).toBe(200)
    const result = await response.json() as Record<string, unknown>
    expect(JSON.stringify(result)).toContain("ok")
    expect(usage).toMatchObject(upstream === "anthropic-messages"
      ? { input: 15, output: 2, cached: 3, cacheCreation: 2 }
      : { input: 10, output: 2, cached: 3 })
    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(new URL(String(url)).pathname).toBe(upstream === "anthropic-messages" ? "/v1/messages" : upstream === "openai-responses" ? "/v1/responses" : "/v1/chat/completions")
    expect(JSON.parse(String(init?.body)).model).toBe(model)
    expect(new Headers(init?.headers).get("authorization")).toBeNull()
    expect(new Headers(init?.headers).get("x-api-key")).toBeNull()
  })

  test(`${client} to ${upstream} converts and terminates a streaming response`, async () => {
    const target = resolved(upstream)
    const body = clientRequest(client, "client-model", true)
    const prepared = prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, client)
    const executed = await proxyToProvider(requestFor(client, body), target, prepared, client)
    expect(executed.response.headers.get("content-type")).toContain("text/event-stream")
    const text = await executed.response.text()
    const usage = await executed.streamUsage
    expect(text).toContain("ok")
    expect(usage).toMatchObject({ terminalEventSeen: true, usage: upstream === "anthropic-messages"
      ? { input: 15, output: 2, cached: 3, cacheCreation: 2 }
      : { input: 10, output: 2, cached: 3 } })
    if (client === "openai-chat") expect(text).toContain("data: [DONE]")
    if (client === "openai-chat" && upstream === "anthropic-messages") expect(text).not.toContain('"choices":[]')
    if (client === "anthropic-messages") expect(text).toContain("event: message_stop")
    if (client === "openai-responses") expect(text).toContain("event: response.completed")
  })
}

test("rejects Responses continuation semantics before contacting a non-Responses provider", async () => {
  const target = resolved("openai-chat")
  for (const requestBody of [
    { model: "client-model", previous_response_id: "resp-prior", input: "hello" },
    { model: "client-model", input: [{ type: "item_reference", id: "item-prior" }] },
  ]) expect(() => prepareProviderRequest(new TextEncoder().encode(JSON.stringify(requestBody)), target, "openai-responses")).toThrow("continuation references")
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

test("rejects silently lossy cross-protocol options before contacting the provider", async () => {
  const target = resolved("anthropic-messages")
  const body = { ...clientRequest("openai-chat"), seed: 7 }
  expect(() => prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat")).toThrow("seed request option")
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

test("converts flat Responses allowed_tools to Chat shape and rejects unsupported entries", async () => {
  const target = resolved("openai-chat")
  const body = {
    model: "client-model",
    input: "hello",
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "lookup" }] },
  }
  const prepared = prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-responses")
  await proxyToProvider(requestFor("openai-responses", body), target, prepared, "openai-responses")
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).tool_choice).toEqual({
    type: "allowed_tools",
    allowed_tools: { mode: "auto", tools: [{ type: "function", name: "lookup" }] },
  })

  fetchMock.mockClear()
  const invalid = { ...body, tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "mcp", server_label: "docs" }] } }
  expect(() => prepareProviderRequest(new TextEncoder().encode(JSON.stringify(invalid)), target, "openai-responses")).toThrow("tool-choice restriction")
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

test("tries eligible credentials in configured order without forwarding the gateway key", async () => {
  const credentials = [
    { id: "first", providerId: "provider", name: "first", key: "provider-secret-one", enabled: true, priority: 2, createdAt: "2026-01-01" },
    { id: "second", providerId: "provider", name: "second", key: "provider-secret-two", enabled: true, priority: 1, createdAt: "2026-01-02" },
  ]
  const target = resolved("openai-chat", credentials)
  const attempts: Array<{ authorization: string | null; body: string }> = []
  fetchMock.mockImplementation(async (_input, init) => {
    attempts.push({ authorization: new Headers(init?.headers).get("authorization"), body: String(init?.body) })
    return attempts.length === 1 ? Response.json({ error: { message: "first key rejected" } }, { status: 401 }) : Response.json(upstreamResponse("openai-chat"))
  })
  const body = clientRequest("openai-chat")
  const result = await proxyToProvider(requestFor("openai-chat", body), target, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat"), "openai-chat")
  expect(result.response.status).toBe(200)
  expect(attempts.map((attempt) => attempt.authorization)).toEqual(["Bearer provider-secret-one", "Bearer provider-secret-two"])
  expect(JSON.stringify(attempts)).not.toContain("rawroute-gateway-secret")
})

test("sends Anthropic's fixed version default and keeps an explicit version override", async () => {
  const apiKey = { id: "anthropic-key", providerId: "provider", name: "Anthropic", key: "provider-anthropic-secret", enabled: true, createdAt: "2026-01-01" }
  const target = resolved("anthropic-messages", [apiKey])
  target.upstream!.authType = "x-api-key"
  const body = clientRequest("openai-chat")
  const base = requestFor("openai-chat", body)
  const headers = new Headers(base.headers)
  headers.set("anthropic-version", "2024-10-22")
  const request = new Request(base.url, { method: base.method, headers, body: JSON.stringify(body) })
  await proxyToProvider(request, target, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat"), "openai-chat")
  const sent = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
  expect(sent.get("anthropic-version")).toBe("2024-10-22")
  expect(sent.get("x-api-key")).toBe("provider-anthropic-secret")
  expect(sent.get("authorization")).toBeNull()
  expect(JSON.stringify(Object.fromEntries(sent))).not.toContain("rawroute-gateway-secret")

  fetchMock.mockClear()
  const anonymous = resolved("anthropic-messages")
  const plainRequest = requestFor("openai-chat", body)
  await proxyToProvider(plainRequest, anonymous, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), anonymous, "openai-chat"), "openai-chat")
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("anthropic-version")).toBe("2023-06-01")
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBeNull()
})

test("sends x-api-key credentials to any directly configured provider origin", async () => {
  const apiKey = { id: "provider-key", providerId: "provider", name: "Provider", key: "provider-x-api-key-secret", enabled: true, createdAt: "2026-01-01" }
  const target = resolved("openai-responses", [apiKey])
  target.upstream!.authType = "x-api-key"
  target.upstream!.baseUrl = "https://gateway.example/v1"
  const body = clientRequest("openai-responses")
  await proxyToProvider(requestFor("openai-responses", body), target, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-responses"), "openai-responses")
  const sent = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
  expect(new URL(String(fetchMock.mock.calls[0]?.[0])).origin).toBe("https://gateway.example")
  expect(sent.get("x-api-key")).toBe("provider-x-api-key-secret")
  expect(sent.get("authorization")).toBeNull()
})

test("normalizes cross-protocol upstream errors while retaining status and retry hints", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "provider busy" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "7" },
  }))
  const target = resolved("openai-responses")
  const body = clientRequest("openai-chat")
  const result = await proxyToProvider(requestFor("openai-chat", body), target, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat"), "openai-chat")
  expect(result.response.status).toBe(429)
  expect(result.response.headers.get("retry-after")).toBe("7")
  await expect(result.response.json()).resolves.toMatchObject({ error: { message: "provider busy" } })
})

test("downstream cancellation aborts the upstream stream", async () => {
  let aborted = false
  fetchMock.mockImplementation(async (_input, init) => {
    const controller = new ReadableStream<Uint8Array>({
      start(stream) {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          stream.error(new Error("cancelled"))
        }, { once: true })
      },
    })
    return new Response(controller, { headers: { "content-type": "text/event-stream" } })
  })
  const target = resolved("openai-responses")
  const body = clientRequest("openai-chat", "client-model", true)
  const result = await proxyToProvider(requestFor("openai-chat", body), target, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat"), "openai-chat")
  await result.response.body?.cancel("client disconnected")
  expect(aborted).toBe(true)
  await result.streamUsage
})

test("converts upstream stream errors to the requested client protocol", async () => {
  const errorData = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "provider busy" } }, null, 2)
    .split("\n").map((line) => `data: ${line}`).join("\r\n")
  const bytes = new TextEncoder().encode(`event: error\r\n${errorData}\r\n\r\n`)
  fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }), { headers: { "content-type": "text/event-stream" } }))
  const target = resolved("anthropic-messages")
  const body = clientRequest("openai-chat", "client-model", true)
  const result = await proxyToProvider(requestFor("openai-chat", body), target, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat"), "openai-chat")
  const text = await result.response.text()
  expect(text).toContain('"message":"provider busy"')
  expect(text).toContain('"type":"rate_limit_error"')
  expect(text).toContain("data: [DONE]")
  await expect(result.streamUsage).resolves.toMatchObject({ terminalEventSeen: true, completedNormally: false })
})

test("includes OpenAI Chat stream usage only when requested from an Anthropic provider", async () => {
  const target = resolved("anthropic-messages")
  const body = { ...clientRequest("openai-chat", "client-model", true), stream_options: { include_usage: true } }
  const result = await proxyToProvider(requestFor("openai-chat", body), target, prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat"), "openai-chat")
  const text = await result.response.text()
  expect(text).toContain('"choices":[]')
  expect(text).toContain('"usage":')
})

test("drains comment-only SSE frames and multiline events across split CRLF/LF chunks", async () => {
  const completed = upstreamResponse("openai-responses")
  const completedPayload = { type: "response.completed", response: completed }
  const multilineData = JSON.stringify(completedPayload, null, 2).split("\n").map((line) => `data: ${line}`).join("\r\n")
  const wire = [
    ": upstream ping\r\n\r\n",
    `event: response.created\r\ndata: ${JSON.stringify({ type: "response.created", response: { ...completed, status: "in_progress", output: [] } })}\r\n\r\n`,
    ": another ping\n\n",
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "ok" })}\n\n`,
    `event: response.completed\r\n${multilineData}\r\n\r\n`,
  ].join("")
  const bytes = new TextEncoder().encode(wire)
  fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }), { headers: { "content-type": "text/event-stream" } }))
  const target = resolved("openai-responses")
  const body = clientRequest("openai-chat", "client-model", true)
  const prepared = prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat")
  const result = await proxyToProvider(requestFor("openai-chat", body), target, prepared, "openai-chat")
  const downstream = await result.response.text()
  const usage = await result.streamUsage
  expect(downstream).toContain("ok")
  expect(downstream).toContain("data: [DONE]")
  expect(usage).toMatchObject({ terminalEventSeen: true, usage: { input: 10, output: 2, cached: 3, cacheCreation: 2 } })
})

test("preserves supported multimodal, tool-call, and reasoning conversions", async () => {
  const target = resolved("anthropic-messages")
  const body = {
    model: "client-model",
    messages: [{ role: "user", content: [
      { type: "text", text: "Describe this." },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ] }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } } }],
    tool_choice: "auto",
  }
  fetchMock.mockResolvedValueOnce(Response.json({
    id: "msg-tools", type: "message", role: "assistant", model, content: [
      { type: "thinking", thinking: "Need lookup." },
      { type: "tool_use", id: "call-1", name: "lookup", input: { query: "weather" } },
    ], stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }))
  const prepared = prepareProviderRequest(new TextEncoder().encode(JSON.stringify(body)), target, "openai-chat")
  const result = await proxyToProvider(requestFor("openai-chat", body), target, prepared, "openai-chat")
  const upstreamBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
  expect(upstreamBody).toMatchObject({
    messages: [{ role: "user", content: [{ type: "text", text: "Describe this." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] }],
    tools: [{ name: "lookup", input_schema: expect.any(Object) }],
  })
  const clientResponse = await result.response.json() as { choices: Array<{ message: { reasoning?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }> }
  expect(clientResponse.choices[0]?.message).toMatchObject({
    reasoning: "Need lookup.",
    tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: JSON.stringify({ query: "weather" }) } }],
  })
})
