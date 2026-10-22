import { expect, test } from "bun:test"
import { withSessionPromptCacheKey } from "../../../packages/gateway-ai/src/server/cliproxy/prompt-cache"

test("session cache keys survive appended turns and separate consumers and branches", () => {
  const headers = new Headers({ "X-Session-Id": "conversation-1" })
  const first = withSessionPromptCacheKey({ input: "first" }, headers, "consumer", "key-1")
  const next = withSessionPromptCacheKey({ input: "first and second", model: "fallback-model", reasoning: { effort: "high" } }, headers, "consumer", "key-1")
  expect(first.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/)
  expect(next.prompt_cache_key).toBe(first.prompt_cache_key)
  expect(first).toMatchObject({ input: "first" })
  for (const [workspace, key] of [["other", "key-1"], ["consumer", "key-2"]] as const) {
    expect(withSessionPromptCacheKey({}, headers, workspace, key).prompt_cache_key).not.toBe(first.prompt_cache_key)
  }
  for (const identity of [new Headers({ "x-session-id": "conversation-2" }), new Headers({ "x-session-id": "conversation-1", "x-claude-code-agent-id": "child" })]) {
    expect(withSessionPromptCacheKey({}, identity, "consumer", "key-1").prompt_cache_key).not.toBe(first.prompt_cache_key)
  }
})

test("preserves explicit keys and never invents a global or request-based session", () => {
  for (const key of ["client-key", "", null]) {
    const payload = { prompt_cache_key: key }
    expect(withSessionPromptCacheKey(payload, new Headers({ "x-session-id": "session" }), "ws", "key")).toBe(payload)
  }
  for (const headers of [new Headers(), new Headers({ "x-request-id": "request-1" }), new Headers({ "x-session-id": " " }), new Headers({ "x-session-id": "a".repeat(513) })]) {
    const payload = { input: "hello" }
    expect(withSessionPromptCacheKey(payload, headers, "ws", "key")).toBe(payload)
  }
  expect(withSessionPromptCacheKey({}, new Headers({ "Session-Id": "session" }), "ws", "key").prompt_cache_key)
    .toBe(withSessionPromptCacheKey({}, new Headers({ "X-Session-Id": " session " }), "ws", "key").prompt_cache_key)
})
