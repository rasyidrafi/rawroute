import type { AuthType, Protocol } from "./domain"

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

export function providerResponsesUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  try {
    const url = new URL(trimmed)
    const path = url.pathname.replace(/\/+$/, "")
    if (path.endsWith("/responses")) return url.toString().replace(/\/+$/, "")
    url.pathname = path.endsWith("/v1") ? `${path}/responses` : `${path}/v1/responses`
    return url.toString()
  } catch {
    if (trimmed.endsWith("/responses")) return trimmed
    return trimmed.endsWith("/v1") ? `${trimmed}/responses` : `${trimmed}/v1/responses`
  }
}

export function supportedProviderAuthTypes(): AuthType[] {
  return ["bearer", "x-api-key", "none"]
}
