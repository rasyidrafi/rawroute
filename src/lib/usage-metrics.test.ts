import { describe, expect, test } from "vitest"

import { extractUsageMetrics } from "@/lib/proxy"

describe("usage metric extraction", () => {
  test("reads OpenAI Responses usage and cached input", () => {
    expect(extractUsageMetrics({
      response: {
        usage: {
          input_tokens: 139054,
          input_tokens_details: { cached_tokens: 137728 },
          output_tokens: 2719,
        },
      },
    })).toEqual({ input: 139054, output: 2719, cached: 137728 })
  })

  test("reads OpenAI-compatible and OpenRouter chat usage", () => {
    expect(extractUsageMetrics({
      usage: {
        prompt_tokens: 348533,
        prompt_tokens_details: { cached_tokens: 320000, cache_write_tokens: 1000 },
        completion_tokens: 1349,
      },
    })).toEqual({ input: 348533, output: 1349, cached: 320000 })
  })

  test("combines Anthropic uncached, cache-read, and cache-created input", () => {
    expect(extractUsageMetrics({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 120,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 850,
          output_tokens: 4,
        },
      },
    })).toEqual({ input: 1000, output: 4, cached: 850, cacheCreation: 30 })
  })

  test("reads Gemini native usage metadata", () => {
    expect(extractUsageMetrics({
      usageMetadata: {
        promptTokenCount: 500,
        cachedContentTokenCount: 420,
        candidatesTokenCount: 80,
        totalTokenCount: 580,
      },
    })).toEqual({ input: 500, output: 80, cached: 420 })
  })

  test("reads DeepSeek cache hits and AWS Bedrock camel-case metrics", () => {
    expect(extractUsageMetrics({
      usage: { prompt_tokens: 900, completion_tokens: 100, prompt_cache_hit_tokens: 700 },
    })).toEqual({ input: 900, output: 100, cached: 700 })
    expect(extractUsageMetrics({
      "amazon-bedrock-invocationMetrics": {
        inputTokenCount: 600,
        outputTokenCount: 50,
        cacheReadInputTokenCount: 400,
      },
    })).toEqual({ input: 600, output: 50, cached: 400 })
  })

  test("keeps partial usage instead of inventing missing totals", () => {
    expect(extractUsageMetrics({ usage: { output_tokens: 42 } })).toEqual({ output: 42 })
    expect(extractUsageMetrics({ usage: { total_tokens: 42 } })).toBeUndefined()
  })
})
