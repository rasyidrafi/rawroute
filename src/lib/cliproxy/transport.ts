import { applyReasoningOverride, mergeComboCustomPayload } from "@/lib/combo-reasoning"
import { providerResponsesUrl } from "@/lib/cliproxy/provider-capabilities"
import { normalizeResponsesRequest } from "@/lib/request-normalization"
import type { Protocol } from "@/lib/types"
import type { ResolvedGatewayModel } from "@/lib/cliproxy/model-resolution"

const DEFAULT_CLIPROXY_URL = "http://cli-proxy-api:8317"

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "expect",
])

function baseUrl() {
  return (process.env.CLIPROXY_URL || DEFAULT_CLIPROXY_URL).replace(/\/$/, "")
}

function upstreamUrl(path: string, search = "") {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return `${baseUrl()}${normalizedPath}${search}`
}

function forwardedHeaders(source: Headers) {
  const headers = new Headers()
  for (const [name, value] of source.entries()) {
    if (!hopByHopHeaders.has(name.toLowerCase())) headers.set(name, value)
  }
  return headers
}

export function responseHeaders(source: Headers) {
  const headers = new Headers()
  for (const [name, value] of source.entries()) {
    if (!hopByHopHeaders.has(name.toLowerCase())) headers.set(name, value)
  }
  return headers
}

function passthroughResponse(response: Response) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
  })
}

export async function proxyToCliProxy(request: Request, path = new URL(request.url).pathname, options: { body?: BodyInit | null; headers?: HeadersInit } = {}) {
  const url = new URL(request.url)
  const headers = forwardedHeaders(request.headers)
  if (options.headers) {
    for (const [name, value] of new Headers(options.headers).entries()) headers.set(name, value)
  }
  const body = options.body !== undefined ? options.body : request.body
  const response = await fetch(upstreamUrl(path, url.search), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    cache: "no-store",
    signal: request.signal,
    ...(body ? { duplex: "half" as const } : {}),
  } as RequestInit & { duplex?: "half" })
  return passthroughResponse(response)
}

export function protocolForPath(path: string): Protocol {
  const normalized = path.toLowerCase()
  if (normalized.includes("/messages")) return "anthropic-messages"
  if (normalized.includes("/responses") || normalized.includes("/backend-api/codex")) return "openai-responses"
  return "openai-chat"
}

function chatToResponses(payload: Record<string, unknown>) {
  const translated: Record<string, unknown> = { ...payload, input: payload.messages }
  delete translated.messages
  if (!Object.hasOwn(translated, "max_output_tokens")) translated.max_output_tokens = translated.max_completion_tokens ?? translated.max_tokens
  delete translated.max_completion_tokens
  delete translated.max_tokens
  return normalizeResponsesRequest(translated)
}

function anthropicToResponses(payload: Record<string, unknown>) {
  const translated: Record<string, unknown> = { ...payload, input: payload.messages, max_output_tokens: payload.max_tokens }
  delete translated.messages
  delete translated.max_tokens
  if (typeof payload.system === "string") translated.instructions = payload.system
  delete translated.system
  return normalizeResponsesRequest(translated)
}

function nativeResponsesBody(body: Uint8Array, model: string, ingress: Protocol, reasoningEffort?: string, customPayload?: Record<string, unknown>) {
  const payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
  payload.model = model
  const translated = ingress === "openai-chat"
    ? chatToResponses(payload)
    : ingress === "anthropic-messages" ? anthropicToResponses(payload) : normalizeResponsesRequest(payload)
  const customized = mergeComboCustomPayload(translated, customPayload)
  const normalized = applyReasoningOverride(customized, reasoningEffort, "openai-responses")
  return JSON.stringify(normalized)
}

export async function proxyToNativeResponses(request: Request, resolved: ResolvedGatewayModel, body: Uint8Array, ingress: Protocol) {
  const config = resolved.nativeResponses!
  const keys = config.authType === "none" ? [undefined] : config.apiKeys.filter((key) => key.enabled && key.key.trim())
  if (!keys.length) return Response.json({ error: { message: "No enabled provider credentials are available." } }, { status: 503 })
  let last: Response | undefined
  for (const key of keys) {
    const headers = new Headers(config.headers)
    headers.set("content-type", "application/json")
    headers.set("accept", request.headers.get("accept") || "application/json")
    if (config.authType === "bearer" && key) headers.set("authorization", `Bearer ${key.key}`)
    const response = await fetch(providerResponsesUrl(config.baseUrl), {
      method: "POST", headers, body: nativeResponsesBody(body, resolved.upstreamModel, ingress, resolved.reasoningEffort, resolved.customPayload), signal: request.signal, cache: "no-store",
    })
    if (response.ok || keys.length === 1) return passthroughResponse(response)
    if (last) await last.body?.cancel().catch(() => undefined)
    last = response
  }
  return passthroughResponse(last!)
}

export async function rewriteForwardedBody(body: Uint8Array, forwardedModel: string, model: string, path: string, reasoningEffort?: string, customPayload?: Record<string, unknown>) {
  const shouldNormalizeResponses = protocolForPath(path) === "openai-responses"
  if (forwardedModel === model && !shouldNormalizeResponses && !reasoningEffort && !customPayload) return body
  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
    if (forwardedModel !== model) payload.model = forwardedModel
    const normalized = shouldNormalizeResponses ? normalizeResponsesRequest(payload) : payload
    const customized = mergeComboCustomPayload(normalized, customPayload)
    customized.model = forwardedModel
    const overridden = applyReasoningOverride(customized, reasoningEffort, protocolForPath(path))
    return new TextEncoder().encode(JSON.stringify(overridden))
  } catch {
    return body
  }
}

export async function cliProxyHealth() {
  try {
    const response = await fetch(upstreamUrl("/healthz"), { cache: "no-store", signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}
