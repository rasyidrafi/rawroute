import { authenticateProxyKey } from "@/lib/auth"
import { writeLog } from "@/lib/logger"
import type { ToolGatewayStatus } from "@/lib/types"

const EXECUTOR_PUBLIC_PREFIX = "/executor"
const EXECUTOR_API_PREFIX = "/api"
// Executor's browser/auth and MCP surfaces are not part of this API-only phase.
const blockedExecutorPrefixes = ["/api/auth", "/api/mcp"]

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

// This is deliberately an allow-list. RawRoute's gateway credential, cookies,
// workspace selectors, and management headers must never cross the service
// boundary. The Executor credential is injected below from server config.
const safeRequestHeaders = [
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "content-encoding",
  "content-language",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "pragma",
  "range",
  "user-agent",
  "x-request-id",
  "traceparent",
  "tracestate",
  "baggage",
] as const

function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id")
  return supplied && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(supplied)
    ? supplied
    : crypto.randomUUID()
}

function executorConfig() {
  const upstream = process.env.EXECUTOR_UPSTREAM_URL?.trim()
  const apiKey = process.env.EXECUTOR_UPSTREAM_API_KEY?.trim()
  if (!upstream || !apiKey || /[\r\n]/.test(apiKey)) return undefined

  try {
    const url = new URL(upstream)
    if (!(["http:", "https:"] as string[]).includes(url.protocol)) return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    return {
      origin: url.origin,
      basePath: url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""),
      apiKey,
    }
  } catch {
    return undefined
  }
}

export async function getToolGatewayStatus(): Promise<ToolGatewayStatus> {
  const config = executorConfig()
  if (!config) return { state: "disabled" }

  try {
    const response = await fetch(`${config.origin}${config.basePath}/api/health`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    })
    return { state: response.ok ? "available" : "unavailable" }
  } catch {
    return { state: "unavailable" }
  }
}

function validExecutorPath(pathname: string) {
  if (
    !(pathname === EXECUTOR_PUBLIC_PREFIX || pathname.startsWith(`${EXECUTOR_PUBLIC_PREFIX}/`))
  ) return undefined

  const upstreamPath = pathname.slice(EXECUTOR_PUBLIC_PREFIX.length)
  if (
    !(upstreamPath === EXECUTOR_API_PREFIX || upstreamPath.startsWith(`${EXECUTOR_API_PREFIX}/`))
  ) return undefined
  if (blockedExecutorPrefixes.some((prefix) => upstreamPath === prefix || upstreamPath.startsWith(`${prefix}/`))) return undefined
  if (upstreamPath.includes("//")) return undefined

  for (const segment of upstreamPath.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return undefined
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) return undefined
  }
  return upstreamPath
}

function forwardedHeaders(source: Headers, internalApiKey: string, id: string) {
  const headers = new Headers()
  for (const name of safeRequestHeaders) {
    const value = source.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set("x-request-id", id)
  headers.set("authorization", `Bearer ${internalApiKey}`)
  return headers
}

function responseHeaders(source: Headers, id: string) {
  const headers = new Headers()
  for (const [name, value] of source.entries()) {
    const normalized = name.toLowerCase()
    if (hopByHopHeaders.has(normalized) || normalized === "set-cookie" || normalized === "location") continue
    headers.set(name, value)
  }
  if (!headers.has("x-request-id")) headers.set("x-request-id", id)
  return headers
}

function errorResponse(status: number, code: string, message: string, id: string) {
  return Response.json({ error: { code, message } }, {
    status,
    headers: { "x-request-id": id },
  })
}

export async function proxyExecutorRequest(request: Request) {
  const id = requestId(request)
  let authenticated: Awaited<ReturnType<typeof authenticateProxyKey>>
  try {
    authenticated = await authenticateProxyKey(request)
  } catch {
    writeLog("error", "gateway", "Executor authentication is unavailable", { requestId: id })
    return errorResponse(503, "executor_auth_unavailable", "Executor authentication is unavailable.", id)
  }

  if (!authenticated) {
    writeLog("warn", "gateway", "Executor request rejected: invalid API key", { requestId: id })
    return errorResponse(401, "invalid_gateway_api_key", "Invalid gateway API key.", id)
  }

  let url: URL
  let path: string | undefined
  try {
    url = new URL(request.url)
    path = validExecutorPath(url.pathname)
  } catch {
    path = undefined
    url = new URL("http://rawroute.invalid/executor/api")
  }
  if (!path) {
    writeLog("warn", "gateway", "Executor request rejected: invalid path", { requestId: id })
    return errorResponse(400, "invalid_executor_path", "Invalid Executor path.", id)
  }

  const config = executorConfig()
  if (!config) {
    writeLog("warn", "gateway", "Executor proxy is not configured", { requestId: id })
    return errorResponse(503, "executor_not_configured", "Executor integration is not configured.", id)
  }

  const target = `${config.origin}${config.basePath}${path}${url.search}`
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: forwardedHeaders(request.headers, config.apiKey, id),
    body,
    cache: "no-store",
    redirect: "manual",
    signal: request.signal,
    ...(body ? { duplex: "half" } : {}),
  }
  const startedAt = Date.now()

  try {
    const response = await fetch(target, init)
    const forwarded = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers, id),
    })
    writeLog(response.ok ? "info" : "warn", "gateway", "Executor request completed", {
      method: request.method,
      path,
      requestId: id,
      status: response.status,
      durationMs: Date.now() - startedAt,
    })
    return forwarded
  } catch {
    writeLog("error", "gateway", "Executor upstream request failed", {
      method: request.method,
      path,
      requestId: id,
      durationMs: Date.now() - startedAt,
    })
    return errorResponse(502, "executor_unavailable", "Executor is unavailable.", id)
  }
}

export function executorPathFromRequest(request: Request) {
  try {
    return validExecutorPath(new URL(request.url).pathname)
  } catch {
    return undefined
  }
}
