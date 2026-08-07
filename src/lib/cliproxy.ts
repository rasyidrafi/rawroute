import { authenticateProxyKey } from "@/lib/auth"
import { BudgetDeniedError, createGatewayUsageEvent, getBudgetRequestState, recordUsageEvent, releaseBudgetReservation, reserveBudgetAdmission, type BudgetReservation } from "@/lib/analytics"
import { listCliProxyCatalog } from "@/lib/cliproxy-catalog"
import { extractUsageMetrics, mergeUsage, type UsageMetrics } from "@/lib/usage-metrics"
import { listAliases, listModels } from "@/lib/store"
import type { Protocol } from "@/lib/types"

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
])

function estimateRequest(body: unknown) {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const serialized = JSON.stringify(body || "")
  const inputTokens = Math.max(1, Math.ceil(serialized.length / 4))
  const outputValue = value.max_output_tokens ?? value.max_completion_tokens ?? value.max_tokens
  const outputTokens = typeof outputValue === "number" && Number.isFinite(outputValue) && outputValue > 0 ? Math.floor(outputValue) : 4_096
  const model = typeof value.model === "string" ? value.model : "unknown"
  return { model, inputTokens, outputTokens }
}

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

function responseHeaders(source: Headers) {
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

function suppliedGatewayKey(request: Request) {
  const authorization = request.headers.get("authorization")
  if (authorization?.slice(0, 7).toLowerCase() === "bearer ") return authorization.slice(7).trim()
  return request.headers.get("x-api-key")?.trim() || ""
}

function protocolForPath(path: string): Protocol {
  const normalized = path.toLowerCase()
  if (normalized.includes("/messages")) return "anthropic-messages"
  if (normalized.includes("/responses") || normalized.includes("/backend-api/codex")) return "openai-responses"
  return "openai-chat"
}

async function actualResponseUsage(response: Response) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) return undefined
  const payload = await response.clone().json().catch(() => undefined) as Record<string, unknown> | undefined
  return payload ? extractUsageMetrics(payload) : undefined
}

interface ResolvedGatewayModel {
  forwardedModel: string
  pricingGatewayModelId: string
  providerModelId?: string
}

async function resolveGatewayModel(model: string): Promise<ResolvedGatewayModel> {
  try {
    const [aliases, models, cliProxyCatalog] = await Promise.all([listAliases(), listModels(), listCliProxyCatalog()])
    const availableModels = [...models, ...cliProxyCatalog.models.filter((candidate) => !models.some((entry) => entry.gatewayModelId === candidate.gatewayModelId))]
    const alias = aliases.find((entry) => entry.alias === model)
    const target = alias
      ? availableModels.find((entry) => entry.id === alias.targetModelId || (entry.gatewayModelId || entry.id) === alias.targetModelId)
      : availableModels.find((entry) => entry.id === model || (entry.gatewayModelId || entry.id) === model)
    if (!target) return { forwardedModel: alias?.targetModelId || model, pricingGatewayModelId: alias?.targetModelId || model }
    return {
      forwardedModel: alias ? target.upstreamModel || target.gatewayModelId || model : model,
      pricingGatewayModelId: target.gatewayModelId || target.id,
      providerModelId: target.id,
    }
  } catch {
    return { forwardedModel: model, pricingGatewayModelId: model }
  }
}

async function rewriteModel(body: Uint8Array, forwardedModel: string, model: string) {
  if (forwardedModel === model) return body
  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
    payload.model = forwardedModel
    return new TextEncoder().encode(JSON.stringify(payload))
  } catch {
    return body
  }
}

async function addAliasesToModelsResponse(response: Response) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) return response
  const payload = await response.clone().json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!payload || !Array.isArray(payload.data)) return response
  try {
    const aliases = await listAliases()
    const [models, cliProxyModels] = await Promise.all([listModels(), listCliProxyCatalog().then((catalog) => catalog.models)])
    const availableModels = [...models, ...cliProxyModels.filter((candidate) => !models.some((entry) => entry.gatewayModelId === candidate.gatewayModelId))]
    const existing = new Set(payload.data.map((entry) => entry && typeof entry === "object" && "id" in entry ? String((entry as Record<string, unknown>).id) : ""))
    const additions = aliases.flatMap((alias) => {
      const target = availableModels.find((entry) => entry.id === alias.targetModelId || (entry.gatewayModelId || entry.id) === alias.targetModelId)
      const targetInUpstream = existing.has(alias.targetModelId)
      if ((!target && !targetInUpstream) || existing.has(alias.alias)) return []
      return [{ id: alias.alias, object: "model", created: Math.floor(Date.parse(alias.createdAt) / 1000) || Math.floor(Date.now() / 1000), owned_by: "rawroute" }]
    })
    if (!additions.length) return response
    return new Response(JSON.stringify({ ...payload, data: [...payload.data, ...additions] }), { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
  } catch {
    return response
  }
}

async function collectStreamUsage(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: UsageMetrics | undefined
  const consumeLine = (line: string) => {
    const value = line.trim()
    if (!value.startsWith("data:")) return
    const payload = value.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      usage = mergeUsage(usage, extractUsageMetrics(parsed))
    } catch {
      // A provider may emit non-JSON comments or partial events; keep reading.
    }
  }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    buffer += decoder.decode(next.value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ""
    for (const line of lines) consumeLine(line)
  }
  buffer += decoder.decode()
  if (buffer) consumeLine(buffer)
  return usage
}

export async function proxyGatewayRequest(request: Request, path = new URL(request.url).pathname) {
  const authenticated = await authenticateProxyKey(request)
  if (!authenticated) return new Response(JSON.stringify({ error: { message: "Invalid gateway API key." } }), { status: 401, headers: { "content-type": "application/json" } })
  const supplied = suppliedGatewayKey(request)
  const { apiKey } = authenticated

  const isInference = request.method !== "GET" && request.method !== "HEAD" && !path.endsWith("/models")
  if (!isInference) {
    const internalKey = process.env.CLIPROXY_API_KEY?.trim() || supplied
    const response = await proxyToCliProxy(request, path, { headers: { authorization: `Bearer ${internalKey}`, "x-api-key": "" } })
    return path.endsWith("/models") && request.method === "GET" ? addAliasesToModelsResponse(response) : response
  }

  const body = new Uint8Array(await request.clone().arrayBuffer())
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(body)) } catch { parsed = {} }
  const estimate = estimateRequest(parsed)
  const resolvedModel = await resolveGatewayModel(estimate.model)
  const forwardedBody = await rewriteModel(body, resolvedModel.forwardedModel, estimate.model)
  let budgetState: Awaited<ReturnType<typeof getBudgetRequestState>>
  let reservation: BudgetReservation | undefined
  try {
    budgetState = await getBudgetRequestState(
      apiKey.id,
      resolvedModel.pricingGatewayModelId,
      resolvedModel.providerModelId,
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined,
      body.byteLength,
    )
    reservation = await reserveBudgetAdmission(apiKey.id, budgetState.admission, budgetState.usageContext)
  } catch (error) {
    if (error instanceof BudgetDeniedError) {
      return new Response(JSON.stringify({ error: { message: error.message } }), { status: error.status, headers: { "content-type": "application/json", "retry-after": String(error.retryAfterSeconds) } })
    }
    return new Response(JSON.stringify({ error: { message: "Budget state is unavailable." } }), { status: 503, headers: { "content-type": "application/json" } })
  }

  const internalKey = process.env.CLIPROXY_API_KEY?.trim() || supplied
  const startedAt = new Date().toISOString()
  let response: Response
  try {
    response = await proxyToCliProxy(request, path, {
      body: Buffer.from(forwardedBody),
      headers: { authorization: `Bearer ${internalKey}`, "x-api-key": "" },
    })
  } catch (error) {
    await releaseBudgetReservation(reservation).catch(() => undefined)
    await recordGatewayUsage({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol: protocolForPath(path), startedAt, status: 502, response: undefined, budgetState }).catch(() => undefined)
    throw error
  }
  if (response.ok && response.body && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const [downstream, monitor] = response.body.tee()
    const trackedResponse = new Response(downstream, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
    void (async () => {
      try {
        const usage = await collectStreamUsage(monitor)
        await recordGatewayUsage({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol: protocolForPath(path), startedAt, status: response.status, response: usage, budgetState })
      } finally {
        await releaseBudgetReservation(reservation).catch(() => undefined)
      }
    })()
    return trackedResponse
  }
  const usage = response.ok ? await actualResponseUsage(response) : undefined
  await recordGatewayUsage({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol: protocolForPath(path), startedAt, status: response.status, response: usage, budgetState }).catch(() => undefined)
  await releaseBudgetReservation(reservation).catch(() => undefined)
  return response
}

async function recordGatewayUsage(input: {
  apiKeyId: string
  model: string
  providerModelId?: string
  protocol: Protocol
  startedAt: string
  status: number
  response: ReturnType<typeof extractUsageMetrics> | undefined
  budgetState: Awaited<ReturnType<typeof getBudgetRequestState>>
}) {
  const event = await createGatewayUsageEvent({
    gatewayKeyId: input.apiKeyId,
    gatewayModelId: input.model,
    providerModelId: input.providerModelId,
    protocol: input.protocol,
    startedAt: input.startedAt,
    status: input.status,
    durationMs: Math.max(0, Date.now() - Date.parse(input.startedAt)),
    metrics: input.response,
  }, input.budgetState.pricing)
  await recordUsageEvent(event, input.budgetState.usageContext)
}

export async function cliProxyHealth() {
  try {
    const response = await fetch(upstreamUrl("/healthz"), { cache: "no-store", signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

export async function cliproxyManagement(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY?.trim()
  if (managementKey) headers.set("x-management-key", managementKey)
  return fetch(upstreamUrl(path), {
    ...init,
    headers,
    cache: "no-store",
  })
}

export async function cliproxyManagementJson<T>(path: string, init: RequestInit = {}) {
  const response = await cliproxyManagement(path, init)
  const data = await response.json().catch(() => undefined) as T | undefined
  return { response, data }
}

export function maskSecret(value: unknown) {
  if (typeof value !== "string" || value.length < 5) return "••••••••"
  return `${value.slice(0, 3)}${"•".repeat(Math.min(12, Math.max(4, value.length - 3)))}${value.slice(-2)}`
}

const secretKeyPattern = /(api[-_]?key|secret|token|password|private[-_]?key|authorization)/i

export function redactSecrets(value: unknown, key = ""): unknown {
  if (secretKeyPattern.test(key)) {
    if (Array.isArray(value)) return value.map(maskSecret)
    if (typeof value === "string") return maskSecret(value)
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)]))
  }
  return value
}
