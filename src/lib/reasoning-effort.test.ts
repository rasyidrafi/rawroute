import { describe, expect, test } from "vitest"

import { extractReasoningEffort } from "@/lib/reasoning-effort"

describe("reasoning effort logging", () => {
  test("reads the Responses API reasoning object", () => {
    expect(extractReasoningEffort({ reasoning: { effort: "high" } })).toBe("high")
  })

  test("reads the Chat Completions reasoning_effort field", () => {
    expect(extractReasoningEffort({ reasoning_effort: "none" })).toBe("none")
  })

  test("reads the Anthropic output_config effort field", () => {
    expect(extractReasoningEffort({ output_config: { effort: "medium" } })).toBe("medium")
  })

  test("reads OpenRouter reasoning effort on a chat-compatible request", () => {
    expect(extractReasoningEffort({ messages: [], reasoning: { effort: "xhigh" } })).toBe("xhigh")
  })

  test("reads common Google thinking-level extension shapes", () => {
    expect(extractReasoningEffort({ google: { thinking_config: { thinking_level: "low" } } })).toBe("low")
    expect(extractReasoningEffort({ generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } })).toBe("HIGH")
  })

  test("ignores missing, mismatched, and non-string values", () => {
    expect(extractReasoningEffort({ reasoning: { effort: 10 } })).toBeUndefined()
    expect(extractReasoningEffort({})).toBeUndefined()
  })

  test("labels conflicting effort fields rather than hiding one", () => {
    expect(extractReasoningEffort({ reasoning: { effort: "none" }, reasoning_effort: "high" }))
      .toBe("reasoning.effort:none, reasoning_effort:high")
  })
})
