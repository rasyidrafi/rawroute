import { authenticateProxyKey } from "@/lib/auth"
import { refreshCodexAccount } from "@/lib/codex"
import { buildCodexHeaders, normalizeCodexRequest } from "@/lib/codex-proxy"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { validateProviderHeaders } from "@/lib/provider-headers"
import { extractReasoningEffort } from "@/lib/reasoning-effort"
import { mergeRequestOverrides } from "@/lib/request-overrides"
import { buildUpstreamUrl, resolveRoute } from "@/lib/routing"
import { getRoutingStateStore } from "@/lib/routing-state"
import { extractSessionIdentity } from "@/lib/session-routing"
import { readData } from "@/lib/store"
import { protocolPaths, type Protocol, type ProviderApiKey } from "@/lib/types"

const blockedRequestHeaders = new Set([
  "authorization", "x-api-key", "cookie", "host", "content-length", "connection",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "x-rawroute-session-id", "x-session-id", "session_id",
])

const blockedResponseHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie",
])

function maximumBodyBytes() {
  const configured = Number(process.env.MAX_PROXY_BODY_BYTES || 10 * 1024 * 1024)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 10 * 1024 * 1024
}

function configuredDurationMs(value: string | undefined, fallbackSeconds: number) {
  const configured = Number(value || fallbackSeconds)
  return Number.isSafeInteger(configured) && configured > 0 ? configured * 1000 : fallbackSeconds * 1000
}

function maximumRoutingRequestMs(streaming: boolean) {
  if (!streaming) return configuredDurationMs(process.env.ROUTING_MAX_NON_STREAM_DURATION_SECONDS, 60)
  return configuredDurationMs(
    process.env.ROUTING_MAX_STREAM_DURATION_SECONDS || process.env.ROUTING_MAX_REQUEST_DURATION_SECONDS,
    290,
  )
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

function retryAfterSeconds(headers: Headers) {
  const value = headers.get("retry-after")
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : undefined
}

function requestItemCount(payload: Record<string, unknown>) {
  if (Array.isArray(payload.messages)) return payload.messages.length
  if (Array.isArray(payload.input)) return payload.input.length
  return payload.input === undefined ? 0 : 1
}

function requestToolCount(payload: Record<string, unknown>) {
  const countTools = (value: unknown) => {
    if (Array.isArray(value)) return value.length
    return value !== null && typeof value === "object" ? 1 : 0
  }
  const directCount = Math.max(countTools(payload.tools), countTools(payload.functions))
  if (directCount) return directCount

  // Some OpenAI-compatible clients wrap the actual request in `request` or
  // `extra_body`; support those forms without counting unrelated nested data.
  for (const key of ["request", "extra_body"]) {
    const nested = objectValue(payload[key])
    if (!nested) continue
    const nestedCount = Math.max(countTools(nested.tools), countTools(nested.functions))
    if (nestedCount) return nestedCount
  }

  // Tool calls may also be present in a continued Responses/Anthropic input.
  // Count only tool-specific items, not ordinary messages or content blocks.
  for (const key of ["input", "messages"]) {
    if (!Array.isArray(payload[key])) continue
    const toolItems = payload[key].filter((item) => {
      const record = objectValue(item)
      return record?.type === "tool_use" || record?.type === "function_call" || record?.type === "tool_result" || record?.type === "function_call_output"
    }).length
    if (toolItems) return toolItems
  }
  return 0
}

function requestSummary(provider: string, gatewayModel: string, upstreamModel: string, protocol: Protocol, account: string, payload: Record<string, unknown>, reasoningEffort?: string) {
  const parts = [
    `POST PROVIDER:${provider}`,
    `MODEL:${gatewayModel} -> ${upstreamModel}`,
    `FMT:${protocol}`,
    `ACC:${account}`,
  ]
  if (reasoningEffort) parts.push(`THINK:${reasoningEffort}`)
  parts.push(`MSG:${requestItemCount(payload)}`)
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

type UsageMetrics = { input?: number; output?: number; cached?: number }

function objectValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numericValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function firstNumber(record: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = numericValue(record?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

function mergeUsage(current: UsageMetrics | undefined, next: UsageMetrics | undefined) {
  if (!next) return current
  return {
    ...(current || {}),
    ...(next.input !== undefined ? { input: next.input } : {}),
    ...(next.output !== undefined ? { output: next.output } : {}),
    ...(next.cached !== undefined ? { cached: next.cached } : {}),
  }
}

export function extractUsageMetrics(payload: Record<string, unknown>): UsageMetrics | undefined {
  const response = objectValue(payload.response) || payload
  const message = objectValue(payload.message)
  const meta = objectValue(payload.meta)
  const metadata = objectValue(payload.metadata)
  const sources = [
    objectValue(response.usage),
    objectValue(message?.usage),
    objectValue(meta?.billed_units),
    objectValue(response.usageMetadata),
    objectValue(response.usage_metadata),
    objectValue(payload.metrics),
    objectValue(metadata?.usage),
    objectValue(payload["amazon-bedrock-invocationMetrics"]),
  ].filter((source): source is Record<string, unknown> => Boolean(source))

  let result: UsageMetrics | undefined
  for (const source of sources) {
    let input = firstNumber(source, [
      "input_tokens", "prompt_tokens", "inputTokens", "promptTokenCount", "inputTokenCount",
      "input_token_count", "inputTokenCount",
    ])
    const output = firstNumber(source, [
      "output_tokens", "completion_tokens", "outputTokens", "candidatesTokenCount",
      "outputTokenCount", "output_token_count",
    ])
    const inputDetails = objectValue(source.input_tokens_details) || objectValue(source.prompt_tokens_details)
    const cached = firstNumber(inputDetails, ["cached_tokens", "cachedTokens", "cache_read_tokens", "cacheReadTokens"])
      ?? firstNumber(source, [
        "cache_read_input_tokens", "cacheReadInputTokens", "cacheReadInputTokenCount",
        "cached_content_token_count", "cachedContentTokenCount", "prompt_cache_hit_tokens",
        "cache_read_tokens", "cached_tokens", "cachedTokens", "input_cached_tokens",
      ])

    // Anthropic exposes uncached, cache-read, and cache-created input as separate buckets.
    const anthropicCacheRead = firstNumber(source, ["cache_read_input_tokens", "cacheReadInputTokens"])
    const anthropicCacheCreation = firstNumber(source, ["cache_creation_input_tokens", "cacheCreationInputTokens"])
    if (input !== undefined && (anthropicCacheRead !== undefined || anthropicCacheCreation !== undefined)) {
      input += (anthropicCacheRead || 0) + (anthropicCacheCreation || 0)
    }

    const extracted = {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cached !== undefined ? { cached } : {}),
    }
    if (input !== undefined || output !== undefined || cached !== undefined) {
      result = mergeUsage(result, extracted)
    }
  }
  return result
}

function responseMetadataFromSse(buffer: string) {
  const ids: string[] = []
  let usage: UsageMetrics | undefined
  for (const line of buffer.split("\n")) {
    if (!line.startsWith("data:")) continue
    try {
      const data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
      const response = objectValue(data.response) || data
      if (typeof response.id === "string") ids.push(response.id)
      usage = mergeUsage(usage, extractUsageMetrics(data))
    } catch { /* Partial and non-JSON SSE data is passed through unchanged. */ }
  }
  return { ids, usage }
}

function trackedUpstreamBody(
  upstream: Response,
  onResponseIds: (ids: string[]) => Promise<void>,
  onFinished: (metrics: { ttftMs?: number; usage?: UsageMetrics }) => Promise<void>,
  onCancelled: () => Promise<void>,
) {
  if (!upstream.body) {
    void onFinished({})
    return null
  }
  const reader = upstream.body.getReader()
  const contentType = upstream.headers.get("content-type") || ""
  const decoder = new TextDecoder()
  let buffered = ""
  let finished = false
  let firstByteAt: number | undefined
  let latestUsage: UsageMetrics | undefined
  const mappedResponseIds = new Set<string>()
  const mapResponseIds = async (ids: string[]) => {
    const newIds = ids.filter((id) => {
      if (mappedResponseIds.has(id)) return false
      mappedResponseIds.add(id)
      return true
    })
    if (!newIds.length) return
    try {
      await onResponseIds(newIds)
    } catch (error) {
      writeLog("warn", "gateway", "Unable to persist response affinity", { error: error instanceof Error ? error.message : "Unknown error" })
    }
  }
  const finish = async () => {
    if (finished) return
    finished = true
    if (contentType.includes("application/json") && buffered) {
      try {
        const parsed = JSON.parse(buffered) as Record<string, unknown>
        if (typeof parsed.id === "string") await mapResponseIds([parsed.id])
        latestUsage = mergeUsage(latestUsage, extractUsageMetrics(parsed))
      } catch { /* The upstream body remains untouched when it is not valid JSON. */ }
    }
    if (contentType.includes("text/event-stream") && buffered) {
      const metadata = responseMetadataFromSse(buffered)
      await mapResponseIds(metadata.ids)
      latestUsage = mergeUsage(latestUsage, metadata.usage)
    }
    try {
      await onFinished({
        ...(firstByteAt !== undefined ? { ttftMs: firstByteAt } : {}),
        ...(latestUsage ? { usage: latestUsage } : {}),
      })
    } catch (error) {
      writeLog("warn", "gateway", "Unable to release routing lease", { error: error instanceof Error ? error.message : "Unknown error" })
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          buffered += decoder.decode()
          await finish()
          controller.close()
          return
        }
        firstByteAt ??= Date.now()
        if (contentType.includes("text/event-stream")) {
          const text = decoder.decode(value, { stream: true })
          buffered += text
          const boundary = buffered.lastIndexOf("\n\n")
          if (boundary >= 0) {
            const complete = buffered.slice(0, boundary + 2)
            buffered = buffered.slice(boundary + 2)
            const metadata = responseMetadataFromSse(complete)
            await mapResponseIds(metadata.ids)
            latestUsage = mergeUsage(latestUsage, metadata.usage)
          }
        } else if (contentType.includes("application/json") && buffered.length < 2 * 1024 * 1024) {
          buffered += decoder.decode(value, { stream: true })
        }
        controller.enqueue(value)
      } catch (error) {
        await finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await onCancelled()
      await reader.cancel(reason)
      await finish()
    },
  })
}

export async function proxyRequest(request: Request, requestedProtocol: Protocol) {
  const gatewayApiKey = await authenticateProxyKey(request)
  if (!gatewayApiKey) {
    writeLog("warn", "gateway", "Request rejected: invalid API key", { protocol: requestedProtocol })
    return jsonError("Invalid gateway API key.", 401)
  }
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
  const route = resolveRoute(data.providers, data.models, data.aliases, payload.model, requestedProtocol)
  if (!route.ok) {
    writeLog("warn", "gateway", "Request could not be routed", { model: payload.model, protocol: requestedProtocol, status: route.status })
    return jsonError(route.message, route.status)
  }
  const { model, provider, protocol: modelProtocol } = route
  const gatewayModelId = model.gatewayModelId || model.id
  const providerApiKeys = data.providerApiKeys.filter((apiKey) => apiKey.providerId === provider.id && apiKey.enabled)
  if (provider.authType !== "none" && !providerApiKeys.length) {
    writeLog("warn", "gateway", "Provider has no enabled API keys", { provider: provider.name, model: gatewayModelId })
    return jsonError("The model provider has no enabled API keys.", 503)
  }

  let providerApiKey: ProviderApiKey | undefined = providerApiKeys[0]
  let routingStore: ReturnType<typeof getRoutingStateStore> | undefined
  let routingLeaseId: string | undefined
  const session = extractSessionIdentity(request, payload, modelProtocol, {
    gatewayKeyId: gatewayApiKey.id,
    providerId: provider.id,
    modelId: gatewayModelId,
    secret: data.sessionSecret,
  })
  const routingSessionKey = session?.key
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
        const status = reservation.reason === "capacity" ? 429 : 503
        return Response.json({ error: { message: reservation.reason === "capacity"
          ? "All provider API keys are currently at capacity."
          : "The API key bound to this response session is currently unavailable." } }, {
          status,
          headers: { "retry-after": String(reservation.retryAfterSeconds) },
        })
      }
      providerApiKey = providerApiKeys.find((apiKey) => apiKey.id === reservation.credentialId)
      if (!providerApiKey) {
        await routingStore.release({
          providerId: provider.id,
          modelId: gatewayModelId,
          credentialId: reservation.credentialId,
          leaseId: reservation.leaseId,
          status: 502,
        }).catch(() => undefined)
        return jsonError("The selected provider API key is unavailable.", 503)
      }
      routingLeaseId = reservation.leaseId
      try {
        providerApiKey = await refreshCodexAccount(providerApiKey)
      } catch (error) {
        await routingStore.release({
          providerId: provider.id,
          modelId: gatewayModelId,
          credentialId: providerApiKey.id,
          leaseId: routingLeaseId,
          status: 503,
        }).catch(() => undefined)
        return jsonError(error instanceof Error ? error.message : "Codex account refresh failed.", 503)
      }
    } catch (error) {
      writeLog("error", "gateway", "Shared routing state unavailable", { error: error instanceof Error ? error.message : "Unknown error" })
      return jsonError("Shared routing state is unavailable.", 503)
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
  const releaseLease = (status: number, retryAfterSeconds?: number) => {
    if (!routingStore || !providerApiKey || !routingLeaseId) {
      cleanupLease()
      return Promise.resolve()
    }
    return routingStore.release({
      providerId: provider.id,
      modelId: gatewayModelId,
      credentialId: providerApiKey.id,
      leaseId: routingLeaseId,
      status,
      retryAfterSeconds,
    })
  }
  const releaseOnce = (status: number, retryAfterSeconds?: number) => {
    if (!releasePromise) {
      releasePromise = releaseLease(status, retryAfterSeconds).finally(cleanupLease)
    }
    return releasePromise
  }
  const safeRelease = async (status: number, retryAfterSeconds?: number) => {
    try {
      await releaseOnce(status, retryAfterSeconds)
    } catch (error) {
      writeLog("warn", "gateway", "Unable to release routing lease", { error: error instanceof Error ? error.message : "Unknown error" })
    }
  }

  try {
    payload = mergeRequestOverrides(payload, model.requestOverrides || {})
    const isCodexOAuth = providerApiKey?.credentialKind === "codex-oauth"
    payload = isCodexOAuth ? normalizeCodexRequest(payload, model.upstreamModel, routingSessionKey) : { ...payload, model: model.upstreamModel }
    const streamOptions = objectValue(payload.stream_options)
    if (modelProtocol === "openai-chat" && payload.stream === true && streamOptions) {
      payload.stream_options = { ...streamOptions, include_usage: true }
    }
    const reasoningEffort = extractReasoningEffort(payload)
    const validatedProviderHeaders = validateProviderHeaders(provider.headers)
    let headers = isCodexOAuth
      ? buildCodexHeaders(request.headers, { ...provider, headers: validatedProviderHeaders }, providerApiKey?.key || "", providerApiKey?.accountId, routingSessionKey)
      : new Headers()
    if (!isCodexOAuth) {
      request.headers.forEach((value, key) => {
        if (!blockedRequestHeaders.has(key.toLowerCase())) headers.set(key, value)
      })
      headers.set("content-type", "application/json")
      Object.entries(validatedProviderHeaders).forEach(([key, value]) => headers.set(key, value))
      if (provider.authType === "bearer" && providerApiKey) headers.set("authorization", `Bearer ${providerApiKey.key}`)
      if (provider.authType === "x-api-key" && providerApiKey) headers.set("x-api-key", providerApiKey.key)
      if (provider.authType === "custom-header" && provider.authHeader && providerApiKey) headers.set(provider.authHeader, providerApiKey.key)
    }

    const account = providerApiKey?.name || provider.name
    const startedAt = Date.now()
    const upstreamController = new AbortController()
    clientAbortListener = () => {
      upstreamController.abort(request.signal.reason)
      void safeRelease(499)
    }
    request.signal.addEventListener("abort", clientAbortListener, { once: true })
    if (request.signal.aborted) clientAbortListener()
    if (request.signal.aborted) throw new Error("Request aborted")
    requestTimeout = setTimeout(() => {
      upstreamController.abort(new Error("Maximum routing request duration exceeded"))
      void safeRelease(502)
    }, maximumRoutingRequestMs(payload.stream === true))
    if (requestTimeout && typeof requestTimeout === "object" && "unref" in requestTimeout) requestTimeout.unref()
    if (routingStore && providerApiKey && routingLeaseId) {
      let renewing = false
      leaseRenewalTimer = setInterval(() => {
        if (renewing) return
        renewing = true
        void routingStore?.renew({
          providerId: provider.id,
          modelId: gatewayModelId,
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
      }, routingStore.leaseRenewalIntervalMs())
      if (leaseRenewalTimer && typeof leaseRenewalTimer === "object" && "unref" in leaseRenewalTimer) leaseRenewalTimer.unref()
    }
    writeLog("info", "gateway", requestSummary(provider.name, gatewayModelId, model.upstreamModel, modelProtocol, account, payload, reasoningEffort))
    const upstreamPath = isCodexOAuth ? (model.upstreamPath || "/responses") : (model.upstreamPath || protocolPaths[modelProtocol])
    const upstreamUrl = buildUpstreamUrl(provider.baseUrl, upstreamPath)
    let upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: upstreamController.signal,
      redirect: "manual",
    })
    if (isCodexOAuth && upstream.status === 401 && providerApiKey?.refreshToken) {
      await upstream.body?.cancel().catch(() => undefined)
      try {
        providerApiKey = await refreshCodexAccount(providerApiKey, true)
        headers = buildCodexHeaders(request.headers, { ...provider, headers: validatedProviderHeaders }, providerApiKey.key, providerApiKey.accountId, routingSessionKey)
        upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: upstreamController.signal,
          redirect: "manual",
        })
      } catch (error) {
        writeLog("warn", "gateway", "Codex token refresh after unauthorized response failed", { provider: provider.name, account: providerApiKey.name, error: error instanceof Error ? error.message : "Unknown error" })
      }
    }
    const responseHeaders = new Headers()
    upstream.headers.forEach((value, key) => {
      if (!blockedResponseHeaders.has(key.toLowerCase())) responseHeaders.set(key, value)
    })
    responseHeaders.set("x-rawroute-provider", provider.id)
    responseHeaders.set("x-rawroute-model", gatewayModelId)
    if (providerApiKey) responseHeaders.set("x-rawroute-provider-key", providerApiKey.id)
    if (!upstream.ok) await safeRelease(upstream.status, retryAfterSeconds(upstream.headers))
    const responseBody = trackedUpstreamBody(
      upstream,
      async (responseIds) => {
        if (routingStore && providerApiKey) await routingStore.mapResponses(responseIds, provider.id, providerApiKey.id)
      },
      async ({ ttftMs, usage }) => {
        if (!upstream.ok) return
        await safeRelease(upstream.status, retryAfterSeconds(upstream.headers))
        writeLog("info", "gateway", completionSummary(Date.now() - startedAt, ttftMs === undefined ? undefined : ttftMs - startedAt, usage))
      },
      async () => {
        upstreamController.abort(new Error("Downstream response was cancelled"))
        await safeRelease(499)
      },
    )
    if (!upstream.ok) writeLog("warn", "gateway", `FAILED ${upstream.status} ${Date.now() - startedAt}ms`)
    return new Response(responseBody, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
  } catch (error) {
    if (routingStore && providerApiKey && routingLeaseId) {
      await safeRelease(502).catch(() => undefined)
    }
    cleanupLease()
    writeLog("error", "gateway", "Upstream request failed", { provider: provider.name, model: gatewayModelId, error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError("Upstream request failed.", 502, error instanceof Error ? error.message : undefined)
  }
}
