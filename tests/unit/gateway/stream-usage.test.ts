import { expect, test } from "bun:test"
import { collectStreamUsage } from "../../../packages/gateway-ai/src/server/gateway/stream-usage"

function sse(payload: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  })
}

function sseThenReadFailure(payload: string) {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode(payload))
        return
      }
      controller.error(new Error("upstream disconnect"))
    },
  })
}

const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const contentChunk = chunk({ choices: [{ index: 0, delta: { content: "hi" } }] })
const finishChunk = chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
const usageChunk = chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
const choiceChunk = (index: number, finishReason: string | null) => chunk({ choices: [{ index, delta: {}, finish_reason: finishReason }] })

test("openai-chat stream ending after finish_reason without [DONE] completes normally", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + usageChunk), "openai", 1)
  expect(collected.completedNormally).toBe(true)
  expect(collected.terminalEventSeen).toBe(false)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})

test("openai-chat stream with [DONE] still completes normally", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + usageChunk + "data: [DONE]\n\n"), "openai", 1)
  expect(collected.completedNormally).toBe(true)
  expect(collected.terminalEventSeen).toBe(true)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})

test("truncated openai-chat stream without terminal markers stays incomplete", async () => {
  const collected = await collectStreamUsage(sse(contentChunk), "openai", 1)
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
})

test("error event after finish_reason keeps the stream failed", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + "event: error\ndata: {\"message\":\"upstream exploded\"}\n\n"), "openai", 1)
  expect(collected.terminalEventSeen).toBe(true)
  expect(collected.completedNormally).toBe(false)
})

test("anthropic message_stop remains terminal", async () => {
  const collected = await collectStreamUsage(sse("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"), "anthropic")
  expect(collected.completedNormally).toBe(true)
})

test("n=2 stream where only choice 0 finishes stays incomplete", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + choiceChunk(0, "stop") + choiceChunk(0, "stop")), "openai", 2)
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
})

test("n=2 stream completes once every choice finishes, including tool_calls turns", async () => {
  const collected = await collectStreamUsage(sse(choiceChunk(1, "tool_calls") + choiceChunk(0, "stop")), "openai", 2)
  expect(collected.completedNormally).toBe(true)
  expect(collected.terminalEventSeen).toBe(false)
})

test("choices without an index fall back to their array position", async () => {
  const bothFinished = chunk({ choices: [{ delta: {}, finish_reason: "stop" }, { delta: {}, finish_reason: "stop" }] })
  const collected = await collectStreamUsage(sse(bothFinished), "openai", 2)
  expect(collected.completedNormally).toBe(true)
})

test("explicitly invalid non-integer index is skipped instead of using its position", async () => {
  const frame = chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }, { index: 1.5, delta: {}, finish_reason: "stop" }] })
  const collected = await collectStreamUsage(sse(frame), "openai", 2)
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
})

test("explicitly invalid non-number index is skipped instead of using its position", async () => {
  const frame = chunk({ choices: [{ index: null, delta: {}, finish_reason: "stop" }, { index: "1", delta: {}, finish_reason: "stop" }] })
  const collected = await collectStreamUsage(sse(frame), "openai", 2)
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
})

test("read failure after finish_reason stays incomplete and preserves usage", async () => {
  const collected = await collectStreamUsage(sseThenReadFailure(contentChunk + finishChunk + usageChunk), "openai", 1)
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})

test("malformed trailing data frame after finish_reason stays incomplete", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + 'data: {"usage":{"prompt_tokens":10,"completion_tok'), "openai", 1)
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
})

test("[DONE] before a read failure still completes normally", async () => {
  const collected = await collectStreamUsage(sseThenReadFailure(contentChunk + finishChunk + usageChunk + "data: [DONE]\n\n"), "openai", 1)
  expect(collected.completedNormally).toBe(true)
  expect(collected.terminalEventSeen).toBe(true)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})

test("[DONE] after a malformed data frame still completes normally", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + "data: {broken\n\ndata: [DONE]\n\n"), "openai", 1)
  expect(collected.completedNormally).toBe(true)
  expect(collected.terminalEventSeen).toBe(true)
})

test("finish_reason without chatChoiceCount does not complete the stream", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + usageChunk))
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})

test("[DONE] with an oversized chatChoiceCount completes normally without allocating by n", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + usageChunk + "data: [DONE]\n\n"), "openai", 2 ** 32)
  expect(collected.completedNormally).toBe(true)
  expect(collected.terminalEventSeen).toBe(true)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})

test("oversized chatChoiceCount with partial finish and clean EOF stays incomplete", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + choiceChunk(0, "stop") + usageChunk), "openai", 2 ** 32)
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})
