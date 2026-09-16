import { expect, test } from "vitest"

import { normalizeProviderBaseUrl, providerResponsesUrl, supportedProviderAuthTypes, validateProviderCliProxyCompatibility } from "@/lib/cliproxy-provider-capabilities"

test("normalizes the Anthropic base URL to the path CLIProxy expects", () => {
  expect(normalizeProviderBaseUrl("anthropic-messages", "https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com")
  expect(normalizeProviderBaseUrl("openai-chat", "https://api.example.com/v1/")).toBe("https://api.example.com/v1")
})

test("normalizes Responses endpoints without duplicate segments", () => {
  expect(providerResponsesUrl("https://example.com")).toBe("https://example.com/v1/responses")
  expect(providerResponsesUrl("https://example.com/v1/")).toBe("https://example.com/v1/responses")
  expect(providerResponsesUrl("https://example.com/v1/responses")).toBe("https://example.com/v1/responses")
})

test("exposes only authentication modes supported by the selected CLIProxy executor", () => {
  expect(supportedProviderAuthTypes("anthropic-messages", "https://api.anthropic.com")).toEqual(["x-api-key", "bearer"])
  expect(supportedProviderAuthTypes("anthropic-messages", "https://gateway.example.com/v1")).toEqual(["bearer"])
  expect(supportedProviderAuthTypes("openai-chat", "https://gateway.example.com/v1")).toEqual(["bearer", "none"])
  expect(() => validateProviderCliProxyCompatibility({ protocol: "anthropic-messages", baseUrl: "https://gateway.example.com", authType: "x-api-key" })).toThrow("https://api.anthropic.com")
})
