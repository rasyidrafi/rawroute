import { authenticateProxyKey } from "@/lib/auth"
import { BudgetDeniedError, createGatewayUsageEvent, getBudgetRequestState, recordUsageEvent, releaseBudgetReservation, reserveBudgetAdmission, type BudgetReservation } from "@/lib/analytics"
import { listCliProxyCatalog } from "@/lib/cliproxy-catalog"
import { writeLog } from "@/lib/logger"
import { normalizeResponsesRequest } from "@/lib/request-normalization"
import { extractUsageMetrics, mergeUsage, type UsageMetrics } from "@/lib/usage-metrics"
import { listAliases, listModels, listProviders } from "@/lib/store"
import type { Protocol } from "@/lib/types"
import { runInWorkspace } from "@/lib/workspace-context"

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

function objectValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0
}

function requestItemCount(payload: Record<string, unknown>, protocol: Protocol) {
  const keys = protocol === "openai-responses" ? ["input", "messages"] : ["messages", "input", "contents"]
  for (const key of keys) {
    const value = payload[key]
    if (Array.isArray(value)) return value.length
  }
  return protocol === "openai-responses" && typeof payload.input === "string" ? 1 : 0
}

function requestToolCount(payload: Record<string, unknown>) {
  const direct = Math.max(arrayLength(payload.tools), arrayLength(payload.functions))
  if (direct) return direct
  for (const key of ["request", "extra_body"]) {
    const nested = objectValue(payload[key])
    if (!nested) continue
    const nestedCount = Math.max(arrayLength(nested.tools), arrayLength(nested.functions))
    if (nestedCount) return nestedCount
  }
  return 0
}

function nestedValue(payload: Record<string, unknown>, path: string[]) {
  let current: unknown = payload
  for (const key of path) {
    current = objectValue(current)?.[key]
    if (current === undefined) return undefined
  }
  return current
}

function extractReasoningEffort(payload: Record<string, unknown>) {
  const paths = [
    ["reasoning", "effort"],
    ["reasoning_effort"],
    ["output_config", "effort"],
    ["thinking", "effort"],
    ["thinking_config", "thinking_level"],
    ["google", "thinking_config", "thinking_level"],
    ["extra_body", "google", "thinking_config", "thinking_level"],
    ["generationConfig", "thinkingConfig", "thinkingLevel"],
  ]
  const found = paths.flatMap((path) => {
    const value = nestedValue(payload, path)
    if (typeof value !== "string" || !value.trim() || value.trim().length > 64) return []
    return [{ path: path.join("."), effort: value.trim() }]
  })
  if (!found.length) return undefined
  const unique = new Set(found.map(({ effort }) => effort))
  return unique.size === 1 ? found[0].effort : found.map(({ path, effort }) => `${path}:${effort}`).join(", ")
}

function requestSummary(provider: string, gatewayModel: string, upstreamModel: string, protocol: Protocol, account: string, payload: Record<string, unknown>, reasoningEffort?: string) {
  const parts = [
    `POST PROVIDER:${provider}`,
    `MODEL:${gatewayModel} -> ${upstreamModel}`,
    `FMT:${protocol}`,
    `ACC:${account}`,
  ]
  if (reasoningEffort) parts.push(`THINK:${reasoningEffort}`)
  parts.push(`MSG:${requestItemCount(payload, protocol)}`)
  const toolCount = requestToolCount(payload)
  if (toolCount) parts.push(`TOOL:${toolCount}`)
  return parts.join(" ")
}

function completionSummary(durationMs: number, ttftMs: number | undefined, usage: UsageMetrics | undefined) {
  const parts = [`DONE ${durationMs}ms`]
  if (ttftMs !== undefined) parts.push(`TTFT:${ttftMs}ms`)
  if (usage) {
    if (usage.input !== undefined) parts.push(`IN:${usage.input}`)
    if (usage.cached !== undefined) parts.push(`(CACHE ↻${usage.cached})`)
    if (usage.output !== undefined) parts.push(`OUT:${usage.output}`)
  }
  return parts.join(" ")
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
  upstreamModel: string
  pricingGatewayModelId: string
  providerModelId?: string
  providerId?: string
  providerName?: string
}

function mergeAvailableModels(models: Awaited<ReturnType<typeof listModels>>, catalogModels: Awaited<ReturnType<typeof listCliProxyCatalog>>["models"]) {
  const configuredGatewayModelIds = new Set(models.map((entry) => entry.gatewayModelId))
  return [...models, ...catalogModels.filter((candidate) => !configuredGatewayModelIds.has(candidate.gatewayModelId))]
}

async function resolveGatewayModel(model: string): Promise<ResolvedGatewayModel> {
  try {
    const [aliases, models, providers, cliProxyCatalog] = await Promise.all([listAliases(), listModels(), listProviders(), listCliProxyCatalog()])
    const availableModels = mergeAvailableModels(models, cliProxyCatalog.models)
    const alias = aliases.find((entry) => entry.alias === model)
    const target = alias
      ? availableModels.find((entry) => entry.id === alias.targetModelId || (entry.gatewayModelId || entry.id) === alias.targetModelId)
      : availableModels.find((entry) => entry.id === model || (entry.gatewayModelId || entry.id) === model)
        || (() => {
          const suffixMatches = availableModels.filter((entry) => entry.upstreamModel === model || (entry.gatewayModelId || entry.id).endsWith(`/${model}`))
          return suffixMatches.length === 1 ? suffixMatches[0] : undefined
        })()
    if (!target) return { forwardedModel: alias?.targetModelId || model, upstreamModel: alias?.targetModelId || model, pricingGatewayModelId: alias?.targetModelId || model }
    const provider = providers.find((entry) => entry.id === target.providerId) || cliProxyCatalog.providers.find((entry) => entry.id === target.providerId)
    const upstreamModel = target.upstreamModel || target.gatewayModelId || model
    return {
      forwardedModel: alias ? upstreamModel : model,
      upstreamModel,
      pricingGatewayModelId: target.gatewayModelId || target.id,
      providerModelId: target.id,
      providerId: target.providerId,
      providerName: provider?.name,
    }
  } catch {
    return { forwardedModel: model, upstreamModel: model, pricingGatewayModelId: model }
  }
}

async function rewriteForwardedBody(body: Uint8Array, forwardedModel: string, model: string, path: string) {
  const shouldNormalizeResponses = protocolForPath(path) === "openai-responses"
  if (forwardedModel === model && !shouldNormalizeResponses) return body
  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
    if (forwardedModel !== model) payload.model = forwardedModel
    const normalized = shouldNormalizeResponses ? normalizeResponsesRequest(payload) : payload
    return new TextEncoder().encode(JSON.stringify(normalized))
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
    const availableModels = mergeAvailableModels(models, cliProxyModels)
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
  let completedNormally = false
  let firstByteAt: number | undefined
  const configuredTimeout = Number(process.env.ROUTING_MAX_STREAM_DURATION_SECONDS || 290) * 1_000 + 10_000
  const readTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 300_000
  const deadline = Date.now() + readTimeoutMs
  const readWithTimeout = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const remaining = Math.max(0, deadline - Date.now())
    if (!remaining) throw new Error("Timed out while collecting streamed usage.")
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out while collecting streamed usage.")), remaining) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
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
  try {
    while (true) {
      const next = await readWithTimeout()
      if (next.done) {
        completedNormally = true
        break
      }
      firstByteAt ??= Date.now()
      buffer += decoder.decode(next.value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""
      for (const line of lines) consumeLine(line)
    }
  } catch {
    // Preserve any usage observed before an upstream disconnect/timeout. The
    // caller will settle the remaining amount conservatively when needed.
    await reader.cancel().catch(() => undefined)
  }
  buffer += decoder.decode()
  for (const line of buffer.split(/\r?\n/)) consumeLine(line)
  return { usage, completedNormally, firstByteAt }
}

export async function proxyGatewayRequest(request: Request, path = new URL(request.url).pathname) {
  const authenticated = await authenticateProxyKey(request)
  if (!authenticated) {
    writeLog("warn", "gateway", "Request rejected: invalid API key", { protocol: protocolForPath(path) })
    return new Response(JSON.stringify({ error: { message: "Invalid gateway API key." } }), { status: 401, headers: { "content-type": "application/json" } })
  }
  return runInWorkspace(authenticated.workspace, () => proxyGatewayRequestInWorkspace(request, path, authenticated.apiKey))
}

async function releaseBudgetReservationWithLog(reservation: BudgetReservation | undefined) {
  try {
    await releaseBudgetReservation(reservation)
  } catch (error) {
    writeLog("warn", "gateway", "Unable to release routing lease", { error: error instanceof Error ? error.message : "Unknown error" })
  }
}

async function proxyGatewayRequestInWorkspace(request: Request, path: string, apiKey: { id: string; name?: string }) {
  const supplied = suppliedGatewayKey(request)

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
  const forwardedBody = await rewriteForwardedBody(body, resolvedModel.forwardedModel, estimate.model, path)
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
  } catch (error) {
    if (error instanceof BudgetDeniedError) {
      return new Response(JSON.stringify({ error: { message: error.message } }), { status: error.status, headers: { "content-type": "application/json", "retry-after": String(error.retryAfterSeconds) } })
    }
    writeLog("error", "gateway", "Budget state unavailable", { error: error instanceof Error ? error.message : "Unknown error" })
    return new Response(JSON.stringify({ error: { message: "Budget state is unavailable." } }), { status: 503, headers: { "content-type": "application/json" } })
  }

  try {
    reservation = await reserveBudgetAdmission(apiKey.id, budgetState.admission, budgetState.usageContext)
  } catch (error) {
    writeLog("error", "gateway", "Shared budget state unavailable", { error: error instanceof Error ? error.message : "Unknown error" })
    return new Response(JSON.stringify({ error: { message: "Budget state is unavailable." } }), { status: 503, headers: { "content-type": "application/json" } })
  }

  const internalKey = process.env.CLIPROXY_API_KEY?.trim() || supplied
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const protocol = protocolForPath(path)
  const payload = objectValue(parsed) || {}
  const provider = resolvedModel.providerName || resolvedModel.providerId || "CLIProxyAPI"
  const account = apiKey.name || "CLIProxyAPI"
  writeLog("info", "gateway", requestSummary(provider, resolvedModel.pricingGatewayModelId, resolvedModel.upstreamModel, protocol, account, payload, extractReasoningEffort(payload)))
  let response: Response
  try {
    response = await proxyToCliProxy(request, path, {
      body: Buffer.from(forwardedBody),
      headers: { authorization: `Bearer ${internalKey}`, "x-api-key": "" },
    })
  } catch (error) {
    await releaseBudgetReservationWithLog(reservation)
    await recordGatewayUsageWithRetry({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: 502, response: undefined, budgetState }, reservation).catch(() => undefined)
    writeLog("error", "gateway", "Upstream request failed", { provider, model: resolvedModel.pricingGatewayModelId, error: error instanceof Error ? error.message : "Unknown error" })
    throw error
  }
  if (response.ok && response.body && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const [downstream, monitor] = response.body.tee()
    const trackedResponse = new Response(downstream, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
    void (async () => {
      try {
        const collected = await collectStreamUsage(monitor)
        await recordGatewayUsageWithRetry({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: collected.completedNormally ? response.status : 502, response: collected.usage, budgetState }, reservation)
          .catch((recordingError) => writeLog("warn", "gateway", "Unable to persist usage event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" }))
        writeLog("info", "gateway", completionSummary(Date.now() - startedAtMs, collected.firstByteAt === undefined ? undefined : collected.firstByteAt - startedAtMs, collected.usage))
      } catch (recordingError) {
        writeLog("warn", "gateway", "Unable to calculate usage event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" })
      } finally {
        await releaseBudgetReservationWithLog(reservation)
      }
    })()
    return trackedResponse
  }
  const usage = await actualResponseUsage(response)
  await recordGatewayUsageWithRetry({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: response.status, response: usage, budgetState }, reservation)
    .catch((recordingError) => writeLog("warn", "gateway", "Unable to persist usage event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" }))
  if (response.ok) writeLog("info", "gateway", completionSummary(Date.now() - startedAtMs, undefined, usage))
  else writeLog("warn", "gateway", `FAILED ${response.status} ${Date.now() - startedAtMs}ms`)
  await releaseBudgetReservationWithLog(reservation)
  return response
}

type GatewayUsageRecordingInput = {
  apiKeyId: string
  model: string
  providerModelId?: string
  protocol: Protocol
  startedAt: string
  status: number
  response: ReturnType<typeof extractUsageMetrics> | undefined
  budgetState: Awaited<ReturnType<typeof getBudgetRequestState>>
  id?: string
}

async function recordGatewayUsageWithRetry(input: GatewayUsageRecordingInput, reservation?: BudgetReservation) {
  const id = input.id || crypto.randomUUID()
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await recordGatewayUsage({ ...input, id }, reservation)
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Usage recording failed.")
}

async function recordGatewayUsage(input: GatewayUsageRecordingInput, reservation?: BudgetReservation) {
  const shouldSettleEstimate = input.status >= 200 && input.status < 300
  const event = await createGatewayUsageEvent({
    id: input.id,
    gatewayKeyId: input.apiKeyId,
    gatewayModelId: input.model,
    providerModelId: input.providerModelId,
    protocol: input.protocol,
    startedAt: input.startedAt,
    status: input.status,
    durationMs: Math.max(0, Date.now() - Date.parse(input.startedAt)),
    metrics: input.response,
    // The reservation is deliberately conservative for admission control. It
    // must not become the historical bill when usage is missing; settle to the
    // best-effort request prediction and only fall back to the reservation if
    // pricing was unavailable for that prediction.
    assumedCostMicros: shouldSettleEstimate
      ? input.budgetState.estimatedCostMicros ?? reservation?.amountMicros
      : undefined,
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
