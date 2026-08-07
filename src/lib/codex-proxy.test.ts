import { describe, expect, test } from "vitest"

import { buildCodexHeaders, collectCodexResponsesSse, normalizeCodexRequest, normalizeCodexResponsesStream } from "@/lib/codex-proxy"
import type { Provider } from "@/lib/types"

const provider: Provider = {
  id: "provider-1",
  name: "Codex",
  prefix: "codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  protocol: "openai-responses",
  authType: "none",
  headers: { "x-static": "yes" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  apiKeyCount: 0,
  enabledApiKeyCount: 0,
  modelCount: 0,
  enabledModelCount: 0,
}

describe("Codex native request adapter", () => {
  test("normalizes data-only Responses SSE into standard event framing", async () => {
    const upstream = new Response('data: {"type":"response.created","response":{"id":"resp_1"}}\n\ndata: [DONE]\n\n')
    const normalized = normalizeCodexResponsesStream(upstream.body!)
    expect(await new Response(normalized).text()).toBe('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\ndata: [DONE]\n\n')
  })

  test("assembles Codex Responses Lite SSE into a native Responses JSON envelope", () => {
    const result = collectCodexResponsesSse([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":123,"model":"gpt-5.4-mini"}}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":11,"total_tokens":18}}}',
      "",
    ].join("\n\n"))

    expect(result).toMatchObject({
      id: "resp_1",
      object: "response",
      created_at: 123,
      model: "gpt-5.4-mini",
      status: "completed",
      usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
    })
  })

  test("keeps Responses structure while applying only Codex compatibility rules", () => {
    expect(normalizeCodexRequest({
      model: "gateway/model",
      input: "hello",
      temperature: 0.2,
      max_output_tokens: 10,
      max_tokens: 10,
      reasoning_effort: "high",
      previous_response_id: "resp_1",
      tools: [],
    }, "gpt-5.4-codex", "session-1")).toEqual({
      model: "gpt-5.4-codex",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      instructions: "",
      prompt_cache_key: "session-1",
      tools: [],
      parallel_tool_calls: false,
      reasoning: { effort: "high" },
    })
  })

  test("converts system messages to developer messages and preserves tools", () => {
    const result = normalizeCodexRequest({
      model: "x",
      input: [{ type: "message", role: "system", content: [{ type: "input_text", text: "rules" }] }],
      tools: [{ type: "function", name: "lookup" }],
    }, "gpt-5.4")
    expect(result.input).toMatchObject([{ role: "developer" }])
    expect(result.parallel_tool_calls).toBe(false)
  })

  test("injects account authentication without forwarding gateway secrets", () => {
    const headers = buildCodexHeaders(new Headers({ authorization: "Bearer gateway", cookie: "secret", "x-client-request-id": "client" }), provider.headers, "access", "acct-1", "session-1")
    expect(headers.get("authorization")).toBe("Bearer access")
    expect(headers.get("chatgpt-account-id")).toBe("acct-1")
    expect(headers.get("session_id")).toBe("session-1")
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("x-static")).toBe("yes")
  })
})
