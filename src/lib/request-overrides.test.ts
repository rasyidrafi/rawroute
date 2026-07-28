import { expect, test } from "bun:test"

import { mergeRequestOverrides, validateRequestOverrides } from "@/lib/request-overrides"

test("deep merges configured values over the client request", () => {
  const payload = { model: "public-model", input: "hello", reasoning: { effort: "high", summary: "auto" }, tools: [{ type: "web_search" }] }
  const merged = mergeRequestOverrides(payload, validateRequestOverrides({ reasoning: { effort: "none" }, tools: [] }))
  expect(merged).toEqual({ model: "public-model", input: "hello", reasoning: { effort: "none", summary: "auto" }, tools: [] })
  expect(payload.reasoning.effort).toBe("high")
})

test("rejects model replacement and prototype pollution keys", () => {
  expect(() => validateRequestOverrides({ model: "bypass" })).toThrow("cannot replace the model")
  expect(() => validateRequestOverrides(JSON.parse('{"reasoning":{"__proto__":{"polluted":true}}}'))).toThrow("not allowed")
})

test("requires an object rather than an array", () => {
  expect(() => validateRequestOverrides([])).toThrow("must be a JSON object")
})
