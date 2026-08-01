import { expect, test } from "bun:test"

import { catalogLiteLlmModelInfo, catalogModels } from "@/lib/catalog"
import type { Model, ModelAlias, Provider } from "@/lib/types"

const provider = { id: "p", prefix: "p", protocol: "openai-chat", enabled: true } as Provider
const model = { id: "p/model", providerId: "p", enabled: true, createdAt: "2026-01-01T00:00:00Z" } as Model
const alias: ModelAlias = {
  id: "alias-1",
  alias: "my-cool-model",
  name: "My Cool Model",
  targetModelId: "p/model",
  createdAt: "2026-01-01T00:00:00Z",
}

test("catalog excludes models whose provider is disabled or missing", () => {
  expect(catalogModels([{ ...provider, enabled: false }], [model])).toEqual([])
  expect(catalogModels([], [model])).toEqual([])
  expect(catalogModels([provider], [model])).toHaveLength(1)
})

test("catalog includes an alias that points at an enabled model", () => {
  expect(catalogModels([provider], [model], [alias])).toEqual([
    {
      id: "p/model",
      object: "model",
      created: 1767225600,
      owned_by: "p",
      protocol: "openai-chat",
    },
    {
      id: "my-cool-model",
      object: "model",
      created: 1767225600,
      owned_by: "p",
      protocol: "openai-chat",
    },
  ])
})

test("catalog excludes aliases whose target model is disabled, missing, or whose provider is disabled", () => {
  const disabledModel = { ...model, enabled: false }
  expect(catalogModels([provider], [disabledModel], [alias])).toEqual([])
  expect(catalogModels([provider], [], [alias])).toEqual([])
  expect(catalogModels([{ ...provider, enabled: false }], [model], [alias])).toEqual([])
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

test("LiteLLM catalog includes chat-protocol aliases with the target's upstream model", () => {
  expect(catalogLiteLlmModelInfo([provider], [{
    ...model,
    upstreamModel: "upstream/model",
  }], [alias])).toEqual([
    {
      model_name: "p/model",
      litellm_params: { model: "upstream/model" },
      model_info: { id: "p/model", db_model: false, mode: "chat" },
    },
    {
      model_name: "my-cool-model",
      litellm_params: { model: "upstream/model" },
      model_info: { id: "my-cool-model", db_model: false, mode: "chat" },
    },
  ])
})

test("LiteLLM catalog excludes aliases whose target is not chat protocol", () => {
  const responsesModel = { ...model, protocol: "openai-responses" as const, upstreamModel: "responses-model" }
  expect(catalogLiteLlmModelInfo([provider], [responsesModel], [alias])).toEqual([])
})

test("LiteLLM catalog excludes models Junie cannot call through Chat Completions", () => {
  const incompatibleModels = (["openai-responses", "anthropic-messages"] as const).map((protocol) => ({
    ...model,
    upstreamModel: `${protocol}-model`,
    protocol,
  })) as Model[]

  expect(catalogLiteLlmModelInfo([provider], incompatibleModels)).toEqual([])
})
