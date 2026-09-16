import { describe, expect, test } from "vitest"

import { applyComboMemberPolicy, applyReasoningOverride, comboMembers, memberPolicyConfigHash, normalizeComboCustomPayload, stripReasoningFields, supportedReasoningEfforts } from "@/lib/combo-reasoning"

describe("combo reasoning policies", () => {
  test("migrates legacy combo members to inherit mode", () => {
    expect(comboMembers({ memberModelIds: ["p/a", "p/b"] })).toEqual([
      { modelId: "p/a", reasoning: { mode: "inherit" } },
      { modelId: "p/b", reasoning: { mode: "inherit" } },
    ])
  })

  test("removes client reasoning before applying a router override", () => {
    const payload = stripReasoningFields({
      reasoning: { effort: "low" },
      reasoning_effort: "medium",
      thinking: { type: "enabled" },
      output_config: { effort: "high", verbosity: "low" },
      extra_body: { reasoning_effort: "max", keep: true },
    })
    expect(payload).toEqual({ output_config: { verbosity: "low" }, extra_body: { keep: true } })
    expect(applyComboMemberPolicy({ reasoning_effort: "low" }, { modelId: "p/a", reasoning: { mode: "override", effort: "xhigh" } })).toEqual({ payload: {}, effort: "xhigh" })
  })

  test("keeps the original payload for inherit and strips it for provider default", () => {
    expect(applyComboMemberPolicy({ reasoning_effort: "low" }, { modelId: "p/a", reasoning: { mode: "inherit" } }).payload).toEqual({ reasoning_effort: "low" })
    expect(applyComboMemberPolicy({ reasoning_effort: "low" }, { modelId: "p/a", reasoning: { mode: "provider-default" } }).payload).toEqual({})
  })

  test("deep merges custom payload without changing protected request fields", () => {
    expect(applyComboMemberPolicy({ model: "combo", messages: [{ role: "user", content: "hello" }], response_format: { type: "text" }, stop: ["old"] }, {
      modelId: "p/a",
      reasoning: { mode: "inherit" },
      customPayload: { response_format: { json_schema: { name: "answer" } }, stop: ["new"], temperature: 0.2 },
    }).payload).toEqual({
      model: "combo",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "text", json_schema: { name: "answer" } },
      stop: ["new"],
      temperature: 0.2,
    })
    expect(() => normalizeComboCustomPayload({ model: "other" })).toThrow("Custom payload cannot override model.")
    expect(() => normalizeComboCustomPayload({ extra_body: { stream: true } })).toThrow("Custom payload cannot override extra_body.stream.")
    expect(() => normalizeComboCustomPayload([])).toThrow("Custom payload must be a JSON object.")
  })

  test("uses a stable policy hash for custom JSON key order", () => {
    const left = memberPolicyConfigHash({ modelId: "p/a", reasoning: { mode: "inherit" }, customPayload: { z: 1, nested: { b: 2, a: 1 } } })
    const right = memberPolicyConfigHash({ modelId: "p/a", reasoning: { mode: "inherit" }, customPayload: { nested: { a: 1, b: 2 }, z: 1 } })
    expect(left).toBe(right)
  })

  test("uses model capability choices", () => {
    expect(supportedReasoningEfforts({ reasoningCapability: { mode: "enabled", supportedEfforts: ["High", "xhigh"] } })).toEqual(["high", "xhigh"])
    expect(supportedReasoningEfforts({ reasoningCapability: { mode: "disabled" } })).toEqual([])
  })

  test("compiles overrides for each client protocol without changing the model", () => {
    const payload = { model: "workspace/provider/model", reasoning_effort: "low", output_config: { verbosity: "low" } }
    expect(applyReasoningOverride(payload, "high", "openai-chat")).toEqual({ model: "workspace/provider/model", reasoning_effort: "high", output_config: { verbosity: "low" } })
    expect(applyReasoningOverride(payload, "xhigh", "openai-responses")).toEqual({ model: "workspace/provider/model", reasoning: { effort: "xhigh" }, output_config: { verbosity: "low" } })
    expect(applyReasoningOverride(payload, "max", "anthropic-messages")).toEqual({ model: "workspace/provider/model", thinking: { type: "adaptive" }, output_config: { verbosity: "low", effort: "max" } })
    expect(applyReasoningOverride(payload, "auto", "anthropic-messages")).toEqual({ model: "workspace/provider/model", thinking: { type: "enabled" }, output_config: { verbosity: "low" } })
    expect(applyReasoningOverride(payload, "none", "anthropic-messages")).toEqual({ model: "workspace/provider/model", thinking: { type: "disabled" }, output_config: { verbosity: "low" } })
    expect(applyReasoningOverride({ model: "m", reasoning: { effort: "low", summary: "auto" } }, "high", "openai-responses")).toEqual({ model: "m", reasoning: { summary: "auto", effort: "high" } })
  })
})
