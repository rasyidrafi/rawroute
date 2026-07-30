import { expect, test } from "bun:test"

import { catalogLiteLlmModelInfo, catalogModels } from "@/lib/catalog"
import type { Model, Provider } from "@/lib/types"

const provider = { id: "p", prefix: "p", protocol: "openai-chat", enabled: true } as Provider
const model = { id: "p/model", providerId: "p", enabled: true, createdAt: "2026-01-01T00:00:00Z" } as Model

test("catalog excludes models whose provider is disabled or missing", () => {
  expect(catalogModels([{ ...provider, enabled: false }], [model])).toEqual([])
  expect(catalogModels([], [model])).toEqual([])
  expect(catalogModels([provider], [model])).toHaveLength(1)
})

test("LiteLLM catalog returns model discovery metadata", () => {
  expect(catalogLiteLlmModelInfo([provider], [{
    ...model,
    upstreamModel: "upstream/model",
  }])).toEqual([{
    model_name: "p/model",
    litellm_params: { model: "upstream/model" },
    model_info: {
      id: "p/model",
      db_model: false,
      mode: "chat",
    },
  }])
})

test("LiteLLM catalog excludes models Junie cannot call through Chat Completions", () => {
  const incompatibleModels = ["openai-responses", "anthropic-messages"].map((protocol) => ({
    ...model,
    upstreamModel: `${protocol}-model`,
    protocol,
  })) as Model[]

  expect(catalogLiteLlmModelInfo([provider], incompatibleModels)).toEqual([])
})
