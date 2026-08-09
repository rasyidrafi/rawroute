import type { AuthType, Protocol } from "@/lib/types"

/**
 * Keep this check identical to CLIProxy's first-party Anthropic URL gate.
 * CLIProxy only emits x-api-key for https://api.anthropic.com (default/443).
 */
export function isAnthropicFirstPartyBaseUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl.trim())
    if (url.username || url.password) return false
    if (url.protocol.toLowerCase() !== "https:") return false
    if (url.hostname.toLowerCase() !== "api.anthropic.com") return false
    return !url.port || url.port === "443"
  } catch {
    return false
  }
}

export function normalizeProviderBaseUrl(protocol: Protocol, baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (protocol !== "anthropic-messages") return trimmed
  try {
    const url = new URL(trimmed)
    if (url.pathname.replace(/\/+$/, "") === "/v1") url.pathname = "/"
    return url.toString().replace(/\/$/, "")
  } catch {
    return trimmed
  }
}

export function supportedProviderAuthTypes(protocol: Protocol, baseUrl: string): AuthType[] {
  if (protocol === "anthropic-messages") {
    return isAnthropicFirstPartyBaseUrl(baseUrl) ? ["x-api-key", "bearer"] : ["bearer"]
  }
  return ["bearer", "none"]
}

export function validateProviderCliProxyCompatibility(input: {
  protocol: Protocol
  baseUrl: string
  authType: AuthType
}) {
  const supported = supportedProviderAuthTypes(input.protocol, input.baseUrl)
  if (!supported.includes(input.authType)) {
    if (input.authType === "x-api-key" && input.protocol !== "anthropic-messages") {
      throw new Error("CLIProxy only supports x-api-key authentication for Anthropic's first-party API.")
    }
    if (input.authType === "x-api-key") {
      throw new Error("CLIProxy only supports x-api-key authentication for https://api.anthropic.com.")
    }
    if (input.authType === "none" && input.protocol === "anthropic-messages") {
      throw new Error("CLIProxy Anthropic credentials require an API key.")
    }
    throw new Error(`Authentication type ${input.authType} is not supported by CLIProxy for this provider.`)
  }
}
