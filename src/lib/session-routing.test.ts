import { createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"

import { extractSessionIdentity } from "@/lib/session-routing"

const context = {
  gatewayKeyId: "gateway-key",
  providerId: "provider",
  modelId: "provider/model",
  secret: "test-session-secret",
}

describe("session identity extraction", () => {
  test("prefers RawRoute's explicit session header", () => {
    const request = new Request("https://gateway.test/v1/responses", {
      headers: { "x-rawroute-session-id": "subagent:research" },
    })
    expect(extractSessionIdentity(request, { metadata: { rawroute_session_id: "ignored" } }, "openai-responses", context)).toEqual({
      key: createHmac("sha256", context.secret).update("gateway-key\nprovider\nprovider/model\nexplicit:subagent:research").digest("hex"),
      source: "x-rawroute-session-id",
      hard: false,
    })
  })

  test("recognizes native metadata and prompt cache signals", () => {
    const request = new Request("https://gateway.test/v1/responses")
    expect(extractSessionIdentity(request, { prompt_cache_key: "chat-42" }, "openai-responses", context)?.source)
      .toBe("prompt_cache_key")
    expect(extractSessionIdentity(request, { metadata: { session_id: "chat-43" } }, "openai-responses", context)?.source)
      .toBe("metadata.session_id")
  })

  test("marks previous_response_id as hard affinity", () => {
    const identity = extractSessionIdentity(
      new Request("https://gateway.test/v1/responses"),
      { previous_response_id: "resp_123" },
      "openai-responses",
      context,
    )
    expect(identity).toMatchObject({ source: "previous_response_id", hard: true, responseId: "resp_123" })
  })

  test("keeps previous_response_id hard even when an explicit session header is present", () => {
    const identity = extractSessionIdentity(
      new Request("https://gateway.test/v1/responses", { headers: { "x-rawroute-session-id": "chat" } }),
      { previous_response_id: "resp_456" },
      "openai-responses",
      context,
    )
    expect(identity).toMatchObject({ source: "x-rawroute-session-id", hard: true, responseId: "resp_456" })
  })

  test("uses only the stable prompt prefix for fallback affinity", () => {
    const request = new Request("https://gateway.test/v1/chat/completions")
    const first = extractSessionIdentity(request, {
      messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Hello" }],
    }, "openai-chat", context)
    const continuation = extractSessionIdentity(request, {
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Continue" },
      ],
    }, "openai-chat", context)
    expect(continuation?.key).toBe(first?.key)
    expect(first?.source).toBe("prompt-prefix")
  })
})
