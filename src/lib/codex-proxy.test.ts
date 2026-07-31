import { describe, expect, test } from "bun:test"

import { buildCodexHeaders, normalizeCodexRequest } from "@/lib/codex-proxy"
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
  test("keeps Responses structure while applying only Codex compatibility rules", () => {
    expect(normalizeCodexRequest({
      model: "gateway/model",
      input: "hello",
      temperature: 0.2,
      max_output_tokens: 10,
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
    })
  })

  test("converts system messages to developer messages and preserves tools", () => {
    const result = normalizeCodexRequest({
      model: "x",
      input: [{ type: "message", role: "system", content: [{ type: "input_text", text: "rules" }] }],
      tools: [{ type: "function", name: "lookup" }],
    }, "gpt-5.4")
    expect(result.input).toMatchObject([{ role: "developer" }])
    expect(result.parallel_tool_calls).toBe(true)
  })

  test("injects account authentication without forwarding gateway secrets", () => {
    const headers = buildCodexHeaders(new Headers({ authorization: "Bearer gateway", cookie: "secret", "x-client-request-id": "client" }), provider, "access", "acct-1", "session-1")
    expect(headers.get("authorization")).toBe("Bearer access")
    expect(headers.get("chatgpt-account-id")).toBe("acct-1")
    expect(headers.get("session_id")).toBe("session-1")
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("x-static")).toBe("yes")
  })
})
