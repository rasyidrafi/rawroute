import { authenticateProxyKey } from "@/lib/auth"
import { BudgetDeniedError, createGatewayUsageEvent, getBudgetRequestState, recordUsageEvent, type BudgetAdmission, type BudgetUsageContext, type ResolvedModelPricing } from "@/lib/analytics"
import { refreshCodexAccount } from "@/lib/codex"
import { buildCodexHeaders, collectCodexResponsesSse, normalizeCodexRequest, normalizeCodexResponsesStream } from "@/lib/codex-proxy"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { validateProviderHeaders } from "@/lib/provider-headers"
import { extractReasoningEffort } from "@/lib/reasoning-effort"
import { mergeRequestOverrides } from "@/lib/request-overrides"
import { buildUpstreamUrl, resolveRoute } from "@/lib/routing"
import { getRoutingStateStore } from "@/lib/routing-state"
import { extractSessionIdentity } from "@/lib/session-routing"
import { readRoutingData } from "@/lib/store"
import { protocolPaths, type AuthenticatedGatewayKey, type Protocol, type ProviderApiKey } from "@/lib/types"
import { extractUsageMetrics, mergeUsage, type UsageMetrics } from "@/lib/usage-metrics"
import { runInWorkspace } from "@/lib/workspace-context"

export { extractUsageMetrics } from "@/lib/usage-metrics"

const blockedRequestHeaders = new Set([
  "authorization", "x-api-key", "cookie", "host", "content-length", "connection",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "x-rawroute-session-id", "x-session-id", "session_id",
])

const blockedResponseHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie",
])

let maximumBodyCache: { raw: string | undefined; value: number } | undefined
const durationCache = new Map<string, { raw: string | undefined; value: number }>()
const enabledProviderKeysCache = new WeakMap<ProviderApiKey[], Map<string, ProviderApiKey[]>>()
const providerKeyIndexCache = new WeakMap<ProviderApiKey[], Map<string, ProviderApiKey>>()
const emptyPayload = Object.freeze({}) as Record<string, unknown>
const maxMappedResponseIds = 64
const maxResponseIdChars = 512

function maximumBodyBytes() {
  const raw = process.env.MAX_PROXY_BODY_BYTES
  const cached = maximumBodyCache
  if (cached && cached.raw === raw) return cached.value
  const configured = Number(raw || 10 * 1024 * 1024)
  const value = Number.isSafeInteger(configured) && configured > 0 ? configured : 10 * 1024 * 1024
  maximumBodyCache = { raw, value }
  return value
}

function configuredDurationMs(cacheKey: string, value: string | undefined, fallbackSeconds: number) {
  const cached = durationCache.get(cacheKey)
  if (cached && cached.raw === value) return cached.value
  const configured = Number(value || fallbackSeconds)
  const duration = Number.isSafeInteger(configured) && configured > 0 ? configured * 1000 : fallbackSeconds * 1000
  durationCache.set(cacheKey, { raw: value, value: duration })
  return duration
}

function maximumRoutingRequestMs(streaming: boolean) {
  if (!streaming) return configuredDurationMs("non-stream", process.env.ROUTING_MAX_NON_STREAM_DURATION_SECONDS, 60)
  const configured = process.env.ROUTING_MAX_STREAM_DURATION_SECONDS || process.env.ROUTING_MAX_REQUEST_DURATION_SECONDS
  return configuredDurationMs("stream", configured, 290)
}

function providerKeysFor(providerApiKeys: ProviderApiKey[], providerId: string) {
  let byProvider = enabledProviderKeysCache.get(providerApiKeys)
  if (!byProvider) {
    byProvider = new Map()
    for (const apiKey of providerApiKeys) {
      if (!apiKey.enabled) continue
      const current = byProvider.get(apiKey.providerId)
      if (current) current.push(apiKey)
      else byProvider.set(apiKey.providerId, [apiKey])
    }
    enabledProviderKeysCache.set(providerApiKeys, byProvider)
  }
  return byProvider.get(providerId) || []
}

function providerKeyFor(providerApiKeys: ProviderApiKey[], id: string) {
  let byId = providerKeyIndexCache.get(providerApiKeys)
  if (!byId) {
    byId = new Map()
    for (const apiKey of providerApiKeys) byId.set(apiKey.id, apiKey)
    providerKeyIndexCache.set(providerApiKeys, byId)
  }
  return byId.get(id)
}

function normalizeResponsesRequest(payload: Record<string, unknown>) {
  const normalized = { ...payload }
  if (!Object.hasOwn(normalized, "max_output_tokens")) {
    if (Object.hasOwn(normalized, "max_completion_tokens")) normalized.max_output_tokens = normalized.max_completion_tokens
    else if (Object.hasOwn(normalized, "max_tokens")) normalized.max_output_tokens = normalized.max_tokens
  }
  // Responses APIs use max_output_tokens; forwarding either chat-completions
  // spelling causes strict OpenAI-compatible upstreams to return HTTP 400.
  delete normalized.max_tokens
  delete normalized.max_completion_tokens
  return normalized
}

async function readBoundedBody(request: Request, maximum: number) {
  const declared = request.headers.get("content-length")
  if (declared) {
    const declaredBytes = Number(declared)
    if (Number.isFinite(declaredBytes) && declaredBytes > maximum) return { ok: false as const }
  }
  if (!request.body) return { ok: true as const, value: "", byteLength: 0 }

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximum) {
      await reader.cancel("Request body too large")
      return { ok: false as const }
    }
    chunks.push(decoder.decode(value, { stream: true }))
  }
  const tail = decoder.decode()
  if (tail) chunks.push(tail)
  return { ok: true as const, value: chunks.join(""), byteLength: total }
}

function retryAfterSeconds(headers: Headers) {
  const value = headers.get("retry-after")
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : undefined
}

function requestItemCount(payload: Record<string, unknown>, protocol?: Protocol) {
  // 9router-style message counting: fall back through the conversation-history
  // arrays used by each supported protocol — `messages` for OpenAI chat and
  // Anthropic, `input` for OpenAI Responses, `contents` for Gemini. Only fall
  // back to a single-entry assumption when a string-shaped input was sent
  // (Responses accepts a bare string as a one-message prompt).
  const keys = protocol === "openai-responses" ? ["input", "messages"] : ["messages", "input", "contents"]
  for (const key of keys) {
    const value = payload[key]
    if (Array.isArray(value)) return value.length
  }
  if (protocol === "openai-responses" && typeof payload.input === "string") return 1
  return 0
}

function requestToolCount(payload: Record<string, unknown>) {
  // 9router-style tool counting: count declared tool definitions on the
  // request side. Different protocols name the array differently:
  //   - openai-chat: `tools` (modern) or `functions` (legacy)
  //   - openai-responses: `tools`
  //   - anthropic-messages: `tools`
  const direct = Math.max(
    arrayLength(payload.tools),
    arrayLength(payload.functions),
  )
  if (direct) return direct

  // Some OpenAI-compatible clients wrap the actual request in `request` or
  // `extra_body`; support those forms without counting unrelated nested data.
  for (const key of ["request", "extra_body"]) {
    const nested = objectValue(payload[key])
    if (!nested) continue
    const nestedCount = Math.max(arrayLength(nested.tools), arrayLength(nested.functions))
    if (nestedCount) return nestedCount
  }

  // Conversation history and tool results are not declarations. Do not count
  // them, or the value grows on every Responses continuation.
  return 0
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
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

function objectValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function responseMetadataFromSse(buffer: string) {
  const ids: string[] = []
  let usage: UsageMetrics | undefined
  let lineStart = 0
  while (lineStart < buffer.length) {
    let lineEnd = buffer.indexOf("\n", lineStart)
    if (lineEnd < 0) lineEnd = buffer.length
    let contentEnd = lineEnd
    if (contentEnd > lineStart && buffer.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1
    if (contentEnd - lineStart >= 5 && buffer.startsWith("data:", lineStart)) {
      const raw = buffer.slice(lineStart + 5, contentEnd).trim()
      if (raw && raw !== "[DONE]") {
        try {
          const data = JSON.parse(raw) as Record<string, unknown>
          const response = objectValue(data.response) || data
          if (typeof response.id === "string" && response.id.length <= maxResponseIdChars && ids.length < maxMappedResponseIds) ids.push(response.id)
          usage = mergeUsage(usage, extractUsageMetrics(data))
        } catch { /* Partial and non-JSON SSE data is passed through unchanged. */ }
      }
    }
    lineStart = lineEnd + 1
  }
  return { ids, usage }
}

function lastSseBoundary(buffer: string) {
  const lf = buffer.lastIndexOf("\n\n")
  const crlf = buffer.lastIndexOf("\r\n\r\n")
  if (crlf > lf) return { index: crlf, length: 4 }
  return lf >= 0 ? { index: lf, length: 2 } : undefined
}

function trackedUpstreamBody(
  upstream: Response,
  onResponseIds: (ids: string[]) => Promise<void>,
  onFinished: (metrics: { ttftMs?: number; usage?: UsageMetrics }) => Promise<void>,
  onCancelled: () => Promise<void>,
) {
  if (!upstream.body) {
    void onFinished({}).catch((error) => writeLog("warn", "gateway", "Unable to release routing lease", { error: error instanceof Error ? error.message : "Unknown error" }))
    return null
  }
  const reader = upstream.body.getReader()
  const contentType = (upstream.headers.get("content-type") || "").toLowerCase()
  // Codex Responses Lite currently omits content-type while still returning
  // an SSE body. Treat an untyped upstream stream as SSE so terminal
  // response.completed usage is not lost.
  const isEventStream = contentType.includes("text/event-stream") || contentType.startsWith("text/plain") || !contentType
  const isJson = !isEventStream && contentType.includes("application/json")
  const decoder = isEventStream || isJson ? new TextDecoder() : undefined
  let buffered = ""
  let finished = false
  let firstByteAt: number | undefined
  let latestUsage: UsageMetrics | undefined
  const maxMetadataBufferChars = 2 * 1024 * 1024
  const mappedResponseIds = new Set<string>()

  const mapResponseIds = async (ids: string[]) => {
    let newIds: string[] | undefined
    for (const id of ids) {
      if (mappedResponseIds.size >= maxMappedResponseIds) break
      if (!id || id.length > maxResponseIdChars) continue
      if (mappedResponseIds.has(id)) continue
      mappedResponseIds.add(id)
      if (newIds) newIds.push(id)
      else newIds = [id]
    }
    if (!newIds) return
    try {
      await onResponseIds(newIds)
    } catch (error) {
      writeLog("warn", "gateway", "Unable to persist response affinity", { error: error instanceof Error ? error.message : "Unknown error" })
    }
  }

  const finish = async () => {
    if (finished) return
    finished = true
    if (isJson && buffered) {
      try {
        const parsed = JSON.parse(buffered) as Record<string, unknown>
        if (typeof parsed.id === "string" && parsed.id.length <= maxResponseIdChars) void mapResponseIds([parsed.id])
        latestUsage = mergeUsage(latestUsage, extractUsageMetrics(parsed))
      } catch { /* The upstream body remains untouched when it is not valid JSON. */ }
    } else if (isEventStream && buffered) {
      const metadata = responseMetadataFromSse(buffered)
      if (metadata.ids.length) void mapResponseIds(metadata.ids)
      latestUsage = mergeUsage(latestUsage, metadata.usage)
    }
    void onFinished({
      ...(firstByteAt !== undefined ? { ttftMs: firstByteAt } : {}),
      ...(latestUsage ? { usage: latestUsage } : {}),
    }).catch((error) => writeLog("warn", "gateway", "Unable to release routing lease", { error: error instanceof Error ? error.message : "Unknown error" }))
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          if (decoder) buffered += decoder.decode()
          if (isEventStream) {
            controller.close()
            void finish()
          } else {
            await finish()
            controller.close()
          }
          return
        }
        firstByteAt ??= Date.now()
        if (isEventStream && decoder) {
          buffered += decoder.decode(value, { stream: true })
          const boundary = lastSseBoundary(buffered)
          if (boundary) {
            const end = boundary.index + boundary.length
            const complete = buffered.slice(0, end)
            buffered = buffered.slice(end)
            const metadata = responseMetadataFromSse(complete)
            if (metadata.ids.length) void mapResponseIds(metadata.ids)
            latestUsage = mergeUsage(latestUsage, metadata.usage)
          }
          if (buffered.length > maxMetadataBufferChars) buffered = buffered.slice(-maxMetadataBufferChars)
        } else if (isJson && decoder && buffered.length < maxMetadataBufferChars) {
          const text = decoder.decode(value, { stream: true })
          const remaining = maxMetadataBufferChars - buffered.length
          buffered += text.length <= remaining ? text : text.slice(0, remaining)
        }
        controller.enqueue(value)
      } catch (error) {
        await finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      void onCancelled()
      await reader.cancel(reason)
      void finish()
    },
  })
}

export async function proxyRequest(request: Request, requestedProtocol: Protocol) {
  const authenticated = await authenticateProxyKey(request)
  if (!authenticated) {
    writeLog("warn", "gateway", "Request rejected: invalid API key", { protocol: requestedProtocol })
    return jsonError("Invalid gateway API key.", 401)
  }
  return runInWorkspace(authenticated.workspace, () => proxyAuthenticatedRequest(request, requestedProtocol, authenticated))
}

async function proxyAuthenticatedRequest(request: Request, requestedProtocol: Protocol, authenticated: AuthenticatedGatewayKey) {
  const { apiKey: gatewayApiKey, workspace } = authenticated
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415)
  }

  // Configuration can be loaded while the request stream is being decoded. Attach
  // a handler immediately so an early body validation return cannot leave a
  // rejected configuration promise unobserved.
  const dataPromise = readRoutingData()
  void dataPromise.catch(() => undefined)
  const body = await readBoundedBody(request, maximumBodyBytes())
  if (!body.ok) return jsonError("Request body exceeds the configured limit.", 413)
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(body.value)
    const parsedObject = objectValue(parsed)
    if (!parsedObject) return jsonError("Request body must be a JSON object.", 400)
    payload = parsedObject
  } catch {
    return jsonError("Request body must be valid JSON.", 400)
  }
  // Drop the raw JSON string before creating the upstream serialization. On large
  // requests this avoids retaining two equivalent multi-megabyte strings.
  body.value = ""

  if (typeof payload.model !== "string") return jsonError("A model ID is required.", 400)
  const data = await dataPromise
  const route = resolveRoute(data.providers, data.models, data.aliases, payload.model, requestedProtocol)
  if (!route.ok) {
    writeLog("warn", "gateway", "Request could not be routed", { model: payload.model, protocol: requestedProtocol, status: route.status })
    return jsonError(route.message, route.status)
  }
  const { model, provider, protocol: modelProtocol } = route
  const gatewayModelId = model.gatewayModelId || model.id
  const providerApiKeys = providerKeysFor(data.providerApiKeys, provider.id)
  if (provider.authType !== "none" && !providerApiKeys.length) {
    writeLog("warn", "gateway", "Provider has no enabled API keys", { provider: provider.name, model: gatewayModelId })
    return jsonError("The model provider has no enabled API keys.", 503)
  }

  const session = extractSessionIdentity(request, payload, modelProtocol, {
    workspaceId: workspace.id,
    gatewayKeyId: gatewayApiKey.id,
    providerId: provider.id,
    modelId: gatewayModelId,
    secret: data.sessionSecret,
  })
  const routingSessionKey = session?.key
  let budgetAdmission: BudgetAdmission | undefined
  let budgetUsageContext: BudgetUsageContext | undefined
  let budgetPricing: ResolvedModelPricing | undefined
  try {
    const budgetState = await getBudgetRequestState(gatewayApiKey.id, gatewayModelId, model.id, payload, body.byteLength)
    budgetAdmission = budgetState.admission
    budgetUsageContext = budgetState.usageContext
    budgetPricing = budgetState.pricing
  } catch (error) {
    if (error instanceof BudgetDeniedError) {
      return Response.json({ error: { message: error.message } }, { status: error.status, headers: { "retry-after": String(error.retryAfterSeconds) } })
    }
    writeLog("error", "gateway", "Budget state unavailable", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError("Budget state is unavailable.", 503)
  }

  let providerApiKey: ProviderApiKey | undefined = providerApiKeys[0]
  let routingStore: ReturnType<typeof getRoutingStateStore> | undefined
  let routingLeaseId: string | undefined
  let budgetLeaseId: string | undefined
  if (provider.authType !== "none") {
    try {
      routingStore = getRoutingStateStore()
      const reservation = await routingStore.reserve({
        providerId: provider.id,
        modelId: gatewayModelId,
        credentials: providerApiKeys,
        sessionKey: routingSessionKey,
        hardAffinity: session?.hard || false,
        responseId: session?.responseId,
        budget: budgetAdmission,
      })
      if (!reservation.ok) {
        writeLog("warn", "gateway", "Provider routing reservation unavailable", {
          provider: provider.name,
          model: gatewayModelId,
          reason: reservation.reason,
          retryAfterSeconds: reservation.retryAfterSeconds,
        })
        if (reservation.reason === "hard-response-missing") {
          return jsonError("The previous response session is unavailable or expired.", 409)
        }
        if (reservation.reason === "budget") {
          return Response.json({ error: { message: "Weekly budget reservation unavailable." } }, { status: 429, headers: { "retry-after": String(reservation.retryAfterSeconds) } })
        }
        const status = reservation.reason === "capacity" ? 429 : 503
        return Response.json({ error: { message: reservation.reason === "capacity"
          ? "All provider API keys are currently at capacity."
          : "The API key bound to this response session is currently unavailable." } }, {
          status,
          headers: { "retry-after": String(reservation.retryAfterSeconds) },
        })
      }
      providerApiKey = providerKeyFor(data.providerApiKeys, reservation.credentialId)
      if (!providerApiKey) {
        await routingStore.release({
          providerId: provider.id,
          credentialId: reservation.credentialId,
          leaseId: reservation.leaseId,
          status: 502,
          ...(budgetAdmission ? { budget: { key: budgetAdmission.key, actualMicros: 0, ttlSeconds: budgetAdmission.ttlSeconds } } : {}),
        }).catch(() => undefined)
        return jsonError("The selected provider API key is unavailable.", 503)
      }
      routingLeaseId = reservation.leaseId
      budgetLeaseId = budgetAdmission ? reservation.leaseId : undefined
      try {
        providerApiKey = await refreshCodexAccount(providerApiKey)
      } catch (error) {
        await routingStore.release({
          providerId: provider.id,
          credentialId: providerApiKey.id,
          leaseId: routingLeaseId,
          status: 503,
          ...(budgetAdmission ? { budget: { key: budgetAdmission.key, actualMicros: 0, ttlSeconds: budgetAdmission.ttlSeconds } } : {}),
        }).catch(() => undefined)
        return jsonError(error instanceof Error ? error.message : "Codex account refresh failed.", 503)
      }
    } catch (error) {
      writeLog("error", "gateway", "Shared routing state unavailable", { error: error instanceof Error ? error.message : "Unknown error" })
      return jsonError("Shared routing state is unavailable.", 503)
    }
  } else if (budgetAdmission) {
    try {
      routingStore = getRoutingStateStore()
      const reservation = await routingStore.reserveBudget(budgetAdmission)
      if (!reservation.ok) return Response.json({ error: { message: "Weekly budget reservation unavailable." } }, { status: 429, headers: { "retry-after": String(reservation.retryAfterSeconds) } })
      budgetLeaseId = reservation.leaseId
    } catch (error) {
      writeLog("error", "gateway", "Shared budget state unavailable", { error: error instanceof Error ? error.message : "Unknown error" })
      return jsonError("Shared budget state is unavailable.", 503)
    }
  }

  let leaseRenewalTimer: ReturnType<typeof setInterval> | undefined
  let requestTimeout: ReturnType<typeof setTimeout> | undefined
  let releasePromise: Promise<void> | undefined
  let clientAbortListener: (() => void) | undefined
  const cleanupLease = () => {
    if (leaseRenewalTimer) clearInterval(leaseRenewalTimer)
    if (requestTimeout) clearTimeout(requestTimeout)
    if (clientAbortListener) request.signal.removeEventListener("abort", clientAbortListener)
    leaseRenewalTimer = undefined
    requestTimeout = undefined
    clientAbortListener = undefined
  }
  const releaseLease = (status: number, retryAfterSeconds?: number, actualMicros = 0) => {
    if (!routingStore) {
      cleanupLease()
      return Promise.resolve()
    }
    if (!providerApiKey || !routingLeaseId) {
      if (!budgetAdmission || !budgetLeaseId) {
        cleanupLease()
        return Promise.resolve()
      }
      return routingStore.settleBudget({ key: budgetAdmission.key, leaseId: budgetLeaseId, actualMicros, ttlSeconds: budgetAdmission.ttlSeconds }).finally(cleanupLease)
    }
    return routingStore.release({
      providerId: provider.id,
      credentialId: providerApiKey.id,
      leaseId: routingLeaseId,
      status,
      retryAfterSeconds,
      ...(budgetAdmission && budgetLeaseId ? { budget: { key: budgetAdmission.key, actualMicros, ttlSeconds: budgetAdmission.ttlSeconds } } : {}),
    })
  }
  const releaseOnce = (status: number, retryAfterSeconds?: number, actualMicros = 0) => {
    if (!releasePromise) {
      releasePromise = releaseLease(status, retryAfterSeconds, actualMicros).finally(cleanupLease)
    }
    return releasePromise
  }
  const safeRelease = async (status: number, retryAfterSeconds?: number, actualMicros = 0) => {
    try {
      await releaseOnce(status, retryAfterSeconds, actualMicros)
    } catch (error) {
      writeLog("warn", "gateway", "Unable to release routing lease", { error: error instanceof Error ? error.message : "Unknown error" })
    }
  }

  try {
    payload = mergeRequestOverrides(payload, model.requestOverrides || {})
    const downstreamRequestedStreaming = payload.stream === true
    // Apply the Codex Responses Lite contract by provider, not only by the
    // credential kind. Codex can also be configured with a regular bearer key.
    const isCodexProvider = provider.prefix === "codex" || providerApiKey?.credentialKind === "codex-oauth"
    const isCodexOAuth = providerApiKey?.credentialKind === "codex-oauth"
    if (isCodexProvider) payload = normalizeCodexRequest(payload, model.upstreamModel, routingSessionKey)
    else {
      if (modelProtocol === "openai-responses") payload = normalizeResponsesRequest(payload)
      payload.model = model.upstreamModel
    }
    const streamOptions = objectValue(payload.stream_options)
    if (modelProtocol === "openai-chat" && payload.stream === true) {
      const options = streamOptions || {}
      options.include_usage = true
      payload.stream_options = options
    }
    const reasoningEffort = extractReasoningEffort(payload)
    const validatedProviderHeaders = validateProviderHeaders(provider.headers)
    let headers = isCodexOAuth
      ? buildCodexHeaders(request.headers, validatedProviderHeaders, providerApiKey?.key || "", providerApiKey?.accountId, routingSessionKey)
      : new Headers()
    if (!isCodexOAuth) {
      request.headers.forEach((value, key) => {
        if (!blockedRequestHeaders.has(key)) headers.set(key, value)
      })
      headers.set("content-type", "application/json")
      Object.entries(validatedProviderHeaders).forEach(([key, value]) => headers.set(key, value))
      if (provider.authType === "bearer" && providerApiKey) headers.set("authorization", `Bearer ${providerApiKey.key}`)
      if (provider.authType === "x-api-key" && providerApiKey) headers.set("x-api-key", providerApiKey.key)
      if (provider.authType === "custom-header" && provider.authHeader && providerApiKey) headers.set(provider.authHeader, providerApiKey.key)
    }

    const account = providerApiKey?.name || provider.name
    const startedAt = Date.now()
    const startedAtIso = new Date(startedAt).toISOString()
    const upstreamController = new AbortController()
    clientAbortListener = () => {
      upstreamController.abort(request.signal.reason)
      void safeRelease(499)
    }
    request.signal.addEventListener("abort", clientAbortListener, { once: true })
    if (request.signal.aborted) clientAbortListener()
    if (request.signal.aborted) throw new Error("Request aborted")
    const maximumRequestMs = maximumRoutingRequestMs(payload.stream === true)
    requestTimeout = setTimeout(() => {
      upstreamController.abort(new Error("Maximum routing request duration exceeded"))
      void safeRelease(502)
    }, maximumRequestMs)
    if (typeof requestTimeout === "object" && requestTimeout !== null && "unref" in requestTimeout) (requestTimeout as { unref(): void }).unref()
    if (routingStore && providerApiKey && routingLeaseId) {
      const renewalIntervalMs = routingStore.leaseRenewalIntervalMs()
      // Avoid allocating a timer for the common case where the request timeout
      // is shorter than the first possible renewal tick.
      if (maximumRequestMs > renewalIntervalMs) {
        let renewing = false
        leaseRenewalTimer = setInterval(() => {
          if (renewing) return
          renewing = true
          void routingStore?.renew({
            providerId: provider.id,
            credentialId: providerApiKey!.id,
            leaseId: routingLeaseId!,
          }).then((renewed) => {
            if (!renewed) {
              writeLog("warn", "gateway", "Routing lease disappeared before completion", { provider: provider.name, model: gatewayModelId })
              upstreamController.abort(new Error("Routing lease expired"))
              void safeRelease(502)
            }
          }).catch((error) => {
            writeLog("warn", "gateway", "Unable to renew routing lease", { error: error instanceof Error ? error.message : "Unknown error" })
          }).finally(() => { renewing = false })
        }, renewalIntervalMs)
        if (typeof leaseRenewalTimer === "object" && leaseRenewalTimer !== null && "unref" in leaseRenewalTimer) (leaseRenewalTimer as { unref(): void }).unref()
      }
    }
    writeLog("info", "gateway", requestSummary(provider.name, gatewayModelId, model.upstreamModel, modelProtocol, account, payload, reasoningEffort))
    const upstreamPath = isCodexOAuth ? (model.upstreamPath || "/responses") : (model.upstreamPath || protocolPaths[modelProtocol])
    const upstreamUrl = buildUpstreamUrl(provider.baseUrl, upstreamPath)
    let upstreamBody = JSON.stringify(payload)
    payload = emptyPayload
    let upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: upstreamBody,
      signal: upstreamController.signal,
      redirect: "manual",
    })
    if (isCodexOAuth && upstream.status === 401 && providerApiKey?.refreshToken) {
      await upstream.body?.cancel().catch(() => undefined)
      try {
        providerApiKey = await refreshCodexAccount(providerApiKey, true)
        headers = buildCodexHeaders(request.headers, validatedProviderHeaders, providerApiKey.key, providerApiKey.accountId, routingSessionKey)
        upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers,
          body: upstreamBody,
          signal: upstreamController.signal,
          redirect: "manual",
        })
      } catch (error) {
        writeLog("warn", "gateway", "Codex token refresh after unauthorized response failed", { provider: provider.name, account: providerApiKey.name, error: error instanceof Error ? error.message : "Unknown error" })
      }
    }
    // A Codex retry can no longer occur once response headers are available.
    // Release the potentially multi-megabyte request serialization before the
    // downstream response stream completes.
    upstreamBody = ""
    const responseHeaders = new Headers()
    upstream.headers.forEach((value, key) => {
      if (!blockedResponseHeaders.has(key)) responseHeaders.set(key, value)
    })
    responseHeaders.set("x-rawroute-provider", provider.id)
    responseHeaders.set("x-rawroute-model", gatewayModelId)
    if (providerApiKey) responseHeaders.set("x-rawroute-provider-key", providerApiKey.id)
    if (!upstream.ok) await safeRelease(upstream.status, retryAfterSeconds(upstream.headers))
    const trackedBody = upstream.ok
      ? trackedUpstreamBody(
          upstream,
          async (responseIds) => {
            if (routingStore && providerApiKey) await routingStore.mapResponses(responseIds, provider.id, providerApiKey.id)
          },
          async ({ ttftMs, usage }) => {
            const elapsed = Date.now() - startedAt
            const firstByteMs = ttftMs === undefined ? undefined : ttftMs - startedAt
            writeLog("info", "gateway", completionSummary(elapsed, firstByteMs, usage))
            void (async () => {
              const retryAfter = retryAfterSeconds(upstream.headers)
              const eventPromise = createGatewayUsageEvent({
                gatewayKeyId: gatewayApiKey.id,
                providerId: provider.id,
                providerModelId: model.id,
                gatewayModelId,
                protocol: modelProtocol,
                startedAt: startedAtIso,
                status: upstream.status,
                durationMs: elapsed,
                ...(firstByteMs !== undefined ? { ttftMs: firstByteMs } : {}),
                metrics: usage,
                ...(budgetAdmission ? { assumedCostMicros: budgetAdmission.reservationMicros } : {}),
              }, budgetPricing)
              void eventPromise.catch(() => undefined)
              // Requests without an active budget do not need pricing before the
              // scarce routing slot can be returned to the pool.
              if (!budgetAdmission) await safeRelease(upstream.status, retryAfter)
              let event: Awaited<typeof eventPromise>
              try {
                event = await eventPromise
              } catch (error) {
                await safeRelease(upstream.status, retryAfter)
                writeLog("warn", "gateway", "Unable to calculate usage event", { error: error instanceof Error ? error.message : "Unknown error" })
                return
              }
              // Budget reservations need the priced amount, but persistence does not
              // need to hold the routing lease open.
              if (budgetAdmission) await safeRelease(upstream.status, retryAfter, event.costMicros)
              try {
                await recordUsageEvent(event, budgetUsageContext || null)
              } catch (error) {
                writeLog("warn", "gateway", "Unable to persist usage event", { error: error instanceof Error ? error.message : "Unknown error" })
              }
            })()
          },
          async () => {
            upstreamController.abort(new Error("Downstream response was cancelled"))
            await safeRelease(499)
          },
        )
      : upstream.body
    const shouldNormalizeCodexStream = upstream.ok
      && isCodexProvider
      && modelProtocol === "openai-responses"
      && downstreamRequestedStreaming
    const shouldCollectCodexResponse = upstream.ok
      && isCodexProvider
      && modelProtocol === "openai-responses"
      && !downstreamRequestedStreaming
    let responseBody: BodyInit | null = trackedBody
    let responseStatus = upstream.status
    if (shouldNormalizeCodexStream && trackedBody) {
      responseHeaders.set("content-type", "text/event-stream")
      responseHeaders.set("cache-control", "no-cache")
      responseHeaders.set("connection", "keep-alive")
      responseBody = normalizeCodexResponsesStream(trackedBody)
    } else if (shouldCollectCodexResponse) {
      const raw = trackedBody ? await new Response(trackedBody).text() : ""
      const contentType = (upstream.headers.get("content-type") || "").toLowerCase()
      let normalizedResponse: Record<string, unknown> | undefined
      try {
        if (contentType.includes("application/json")) {
          const parsed = JSON.parse(raw)
          normalizedResponse = objectValue(parsed)
        } else {
          normalizedResponse = collectCodexResponsesSse(raw)
        }
      } catch {
        normalizedResponse = undefined
      }
      if (normalizedResponse) {
        responseHeaders.set("content-type", "application/json")
        responseBody = JSON.stringify(normalizedResponse)
      } else {
        responseStatus = 502
        responseHeaders.set("content-type", "application/json")
        responseBody = JSON.stringify({ error: { message: "Invalid Codex Responses Lite response." } })
        writeLog("warn", "gateway", "Codex Responses Lite returned an invalid response", { provider: provider.name, model: gatewayModelId })
      }
    }
    if (!upstream.ok) writeLog("warn", "gateway", `FAILED ${upstream.status} ${Date.now() - startedAt}ms`)
    return new Response(responseBody, { status: responseStatus, statusText: upstream.statusText, headers: responseHeaders })
  } catch (error) {
    if (routingStore) await safeRelease(502).catch(() => undefined)
    cleanupLease()
    writeLog("error", "gateway", "Upstream request failed", { provider: provider.name, model: gatewayModelId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError("Upstream request failed.", 502, error instanceof Error ? error.message : undefined)
  }
}
