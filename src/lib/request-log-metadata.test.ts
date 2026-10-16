import { expect, test } from "bun:test"
import { extractRequestReasoningEffort, normalizeRequestLogMetadata, normalizeRequestReasoningEffort, normalizeRequestToolCount } from "./request-log-metadata"

test("only reviewed, normalized reasoning efforts are accepted", () => {
  expect(normalizeRequestReasoningEffort(" HIGH ")).toBe("high")
  expect(normalizeRequestReasoningEffort("customer-private-value")).toBeUndefined()
  expect(normalizeRequestReasoningEffort("ultra")).toBeUndefined()
  expect(normalizeRequestReasoningEffort({ effort: "high" })).toBeUndefined()
})

test("reasoning extraction follows protocol-specific field precedence and rejects conflicts", () => {
  expect(extractRequestReasoningEffort({ reasoning: { effort: "xhigh" }, reasoning_effort: "xhigh" }, "openai-responses")).toBe("xhigh")
  expect(extractRequestReasoningEffort({ reasoning: { effort: "high" }, reasoning_effort: "low" }, "openai-responses")).toBeUndefined()
  expect(extractRequestReasoningEffort({ reasoning_effort: "medium", reasoning: { effort: "high" } }, "openai-chat")).toBeUndefined()
  expect(extractRequestReasoningEffort({ output_config: { effort: "max" } }, "anthropic-messages")).toBe("max")
  expect(extractRequestReasoningEffort({ output_config: { effort: "high" } }, "openai-responses")).toBeUndefined()
})

test("tool metadata accepts only nonnegative safe integer counts", () => {
  expect(normalizeRequestToolCount(0)).toBe(0)
  expect(normalizeRequestToolCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
    expect(normalizeRequestToolCount(value)).toBeUndefined()
  }
  expect(normalizeRequestLogMetadata({ reasoningEffort: "customer-private-value", toolCount: -1 })).toEqual({})
})
