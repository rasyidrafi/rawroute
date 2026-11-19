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

const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const contentChunk = chunk({ choices: [{ index: 0, delta: { content: "hi" } }] })
const finishChunk = chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
const usageChunk = chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })

test("openai-chat stream ending after finish_reason without [DONE] completes normally", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + usageChunk))
  expect(collected.completedNormally).toBe(true)
  expect(collected.terminalEventSeen).toBe(true)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})

test("openai-chat stream with [DONE] still completes normally", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + usageChunk + "data: [DONE]\n\n"))
  expect(collected.completedNormally).toBe(true)
  expect(collected.usage).toMatchObject({ input: 10, output: 2 })
})

test("truncated openai-chat stream without terminal markers stays incomplete", async () => {
  const collected = await collectStreamUsage(sse(contentChunk))
  expect(collected.completedNormally).toBe(false)
  expect(collected.terminalEventSeen).toBe(false)
})

test("error event after finish_reason keeps the stream failed", async () => {
  const collected = await collectStreamUsage(sse(contentChunk + finishChunk + "event: error\ndata: {\"message\":\"upstream exploded\"}\n\n"))
  expect(collected.terminalEventSeen).toBe(true)
  expect(collected.completedNormally).toBe(false)
})

test("anthropic message_stop remains terminal", async () => {
  const collected = await collectStreamUsage(sse("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"), "anthropic")
  expect(collected.completedNormally).toBe(true)
})
