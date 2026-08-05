import { describe, expect, test } from "vitest"

import { buildUpstreamUrl, resolveRoute } from "@/lib/routing"
import type { Model, ModelAlias, Provider } from "@/lib/types"

const provider: Provider = {
  id: "codex",
  name: "Codex",
  prefix: "cx",
  baseUrl: "https://api.example.com/v1",
  protocol: "openai-responses",
  authType: "bearer",
  headers: {},
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  apiKeyCount: 0,
  enabledApiKeyCount: 0,
  modelCount: 0,
  enabledModelCount: 0,
}

const model: Model = {
  id: "cx/gpt-codex",
  providerId: "codex",
  gatewayModelId: "cx/gpt-codex",
  name: "gpt-codex",
  upstreamModel: "gpt-5.3-codex",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
}

const alias: ModelAlias = {
  id: "alias-1",
  alias: "my-cool-model",
  name: "My Cool Model",
  targetModelId: "cx/gpt-codex",
  createdAt: "2026-01-01T00:00:00.000Z",
}

describe("protocol-preserving routing", () => {
  test("resolves the prefixed model and changes only the upstream model ID", () => {
    const result = resolveRoute([provider], [model], [], "cx/gpt-codex", "openai-responses")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.upstreamModel).toBe("gpt-5.3-codex")
  })

  test("rejects a request made through a different protocol endpoint", () => {
    const result = resolveRoute([provider], [model], [], "cx/gpt-codex", "openai-chat")
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "Model cx/gpt-codex uses openai-responses. Send it to /v1/responses.",
    })
  })

  test("allows a model to override its provider protocol", () => {
    const overridden = { ...model, protocol: "anthropic-messages" as const }
    const result = resolveRoute([provider], [overridden], [], overridden.id, "anthropic-messages")
    expect(result.ok).toBe(true)
  })

  test("does not duplicate /v1 when the provider base URL already contains it", () => {
    expect(buildUpstreamUrl("https://api.example.com/v1", "/v1/responses").toString())
      .toBe("https://api.example.com/v1/responses")
  })

  test("honors provider base paths and custom model paths", () => {
    expect(buildUpstreamUrl("https://proxy.example.com/tenant/acme", "/custom/infer").toString())
      .toBe("https://proxy.example.com/tenant/acme/custom/infer")
  })
})

describe("alias routing", () => {
  test("resolves an alias to its target model's upstream model and provider", () => {
    const result = resolveRoute([provider], [model], [alias], "my-cool-model", "openai-responses")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.model).toBe(model)
      expect(result.provider).toBe(provider)
      expect(result.upstreamModel).toBe("gpt-5.3-codex")
      expect(result.protocol).toBe("openai-responses")
    }
  })

  test("resolves an alias case-insensitively", () => {
    const result = resolveRoute([provider], [model], [alias], "My-Cool-Model", "openai-responses")
    expect(result.ok).toBe(true)
  })

  test("rejects an unknown alias", () => {
    const result = resolveRoute([provider], [model], [alias], "no-such-alias", "openai-responses")
    expect(result).toEqual({
      ok: false,
      status: 404,
      message: "Unknown or disabled model: no-such-alias",
    })
  })

  test("rejects an alias whose target model is disabled or missing", () => {
    const brokenAlias = { ...alias, targetModelId: "cx/disabled-model" }
    const result = resolveRoute([provider], [model], [brokenAlias], "my-cool-model", "openai-responses")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  test("rejects an alias sent to a different protocol endpoint with the target's protocol", () => {
    const result = resolveRoute([provider], [model], [alias], "my-cool-model", "openai-chat")
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "Model cx/gpt-codex uses openai-responses. Send it to /v1/responses.",
    })
  })

  test("prefers a direct model match over an alias with the same ID", () => {
    const modelAlias = { ...alias, alias: "cx/gpt-codex" }
    const result = resolveRoute([provider], [model], [modelAlias], "cx/gpt-codex", "openai-responses")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.model).toBe(model)
  })
})
