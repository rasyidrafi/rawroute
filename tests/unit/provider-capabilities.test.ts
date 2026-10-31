import { expect, test } from "bun:test"
import { normalizeProviderBaseUrl, providerResponsesUrl, supportedProviderAuthTypes } from "../../packages/gateway-ai/src/contracts/provider-capabilities"

test("canonicalizes protocol endpoints without duplicating URL segments", () => {
  expect(normalizeProviderBaseUrl("anthropic-messages", "https://gateway.example/v1/")).toBe("https://gateway.example")
  expect(normalizeProviderBaseUrl("openai-chat", "https://gateway.example/v1/")).toBe("https://gateway.example/v1")
  expect(providerResponsesUrl("https://gateway.example")).toBe("https://gateway.example/v1/responses")
  expect(providerResponsesUrl("https://gateway.example/v1/")).toBe("https://gateway.example/v1/responses")
  expect(providerResponsesUrl("https://gateway.example/v1/responses")).toBe("https://gateway.example/v1/responses")
})

test("provider authentication choices match the methods supported by direct forwarding", () => {
  expect(supportedProviderAuthTypes()).toEqual(["bearer", "x-api-key", "none"])
})
