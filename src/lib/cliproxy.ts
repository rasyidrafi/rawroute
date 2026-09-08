import { authenticateProxyKey } from "@/lib/auth"
import { BudgetDeniedError, BudgetPricingUnavailableError, createGatewayUsageEvent, getBudgetRequestState, recordUsageEvent, releaseBudgetReservation, reserveBudgetAdmission, type BudgetReservation } from "@/lib/analytics"
import { codexWorkspacePrefix } from "@/lib/cliproxy-codex"
import { ensureNonCodexProviderProjection, nonCodexProviderPrefix } from "@/lib/cliproxy-provider-sync"
import { catalogModels } from "@/lib/catalog"
import { writeLog } from "@/lib/logger"
import { resolveSharedModelForRecipient } from "@/lib/model-shares"
import { normalizeResponsesRequest } from "@/lib/request-normalization"
import { extractUsageMetrics, mergeUsage, type UsageMetrics } from "@/lib/usage-metrics"
import { listAliases, listCombos, listModels, listProviders } from "@/lib/store"
import type { Protocol, UsageEvent } from "@/lib/types"
import { currentWorkspaceId, runInWorkspace } from "@/lib/workspace-context"
import { getWorkspace } from "@/lib/workspaces"
import { upstreamFailure } from "@/lib/upstream-failure"

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

function requestSummary(provider: string, gatewayModel: string, upstreamModel: string, receivedProtocol: Protocol, upstreamProtocol: Protocol, account: string, payload: Record<string, unknown>, reasoningEffort?: string) {
  const parts = [
    `POST PROVIDER:${provider}`,
    `MODEL:${gatewayModel} -> ${upstreamModel}`,
    `FMT:${receivedProtocol} -> ${upstreamProtocol}`,
    `KEY:${account}`,
  ]
  if (reasoningEffort) parts.push(`THINK:${reasoningEffort}`)
  parts.push(`MSG:${requestItemCount(payload, receivedProtocol)}`)
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
  } else parts.push("USAGE:unknown")
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

function protocolForLogPath(path: string): Protocol | "catalog" {
  const normalized = path.toLowerCase()
  if (normalized.endsWith("/models") || normalized.endsWith("/models/")) return "catalog"
  return protocolForPath(path)
}

function actualResponseUsage(body: Uint8Array, contentType: string | null) {
  if (!contentType?.toLowerCase().includes("json")) return undefined
  let payload: Record<string, unknown> | undefined
  try { payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown> } catch { return undefined }
  return payload ? extractUsageMetrics(payload) : undefined
}

interface ResolvedGatewayModel {
  forwardedModel: string
  upstreamModel: string
  upstreamProtocol: Protocol
  pricingGatewayModelId: string
  providerModelId?: string
  providerId?: string
  providerName?: string
  promptCacheKey: boolean
  shared?: { id: string; ownerWorkspaceId: string; ownerWorkspaceName: string; consumerWorkspaceId: string; consumerWorkspaceName: string; sourceGatewayModelId: string; sourceModelId: string }
}

export class GatewayModelResolutionError extends Error {
  readonly status: 400 | 503
  readonly code: "model_not_found" | "model_resolver_unavailable"

  constructor(message: string, status: 400 | 503, code: GatewayModelResolutionError["code"]) {
    super(message)
    this.name = "GatewayModelResolutionError"
    this.status = status
    this.code = code
  }
}

function modelGatewayId(model: { gatewayModelId?: string; id: string }) {
  return model.gatewayModelId || model.id
}

function activeModel(model: Awaited<ReturnType<typeof listModels>>[number], provider: Awaited<ReturnType<typeof listProviders>>[number] | undefined) {
  return Boolean(provider && provider.enabled !== false && model.enabled)
}

function modelNotFound(model: string): never {
  throw new GatewayModelResolutionError(`Model ${model} is not configured or is unavailable.`, 400, "model_not_found")
}

function providerModelSuffix(provider: Awaited<ReturnType<typeof listProviders>>[number], model: Awaited<ReturnType<typeof listModels>>[number]) {
  const gatewayModelId = modelGatewayId(model)
  const prefix = `${provider.prefix}/`
  if (!gatewayModelId.startsWith(prefix)) modelNotFound(gatewayModelId)
  const suffix = gatewayModelId.slice(prefix.length).trim()
  if (!suffix) modelNotFound(gatewayModelId)
  return suffix
}

async function resolveGatewayModel(model: string): Promise<ResolvedGatewayModel> {
  const [aliases, models, providers] = await Promise.all([listAliases(), listModels(), listProviders()])
  const providerIndex = new Map(providers.map((provider) => [provider.id, provider]))
  const availableModels = models.filter((candidate) => activeModel(candidate, providerIndex.get(candidate.providerId)))
  const alias = aliases.find((entry) => entry.alias === model)
  if (alias?.sharedModelId) {
    const consumerWorkspaceId = currentWorkspaceId()
    const [shared, consumerWorkspace] = await Promise.all([resolveSharedModelForRecipient(alias.sharedModelId, consumerWorkspaceId), getWorkspace(consumerWorkspaceId)])
    if (!shared || !consumerWorkspace) throw new GatewayModelResolutionError("Shared model is no longer available.", 400, "model_not_found")
    return runInWorkspace(shared.owner, async () => {
      const target = shared.model
      const provider = shared.provider
      const upstreamModel = target.upstreamModel || modelGatewayId(target)
      const forwardedModel = provider.prefix === "codex"
        ? `${codexWorkspacePrefix(currentWorkspaceId())}/${upstreamModel}`
        : `${nonCodexProviderPrefix(currentWorkspaceId(), provider.id)}/${providerModelSuffix(provider, target)}`
      if (provider.prefix !== "codex") await ensureNonCodexProviderProjection(provider.id)
      return {
        forwardedModel,
        upstreamModel,
        upstreamProtocol: provider.protocol || (provider.prefix === "codex" ? "openai-responses" : "openai-chat"),
        pricingGatewayModelId: modelGatewayId(target),
        providerModelId: target.id,
        providerId: target.providerId,
        providerName: provider.name,
        promptCacheKey: provider.protocol !== "anthropic-messages" && provider.supportPromptCacheKey === true,
        shared: {
          id: shared.share.id,
          ownerWorkspaceId: shared.owner.id,
          ownerWorkspaceName: shared.owner.name,
          consumerWorkspaceId,
          consumerWorkspaceName: consumerWorkspace.name,
          sourceGatewayModelId: modelGatewayId(target),
          sourceModelId: target.id,
        },
      }
    })
  }
  const target = alias
    ? availableModels.find((entry) => entry.id === alias.targetModelId || modelGatewayId(entry) === alias.targetModelId)
    : availableModels.find((entry) => entry.id === model || modelGatewayId(entry) === model)
      || (() => {
        if (model.includes("/")) return undefined
        const suffixMatches = availableModels.filter((entry) => entry.upstreamModel === model || modelGatewayId(entry).endsWith(`/${model}`))
        return suffixMatches.length === 1 ? suffixMatches[0] : undefined
      })()
  if (!target) return modelNotFound(model)

  const provider = providerIndex.get(target.providerId)
  if (!provider || provider.enabled === false) return modelNotFound(model)
  // The request endpoint is the client source format. The saved provider
  // protocol identifies the CLIProxy upstream executor; it is not an ingress
  // restriction because CLIProxy translates supported client formats.
  const upstreamModel = target.upstreamModel || modelGatewayId(target)
  let forwardedModel = upstreamModel

  if (provider.prefix === "codex") {
    // RawRoute has already selected the workspace from the global API-key
    // index. The namespace is an internal CLIProxy transport selector; it is
    // never stored as a provider or exposed in the RawRoute model catalog.
    forwardedModel = `${codexWorkspacePrefix(currentWorkspaceId())}/${upstreamModel}`
  } else {
    // RawRoute owns the external provider/model resolver. CLIProxy receives a
    // workspace/provider-scoped transport model only after this local lookup.
    await ensureNonCodexProviderProjection(provider.id)
    forwardedModel = `${nonCodexProviderPrefix(currentWorkspaceId(), provider.id)}/${providerModelSuffix(provider, target)}`
  }

  return {
    forwardedModel,
    upstreamModel,
    upstreamProtocol: provider.protocol || (provider.prefix === "codex" ? "openai-responses" : "openai-chat"),
    pricingGatewayModelId: modelGatewayId(target),
    providerModelId: target.id,
    providerId: target.providerId,
    providerName: provider.name,
    promptCacheKey: provider.protocol !== "anthropic-messages" && provider.supportPromptCacheKey === true,
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

async function canonicalModelsResponse() {
  const [models, providers, aliases, combos] = await Promise.all([listModels(), listProviders(), listAliases(), listCombos()])
  return Response.json({ object: "list", data: catalogModels(providers, models, aliases, combos) }, { headers: { "cache-control": "no-store" } })
}

export function isTerminalStreamEvent(eventName: string, parsed: Record<string, unknown> | undefined) {
  const normalizedEvent = eventName.trim().toLowerCase()
  if (["message_stop", "response.completed", "response.done", "message.completed", "message.done", "done"].includes(normalizedEvent)) return true
  const type = typeof parsed?.type === "string" ? parsed.type.trim().toLowerCase() : ""
  if (["response.completed", "response.done", "message_stop", "message.completed", "message.done", "done"].includes(type)) return true
  const response = objectValue(parsed?.response)
  return response?.status === "completed" || response?.status === "complete"
}

export async function collectStreamUsage(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: UsageMetrics | undefined
  let terminalEventSeen = false
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
  let eventName = ""
  const consumeLine = (line: string) => {
    const value = line.trim()
    if (value.startsWith("event:")) {
      eventName = value.slice(6).trim()
      return
    }
    if (!value) {
      eventName = ""
      return
    }
    if (!value.startsWith("data:")) return
    const payload = value.slice(5).trim()
    if (!payload) return
    if (payload === "[DONE]") {
      terminalEventSeen = true
      return
    }
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      terminalEventSeen ||= isTerminalStreamEvent(eventName, parsed)
      usage = mergeUsage(usage, extractUsageMetrics(parsed))
    } catch {
      // A provider may emit non-JSON comments or partial events; keep reading.
    }
  }
  try {
    while (true) {
      const next = await readWithTimeout()
      if (next.done) {
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
  return { usage, completedNormally: terminalEventSeen, terminalEventSeen, firstByteAt }
}

export async function proxyGatewayRequest(request: Request, path = new URL(request.url).pathname) {
  const authenticated = await authenticateProxyKey(request)
  if (!authenticated) {
    writeLog("warn", "gateway", "Request rejected: invalid API key", { protocol: protocolForLogPath(path) })
    return new Response(JSON.stringify({ error: { message: "Invalid gateway API key." } }), { status: 401, headers: { "content-type": "application/json" } })
  }
  return runInWorkspace(authenticated.workspace, () => proxyGatewayRequestInWorkspace(request, path, authenticated.apiKey))
    .then(normalizeRoutingFailure)
    .then(responseWithoutComboHeaders)
}

async function releaseBudgetReservationWithLog(reservation: BudgetReservation | undefined) {
  try {
    await releaseBudgetReservation(reservation)
  } catch (error) {
    writeLog("warn", "gateway", "Unable to release routing lease", { error: error instanceof Error ? error.message : "Unknown error" })
  }
}

function responseWithoutComboHeaders(response: Response) {
  const headers = responseHeaders(response.headers)
  headers.delete("x-rawroute-combo-terminal")
  headers.delete("x-rawroute-combo-member-unavailable")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function routingErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.code === "string") return record.code.trim().toLowerCase()
  if (typeof record.type === "string") return record.type.trim().toLowerCase()
  return routingErrorCode(record.error)
}

function routingErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const record = value as Record<string, unknown>
  const own = typeof record.message === "string" ? record.message : ""
  return `${own} ${routingErrorMessage(record.error)}`.trim()
}

function confirmedLimitError(code: string | undefined, message: string) {
  const normalizedCode = code?.replace(/[-:]/g, "_") || ""
  if (["usage_limit_reached", "insufficient_quota", "quota_exceeded", "rate_limit_exceeded", "rate_limit_error", "too_many_requests", "requests_per_minute_exceeded"].includes(normalizedCode)) return true
  return ["usage limit reached", "quota exceeded", "quota exhausted", "insufficient quota", "rate limit exceeded", "requests per minute", "request per minute", "too many requests", "weekly budget exceeded"].some((phrase) => message.includes(phrase))
}

async function normalizeRoutingFailure(response: Response) {
  const headers = responseHeaders(response.headers)
  if (response.status !== 429) {
    // Retry-After on a server/auth/routing failure makes coding clients treat a
    // recoverable provider error as quota exhaustion and can stall for hours.
    if (!headers.has("retry-after")) return response
    headers.delete("retry-after")
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  const body = new Uint8Array(await response.arrayBuffer())
  const payload = response.headers.get("content-type")?.toLowerCase().includes("json")
    ? (() => { try { return JSON.parse(new TextDecoder().decode(body)) as unknown } catch { return undefined } })()
    : undefined
  const code = routingErrorCode(payload)
  const message = routingErrorMessage(payload).toLowerCase()
  const syntheticCooldownCodes = new Set(["model_cooldown", "codex_cooldown", "combo_cooldown", "combo_rate_limited"])
  const syntheticCooldown = Boolean(code && syntheticCooldownCodes.has(code)) || message.includes("cooldown is still active") || message.includes("credentials for model") && message.includes("cooling down")
  const confirmedLimit = response.headers.get("x-rawroute-combo-terminal") === "1" || confirmedLimitError(code, message)
  if (!syntheticCooldown && confirmedLimit) return new Response(body, { status: response.status, statusText: response.statusText, headers })

  headers.delete("retry-after")
  headers.set("content-type", "application/json")
  return Response.json({ error: { code: "upstream_unavailable", message: "Upstream routing is temporarily unavailable." } }, { status: 503, headers })
}

async function proxyGatewayRequestInWorkspace(request: Request, path: string, apiKey: { id: string; name?: string }) {
  const isInference = request.method !== "GET" && request.method !== "HEAD" && !path.endsWith("/models")
  if (!isInference) return proxyGatewaySingleRequest(request, path, apiKey)
  const rawBody = new Uint8Array(await request.clone().arrayBuffer())
  let payload: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
  } catch {}
  const requestedModel = typeof payload?.model === "string" ? payload.model.trim() : ""
  if (!requestedModel) return proxyGatewaySingleRequest(request, path, apiKey)
  const combo = (await listCombos()).find((entry) => entry.combo === requestedModel)
  if (!combo) return proxyGatewaySingleRequest(request, path, apiKey)

  let lastResponse: Response | undefined
  for (const memberModelId of combo.memberModelIds) {
    if (request.signal.aborted) throw request.signal.reason
    const resolved = await resolveGatewayModel(memberModelId).catch(() => undefined)
    const memberRequest = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
      body: JSON.stringify({ ...payload, model: memberModelId }),
      signal: request.signal,
    })
    const response = await normalizeRoutingFailure(await proxyGatewaySingleRequest(memberRequest, path, apiKey, resolved))
    if (response.ok || response.headers.get("x-rawroute-combo-terminal") === "1") {
      if (lastResponse) void lastResponse.body?.cancel().catch(() => undefined)
      return responseWithoutComboHeaders(response)
    }
    if (lastResponse) void lastResponse.body?.cancel().catch(() => undefined)
    lastResponse = response
    writeLog("warn", "gateway", "Combo member failed, trying next", { combo: combo.combo, memberModelId, status: response.status })
  }
  return responseWithoutComboHeaders(lastResponse || new Response(JSON.stringify({ error: { message: "No combo models are available." } }), { status: 503, headers: { "content-type": "application/json" } }))
}

async function proxyGatewaySingleRequest(request: Request, path: string, apiKey: { id: string; name?: string }, preResolved?: ResolvedGatewayModel) {
  const supplied = suppliedGatewayKey(request)

  const isInference = request.method !== "GET" && request.method !== "HEAD" && !path.endsWith("/models")
  if (!isInference) {
    if (request.method === "GET" && path.endsWith("/models")) return canonicalModelsResponse()
    const internalKey = process.env.CLIPROXY_API_KEY?.trim() || supplied
    const response = await proxyToCliProxy(request, path, { headers: { authorization: `Bearer ${internalKey}`, "x-api-key": "" } })
    return response
  }

  const body = new Uint8Array(await request.clone().arrayBuffer())
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(body)) } catch { parsed = {} }
  const estimate = estimateRequest(parsed)
  const protocol = protocolForPath(path)
  let resolvedModel: ResolvedGatewayModel
  try {
    resolvedModel = preResolved || await resolveGatewayModel(estimate.model)
  } catch (error) {
    const resolution = error instanceof GatewayModelResolutionError
      ? error
      : new GatewayModelResolutionError("Model resolver is unavailable.", 503, "model_resolver_unavailable")
    writeLog(resolution.status === 400 ? "warn" : "error", "gateway", "Model resolution failed", { model: estimate.model, error: error instanceof Error ? error.message : "Unknown error" })
    return new Response(JSON.stringify({ error: { message: resolution.message, code: resolution.code } }), {
      status: resolution.status,
      headers: {
        "content-type": "application/json",
        ...(resolution.code === "model_not_found" ? { "x-rawroute-combo-member-unavailable": "1" } : {}),
      },
    })
  }
  const payload = objectValue(parsed) || {}
  const forwardedBody = await rewriteForwardedBody(body, resolvedModel.forwardedModel, estimate.model, path)
  let budgetState: Awaited<ReturnType<typeof getBudgetRequestState>>
  let reservation: BudgetReservation | undefined
  try {
    const ownerWorkspace = resolvedModel.shared ? await getWorkspace(resolvedModel.shared.ownerWorkspaceId) : undefined
    budgetState = resolvedModel.shared && ownerWorkspace
      ? await runInWorkspace(ownerWorkspace, () => getBudgetRequestState(
          `shared-workspace:${resolvedModel.shared!.consumerWorkspaceId}`,
          resolvedModel.pricingGatewayModelId,
          resolvedModel.providerModelId,
          parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined,
          forwardedBody.byteLength,
          protocol,
        ))
      : await getBudgetRequestState(
          apiKey.id,
          resolvedModel.pricingGatewayModelId,
          resolvedModel.providerModelId,
          parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined,
          forwardedBody.byteLength,
          protocol,
        )
  } catch (error) {
    if (error instanceof BudgetDeniedError) {
      return new Response(JSON.stringify({ error: { message: error.message } }), { status: error.status, headers: { "content-type": "application/json", "retry-after": String(error.retryAfterSeconds), "x-rawroute-combo-terminal": "1" } })
    }
    if (error instanceof BudgetPricingUnavailableError) {
      return new Response(JSON.stringify({ error: { message: error.message } }), { status: error.status, headers: { "content-type": "application/json", "x-rawroute-combo-terminal": "1" } })
    }
    writeLog("error", "gateway", "Budget state unavailable", { error: error instanceof Error ? error.message : "Unknown error" })
    return new Response(JSON.stringify({ error: { message: "Budget state is unavailable." } }), { status: 503, headers: { "content-type": "application/json", "x-rawroute-combo-terminal": "1" } })
  }

  try {
    reservation = await reserveBudgetAdmission(apiKey.id, budgetState.admission, budgetState.usageContext)
  } catch (error) {
    if (error instanceof BudgetDeniedError) {
      writeLog("warn", "gateway", "Budget admission denied", { apiKeyId: apiKey.id, error: error.message })
      return new Response(JSON.stringify({ error: { message: error.message } }), {
        status: error.status,
        headers: { "content-type": "application/json", "retry-after": String(error.retryAfterSeconds), "x-rawroute-combo-terminal": "1" },
      })
    }
    writeLog("error", "gateway", "Shared budget state unavailable", { error: error instanceof Error ? error.message : "Unknown error" })
    return new Response(JSON.stringify({ error: { message: "Budget state is unavailable." } }), { status: 503, headers: { "content-type": "application/json", "x-rawroute-combo-terminal": "1" } })
  }

  const internalKey = process.env.CLIPROXY_API_KEY?.trim() || supplied
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const provider = resolvedModel.providerName || resolvedModel.providerId || "RawRoute"
  const account = apiKey.name || "CLIProxyAPI"
  writeLog("info", "gateway", requestSummary(provider, resolvedModel.pricingGatewayModelId, resolvedModel.upstreamModel, protocol, resolvedModel.upstreamProtocol, account, payload, extractReasoningEffort(payload)), {
    promptCacheKey: resolvedModel.promptCacheKey,
  })
  let response: Response
  try {
    response = await proxyToCliProxy(request, path, {
      body: Buffer.from(forwardedBody),
      headers: { authorization: `Bearer ${internalKey}`, "x-api-key": "" },
    })
  } catch (error) {
    await releaseBudgetReservationWithLog(reservation)
    await recordGatewayUsageWithRetry({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: 502, response: undefined, budgetState, shared: resolvedModel.shared }).catch(() => undefined)
    writeLog("error", "gateway", "Upstream request failed", { provider, model: resolvedModel.pricingGatewayModelId, error: error instanceof Error ? error.message : "Unknown error" })
    return new Response(JSON.stringify({ error: { message: "Upstream request failed." } }), { status: 502, headers: { "content-type": "application/json" } })
  }
  if (response.ok && response.body && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const [downstream, monitor] = response.body.tee()
    const trackedResponse = new Response(downstream, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
    void (async () => {
      try {
        const collected = await collectStreamUsage(monitor)
        const streamStatus = collected.terminalEventSeen ? response.status : 502
        await recordGatewayUsageWithRetry({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: streamStatus, response: collected.usage, budgetState, shared: resolvedModel.shared })
          .catch((recordingError) => writeLog("warn", "gateway", "Unable to persist usage event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" }))
        const details = { status: streamStatus, terminalEvent: collected.terminalEventSeen, usageKnown: collected.usage !== undefined }
        if (streamStatus >= 200 && streamStatus < 400) writeLog("info", "gateway", completionSummary(Date.now() - startedAtMs, collected.firstByteAt === undefined ? undefined : collected.firstByteAt - startedAtMs, collected.usage), details)
        else writeLog("warn", "gateway", `FAILED ${streamStatus} ${Date.now() - startedAtMs}ms`, details)
      } catch (recordingError) {
        writeLog("warn", "gateway", "Unable to calculate usage event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" })
      } finally {
        await releaseBudgetReservationWithLog(reservation)
      }
    })()
    return trackedResponse
  }
  const responseBody = new Uint8Array(await response.arrayBuffer())
  const usage = actualResponseUsage(responseBody, response.headers.get("content-type"))
  await recordGatewayUsageWithRetry({ apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: response.status, response: usage, budgetState, shared: resolvedModel.shared })
    .catch((recordingError) => writeLog("warn", "gateway", "Unable to persist usage event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" }))
  if (response.ok) writeLog("info", "gateway", completionSummary(Date.now() - startedAtMs, undefined, usage))
  else {
    const failure = await upstreamFailure(new Response(responseBody, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) }))
    if (!response.headers.has("retry-after") && failure.retrySeconds) response.headers.set("retry-after", String(failure.retrySeconds))
    writeLog("warn", "gateway", `FAILED ${response.status} ${Date.now() - startedAtMs}ms`, { provider, model: resolvedModel.pricingGatewayModelId, source: "cliproxy", errorCode: failure.errorCode || "unknown", retryAfter: response.headers.get("retry-after") || "unspecified" })
  }
  await releaseBudgetReservationWithLog(reservation)
  return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
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
  shared?: ResolvedGatewayModel["shared"]
}

async function recordGatewayUsageWithRetry(input: GatewayUsageRecordingInput) {
  const id = input.id || crypto.randomUUID()
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await recordGatewayUsage({ ...input, id })
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Usage recording failed.")
}

async function recordGatewayUsage(input: GatewayUsageRecordingInput) {
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
    requestBodyBytes: input.budgetState.requestBodyBytes,
    metrics: input.response,
    // This estimate is only a settlement fallback when the provider omits
    // usage metadata. It is never used for admission control, and it must not
    // become the historical bill when actual usage is available.
    assumedCostMicros: shouldSettleEstimate
      ? input.budgetState.estimatedCostMicros
      : undefined,
    assumedCostSource: shouldSettleEstimate && input.budgetState.estimatedCostMicros !== undefined
      ? input.budgetState.estimatedCostSource === "payload-calibrated"
        ? "payload-calibrated"
        : input.budgetState.estimatedCostSource === "empirical" ? "empirical" : "reservation"
      : undefined,
    predictionMethod: shouldSettleEstimate ? input.budgetState.predictionMethod : undefined,
    predictionSampleCount: shouldSettleEstimate ? input.budgetState.predictionSampleCount : undefined,
  }, input.budgetState.pricing)
  if (!input.shared) {
    await recordUsageEvent(event, input.budgetState.usageContext)
    return
  }
  const shared = input.shared
  const consumerEvent: UsageEvent = {
    ...event,
    id: `${event.id}-consumer`,
    costMicros: 0,
    pricingConfidence: event.pricingConfidence === "unpriced" ? "unpriced" : "exact",
    costSource: undefined,
    pricingGroupId: undefined,
    pricingVersionId: undefined,
    pricingContextTier: undefined,
    sharedUsage: { shareId: shared.id, role: "consumer" as const, peerWorkspaceId: shared.ownerWorkspaceId, peerWorkspaceName: shared.ownerWorkspaceName, sourceGatewayModelId: shared.sourceGatewayModelId },
  }
  const ownerEvent = {
    ...event,
    id: `${event.id}-owner`,
    gatewayKeyId: `shared-workspace:${shared.consumerWorkspaceId}`,
    gatewayModelId: shared.sourceGatewayModelId,
    sharedUsage: { shareId: shared.id, role: "owner" as const, peerWorkspaceId: shared.consumerWorkspaceId, peerWorkspaceName: shared.consumerWorkspaceName, sourceGatewayModelId: shared.sourceGatewayModelId },
  }
  await recordUsageEvent(consumerEvent, null)
  const ownerWorkspace = await getWorkspace(shared.ownerWorkspaceId)
  if (ownerWorkspace) await runInWorkspace(ownerWorkspace, () => recordUsageEvent(ownerEvent, input.budgetState.usageContext))
}

export async function cliProxyHealth() {
  try {
    const response = await fetch(upstreamUrl("/healthz"), { cache: "no-store", signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

export { cliproxyManagement, cliproxyManagementJson } from "@/lib/cliproxy-management"

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
