import { describe, expect, test } from "bun:test"

import { buildUpstreamUrl, resolveRoute, selectProviderApiKey } from "@/lib/routing"
import type { Model, Provider, ProviderApiKey } from "@/lib/types"

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
}

const model: Model = {
  id: "cx/gpt-codex",
  providerId: "codex",
  name: "gpt-codex",
  upstreamModel: "gpt-5.3-codex",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
}

describe("protocol-preserving routing", () => {
  test("resolves the prefixed model and changes only the upstream model ID", () => {
    const result = resolveRoute([provider], [model], "cx/gpt-codex", "openai-responses")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.upstreamModel).toBe("gpt-5.3-codex")
  })

  test("rejects a request made through a different protocol endpoint", () => {
    const result = resolveRoute([provider], [model], "cx/gpt-codex", "openai-chat")
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "Model cx/gpt-codex uses openai-responses. Send it to /v1/responses.",
    })
  })

  test("allows a model to override its provider protocol", () => {
    const overridden = { ...model, protocol: "anthropic-messages" as const }
    const result = resolveRoute([provider], [overridden], overridden.id, "anthropic-messages")
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

describe("provider API key selection", () => {
  test("round-robins enabled keys belonging to the requested provider", () => {
    const keys: ProviderApiKey[] = [
      { id: "a", providerId: "round-robin-test", name: "A", key: "secret-a", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "disabled", providerId: "round-robin-test", name: "Disabled", key: "secret-disabled", enabled: false, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "other", providerId: "other", name: "Other", key: "secret-other", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", providerId: "round-robin-test", name: "B", key: "secret-b", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ]

    expect(selectProviderApiKey("round-robin-test", keys)?.id).toBe("a")
    expect(selectProviderApiKey("round-robin-test", keys)?.id).toBe("b")
    expect(selectProviderApiKey("round-robin-test", keys)?.id).toBe("a")
  })

  test("returns no key when a provider has no enabled credentials", () => {
    const keys: ProviderApiKey[] = [
      { id: "disabled", providerId: "empty-test", name: "Disabled", key: "secret", enabled: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ]
    expect(selectProviderApiKey("empty-test", keys)).toBeUndefined()
  })
})
