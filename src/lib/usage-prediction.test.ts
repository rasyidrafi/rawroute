import { describe, expect, test } from "vitest"

import { isOpenAiCodexModel, predictPayloadCalibratedCost } from "@/lib/usage-prediction"

const pricing = {
  inputMicrosPerMillion: 5_000_000,
  outputMicrosPerMillion: 30_000_000,
  cacheReadMicrosPerMillion: 500_000,
  cacheCreationMicrosPerMillion: 6_250_000,
}

const samples = [
  { requestBodyBytes: 1_000, inputTokens: 250, outputTokens: 100, cacheReadTokens: 225, cacheCreationTokens: 0, protocol: "openai-responses" as const },
  { requestBodyBytes: 2_000, inputTokens: 500, outputTokens: 200, cacheReadTokens: 450, cacheCreationTokens: 0, protocol: "openai-responses" as const },
  { requestBodyBytes: 3_000, inputTokens: 750, outputTokens: 300, cacheReadTokens: 675, cacheCreationTokens: 0, protocol: "openai-responses" as const },
]

describe("OpenAI/Codex payload usage prediction", () => {
  test("limits calibration to direct OpenAI and Codex model ids", () => {
    expect(isOpenAiCodexModel("gpt-5.6-sol")).toBe(true)
    expect(isOpenAiCodexModel("codex/gpt-5.6-sol")).toBe(true)
    expect(isOpenAiCodexModel("cx/gpt-5.6-sol")).toBe(false)
    expect(isOpenAiCodexModel("custom/model")).toBe(false)
  })

  test("uses nearest request sizes and does not invent a fixed cache-write fee", () => {
    const result = predictPayloadCalibratedCost({
      gatewayModelId: "codex/gpt-5.6-sol",
      requestBodyBytes: 2_000,
      protocol: "openai-responses",
      defaultOutputTokens: 1_024,
      samples,
      pricing,
    })

    expect(result).toMatchObject({
      sampleCount: 3,
      method: "openai-codex-payload-calibrated-p50",
      predictedUsage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 450, cacheCreationTokens: 0 },
      costMicros: 6_475,
    })
  })

  test("uses observed cache-write ratios only when history contains them", () => {
    const result = predictPayloadCalibratedCost({
      gatewayModelId: "gpt-5.6-sol",
      requestBodyBytes: 2_000,
      protocol: "openai-responses",
      defaultOutputTokens: 1_024,
      samples: samples.map((sample) => ({
        ...sample,
        cacheReadTokens: Math.floor(sample.inputTokens * 0.5),
        cacheCreationTokens: Math.floor(sample.inputTokens * 0.2),
      })),
      pricing,
    })

    expect(result?.predictedUsage.cacheCreationTokens).toBe(100)
    expect(result?.costMicros).toBeGreaterThan(6_475)
  })
})
