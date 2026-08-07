import { expect, test } from "vitest"

import { normalizeResponsesRequest } from "@/lib/request-normalization"

test("normalizes chat-completions compatibility fields in one Responses adapter", () => {
  expect(normalizeResponsesRequest({
    input: "hello",
    max_tokens: 512,
    reasoning_effort: " high ",
  })).toEqual({
    input: "hello",
    max_output_tokens: 512,
    reasoning: { effort: "high" },
  })
})

test("prefers explicit Responses fields over compatibility aliases", () => {
  expect(normalizeResponsesRequest({
    input: "hello",
    max_output_tokens: 256,
    max_tokens: 512,
    reasoning: { effort: "low" },
    reasoning_effort: "high",
  })).toEqual({
    input: "hello",
    max_output_tokens: 256,
    reasoning: { effort: "low" },
  })
})

test("Codex can opt out of the output-token field after shared normalization", () => {
  expect(normalizeResponsesRequest({ max_tokens: 512 }, { dropOutputTokenLimit: true })).toEqual({})
})
