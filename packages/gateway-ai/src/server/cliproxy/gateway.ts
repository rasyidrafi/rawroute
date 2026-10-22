import { admitExecution } from "./admission"
import { cliproxySecret } from "./connection"
import { authenticateProxyKey } from "../auth"
import { assertUnlimitedModelsAllowed, BudgetDeniedError, BudgetModelExcludedError, BudgetPricingUnavailableError, createGatewayUsageEvent, getBudgetRequestState, recordUsageEvent, releaseBudgetReservation, reserveBudgetAdmission, type BudgetReservation } from "../analytics"
import { scheduleCodexModelRefresh } from "../codex/model-refresh"
import { trackBackgroundTask } from "@rawroute/platform/server/background-tasks"
import { catalogModels } from "../../contracts/catalog"
import { applyComboMemberPolicy, comboMembers, normalizeComboCustomPayload } from "../../contracts/combo-reasoning"
import { extractRequestReasoningEffort, normalizeRequestLogMetadata, type RequestLogMetadata } from "../request-log-metadata"
import { recordLog } from "../logging"
import { extractUsageMetrics, type UsageMetrics } from "../usage-metrics"
import { listAliases, listCombos, listModels, listProviders } from "../store"
import type { ComboMember, Protocol, UsageEvent } from "../../contracts/domain"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { runWithGatewayAuditIdentity } from "@rawroute/observability/server/audit-context"

import { listSharedModelsForRecipient } from "../model-shares"
import { getWorkspace } from "@rawroute/platform/server/runtime"
import { upstreamFailure } from "../upstream-failure"
import { GatewayModelResolutionError, resolveGatewayModel } from "./model-resolution"
import type { ResolvedGatewayModel } from "./model-resolution"
import { collectStreamUsage } from "./stream-usage"
import { nativeResponsesBody, protocolForPath, proxyToCliProxy, proxyToNativeResponses, responseHeaders, rewriteForwardedBody } from "./transport"
import { requestServiceTier, serviceTierProfile } from "../../contracts/service-tier"

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
  // Preserve console-log precedence: direct declarations, then request and extra_body wrappers.
  // A zero is recorded only when one of those fields was explicitly an array.
  const directCounts = [payload.tools, payload.functions]
    .filter(Array.isArray)
    .map(arrayLength)
  const directCount = Math.max(0, ...directCounts)
  if (directCount) return directCount
  let toolsDeclared = directCounts.length > 0
  for (const key of ["request", "extra_body"]) {
    const nested = objectValue(payload[key])
    if (!nested) continue
    const nestedCounts = [nested.tools, nested.functions].filter(Array.isArray).map(arrayLength)
    toolsDeclared ||= nestedCounts.length > 0
    const nestedCount = Math.max(0, ...nestedCounts)
    if (nestedCount) return nestedCount
  }
  return toolsDeclared ? 0 : undefined
}

function completionDetails(durationMs: number, ttftMs: number | undefined, usage: UsageMetrics | undefined) {
  return { durationMs, ttftMs, usageKnown: usage !== undefined, inputTokens: usage?.input, cachedTokens: usage?.cached, outputTokens: usage?.output }
}

function suppliedGatewayKey(request: Request) {
  const authorization = request.headers.get("authorization")
  if (authorization?.slice(0, 7).toLowerCase() === "bearer ") return authorization.slice(7).trim()
  return request.headers.get("x-api-key")?.trim() || ""
}

function protocolForLogPath(path: string): Protocol | "catalog" {
  const normalized = path.toLowerCase()
  if (normalized.endsWith("/models") || normalized.endsWith("/models/")) return "catalog"
  return protocolForPath(path)
}

function actualResponseUsage(body: Uint8Array, contentType: string | null, profile: "openai" | "anthropic") {
  if (!contentType?.toLowerCase().includes("json")) return undefined
  let payload: Record<string, unknown> | undefined
  try { payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown> } catch { return undefined }
  return payload ? extractUsageMetrics(payload, profile) : undefined
}

export interface ComboMemberTestResult {
  modelId: string
  status: "verified" | "unverified" | "invalid"
  httpStatus?: number
  message: string
  latencyMs: number
}

function validationMessage(value: string) {
  try {
    const parsed = JSON.parse(value) as { error?: { message?: string }; message?: string }
    return parsed.error?.message || parsed.message || value
  } catch {
    return value
  }
}

export async function testComboMemberPolicy(member: ComboMember): Promise<ComboMemberTestResult> {
  const started = Date.now()
  const effort = member.reasoning?.mode === "override" ? member.reasoning.effort?.trim().toLowerCase() : undefined
  let customPayload: Record<string, unknown> | undefined
  try { customPayload = normalizeComboCustomPayload(member.customPayload) }
  catch (error) { return { modelId: member.modelId, status: "invalid", message: error instanceof Error ? error.message : "Custom payload is invalid.", latencyMs: 0 } }
  if (!effort && !customPayload) return { modelId: member.modelId, status: "verified", message: "No member policy to test.", latencyMs: 0 }
  try {
    const resolved = await resolveGatewayModel(member.modelId, member.sharedModelId)
    const supported = resolved.reasoningCapability?.supportedEfforts?.map((value) => value.trim().toLowerCase()).filter(Boolean)
    if (effort && resolved.reasoningCapability?.mode === "disabled") return { modelId: member.modelId, status: "invalid", message: "Reasoning overrides are disabled for this model.", latencyMs: Date.now() - started }
    if (effort && supported?.length && !supported.includes(effort)) return { modelId: member.modelId, status: "invalid", message: `This model does not allow reasoning effort ${effort}.`, latencyMs: Date.now() - started }

    const testCustomPayload = customPayload ? structuredClone(customPayload) : undefined
    if (testCustomPayload) for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens", "n"]) delete testCustomPayload[key]
    const probe = { model: member.modelId, messages: [{ role: "user", content: "Reply with OK." }], max_completion_tokens: 8, stream: true }
    const applied = applyComboMemberPolicy(probe, { ...member, customPayload: testCustomPayload })
    const payload = { ...applied.payload, model: member.modelId, messages: probe.messages, max_completion_tokens: 8, stream: true }
    const body = new TextEncoder().encode(JSON.stringify(payload))
    const request = new Request("http://rawroute.internal/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body, signal: AbortSignal.timeout(20_000) })
    const tested = { ...resolved, reasoningEffort: applied.effort, customPayload: applied.customPayload }
    let response: Response
    if (tested.nativeResponses) response = await proxyToNativeResponses(request, tested, body, "openai-chat")
    else {
      const internalKey = cliproxySecret("apiKey")
      if (!internalKey) return { modelId: member.modelId, status: "unverified", message: "CLIProxy internal key is unavailable.", latencyMs: Date.now() - started }
      const forwardedBody = await rewriteForwardedBody(body, tested.forwardedModel, member.modelId, "/v1/chat/completions", applied.effort, applied.customPayload)
      response = await proxyToCliProxy(request, "/v1/chat/completions", { body: Buffer.from(forwardedBody), headers: { authorization: `Bearer ${internalKey}`, "x-api-key": "" } })
    }
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { modelId: member.modelId, status: "verified", httpStatus: response.status, message: "Upstream accepted the streaming member policy.", latencyMs: Date.now() - started }
    }
    const responseText = (await response.text()).slice(0, 500)
    const message = validationMessage(responseText) || `Upstream returned ${response.status}.`
    const invalid = response.status === 400 || response.status === 404 || response.status === 422
    return { modelId: member.modelId, status: invalid ? "invalid" : "unverified", httpStatus: response.status, message, latencyMs: Date.now() - started }
  } catch (error) {
    return { modelId: member.modelId, status: "unverified", message: error instanceof Error ? error.message : "Unable to reach the upstream.", latencyMs: Date.now() - started }
  }
}

async function canonicalModelsResponse() {
  scheduleCodexModelRefresh()
  const [models, providers, aliases, combos, sharedModels] = await Promise.all([listModels(), listProviders(), listAliases(), listCombos(), listSharedModelsForRecipient()])
  return Response.json({ object: "list", data: catalogModels(providers, models, aliases, combos, sharedModels) }, { headers: { "cache-control": "no-store" } })
}

export async function proxyGatewayRequest(request: Request, path = new URL(request.url).pathname) {
  const authenticated = await authenticateProxyKey(request)
  if (!authenticated) {
    recordLog("gateway.authentication.rejected", { protocol: protocolForLogPath(path) }, { level: "warn" })
    return new Response(JSON.stringify({ error: { message: "Invalid gateway API key." } }), { status: 401, headers: { "content-type": "application/json" } })
  }
  return runWithGatewayAuditIdentity(authenticated.apiKey.id, () => runInWorkspace(authenticated.workspace, () => proxyGatewayRequestInWorkspace(request, path, authenticated.apiKey)))
    .then(normalizeRoutingFailure)
    .then(responseWithoutComboHeaders)
}

async function releaseBudgetReservationWithLog(reservation: BudgetReservation | undefined) {
  try {
    await releaseBudgetReservation(reservation)
  } catch (error) {
    recordLog("gateway.unable.to.release.routing.lease", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "warn" })
  }
}

function responseWithoutComboHeaders(response: Response) {
  const headers = responseHeaders(response.headers)
  headers.delete("x-rawroute-combo-terminal")
  headers.delete("x-rawroute-combo-member-unavailable")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function excludedModelResponse(error: BudgetModelExcludedError, comboMember = false) {
  return Response.json({ error: { message: error.message, code: error.code } }, {
    status: error.status,
    headers: comboMember ? { "x-rawroute-combo-member-unavailable": "1" } : undefined,
  })
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
  const attempt: RequestAttempt = { requestId: crypto.randomUUID(), requestedModel: typeof payload?.model === "string" ? payload.model : undefined, requestedServiceTier: requestServiceTier(payload || {}, serviceTierProfile(protocolForPath(path))), attemptIndex: 0, last: true }
  if (!requestedModel) return proxyGatewaySingleRequest(request, path, apiKey, undefined, undefined, attempt)
  const combo = (await listCombos()).find((entry) => entry.combo === requestedModel)
  if (!combo) return proxyGatewaySingleRequest(request, path, apiKey, undefined, undefined, attempt)
  attempt.routeName = combo.name.trim() || combo.combo
  try { await assertUnlimitedModelsAllowed([requestedModel]) }
  catch (error) { if (error instanceof BudgetModelExcludedError) return excludedModelResponse(error); throw error }

  let lastResponse: Response | undefined
  const members = comboMembers(combo)
  for (const [attemptIndex, member] of members.entries()) {
    const memberModelId = member.modelId
    if (request.signal.aborted) throw request.signal.reason
    const resolved = await resolveGatewayModel(memberModelId, member.sharedModelId).catch(() => undefined)
    if (member.sharedModelId && !resolved) continue
    let memberPayload = payload
    let reasoningEffort: string | undefined
    let customPayload: Record<string, unknown> | undefined
    try {
      const applied = applyComboMemberPolicy(payload!, member)
      memberPayload = applied.payload
      reasoningEffort = applied.effort
      customPayload = applied.customPayload
    } catch (error) {
      recordLog("gateway.combo.member.policy.is.invalid", { comboId: combo.id, memberModelId, error: error instanceof Error ? error.message : "Unknown error" }, { level: "warn" })
      continue
    }
    const memberRequest = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
      body: JSON.stringify({ ...memberPayload, model: memberModelId }),
      signal: request.signal,
    })
    const response = await normalizeRoutingFailure(await proxyGatewaySingleRequest(memberRequest, path, apiKey, resolved ? { ...resolved, reasoningEffort, customPayload } : undefined, requestedModel, { ...attempt, attemptIndex, last: attemptIndex === members.length - 1 }))
    if (response.ok || response.headers.get("x-rawroute-combo-terminal") === "1") {
      if (lastResponse) void lastResponse.body?.cancel().catch(() => undefined)
      return responseWithoutComboHeaders(response)
    }
    if (lastResponse) void lastResponse.body?.cancel().catch(() => undefined)
    lastResponse = response
    recordLog("gateway.combo.member.failed.trying.next", { comboId: combo.id, memberModelId, status: response.status }, { level: "warn" })
  }
  return responseWithoutComboHeaders(lastResponse || new Response(JSON.stringify({ error: { message: "No combo models are available." } }), { status: 503, headers: { "content-type": "application/json" } }))
}

type RequestAttempt = { routeName?: string; requestId: string; requestedModel?: string; requestedServiceTier?: string; attemptIndex: number; last: boolean }

function attemptMetadata(attempt: RequestAttempt | undefined, response?: Response) {
  if (!attempt) return {}
  return { requestId: attempt.requestId, requestedModel: attempt.requestedModel, attemptIndex: attempt.attemptIndex, requestFinal: attempt.last || response?.ok === true || response?.headers.get("x-rawroute-combo-terminal") === "1" }
}

async function proxyGatewaySingleRequest(request: Request, path: string, apiKey: { id: string; name?: string }, preResolved?: ResolvedGatewayModel, requestedCombo?: string, attempt?: RequestAttempt) {
  const supplied = suppliedGatewayKey(request)

  const isInference = request.method !== "GET" && request.method !== "HEAD" && !path.endsWith("/models")
  if (!isInference) {
    if (request.method === "GET" && path.endsWith("/models")) {
      const response = await canonicalModelsResponse()
      recordLog("gateway.catalog.served", { apiKeyId: apiKey.id, status: response.status, protocol: "catalog" })
      return response
    }
    const internalKey = cliproxySecret("apiKey") || supplied
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
    recordLog("gateway.model.resolution.failed", { model: estimate.model, errorCode: resolution.code, status: resolution.status }, { level: resolution.status === 400 ? "warn" : "error" })
    return new Response(JSON.stringify({ error: { message: resolution.message, code: resolution.code } }), {
      status: resolution.status,
      headers: {
        "content-type": "application/json",
        ...(resolution.code === "model_not_found" ? { "x-rawroute-combo-member-unavailable": "1" } : {}),
      },
    })
  }
  const routing: NonNullable<UsageEvent["routing"]> = {
    modelId: resolvedModel.pricingGatewayModelId,
    modelName: resolvedModel.modelName,
    routeName: attempt?.routeName || resolvedModel.aliasName,
  }
  let releaseExecution: (() => void) | undefined
  try { if (!resolvedModel.nativeResponses) releaseExecution = admitExecution() }
  catch { return Response.json({ error: { message: "CLIProxy is draining requests for maintenance." } }, { status: 503 }) }
  let deferredRelease = false
  try {
    const payload = objectValue(parsed) || {}
    const tierProfile = resolvedModel.serviceTierCapability?.profile || serviceTierProfile(resolvedModel.upstreamProtocol)
    const forwardedBody = resolvedModel.nativeResponses
      ? new TextEncoder().encode(nativeResponsesBody(body, resolvedModel.upstreamModel, protocol, resolvedModel.reasoningEffort, resolvedModel.customPayload))
      : await rewriteForwardedBody(body, resolvedModel.forwardedModel, estimate.model, path, resolvedModel.reasoningEffort, resolvedModel.customPayload)
    const forwardedPayload = objectValue(JSON.parse(new TextDecoder().decode(forwardedBody))) || payload
    let budgetState: Awaited<ReturnType<typeof getBudgetRequestState>>
    let reservation: BudgetReservation | undefined
    try {
      const ownerWorkspace = resolvedModel.shared ? await getWorkspace(resolvedModel.shared.ownerWorkspaceId) : undefined
      // A recipient combo exception must never bypass the shared owner policy.
      budgetState = resolvedModel.shared && ownerWorkspace
        ? await runInWorkspace(ownerWorkspace, () => getBudgetRequestState(
            `shared-workspace:${resolvedModel.shared!.consumerWorkspaceId}`,
            resolvedModel.pricingGatewayModelId,
            resolvedModel.providerModelId,
            forwardedPayload,
            forwardedBody.byteLength,
            protocol,
            undefined,
            tierProfile,
          ))
        : await getBudgetRequestState(
            apiKey.id,
            resolvedModel.pricingGatewayModelId,
            resolvedModel.providerModelId,
            forwardedPayload,
            forwardedBody.byteLength,
            protocol,
            requestedCombo,
            tierProfile,
          )
    } catch (error) {
      if (error instanceof BudgetModelExcludedError) {
        recordLog("gateway.budget.model.excluded", { apiKeyId: apiKey.id, model: estimate.model }, { level: "warn" })
        return excludedModelResponse(error, true)
      }
      if (error instanceof BudgetDeniedError) {
        recordLog("gateway.budget.admission.denied", { apiKeyId: apiKey.id, status: error.status, retryAfter: error.retryAfterSeconds }, { level: "warn" })
        return new Response(JSON.stringify({ error: { message: error.message } }), { status: error.status, headers: { "content-type": "application/json", "retry-after": String(error.retryAfterSeconds), ...(requestedCombo ? { "x-rawroute-combo-member-unavailable": "1" } : { "x-rawroute-combo-terminal": "1" }) } })
      }
      if (error instanceof BudgetPricingUnavailableError) {
        recordLog("gateway.budget.pricing.unavailable", { apiKeyId: apiKey.id, status: error.status, model: estimate.model }, { level: "warn" })
        return new Response(JSON.stringify({ error: { message: error.message } }), { status: error.status, headers: { "content-type": "application/json", ...(requestedCombo ? { "x-rawroute-combo-member-unavailable": "1" } : { "x-rawroute-combo-terminal": "1" }) } })
      }
      recordLog("gateway.budget.state.unavailable", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
      return new Response(JSON.stringify({ error: { message: "Budget state is unavailable." } }), { status: 503, headers: { "content-type": "application/json", "x-rawroute-combo-terminal": "1" } })
    }

    try {
      reservation = await reserveBudgetAdmission(apiKey.id, budgetState.admission, budgetState.usageContext)
    } catch (error) {
      if (error instanceof BudgetDeniedError) {
        recordLog("gateway.budget.admission.denied", { apiKeyId: apiKey.id, status: error.status, retryAfter: error.retryAfterSeconds }, { level: "warn" })
        return new Response(JSON.stringify({ error: { message: error.message } }), {
          status: error.status,
          headers: { "content-type": "application/json", "retry-after": String(error.retryAfterSeconds), ...(requestedCombo ? { "x-rawroute-combo-member-unavailable": "1" } : { "x-rawroute-combo-terminal": "1" }) },
        })
      }
      recordLog("gateway.shared.budget.state.unavailable", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
      return new Response(JSON.stringify({ error: { message: "Budget state is unavailable." } }), { status: 503, headers: { "content-type": "application/json", "x-rawroute-combo-terminal": "1" } })
    }

    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const requestMetadata: RequestLogMetadata = normalizeRequestLogMetadata({
      requestedServiceTier: attempt ? attempt.requestedServiceTier : requestServiceTier(payload, serviceTierProfile(protocol)),
      sentServiceTier: requestServiceTier(forwardedPayload, tierProfile) || "auto",
      reasoningEffort: resolvedModel.reasoningEffort !== undefined
        ? resolvedModel.reasoningEffort
        : extractRequestReasoningEffort(payload, protocol),
      toolCount: requestToolCount(payload),
    })
    recordLog("gateway.request.started", {
      providerId: resolvedModel.providerId, model: resolvedModel.pricingGatewayModelId, upstreamModel: resolvedModel.upstreamModel,
      protocol, upstreamProtocol: resolvedModel.upstreamProtocol, apiKeyId: apiKey.id,
      ...requestMetadata,
      messageCount: requestItemCount(payload, protocol), promptCacheKey: resolvedModel.promptCacheKey,
    })
    let response: Response
    try {
      response = resolvedModel.nativeResponses
        ? await proxyToNativeResponses(request, resolvedModel, body, protocol)
        : await proxyToCliProxy(request, path, {
            body: Buffer.from(forwardedBody),
            admitted: true,
            headers: { authorization: `Bearer ${cliproxySecret("apiKey") || supplied}`, "x-api-key": "" },
          })
    } catch {
      await releaseBudgetReservationWithLog(reservation)
      await recordGatewayUsageWithRetry({ routing, apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: 502, response: undefined, budgetState, shared: resolvedModel.shared, ...requestMetadata, ...attemptMetadata(attempt) }).catch(() => undefined)
      recordLog("gateway.upstream.request.failed", { providerId: resolvedModel.providerId, model: resolvedModel.pricingGatewayModelId, status: 502 }, { level: "error" })
      return new Response(JSON.stringify({ error: { message: "Upstream request failed." } }), { status: 502, headers: { "content-type": "application/json" } })
    }
    if (response.ok && response.body && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      const [downstream, monitor] = response.body.tee()
      const trackedResponse = new Response(downstream, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
      deferredRelease = true
      void trackBackgroundTask((async () => {
        try {
          const collected = await collectStreamUsage(monitor, tierProfile)
          const streamStatus = collected.terminalEventSeen ? response.status : 502
          await recordGatewayUsageWithRetry({ routing, apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: streamStatus, response: collected.usage, budgetState, shared: resolvedModel.shared, ...requestMetadata, ...attemptMetadata(attempt, response) })
            .catch((recordingError) => recordLog("gateway.unable.to.persist.usage.event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" }, { level: "warn" }))
          const details = { status: streamStatus, terminalEvent: collected.terminalEventSeen, usageKnown: collected.usage !== undefined }
          recordLog(streamStatus < 400 ? "gateway.request.completed" : "gateway.request.failed", {
            ...details, ...completionDetails(Date.now() - startedAtMs, collected.firstByteAt === undefined ? undefined : collected.firstByteAt - startedAtMs, collected.usage), streaming: true,
          }, { level: streamStatus < 400 ? "info" : "warn" })
        } catch (recordingError) {
          recordLog("gateway.unable.to.calculate.usage.event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" }, { level: "warn" })
        } finally {
          await releaseBudgetReservationWithLog(reservation)
          releaseExecution?.()
        }
      })())
      return trackedResponse
    }
    const responseBody = new Uint8Array(await response.arrayBuffer())
    const usage = actualResponseUsage(responseBody, response.headers.get("content-type"), tierProfile)
    await recordGatewayUsageWithRetry({ routing, apiKeyId: apiKey.id, model: estimate.model, providerModelId: resolvedModel.providerModelId, protocol, startedAt, status: response.status, response: usage, budgetState, shared: resolvedModel.shared, ...requestMetadata, ...attemptMetadata(attempt, response) })
      .catch((recordingError) => recordLog("gateway.unable.to.persist.usage.event", { error: recordingError instanceof Error ? recordingError.message : "Unknown error" }, { level: "warn" }))
    if (response.ok) recordLog("gateway.request.completed", { status: response.status, ...completionDetails(Date.now() - startedAtMs, undefined, usage), streaming: false })
    else {
      const failure = await upstreamFailure(new Response(responseBody, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) }))
      if (!response.headers.has("retry-after") && failure.retrySeconds) response.headers.set("retry-after", String(failure.retrySeconds))
      recordLog("gateway.request.failed", { status: response.status, durationMs: Date.now() - startedAtMs, providerId: resolvedModel.providerId, model: resolvedModel.pricingGatewayModelId, source: resolvedModel.nativeResponses ? "provider" : "cliproxy", errorCode: failure.errorCode || "unknown", retryAfter: failure.retrySeconds }, { level: "warn" })
    }
    await releaseBudgetReservationWithLog(reservation)
    return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) })
  } finally { if (!deferredRelease) releaseExecution?.() }
}

type GatewayUsageRecordingInput = {
  routing: NonNullable<UsageEvent["routing"]>
  requestedServiceTier?: string
  sentServiceTier?: string
  requestId?: string
  requestedModel?: string
  attemptIndex?: number
  requestFinal?: boolean
  apiKeyId: string
  model: string
  providerModelId?: string
  protocol: Protocol
  startedAt: string
  status: number
  response: ReturnType<typeof extractUsageMetrics> | undefined
  reasoningEffort?: RequestLogMetadata["reasoningEffort"]
  toolCount?: number
  budgetState: Awaited<ReturnType<typeof getBudgetRequestState>>
  id?: string
  shared?: ResolvedGatewayModel["shared"]
}

export function sharedUsageEventCopies(event: UsageEvent, shared: NonNullable<ResolvedGatewayModel["shared"]>) {
  const consumerEvent: UsageEvent = {
    ...event,
    id: `${event.id}-consumer`,
    costMicros: 0,
    pricingConfidence: event.pricingConfidence === "unpriced" ? "unpriced" : "exact",
    costSource: undefined,
    pricingGroupId: undefined,
    pricingVersionId: undefined,
    pricingContextTier: undefined,
    sharedUsage: { shareId: shared.id, role: "consumer", peerWorkspaceId: shared.ownerWorkspaceId, peerWorkspaceName: shared.ownerWorkspaceName, sourceGatewayModelId: shared.sourceGatewayModelId },
  }
  const ownerEvent: UsageEvent = {
    ...event,
    id: `${event.id}-owner`,
    gatewayKeyId: `shared-workspace:${shared.consumerWorkspaceId}`,
    gatewayModelId: shared.sourceGatewayModelId,
    sharedUsage: { shareId: shared.id, role: "owner", peerWorkspaceId: shared.consumerWorkspaceId, peerWorkspaceName: shared.consumerWorkspaceName, sourceGatewayModelId: shared.sourceGatewayModelId },
  }
  return { consumerEvent, ownerEvent }
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
    requestId: input.requestId,
    requestedModel: input.requestedModel,
    routing: input.routing,
    attemptIndex: input.attemptIndex,
    requestFinal: input.requestFinal,
    requestedServiceTier: input.requestedServiceTier,
    sentServiceTier: input.sentServiceTier,
    gatewayKeyId: input.apiKeyId,
    gatewayModelId: input.model,
    providerModelId: input.providerModelId,
    protocol: input.protocol,
    startedAt: input.startedAt,
    status: input.status,
    durationMs: Math.max(0, Date.now() - Date.parse(input.startedAt)),
    requestBodyBytes: input.budgetState.requestBodyBytes,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.toolCount !== undefined ? { toolCount: input.toolCount } : {}),
    metrics: input.response,
    estimatedUsage: shouldSettleEstimate ? input.budgetState.estimatedUsage : undefined,
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
  const { consumerEvent, ownerEvent } = sharedUsageEventCopies(event, shared)
  await recordUsageEvent(consumerEvent, null)
  const ownerWorkspace = await getWorkspace(shared.ownerWorkspaceId)
  if (ownerWorkspace) await runInWorkspace(ownerWorkspace, () => recordUsageEvent(ownerEvent, input.budgetState.usageContext))
}

export { cliproxyManagement, cliproxyManagementJson } from "./management"
export { GatewayModelResolutionError } from "./model-resolution"
export type { ResolvedGatewayModel } from "./model-resolution"
export { collectStreamUsage, isTerminalStreamEvent } from "./stream-usage"
export { cliProxyHealth, proxyToCliProxy } from "./transport"

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
