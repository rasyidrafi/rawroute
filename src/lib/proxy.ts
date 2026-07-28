import { validateProxyKey } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { validateProviderHeaders } from "@/lib/provider-headers"
import { buildUpstreamUrl, resolveRoute } from "@/lib/routing"
import { readData } from "@/lib/store"
import { protocolPaths, type Protocol } from "@/lib/types"

const blockedRequestHeaders = new Set([
  "authorization", "x-api-key", "cookie", "host", "content-length", "connection",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
])

const blockedResponseHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie",
])

function maximumBodyBytes() {
  const configured = Number(process.env.MAX_PROXY_BODY_BYTES || 10 * 1024 * 1024)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 10 * 1024 * 1024
}

async function readBoundedBody(request: Request, maximum: number) {
  const declared = request.headers.get("content-length")
  if (declared && Number(declared) > maximum) return { ok: false as const }
  if (!request.body) return { ok: true as const, value: "" }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximum) {
      await reader.cancel("Request body too large")
      return { ok: false as const }
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true as const, value: new TextDecoder().decode(body) }
}

export async function proxyRequest(request: Request, requestedProtocol: Protocol) {
  if (!(await validateProxyKey(request))) return jsonError("Invalid gateway API key.", 401)
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415)
  }

  const body = await readBoundedBody(request, maximumBodyBytes())
  if (!body.ok) return jsonError("Request body exceeds the configured limit.", 413)
  const raw = body.value
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return jsonError("Request body must be valid JSON.", 400)
  }

  if (typeof payload.model !== "string") return jsonError("A model ID is required.", 400)
  const data = await readData()
  const route = resolveRoute(data.providers, data.models, payload.model, requestedProtocol)
  if (!route.ok) return jsonError(route.message, route.status)
  const { model, provider, protocol: modelProtocol } = route

  try {
    payload.model = model.upstreamModel
    const headers = new Headers()
    request.headers.forEach((value, key) => {
      if (!blockedRequestHeaders.has(key.toLowerCase())) headers.set(key, value)
    })
    headers.set("content-type", "application/json")
    Object.entries(validateProviderHeaders(provider.headers)).forEach(([key, value]) => headers.set(key, value))

    if (provider.authType === "bearer" && provider.secret) headers.set("authorization", `Bearer ${provider.secret}`)
    if (provider.authType === "x-api-key" && provider.secret) headers.set("x-api-key", provider.secret)
    if (provider.authType === "custom-header" && provider.authHeader && provider.secret) {
      headers.set(provider.authHeader, provider.secret)
    }

    const upstream = await fetch(buildUpstreamUrl(provider.baseUrl, model.upstreamPath || protocolPaths[modelProtocol]), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: request.signal,
      redirect: "manual",
    })
    const responseHeaders = new Headers()
    upstream.headers.forEach((value, key) => {
      if (!blockedResponseHeaders.has(key.toLowerCase())) responseHeaders.set(key, value)
    })
    responseHeaders.set("x-rawroute-provider", provider.id)
    responseHeaders.set("x-rawroute-model", model.id)
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
  } catch (error) {
    return jsonError("Upstream request failed.", 502, error instanceof Error ? error.message : undefined)
  }
}
