import {
  ChatCompletionToMessagesConverter,
  ChatCompletionToResponsesConverter,
  MessagesToChatCompletionConverter,
  MessagesToResponsesConverter,
  ResponsesToChatCompletionConverter,
  ResponsesToMessagesConverter,
} from "@zenmux/rosetta-ai"
import { createHash } from "node:crypto"
import { createOpenAIOAuthTransport, type OpenAIOAuthSession, type OpenAIOAuthTransport } from "@openai-oauth/core"
import type { Protocol, Provider, ProviderApiKey } from "../../contracts/domain"
import { mergeComboCustomPayload, applyReasoningOverride } from "../../contracts/combo-reasoning"
import { normalizeProviderBaseUrl, providerResponsesUrl } from "../../contracts/provider-capabilities"
import { normalizeResponsesRequest } from "../request-normalization"
import { withProviderCredentialRoutingSnapshot } from "../store"
import { extractUsageMetrics, type UsageMetrics } from "../usage-metrics"
import type { ResolvedGatewayModel } from "./model-resolution"
import { sessionPromptCacheScope } from "./prompt-cache"
import { collectStreamUsage, isTerminalStreamEvent } from "./stream-usage"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { providerCredentialScheduler, type ProviderCredentialAdmission, type ProviderCredentialScheduler } from "./provider-credential-scheduler"

const hopByHopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length", "expect", "content-encoding",
])
const DEFAULT_ANTHROPIC_API_VERSION = "2023-06-01"

const CODEX_REPLAY_CACHE_LIMIT = 256
const PROVIDER_RESPONSE_REFERENCE_LIMIT = 4_096
const PROVIDER_RESPONSE_REFERENCE_ID_LIMIT = 512
const PROVIDER_RESPONSE_REFERENCE_FRAME_LIMIT = 256 * 1_024
const PROVIDER_STREAM_LEASE_TIMEOUT_MS = 299_000
const codexReplayTransports = new Map<string, OpenAIOAuthTransport>()
const codexResponseCaptures = new WeakMap<Response, CodexReplayCapture>()
const codexTransportSessions = new WeakMap<OpenAIOAuthTransport, { lastSession?: OpenAIOAuthSession }>()
const codexReplayCredentialIds = new Map<string, string>()
const providerResponseCredentialIds = new Map<string, ProviderResponseCredential | { conflict: true }>()

type GatewayCaller = { workspaceId: string; gatewayKeyId: string }
type CodexReplayCapture = { namespace: string; callerNamespace: string; sessionKey?: string; credentialId: string; transport: OpenAIOAuthTransport }
type ProviderResponseReferenceObserver = { write: (chunk: Uint8Array) => void; finish: () => void }
type ProviderResponseCredential = { credentialId: string | null; keyFingerprint?: string }

function providerResponseNamespace(resolved: ResolvedGatewayModel, caller: GatewayCaller) {
  const upstream = resolved.upstream!
  return JSON.stringify([
    caller.workspaceId,
    caller.gatewayKeyId,
    resolved.shared?.ownerWorkspaceId || currentWorkspaceId(),
    resolved.providerId,
    resolved.providerPrefix,
    upstream.baseUrl,
    upstream.protocol,
    upstream.authType,
    createHash("sha256").update(providerHeadersFingerprint(upstream.headers)).digest("hex"),
  ])
}

function providerResponseReferenceKey(namespace: string, id: string) {
  return JSON.stringify([namespace, id])
}

function credentialFingerprint(credential: ProviderApiKey | undefined) {
  return credential ? createHash("sha256").update(credential.key).digest("hex") : undefined
}

function rememberProviderResponseCredential(namespace: string, id: string, credential: ProviderResponseCredential) {
  if (!id || id.length > PROVIDER_RESPONSE_REFERENCE_ID_LIMIT) return
  const key = providerResponseReferenceKey(namespace, id)
  const existing = providerResponseCredentialIds.get(key)
  const value = existing && ("conflict" in existing || JSON.stringify(existing) !== JSON.stringify(credential))
    ? { conflict: true as const }
    : credential
  providerResponseCredentialIds.delete(key)
  providerResponseCredentialIds.set(key, value)
  while (providerResponseCredentialIds.size > PROVIDER_RESPONSE_REFERENCE_LIMIT) {
    const oldest = providerResponseCredentialIds.keys().next().value
    if (oldest === undefined) break
    providerResponseCredentialIds.delete(oldest)
  }
}

function lookupProviderResponseCredential(namespace: string, id: string) {
  if (id.length > PROVIDER_RESPONSE_REFERENCE_ID_LIMIT) return { found: false as const }
  const key = providerResponseReferenceKey(namespace, id)
  if (!providerResponseCredentialIds.has(key)) return { found: false as const }
  const credential = providerResponseCredentialIds.get(key)!
  providerResponseCredentialIds.delete(key)
  providerResponseCredentialIds.set(key, credential)
  return "conflict" in credential
    ? { found: true as const, conflict: true as const }
    : { found: true as const, credential }
}

function providerResponseReferenceIds(payload: Record<string, unknown>) {
  const ids = [
    ...(typeof payload.previous_response_id === "string" ? [payload.previous_response_id] : []),
    ...responseReferences(payload.input),
  ]
  return [...new Set(ids)]
}

function rememberProviderResponseValue(namespace: string, credential: ProviderResponseCredential, value: unknown, jsonRoot = false) {
  const record = objectValue(value)
  if (!record) return
  const response = objectValue(record.response) || record
  const responseId = response.id
  const isResponseEvent = typeof record.type === "string" && record.type.startsWith("response.")
  if (typeof responseId === "string" && responseId && (jsonRoot || Object.hasOwn(record, "response") || isResponseEvent)) {
    rememberProviderResponseCredential(namespace, responseId, credential)
  }
  if (Array.isArray(response.output)) for (const entry of response.output.slice(0, PROVIDER_RESPONSE_REFERENCE_LIMIT)) {
    const item = objectValue(entry)
    if (typeof item?.id === "string" && item.id) rememberProviderResponseCredential(namespace, item.id, credential)
  }
  const item = objectValue(record.item)
  if (typeof item?.id === "string" && item.id) rememberProviderResponseCredential(namespace, item.id, credential)
  for (const field of [record.item_id, record.response_id]) {
    if (typeof field === "string" && field) rememberProviderResponseCredential(namespace, field, credential)
  }
}

function createProviderResponseReferenceObserver(namespace: string, credential: ProviderResponseCredential): ProviderResponseReferenceObserver {
  const decoder = new TextDecoder()
  let buffer = ""
  const observe = (event: ParsedSseEvent) => {
    if (event.data.trim() === "[DONE]") return
    try { rememberProviderResponseValue(namespace, credential, JSON.parse(event.data)) } catch {}
  }
  return {
    write(chunk) {
      buffer = drainSseFrames(buffer + decoder.decode(chunk, { stream: true }), observe)
      if (buffer.length > PROVIDER_RESPONSE_REFERENCE_FRAME_LIMIT) buffer = ""
    },
    finish() {
      buffer += decoder.decode()
      if (buffer && buffer.length <= PROVIDER_RESPONSE_REFERENCE_FRAME_LIMIT) drainSseFrames(`${buffer}\n\n`, observe)
      buffer = ""
    },
  }
}

// The OAuth transport owns response replay state. Keep it caller/account scoped;
// without a session header, reuse is allowed only through that caller's response ID.
function rememberCodexTransport(key: string, transport: OpenAIOAuthTransport) {
  codexReplayTransports.delete(key)
  codexReplayTransports.set(key, transport)
  while (codexReplayTransports.size > CODEX_REPLAY_CACHE_LIMIT) {
    const oldest = codexReplayTransports.keys().next().value
    if (oldest === undefined) break
    codexReplayTransports.delete(oldest)
  }
}

function rememberCodexCredential(key: string, credentialId: string) {
  codexReplayCredentialIds.delete(key)
  codexReplayCredentialIds.set(key, credentialId)
  while (codexReplayCredentialIds.size > CODEX_REPLAY_CACHE_LIMIT * 2) {
    const oldest = codexReplayCredentialIds.keys().next().value
    if (oldest === undefined) break
    codexReplayCredentialIds.delete(oldest)
  }
}

function codexCallerNamespace(resolved: ResolvedGatewayModel, caller: GatewayCaller) {
  return JSON.stringify([caller.workspaceId, caller.gatewayKeyId, resolved.providerId, resolved.upstream!.baseUrl])
}

function responseReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(responseReferences)
  const record = objectValue(value)
  if (!record) return []
  const own = record.type === "item_reference" && typeof record.id === "string" ? [record.id] : []
  return [...own, ...Object.values(record).flatMap(responseReferences)]
}

function codexReplayReferenceKeys(payload: Record<string, unknown>, namespace: string) {
  return [
    ...(typeof payload.previous_response_id === "string" ? [`response:${namespace}:${payload.previous_response_id}`] : []),
    ...responseReferences(payload.input).map((id) => `item:${namespace}:${id}`),
  ]
}

function preferredCodexCredential(request: Request, body: Uint8Array, resolved: ResolvedGatewayModel, caller: GatewayCaller | undefined) {
  if (!caller) return undefined
  const callerNamespace = codexCallerNamespace(resolved, caller)
  const session = sessionPromptCacheScope(request.headers, caller.workspaceId, caller.gatewayKeyId)
  let payload: Record<string, unknown> | undefined
  try { payload = objectValue(JSON.parse(new TextDecoder().decode(body))) } catch {}
  if (!payload) return undefined
  const referenceKeys = codexReplayReferenceKeys(payload, callerNamespace)
  const credentials = new Set(referenceKeys.map((key) => codexReplayCredentialIds.get(key)).filter((id): id is string => Boolean(id)))
  if (credentials.size > 1) throw new ProtocolConversionError("Responses continuation items belong to different Codex sessions.")
  const credentialId = [...credentials][0]
  const sessionKey = session ? `session:${callerNamespace}:${session}` : undefined
  const sessionCredentialId = sessionKey ? codexReplayCredentialIds.get(sessionKey) : undefined
  if (sessionCredentialId && credentialId && sessionCredentialId !== credentialId) throw new ProtocolConversionError("Responses continuation items belong to a different Codex session.")
  if (sessionCredentialId) return { credentialId: sessionCredentialId, continuation: referenceKeys.length > 0 }
  return credentialId ? { credentialId, continuation: referenceKeys.length > 0 } : undefined
}

function codexReplayTransport(request: Request, resolved: ResolvedGatewayModel, credential: ProviderApiKey, body: Uint8Array, caller: GatewayCaller | undefined, loadSession: () => Promise<OpenAIOAuthSession>) {
  const accountId = credential.accountId || credential.id
  const callerNamespace = caller ? codexCallerNamespace(resolved, caller) : ""
  const namespace = caller ? JSON.stringify([callerNamespace, accountId]) : ""
  const session = caller ? sessionPromptCacheScope(request.headers, caller.workspaceId, caller.gatewayKeyId) : undefined
  let payload: Record<string, unknown> | undefined
  try {
    payload = objectValue(JSON.parse(new TextDecoder().decode(body)))
  } catch {}
  const sessionKey = session && namespace ? `session:${namespace}:${session}` : undefined
  const referenceKeys = payload && callerNamespace ? codexReplayReferenceKeys(payload, callerNamespace) : []
  const referenced = referenceKeys.flatMap((referenceKey) => {
    const id = referenceKey.slice(referenceKey.lastIndexOf(":") + 1)
    const type = referenceKey.startsWith("response:") ? "response" : "item"
    const key = `response:${namespace}:${id}`
    const transport = type === "response" ? codexReplayTransports.get(key) : codexReplayTransports.get(`item:${namespace}:${id}`)
    return transport ? [{ key: type === "response" ? key : `item:${namespace}:${id}`, transport }] : []
  })
  if (new Set(referenced.map((entry) => entry.transport)).size > 1) throw new ProtocolConversionError("Responses continuation items belong to different Codex sessions.")
  const sessionTransport = sessionKey ? codexReplayTransports.get(sessionKey) : undefined
  const referenceTransport = referenced[0]?.transport
  if (sessionTransport && referenceTransport && sessionTransport !== referenceTransport) throw new ProtocolConversionError("Responses continuation items belong to a different Codex session.")
  let transport = sessionTransport || referenceTransport
  if (transport) {
    const existingKey = sessionTransport && sessionKey ? sessionKey : referenced[0]?.key
    if (existingKey) {
      codexReplayTransports.delete(existingKey)
      codexReplayTransports.set(existingKey, transport)
    }
  } else {
    const state: { lastSession?: OpenAIOAuthSession } = {}
    transport = createOpenAIOAuthTransport({
      auth: async () => {
        state.lastSession = await loadSession()
        return state.lastSession
      },
      baseURL: resolved.upstream!.baseUrl,
    })
    codexTransportSessions.set(transport, state)
  }
  if (sessionKey) rememberCodexTransport(sessionKey, transport)
  return {
    transport,
    sessionState: codexTransportSessions.get(transport),
    capture: namespace ? { namespace, callerNamespace, sessionKey: session && callerNamespace ? `session:${callerNamespace}:${session}` : undefined, credentialId: credential.id, transport } : undefined,
  }
}

function rememberCodexResponse(capture: CodexReplayCapture | undefined, value: unknown) {
  if (!capture) return
  const response = objectValue(objectValue(value)?.response) || objectValue(value)
  const responseId = response?.id
  if (typeof responseId === "string" && responseId) {
    rememberCodexTransport(`response:${capture.namespace}:${responseId}`, capture.transport)
    rememberCodexCredential(`response:${capture.callerNamespace}:${responseId}`, capture.credentialId)
  }
  if (Array.isArray(response?.output)) for (const output of response.output) {
    const item = objectValue(output)
    if (typeof item?.id !== "string" || !item.id) continue
    rememberCodexItem(capture, item.id)
  }
  if (capture.sessionKey) rememberCodexCredential(capture.sessionKey, capture.credentialId)
}

function rememberCodexItem(capture: CodexReplayCapture, itemId: string) {
  rememberCodexTransport(`item:${capture.namespace}:${itemId}`, capture.transport)
  rememberCodexCredential(`item:${capture.callerNamespace}:${itemId}`, capture.credentialId)
  if (capture.sessionKey) rememberCodexCredential(capture.sessionKey, capture.credentialId)
}

export function responseHeaders(source: Headers) {
  const headers = new Headers()
  for (const [name, value] of source.entries()) {
    if (!hopByHopHeaders.has(name.toLowerCase())) headers.set(name, value)
  }
  return headers
}

export class ProtocolConversionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtocolConversionError"
  }
}

function localProviderError(status: number, code: string, message: string, options: { retryAfterSeconds?: number; terminal?: boolean } = {}) {
  return Response.json({ error: { code, message } }, {
    status,
    headers: {
      ...(options.retryAfterSeconds !== undefined ? { "retry-after": String(options.retryAfterSeconds) } : {}),
      ...(options.terminal ? { "x-rawroute-combo-terminal": "1" } : {}),
    },
  })
}

function providerAdmissionFailure(admission: Extract<ProviderCredentialAdmission, { ok: false }>, terminal = false) {
  if (admission.reason === "rpm_limit") {
    return localProviderError(429, "provider_credential_rpm_limit", "Provider request limit reached. Retry after the current window expires.", {
      retryAfterSeconds: Math.max(1, Math.ceil((admission.retryAfterMs || 0) / 1_000)),
      terminal,
    })
  }
  if (admission.reason === "required_credential_unavailable") {
    return localProviderError(503, "provider_response_continuation_unavailable", "This Responses continuation is unavailable. Start a new response.", { terminal: true })
  }
  if (admission.reason === "no_eligible_credentials") {
    return localProviderError(503, "provider_credentials_unavailable", "Provider credentials are unavailable.", { terminal })
  }
  return localProviderError(503, "provider_credential_concurrency_limit", "Provider capacity is temporarily unavailable.", { terminal })
}

function ambiguousProviderFailure() {
  return localProviderError(502, "provider_request_outcome_unknown", "The provider request did not complete. It was not retried because its outcome is unknown.", { terminal: true })
}

function continuationUnavailable() {
  return localProviderError(503, "provider_response_continuation_unavailable", "This Responses continuation is unavailable. Start a new response.", { terminal: true })
}

function continuationConflict() {
  return localProviderError(400, "provider_response_continuation_conflict", "Responses continuation items belong to different requests.", { terminal: true })
}

type RosettaRoundTrip = {
  convertRequest(value: Record<string, unknown>): unknown
  convertResponse(value: Record<string, unknown>): unknown
  convertStreamEvent?(value: Record<string, unknown>): unknown
  convertStreamChunk?(value: Record<string, unknown>): unknown
  flushTerminalEvents?(): unknown
  finalizeStream?(): unknown
}

function createConverter(client: Protocol, upstream: Protocol): RosettaRoundTrip | undefined {
  if (client === upstream) return undefined
  if (client === "openai-chat" && upstream === "anthropic-messages") return new ChatCompletionToMessagesConverter() as unknown as RosettaRoundTrip
  if (client === "openai-chat" && upstream === "openai-responses") return new ChatCompletionToResponsesConverter() as unknown as RosettaRoundTrip
  if (client === "anthropic-messages" && upstream === "openai-chat") return new MessagesToChatCompletionConverter() as unknown as RosettaRoundTrip
  if (client === "anthropic-messages" && upstream === "openai-responses") return new MessagesToResponsesConverter() as unknown as RosettaRoundTrip
  if (client === "openai-responses" && upstream === "openai-chat") return new ResponsesToChatCompletionConverter() as unknown as RosettaRoundTrip
  if (client === "openai-responses" && upstream === "anthropic-messages") return new ResponsesToMessagesConverter() as unknown as RosettaRoundTrip
  return undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function containsResponsesReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsResponsesReference)
  const record = objectValue(value)
  if (!record) return false
  return record.type === "item_reference" && typeof record.id === "string" || Object.values(record).some(containsResponsesReference)
}

function containsField(value: unknown, field: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsField(entry, field))
  const record = objectValue(value)
  if (!record) return false
  return Object.hasOwn(record, field) || Object.values(record).some((entry) => containsField(entry, field))
}

function validateChatMessages(payload: Record<string, unknown>, target: Protocol) {
  if (!Array.isArray(payload.messages)) return
  for (const message of payload.messages) {
    const record = objectValue(message)
    if (!record || !["system", "developer", "user", "assistant", "tool"].includes(String(record.role))) {
      throw new ProtocolConversionError("A Chat message role cannot be converted to this provider protocol.")
    }
    const role = record.role
    if (role === "assistant" && target === "anthropic-messages" && record.refusal) {
      throw new ProtocolConversionError("Assistant refusal metadata cannot be converted to this provider protocol.")
    }
    if (Array.isArray(record.content)) {
      for (const part of record.content) {
        const content = objectValue(part)
        if (!content) throw new ProtocolConversionError("A Chat message content part cannot be converted to this provider protocol.")
        const supported = content.type === "text"
          || role === "user" && (content.type === "image_url" || content.type === "file")
          || role === "assistant" && target === "openai-responses" && content.type === "refusal"
        if (!supported) throw new ProtocolConversionError(`Chat content type ${String(content.type)} cannot be converted to this provider protocol.`)
      }
    }
    if (role === "assistant" && Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        const toolCall = objectValue(call)
        if (!toolCall || !["function", "custom"].includes(String(toolCall.type))) throw new ProtocolConversionError("This tool call cannot be converted to the selected provider protocol.")
        const functionValue = objectValue(toolCall.function)
        const customValue = objectValue(toolCall.custom)
        const argumentsValue = toolCall.type === "function" ? functionValue?.arguments : customValue?.input
        if (target === "anthropic-messages" && typeof argumentsValue === "string") {
          try {
            const parsed = objectValue(JSON.parse(argumentsValue))
            if (!parsed) throw new Error()
          } catch {
            throw new ProtocolConversionError("Tool-call arguments must be a JSON object for this provider protocol.")
          }
        }
      }
    }
    if (role === "tool" && Array.isArray(record.content) && record.content.some((part) => objectValue(part)?.type !== "text")) {
      throw new ProtocolConversionError("Tool results with non-text content cannot be converted to this provider protocol.")
    }
  }
}

function validateResponsesInput(payload: Record<string, unknown>, target: Protocol) {
  if (typeof payload.input === "string" || !Array.isArray(payload.input)) return
  const allowedParts = target === "anthropic-messages"
    ? new Set(["input_text", "output_text", "input_image", "input_file"])
    : new Set(["input_text", "output_text", "input_image", "input_file", "input_audio", "input_video"])
  const toolItemTypes = target === "openai-chat"
    ? new Set(["function_call", "function_call_output", "custom_tool_call_output"])
    : new Set(["function_call", "function_call_output"])
  for (const item of payload.input) {
    const record = objectValue(item)
    if (!record) throw new ProtocolConversionError("A Responses input item cannot be converted to this provider protocol.")
    if (toolItemTypes.has(String(record.type))) {
      if (record.type === "function_call_output" && Array.isArray(record.output) && record.output.some((part) => !allowedParts.has(String(objectValue(part)?.type)))) {
        throw new ProtocolConversionError("This tool result cannot be converted to the selected provider protocol.")
      }
      if (record.type === "function_call_output" && target === "anthropic-messages" && Array.isArray(record.output)) {
        throw new ProtocolConversionError("Multimodal tool results cannot be converted to this provider protocol.")
      }
      if (record.type === "function_call_output" && target === "openai-chat" && Array.isArray(record.output) && record.output.some((part) => objectValue(part)?.type !== "input_text")) {
        throw new ProtocolConversionError("This tool result cannot be converted to the selected provider protocol.")
      }
      if (record.type === "function_call" && target === "anthropic-messages") {
        try {
          if (!objectValue(JSON.parse(String(record.arguments)))) throw new Error()
        } catch {
          throw new ProtocolConversionError("Tool-call arguments must be a JSON object for this provider protocol.")
        }
      }
      if (record.type === "custom_tool_call_output" && Array.isArray(record.output) && record.output.some((part) => objectValue(part)?.type !== "input_text")) {
        throw new ProtocolConversionError("This tool result cannot be converted to the selected provider protocol.")
      }
      continue
    }
    if (record.type === "reasoning" && target === "openai-chat") {
      if (record.encrypted_content || Array.isArray(record.summary) && record.summary.some((part) => objectValue(part)?.type !== "summary_text")) {
        throw new ProtocolConversionError("Encrypted or unsupported reasoning history cannot be converted to this provider protocol.")
      }
      continue
    }
    if (record.type && record.type !== "message") throw new ProtocolConversionError(`Responses input type ${String(record.type)} cannot be converted to this provider protocol.`)
    if (!["user", "assistant", "system", "developer"].includes(String(record.role))) throw new ProtocolConversionError("A Responses message role cannot be converted to this provider protocol.")
    const roleParts = record.role === "user"
      ? new Set([...allowedParts].filter((part) => part !== "output_text"))
      : record.role === "assistant" ? new Set(["output_text", "input_text"])
        : new Set(["input_text"])
    if (Array.isArray(record.content) && record.content.some((part) => !roleParts.has(String(objectValue(part)?.type)))) {
      throw new ProtocolConversionError("A Responses content part cannot be converted to this provider protocol.")
    }
    if (target === "openai-chat" && record.role === "user" && Array.isArray(record.content) && record.content.some((part) => objectValue(part)?.type === "output_text")) {
      throw new ProtocolConversionError("Assistant output content cannot be used as user input in this provider protocol.")
    }
    if (target === "anthropic-messages" && Array.isArray(record.content) && record.content.some((part) => objectValue(part)?.type === "refusal")) {
      throw new ProtocolConversionError("Responses refusal content cannot be converted to this provider protocol.")
    }
  }
}

function validateAnthropicMessages(payload: Record<string, unknown>, target: Protocol) {
  if (!Array.isArray(payload.messages)) return
  const userBlocks = new Set(["text", "image", "document", "tool_result"])
  const assistantBlocks = new Set(["text", "thinking", "tool_use"])
  const toolResultParts = target === "openai-chat" ? new Set(["text", "search_result", "tool_reference"]) : new Set(["text"])
  for (const message of payload.messages) {
    const record = objectValue(message)
    if (!record || !["user", "assistant"].includes(String(record.role))) throw new ProtocolConversionError("An Anthropic message role cannot be converted to this provider protocol.")
    if (!Array.isArray(record.content)) continue
    const allowed = record.role === "user" ? userBlocks : assistantBlocks
    for (const block of record.content) {
      const value = objectValue(block)
      if (!value || !allowed.has(String(value.type))) throw new ProtocolConversionError(`Anthropic content type ${String(value?.type)} cannot be converted to this provider protocol.`)
      if (value.type === "tool_result" && Array.isArray(value.content) && value.content.some((part) => !toolResultParts.has(String(objectValue(part)?.type)))) {
        throw new ProtocolConversionError("Multimodal Anthropic tool results cannot be converted to this provider protocol.")
      }
    }
  }
}

function validateCrossProtocolTools(payload: Record<string, unknown>, client: Protocol, target: Protocol) {
  if (!Array.isArray(payload.tools)) return
  for (const tool of payload.tools) {
    const record = objectValue(tool)
    if (!record) throw new ProtocolConversionError("A tool declaration cannot be converted to this provider protocol.")
    const type = String(record.type)
    const supported = client === "openai-chat"
      ? type === "function" || type === "custom"
      : client === "openai-responses"
        ? type === "function" || target === "openai-chat" && type === "custom" || ["web_search", "web_search_2025_08_26", "web_search_preview", "web_search_preview_2025_03_11"].includes(type)
        : "input_schema" in record || ["web_search_20250305", "web_search_20260209"].includes(type)
    if (!supported) throw new ProtocolConversionError(`Tool type ${type} cannot be converted to this provider protocol.`)
  }
}

const crossProtocolFields: Record<Protocol, Partial<Record<Protocol, ReadonlySet<string>>>> = {
  "openai-chat": {
    "openai-responses": new Set(["model", "messages", "stream", "temperature", "top_p", "max_tokens", "max_completion_tokens", "n", "parallel_tool_calls", "metadata", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention", "reasoning_effort", "top_logprobs", "service_tier", "store", "safety_identifier", "user", "tools", "tool_choice", "functions", "function_call", "response_format", "verbosity", "stream_options", "web_search_options"]),
    "anthropic-messages": new Set(["model", "messages", "stream", "temperature", "top_p", "max_tokens", "max_completion_tokens", "n", "stop", "tools", "tool_choice", "parallel_tool_calls", "response_format", "reasoning_effort", "metadata", "user", "service_tier", "stream_options", "web_search_options"]),
  },
  "openai-responses": {
    "openai-chat": new Set(["model", "input", "instructions", "stream", "max_output_tokens", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "metadata", "service_tier", "prompt_cache_key", "prompt_cache_retention", "safety_identifier", "include", "stream_options"]),
    "anthropic-messages": new Set(["model", "input", "instructions", "stream", "max_output_tokens", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "metadata", "service_tier"]),
  },
  "anthropic-messages": {
    "openai-chat": new Set(["model", "system", "messages", "max_tokens", "temperature", "top_p", "stop_sequences", "tools", "tool_choice", "output_config", "thinking", "metadata", "service_tier", "stream"]),
    "openai-responses": new Set(["model", "system", "messages", "max_tokens", "temperature", "top_p", "tools", "tool_choice", "thinking", "output_config", "metadata", "service_tier", "stream"]),
  },
}

function assertCrossProtocolSemantics(payload: Record<string, unknown>, client: Protocol, upstream: Protocol, customPayload?: Record<string, unknown>) {
  if (client === upstream) return
  if (client === "openai-responses" && (typeof payload.previous_response_id === "string" || containsResponsesReference(payload.input))) {
    throw new ProtocolConversionError("Responses continuation references are only supported by Responses providers.")
  }
  if (containsField(payload, "cache_control")) {
    throw new ProtocolConversionError("Prompt cache controls cannot be converted between provider protocols.")
  }
  if (Object.hasOwn(payload, "prompt_cache_key") && upstream === "anthropic-messages") {
    throw new ProtocolConversionError("Prompt cache keys are only supported by OpenAI-compatible providers.")
  }
  if (client === "openai-chat" && Object.hasOwn(payload, "n") && payload.n !== 1) {
    throw new ProtocolConversionError("Multiple Chat completions cannot be converted to this provider protocol.")
  }
  const allowed = crossProtocolFields[client][upstream]
  if (!allowed) throw new ProtocolConversionError("This protocol conversion is not supported.")
  const customFields = new Set(Object.keys(customPayload || {}))
  const unsupported = Object.keys(payload).find((key) => !allowed.has(key) && !customFields.has(key))
  if (unsupported) throw new ProtocolConversionError(`The ${unsupported} request option is not supported by this provider protocol.`)
  for (const key of ["metadata"]) {
    const metadata = objectValue(payload[key])
    if (!metadata || client !== "openai-chat" && upstream === "openai-chat" || upstream === "anthropic-messages") {
      if (metadata && Object.keys(metadata).some((entry) => entry !== "user_id")) throw new ProtocolConversionError("Only metadata.user_id can be converted to this provider protocol.")
    }
  }
  if (client === "openai-chat" && upstream === "anthropic-messages") {
    const tier = payload.service_tier
    if (tier !== undefined && tier !== "auto" && tier !== "standard_only") throw new ProtocolConversionError("The requested service tier cannot be converted to this provider protocol.")
  }
  if (client === "openai-responses" && upstream === "anthropic-messages") {
    const tier = payload.service_tier
    if (tier !== undefined && tier !== "auto" && tier !== "standard_only") throw new ProtocolConversionError("The requested service tier cannot be converted to this provider protocol.")
  }
  if (client === "openai-responses" && upstream === "openai-chat") {
    const include = Array.isArray(payload.include) ? payload.include : []
    if (include.some((entry) => entry !== "message.output_text.logprobs")) throw new ProtocolConversionError("The requested Responses include option cannot be converted to this provider protocol.")
    const streamOptions = objectValue(payload.stream_options)
    if (streamOptions && Object.keys(streamOptions).some((entry) => entry !== "include_obfuscation" && entry !== "include_usage")) throw new ProtocolConversionError("The requested stream option cannot be converted to this provider protocol.")
  }
  if (client === "openai-chat" && upstream === "openai-responses") {
    const streamOptions = objectValue(payload.stream_options)
    if (streamOptions && Object.keys(streamOptions).some((entry) => entry !== "include_obfuscation" && entry !== "include_usage")) throw new ProtocolConversionError("The requested stream option cannot be converted to this provider protocol.")
  }
  if (client === "openai-chat" && upstream === "anthropic-messages") {
    const streamOptions = objectValue(payload.stream_options)
    if (streamOptions && Object.keys(streamOptions).some((entry) => entry !== "include_usage")) throw new ProtocolConversionError("The requested stream option cannot be converted to this provider protocol.")
    const searchOptions = objectValue(payload.web_search_options)
    if (searchOptions && Object.keys(searchOptions).length) throw new ProtocolConversionError("The requested web search options cannot be converted to this provider protocol.")
    const format = objectValue(payload.response_format)
    if (format?.type === "json_object") throw new ProtocolConversionError("JSON object response mode cannot be converted to this provider protocol.")
    const toolChoice = objectValue(payload.tool_choice)
    if (typeof payload.tool_choice === "string" && !["auto", "none", "required"].includes(payload.tool_choice)) {
      throw new ProtocolConversionError("The requested tool choice cannot be converted to this provider protocol.")
    }
    if (toolChoice && (toolChoice.type !== "function" || typeof objectValue(toolChoice.function)?.name !== "string")) {
      throw new ProtocolConversionError("The requested tool choice cannot be converted to this provider protocol.")
    }
  }
  if (client === "openai-chat") validateChatMessages(payload, upstream)
  if (client === "openai-responses") validateResponsesInput(payload, upstream)
  if (client === "anthropic-messages") validateAnthropicMessages(payload, upstream)
  validateCrossProtocolTools(payload, client, upstream)
  if (client === "openai-responses") {
    const reasoning = objectValue(payload.reasoning)
    if (reasoning && Object.keys(reasoning).some((entry) => entry !== "effort")) throw new ProtocolConversionError("The requested reasoning option cannot be converted to this provider protocol.")
    const text = objectValue(payload.text)
    if (upstream === "anthropic-messages" && text && Object.keys(text).some((entry) => entry !== "format")) throw new ProtocolConversionError("The requested text option cannot be converted to this provider protocol.")
    const toolChoice = objectValue(payload.tool_choice)
    if (typeof payload.tool_choice === "string" && !["auto", "none", "required"].includes(payload.tool_choice)) throw new ProtocolConversionError("The requested tool choice cannot be converted to this provider protocol.")
    if (toolChoice && upstream === "anthropic-messages" && (toolChoice.type !== "function" || typeof toolChoice.name !== "string")) {
      throw new ProtocolConversionError("The requested tool choice cannot be converted to this provider protocol.")
    }
    if (toolChoice && upstream === "openai-chat") {
      if (toolChoice.type === "allowed_tools") {
        if (!(["auto", "required"] as unknown[]).includes(toolChoice.mode) || !Array.isArray(toolChoice.tools) || toolChoice.tools.some((entry) => {
          const value = objectValue(entry)
          return !value || !["function", "custom"].includes(String(value.type)) || typeof value.name !== "string"
        })) throw new ProtocolConversionError("The requested tool-choice restriction cannot be converted to this provider protocol.")
      } else if (!["function", "custom"].includes(String(toolChoice.type)) || typeof toolChoice.name !== "string") {
        throw new ProtocolConversionError("The requested tool choice cannot be converted to this provider protocol.")
      }
    }
    if (upstream === "anthropic-messages" && Array.isArray(payload.tools) && payload.tools.some((tool) => {
      const value = objectValue(tool)
      return value?.type === "web_search" && (Object.hasOwn(value, "search_context_size") || Object.hasOwn(value, "user_location"))
    })) throw new ProtocolConversionError("The requested web search options cannot be converted to this provider protocol.")
  }
}

function convertRequestBody(body: Uint8Array, resolved: ResolvedGatewayModel, client: Protocol) {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
  } catch {
    throw new ProtocolConversionError("Request body must be a JSON object.")
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ProtocolConversionError("Request body must be a JSON object.")
  const upstream = resolved.upstreamProtocol
  assertCrossProtocolSemantics(payload, client, upstream, resolved.customPayload)
  const converter = createConverter(client, upstream)
  const clientPayload = client === "openai-responses" ? normalizeResponsesRequest(payload) : payload
  let converted: Record<string, unknown>
  if (!converter) converted = structuredClone(clientPayload)
  else {
    try {
      const result = objectValue(converter.convertRequest(clientPayload))
      if (!result) throw new Error("The converter did not produce a JSON request.")
      converted = result
    } catch (error) {
      if (error instanceof ProtocolConversionError) throw error
      throw new ProtocolConversionError(error instanceof Error ? error.message : "This request cannot be converted to the selected provider protocol.")
    }
  }
  converted = mergeComboCustomPayload(converted, resolved.customPayload)
  converted = applyReasoningOverride(converted, resolved.reasoningEffort, upstream)
  converted.model = resolved.upstreamModel
  if (upstream === "openai-responses") converted = normalizeResponsesRequest(converted)
  if (upstream === "openai-chat" && converted.stream === true) {
    converted.stream_options = { ...objectValue(converted.stream_options), include_usage: true }
  }
  const includeChatStreamUsage = client === "openai-chat" && payload.stream === true && objectValue(payload.stream_options)?.include_usage === true
  return { body: new TextEncoder().encode(JSON.stringify(converted)), converter, includeChatStreamUsage }
}

export type PreparedProviderRequest = ReturnType<typeof convertRequestBody>

export function prepareProviderRequest(body: Uint8Array, resolved: ResolvedGatewayModel, client: Protocol): PreparedProviderRequest {
  return convertRequestBody(body, resolved, client)
}

function endpointUrl(baseUrl: string, protocol: Protocol, search: string) {
  if (protocol === "openai-responses") return `${providerResponsesUrl(baseUrl)}${search}`
  const normalized = normalizeProviderBaseUrl(protocol, baseUrl).replace(/\/+$/, "")
  const url = new URL(normalized)
  const pathname = url.pathname.replace(/\/+$/, "")
  const suffix = protocol === "openai-chat" ? "/chat/completions" : "/messages"
  const endpoint = pathname.endsWith(suffix)
    ? pathname
    : pathname.endsWith("/v1") ? `${pathname}${suffix}` : `${pathname}/v1${suffix}`
  url.pathname = endpoint
  url.search = search
  return url.toString()
}

function upstreamHeaders(request: Request, providerHeaders: Record<string, string>, credential: ProviderApiKey | undefined, authType: "bearer" | "x-api-key" | "none", protocol: Protocol) {
  const headers = new Headers()
  for (const [name, value] of request.headers.entries()) {
    const lower = name.toLowerCase()
    if (hopByHopHeaders.has(lower) || lower === "authorization" || lower === "x-api-key") continue
    headers.set(name, value)
  }
  headers.delete("authorization")
  headers.delete("x-api-key")
  for (const [name, value] of Object.entries(providerHeaders)) headers.set(name, value)
  headers.set("content-type", "application/json")
  headers.set("accept", request.headers.get("accept") || "application/json")
  if (credential && authType === "bearer") headers.set("authorization", `Bearer ${credential.key}`)
  if (credential && authType === "x-api-key") headers.set("x-api-key", credential.key)
  if (protocol === "anthropic-messages" && !headers.has("anthropic-version")) headers.set("anthropic-version", DEFAULT_ANTHROPIC_API_VERSION)
  return headers
}

function eligibleCredentials(resolved: ResolvedGatewayModel): Array<ProviderApiKey | undefined> {
  const upstream = resolved.upstream
  if (!upstream) return []
  if (upstream.codex) return upstream.apiKeys.filter((key) => key.enabled && key.credentialKind === "codex-oauth")
  if (upstream.authType === "none") return [undefined]
  return upstream.apiKeys.filter((key) => key.enabled && key.credentialKind !== "codex-oauth" && key.key.trim())
}

function expired(expiresAt: string | undefined) {
  if (!expiresAt) return false
  const expiry = Date.parse(expiresAt)
  return Number.isFinite(expiry) && expiry <= Date.now()
}

async function codexSession(resolved: ResolvedGatewayModel, credential: ProviderApiKey) {
  const [{ getCodexCredential, readCodexCredentialSecrets }, { refreshCodexCredentialSession }] = await Promise.all([
    import("../codex-credentials"), import("../codex/login"),
  ])
  const account = await getCodexCredential(resolved.providerId!, credential.id)
  if (!account || !account.enabled) throw new Error("Codex credential is unavailable.")
  let secrets = await readCodexCredentialSecrets(credential.id)
  if (!secrets) throw new Error("Codex credential is unavailable.")
  if (expired(secrets.expiresAt)) secrets = await refreshCodexCredentialSession(resolved.providerId!, credential.id)
  if (!account.accountId) throw new Error("Codex credential is unavailable.")
  return {
    accessToken: secrets.accessToken,
    accountId: account.accountId,
    ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
    ...(secrets.idToken ? { idToken: secrets.idToken } : {}),
    ...(secrets.expiresAt ? { expiresAt: secrets.expiresAt } : {}),
    ...(secrets.lastRefresh ? { lastRefresh: secrets.lastRefresh } : {}),
  }
}

function eventObjects(value: unknown) {
  if (Array.isArray(value)) return value.flatMap((entry) => objectValue(entry) ? [entry as Record<string, unknown>] : [])
  return objectValue(value) ? [value as Record<string, unknown>] : []
}

function encodeSse(value: Record<string, unknown>, client: Protocol) {
  const data = JSON.stringify(value)
  const eventType = typeof value.type === "string" ? value.type : undefined
  if (client === "openai-chat") return `data: ${data}\n\n`
  if (client === "openai-responses") return `${eventType ? `event: ${eventType}\n` : ""}data: ${data}\n\n`
  return `${eventType ? `event: ${eventType}\n` : ""}data: ${data}\n\n`
}

type ParsedSseEvent = { event: string; data: string }

function findSseSeparator(buffer: string) {
  let previousStart = -1
  let previousEnd = -1
  for (let index = 0; index < buffer.length;) {
    const character = buffer[index]
    let end = index
    if (character === "\r") {
      // Hold a trailing CR until the next chunk establishes CR vs CRLF.
      if (index + 1 === buffer.length) return undefined
      end = buffer[index + 1] === "\n" ? index + 2 : index + 1
    } else if (character === "\n") end = index + 1
    else {
      previousStart = -1
      previousEnd = -1
      index += 1
      continue
    }
    if (previousEnd === index) return { start: previousStart, end }
    previousStart = index
    previousEnd = end
    index = end
  }
  return undefined
}

function takeSseEvent(buffer: string): { consumed: boolean; event?: ParsedSseEvent; frame?: string; rest: string } {
  const separator = findSseSeparator(buffer)
  if (!separator) return { consumed: false, rest: buffer }
  const raw = buffer.slice(0, separator.start)
  const rest = buffer.slice(separator.end)
  const frame = buffer.slice(0, separator.end)
  let event = ""
  const data: string[] = []
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
  }
  return { consumed: true, event: data.length ? { event, data: data.join("\n") } : undefined, frame, rest }
}

function drainSseFrames(buffer: string, consume: (event: ParsedSseEvent) => void) {
  let rest = buffer
  while (true) {
    const next = takeSseEvent(rest)
    if (!next.consumed) return next.rest
    rest = next.rest
    if (next.event) consume(next.event)
  }
}

function observeCodexResponseIds(source: ReadableStream<Uint8Array>, abort: AbortController, capture: CodexReplayCapture) {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const observeEvent = (event: ParsedSseEvent | undefined) => {
    if (!event || event.data.trim() === "[DONE]") return
    try {
      const payload = objectValue(JSON.parse(event.data))
      if (!payload) return
      const item = objectValue(payload.item)
      if (typeof item?.id === "string") rememberCodexItem(capture, item.id)
      const response = objectValue(payload.response)
      if (["response.completed", "response.failed", "response.incomplete", "response.cancelled", "response.canceled", "error"].includes(String(payload.type)) || ["completed", "failed", "incomplete", "cancelled", "canceled"].includes(String(response?.status))) {
        rememberCodexResponse(capture, response || payload)
      }
    } catch {}
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          buffer += decoder.decode()
          if (buffer) drainSseFrames(`${buffer}\n\n`, observeEvent)
          controller.close()
          return
        }
        buffer += decoder.decode(next.value, { stream: true })
        buffer = drainSseFrames(buffer, observeEvent)
        controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      abort.abort(reason)
      await reader.cancel(reason).catch(() => undefined)
    },
  })
}

function convertEvent(event: ParsedSseEvent, converter: RosettaRoundTrip, client: Protocol, includeChatStreamUsage: boolean) {
  if (event.data.trim() === "[DONE]") return { output: [], terminal: true }
  let parsed: Record<string, unknown>
  try {
    const value = objectValue(JSON.parse(event.data))
    if (!value) throw new Error()
    parsed = value
  } catch {
    throw new Error("The provider returned an invalid event during protocol conversion.")
  }
  const response = objectValue(parsed.response)
  const failed = event.event.trim().toLowerCase() === "error" || ["error", "response.failed", "response.cancelled", "response.canceled"].includes(String(parsed.type)) || ["failed", "cancelled", "canceled"].includes(String(response?.status))
  if (failed) {
    const error = makeClientError(client, upstreamErrorDetails(parsed))
    const value = client === "openai-chat" ? error : { type: "error", ...error }
    return { output: [new TextEncoder().encode(encodeSse(value, client))], terminal: true, failed: true }
  }
  const convert = converter.convertStreamEvent || converter.convertStreamChunk
  if (!convert) throw new Error("The converter does not support streaming responses.")
  const converted = convert.call(converter, parsed)
  const output = eventObjects(converted).filter((value) => client !== "openai-chat" || includeChatStreamUsage || !Array.isArray(value.choices) || value.choices.length > 0 || !Object.hasOwn(value, "usage"))
  return {
    output: output.map((value) => new TextEncoder().encode(encodeSse(value, client))),
    terminal: isTerminalStreamEvent(event.event, parsed),
    failed: false,
  }
}

function convertStreamBody(source: ReadableStream<Uint8Array>, converter: RosettaRoundTrip, client: Protocol, abort: AbortController, includeChatStreamUsage: boolean) {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const queue: Uint8Array[] = []
  let buffer = ""
  let ended = false
  let terminalEventSeen = false
  let failedEventSeen = false
  const finalize = () => {
    if (terminalEventSeen) {
      if (!failedEventSeen) {
        const final = converter.flushTerminalEvents?.() ?? converter.finalizeStream?.()
        queue.push(...eventObjects(final).map((value) => new TextEncoder().encode(encodeSse(value, client))))
      }
      if (client === "openai-chat") queue.push(new TextEncoder().encode("data: [DONE]\n\n"))
    }
  }
  const readEvents = async () => {
    while (!queue.length && !ended) {
      const next = await reader.read()
      if (next.done) {
        ended = true
        buffer += decoder.decode()
        if (buffer) buffer = drainSseFrames(`${buffer}\n\n`, consumeEvent)
        finalize()
        break
      }
      buffer += decoder.decode(next.value, { stream: true })
      buffer = drainSseFrames(buffer, consumeEvent)
    }
  }
  const consumeEvent = (event: ParsedSseEvent) => {
    const converted = convertEvent(event, converter, client, includeChatStreamUsage)
    terminalEventSeen ||= converted.terminal
    failedEventSeen ||= converted.failed === true
    queue.push(...converted.output)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await readEvents()
        const value = queue.shift()
        if (value) controller.enqueue(value)
        else if (ended) controller.close()
      } catch (error) {
        abort.abort(error)
        await reader.cancel(error).catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel(reason) {
      abort.abort(reason)
      await reader.cancel(reason).catch(() => undefined)
    },
  })
}

function cancelablePassthrough(source: ReadableStream<Uint8Array>, abort: AbortController) {
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (error) { controller.error(error) }
    },
    async cancel(reason) {
      abort.abort(reason)
      await reader.cancel(reason).catch(() => undefined)
    },
  })
}

function providerBodyLifetime(source: ReadableStream<Uint8Array>, abort: AbortController, lease?: Extract<ProviderCredentialAdmission, { ok: true }>, observer?: ProviderResponseReferenceObserver) {
  const reader = source.getReader()
  let finished = false
  let cancellation: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeoutError: Error | undefined
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const finish = () => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    try { observer?.finish() }
    finally { lease?.release() }
  }
  const cancelUpstream = (reason: unknown) => {
    abort.abort(reason)
    cancellation ??= reader.cancel(reason).then(() => undefined, () => undefined)
    return cancellation
  }
  if (lease) {
    timer = setTimeout(() => {
      const reason = new Error("Provider response stream exceeded its maximum lifetime.")
      timeoutError = reason
      void cancelUpstream(reason).then(() => {
        finish()
        try { streamController?.error(reason) } catch {}
      })
    }, PROVIDER_STREAM_LEASE_TIMEOUT_MS)
    timer.unref()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      streamController = controller
      if (timeoutError) {
        controller.error(timeoutError)
        return
      }
      try {
        const next = await reader.read()
        if (cancellation) await cancellation
        if (timeoutError) return
        if (next.done) {
          finish()
          controller.close()
        } else {
          observer?.write(next.value)
          controller.enqueue(next.value)
        }
      } catch (error) {
        await cancelUpstream(error)
        finish()
        if (!timeoutError) controller.error(error)
      }
    },
    async cancel(reason) {
      await cancelUpstream(reason)
      finish()
    },
  })
}

function chatUsageOnly(event: ParsedSseEvent | undefined) {
  if (!event || event.data.trim() === "[DONE]") return false
  try {
    const value = objectValue(JSON.parse(event.data))
    return Boolean(value && Array.isArray(value.choices) && value.choices.length === 0 && Object.hasOwn(value, "usage"))
  } catch {
    return false
  }
}

function filterUnrequestedChatUsage(source: ReadableStream<Uint8Array>, abort: AbortController) {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const queue: Uint8Array[] = []
  let buffer = ""
  let ended = false
  const drain = () => {
    while (true) {
      const next = takeSseEvent(buffer)
      if (!next.consumed) { buffer = next.rest; return }
      buffer = next.rest
      if (next.frame && !chatUsageOnly(next.event)) queue.push(encoder.encode(next.frame))
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!queue.length && !ended) {
          const next = await reader.read()
          if (next.done) {
            ended = true
            buffer += decoder.decode()
            if (buffer) {
              const final = takeSseEvent(`${buffer}\n\n`)
              if (!chatUsageOnly(final.event)) queue.push(encoder.encode(buffer))
              buffer = ""
            }
            break
          }
          buffer += decoder.decode(next.value, { stream: true })
          drain()
        }
        const value = queue.shift()
        if (value) controller.enqueue(value)
        else if (ended) controller.close()
      } catch (error) {
        abort.abort(error)
        await reader.cancel(error).catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel(reason) {
      abort.abort(reason)
      await reader.cancel(reason).catch(() => undefined)
    },
  })
}

function upstreamErrorDetails(value: unknown) {
  const record = objectValue(value)
  const nested = objectValue(record?.error)
  const source = nested || record
  const sourceType = typeof source?.type === "string" && source.type !== "error" ? source.type : undefined
  const rootType = typeof record?.type === "string" && record.type !== "error" ? record.type : undefined
  const type = sourceType || rootType || (typeof source?.code === "string" ? source.code : undefined)
  const code = typeof source?.code === "string" ? source.code : typeof record?.code === "string" ? record.code : undefined
  const message = typeof source?.message === "string" ? source.message : typeof record?.message === "string" ? record.message : "The provider returned an error."
  return { message, type, code }
}

function makeClientError(protocol: Protocol, details: ReturnType<typeof upstreamErrorDetails>) {
  if (protocol === "anthropic-messages") return {
    type: "error",
    ...(details.code ? { code: details.code } : {}),
    error: { type: details.type || "api_error", ...(details.code ? { code: details.code } : {}), message: details.message },
  }
  if (protocol === "openai-responses") return { error: { type: details.type || "server_error", ...(details.code ? { code: details.code } : {}), message: details.message } }
  return { error: { type: details.type || "upstream_error", ...(details.code ? { code: details.code } : {}), message: details.message } }
}

function nativeUsage(body: Uint8Array, protocol: Protocol, contentType: string | null): UsageMetrics | undefined {
  if (!contentType?.toLowerCase().includes("json")) return undefined
  try {
    const payload = objectValue(JSON.parse(new TextDecoder().decode(body)))
    if (!payload) return undefined
    return extractUsageMetrics(payload, protocol === "anthropic-messages" ? "anthropic" : "openai")
  } catch { return undefined }
}

async function makeUpstreamResponse(request: Request, resolved: ResolvedGatewayModel, credential: ProviderApiKey | undefined, body: Uint8Array, abort: AbortController, caller?: GatewayCaller) {
  const upstream = resolved.upstream!
  const headers = upstreamHeaders(request, upstream.headers, credential, upstream.authType, upstream.protocol)
  const signal = request.signal ? AbortSignal.any([request.signal, abort.signal]) : abort.signal
  if (upstream.codex) {
    if (!credential) throw new Error("No enabled Codex credentials are available.")
    const loadSession = () => codexSession(resolved, credential)
    const { transport, sessionState, capture } = codexReplayTransport(request, resolved, credential, body, caller, loadSession)
    const send = () => transport.request(`/v1/responses${new URL(request.url).search}`, { method: "POST", headers, body: Buffer.from(body), signal, cache: "no-store" })
    let response = await send()
    if (response.status === 401 && sessionState?.lastSession?.refreshToken) {
      await response.body?.cancel().catch(() => undefined)
      const usedAccessToken = sessionState.lastSession.accessToken
      const current = await loadSession()
      if (current.accessToken === usedAccessToken) {
        const { refreshCodexCredentialSession } = await import("../codex/login")
        await refreshCodexCredentialSession(resolved.providerId!, credential.id)
      }
      response = await send()
    }
    if (capture) codexResponseCaptures.set(response, capture)
    return response
  }
  const response = await fetch(endpointUrl(upstream.baseUrl, upstream.protocol, new URL(request.url).search), {
    method: "POST", headers, body: Buffer.from(body), signal, cache: "no-store",
  })
  return response
}

export interface GatewayUpstreamResponse {
  response: Response
  usage?: UsageMetrics
  streamUsage?: ReturnType<typeof collectStreamUsage>
}

type ProviderFailure = { status: number; statusText: string; headers: Headers; body: Uint8Array }

function responseFromProviderFailure(failure: ProviderFailure, clientProtocol: Protocol, upstreamProtocol: Protocol, terminal = false): GatewayUpstreamResponse {
  const responseHeadersForFailure = responseHeaders(failure.headers)
  if (terminal) responseHeadersForFailure.set("x-rawroute-combo-terminal", "1")
  if (clientProtocol === upstreamProtocol) {
    return { response: new Response(Buffer.from(failure.body), { status: failure.status, statusText: failure.statusText, headers: responseHeadersForFailure }) }
  }
  let payload: unknown
  try { payload = JSON.parse(new TextDecoder().decode(failure.body)) } catch { payload = undefined }
  const headers = responseHeadersForFailure
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  return { response: Response.json(makeClientError(clientProtocol, upstreamErrorDetails(payload)), { status: failure.status, statusText: failure.statusText, headers }) }
}

function responseReferencesForOrdinaryRequest(body: Uint8Array, clientProtocol: Protocol, resolved: ResolvedGatewayModel, caller: GatewayCaller | undefined) {
  const upstream = resolved.upstream
  if (!caller || clientProtocol !== "openai-responses" || upstream?.protocol !== "openai-responses") return { continuation: false as const }
  const namespace = providerResponseNamespace(resolved, caller)
  let payload: Record<string, unknown> | undefined
  try { payload = objectValue(JSON.parse(new TextDecoder().decode(body))) } catch {}
  if (!payload) return { continuation: false as const, namespace }
  const references = providerResponseReferenceIds(payload)
  if (!references.length) return { continuation: false as const, namespace }
  const credentials = references.map((id) => lookupProviderResponseCredential(namespace, id))
  if (credentials.some((value) => !value.found)) return { continuation: true as const, error: continuationUnavailable() }
  if (credentials.some((value) => value.found && "conflict" in value)) return { continuation: true as const, error: continuationConflict() }
  const bound = credentials.map((value) => value.found && "credential" in value ? value.credential : undefined)
  if (bound.some((value) => value === undefined)) return { continuation: true as const, error: continuationUnavailable() }
  const unique = new Map(bound.map((value) => [JSON.stringify(value), value]))
  if (unique.size !== 1) return { continuation: true as const, error: continuationConflict() }
  const credential = bound[0]!
  if (credential.credentialId === null && upstream.authType !== "none"
    || credential.credentialId !== null && upstream.authType === "none") {
    return { continuation: true as const, error: continuationUnavailable() }
  }
  return { continuation: true as const, namespace, credential }
}

function providerHeadersFingerprint(headers: Record<string, string>) {
  return JSON.stringify(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)))
}

function providerConfigurationMatches(provider: Provider, resolved: ResolvedGatewayModel) {
  const upstream = resolved.upstream!
  const promptCacheKey = provider.prefix === "codex"
    || provider.protocol !== "anthropic-messages" && provider.supportPromptCacheKey === true
  return provider.enabled
    && provider.prefix === resolved.providerPrefix
    && provider.baseUrl === upstream.baseUrl
    && provider.protocol === upstream.protocol
    && provider.protocol === resolved.upstreamProtocol
    && provider.authType === upstream.authType
    && providerHeadersFingerprint(provider.headers || {}) === providerHeadersFingerprint(upstream.headers)
    && (provider.prefix === "codex") === upstream.codex
    && promptCacheKey === resolved.promptCacheKey
}

function safeCredentialFallback(status: number) {
  return status === 401 || status === 403 || status === 429
}

async function proxyToCodexProvider(request: Request, resolved: ResolvedGatewayModel, converted: PreparedProviderRequest, clientProtocol: Protocol, caller?: GatewayCaller): Promise<GatewayUpstreamResponse> {
  const upstream = resolved.upstream!
  const credentials = eligibleCredentials(resolved).filter((credential): credential is ProviderApiKey => credential !== undefined)
  if (!credentials.length) return { response: localProviderError(503, "provider_credentials_unavailable", "No enabled Codex accounts are available.") }
  let preferred: ReturnType<typeof preferredCodexCredential>
  try { preferred = preferredCodexCredential(request, converted.body, resolved, caller) }
  catch { return { response: continuationConflict() } }
  if (preferred) {
    const selected = credentials.find((credential) => credential.id === preferred!.credentialId)
    if (!selected && preferred.continuation) return { response: continuationUnavailable() }
    if (selected) credentials.splice(0, credentials.length, selected, ...credentials.filter((credential) => credential.id !== selected.id))
  }
  let lastFailure: ProviderFailure | undefined
  for (const [index, credential] of credentials.entries()) {
    if (request.signal.aborted) throw request.signal.reason
    const abort = new AbortController()
    let response: Response
    try { response = await makeUpstreamResponse(request, resolved, credential, converted.body, abort, caller) }
    catch {
      abort.abort()
      if (request.signal.aborted) throw request.signal.reason
      return { response: ambiguousProviderFailure() }
    }
    if (!response.ok) {
      let body: Uint8Array
      try { body = new Uint8Array(await response.arrayBuffer()) }
      catch { abort.abort(); return { response: ambiguousProviderFailure() } }
      const failure = { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers), body }
      lastFailure = failure
      const safeFallback = safeCredentialFallback(response.status)
      if (!preferred?.continuation && safeFallback && index < credentials.length - 1) continue
      return responseFromProviderFailure(failure, clientProtocol, upstream.protocol, preferred?.continuation || !safeFallback)
    }

    const isEventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true
    if (isEventStream && response.body) {
      const codexCapture = codexResponseCaptures.get(response)
      const [clientBody, accountingBody] = response.body.tee()
      const streamUsage = collectStreamUsage(accountingBody, upstream.protocol === "anthropic-messages" ? "anthropic" : "openai")
      const observedBody = codexCapture ? observeCodexResponseIds(clientBody, abort, codexCapture) : clientBody
      const outputBody = converted.converter
        ? convertStreamBody(observedBody, converted.converter, clientProtocol, abort, converted.includeChatStreamUsage)
        : clientProtocol === "openai-chat" && upstream.protocol === "openai-chat" && !converted.includeChatStreamUsage
          ? filterUnrequestedChatUsage(observedBody, abort)
        : cancelablePassthrough(observedBody, abort)
      const headers = responseHeaders(response.headers)
      if (converted.converter) headers.set("content-type", "text/event-stream; charset=utf-8")
      return { response: new Response(outputBody, { status: response.status, statusText: response.statusText, headers }), streamUsage }
    }

    let upstreamBody: Uint8Array
    try { upstreamBody = new Uint8Array(await response.arrayBuffer()) }
    catch { abort.abort(); return { response: ambiguousProviderFailure() } }
    const codexCapture = codexResponseCaptures.get(response)
    if (codexCapture) {
      try { rememberCodexResponse(codexCapture, JSON.parse(new TextDecoder().decode(upstreamBody)) as unknown) } catch {}
    }
    const usage = nativeUsage(upstreamBody, upstream.protocol, response.headers.get("content-type"))
    if (!converted.converter) return { response: new Response(Buffer.from(upstreamBody), { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) }), usage }
    try {
      const value = objectValue(JSON.parse(new TextDecoder().decode(upstreamBody)))
      if (!value) throw new Error("The provider returned a non-JSON response.")
      const result = objectValue(converted.converter.convertResponse(value))
      if (!result) throw new Error("The converter did not produce a JSON response.")
      const headers = responseHeaders(response.headers)
      headers.set("content-type", "application/json")
      headers.delete("content-length")
      return { response: new Response(JSON.stringify(result), { status: response.status, statusText: response.statusText, headers }), usage }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The provider response could not be converted."
      return { response: localProviderError(502, "unsupported_protocol_conversion", message, { terminal: true }), usage }
    }
  }
  return lastFailure
    ? responseFromProviderFailure(lastFailure, clientProtocol, upstream.protocol)
    : { response: ambiguousProviderFailure() }
}

async function proxyToOrdinaryProvider(request: Request, resolved: ResolvedGatewayModel, prepared: PreparedProviderRequest, clientProtocol: Protocol, caller: GatewayCaller | undefined, scheduler: ProviderCredentialScheduler): Promise<GatewayUpstreamResponse> {
  const upstream = resolved.upstream!
  if (!resolved.providerId) return { response: localProviderError(503, "provider_configuration_unavailable", "Provider configuration is temporarily unavailable.") }
  const body = Buffer.from(prepared.body)
  const url = endpointUrl(upstream.baseUrl, upstream.protocol, new URL(request.url).search)
  const baseHeaders = upstreamHeaders(request, upstream.headers, undefined, upstream.authType, upstream.protocol)
  const continuation = responseReferencesForOrdinaryRequest(prepared.body, clientProtocol, resolved, caller)
  if (continuation.error) return { response: continuation.error }
  const namespace = continuation.namespace
  const usesCredentialScheduler = upstream.authType !== "none"
  const responseCaptureEnabled = namespace !== undefined && clientProtocol === "openai-responses" && upstream.protocol === "openai-responses"
  const attemptedCredentialIds = new Set<string>()
  const sessionScopeHash = caller ? sessionPromptCacheScope(request.headers, caller.workspaceId, caller.gatewayKeyId) : undefined
  let lastFailure: ProviderFailure | undefined

  while (true) {
    if (request.signal.aborted) throw request.signal.reason
    type DispatchResult =
      | { kind: "dispatched"; pending: Promise<Response>; abort: AbortController; credential?: ProviderApiKey; lease?: Extract<ProviderCredentialAdmission, { ok: true }> }
      | { kind: "retry" }
      | { kind: "aborted" }
      | { kind: "blocked"; response: Response }
    let dispatch: DispatchResult
    try {
      dispatch = await withProviderCredentialRoutingSnapshot(resolved.providerId, (snapshot): DispatchResult => {
        if (!snapshot.provider || !providerConfigurationMatches(snapshot.provider, resolved)) {
          if (lastFailure) return { kind: "blocked", response: responseFromProviderFailure(lastFailure, clientProtocol, upstream.protocol).response }
          return {
            kind: "blocked",
            response: localProviderError(
              503,
              continuation.continuation ? "provider_response_continuation_unavailable" : "provider_configuration_changed",
              continuation.continuation ? "This Responses continuation is unavailable. Start a new response." : "Provider settings changed during request preparation. Retry the request.",
              { terminal: continuation.continuation },
            ),
          }
        }

        const credentials: Array<ProviderApiKey | undefined> = upstream.authType === "none"
          ? [undefined]
          : snapshot.apiKeys.filter((key) => key.enabled && key.credentialKind !== "codex-oauth" && key.key.trim())
        if (!credentials.length) {
          if (continuation.continuation) return { kind: "blocked", response: continuationUnavailable() }
          if (lastFailure) return { kind: "blocked", response: responseFromProviderFailure(lastFailure, clientProtocol, upstream.protocol).response }
          return { kind: "blocked", response: localProviderError(503, "provider_credentials_unavailable", "No enabled provider credentials are available.") }
        }
        if (upstream.authType === "none" && attemptedCredentialIds.has("__none__")) {
          return { kind: "blocked", response: lastFailure
            ? responseFromProviderFailure(lastFailure, clientProtocol, upstream.protocol).response
            : localProviderError(503, "provider_credentials_unavailable", "Provider credentials are unavailable.") }
        }

        if (continuation.credential) {
          if (continuation.credential.credentialId === null) {
            if (upstream.authType !== "none") return { kind: "blocked", response: continuationUnavailable() }
          } else {
            const original = credentials.find((credential) => credential?.id === continuation.credential!.credentialId)
            if (!original || credentialFingerprint(original) !== continuation.credential.keyFingerprint) {
              return { kind: "blocked", response: continuationUnavailable() }
            }
          }
        }

        let credential: ProviderApiKey | undefined
        let lease: Extract<ProviderCredentialAdmission, { ok: true }> | undefined
        if (usesCredentialScheduler) {
          const admission = scheduler.acquire({
            ownerWorkspaceId: resolved.shared?.ownerWorkspaceId || currentWorkspaceId(),
            providerId: resolved.providerId!,
            credentials: credentials.filter((value): value is ProviderApiKey => value !== undefined),
            ...(sessionScopeHash ? { sessionScopeHash } : {}),
            excludedCredentialIds: attemptedCredentialIds,
            ...(continuation.credential?.credentialId ? { requiredCredentialId: continuation.credential.credentialId } : {}),
          })
          if (!admission.ok) {
            if (lastFailure && !continuation.continuation) {
              return { kind: "blocked", response: responseFromProviderFailure(lastFailure, clientProtocol, upstream.protocol).response }
            }
            return { kind: "blocked", response: providerAdmissionFailure(admission, continuation.continuation) }
          }
          lease = admission
          credential = admission.credential
        } else {
          credential = credentials.find((candidate) => candidate === undefined
            ? !attemptedCredentialIds.has("__none__")
            : !attemptedCredentialIds.has(candidate.id))
          if (!credential && upstream.authType !== "none") {
            return { kind: "blocked", response: lastFailure
              ? responseFromProviderFailure(lastFailure, clientProtocol, upstream.protocol).response
              : localProviderError(503, "provider_credentials_unavailable", "No enabled provider credentials are available.") }
          }
        }

        if (credential) {
          const resolvedCredential = upstream.apiKeys.find((candidate) => candidate.id === credential!.id)
          if (!resolvedCredential || credentialFingerprint(resolvedCredential) !== credentialFingerprint(credential)) {
            lease?.cancelBeforeDispatch()
            if (continuation.continuation) return { kind: "blocked", response: continuationUnavailable() }
            if (lastFailure) return { kind: "blocked", response: responseFromProviderFailure(lastFailure, clientProtocol, upstream.protocol).response }
            return { kind: "blocked", response: localProviderError(503, "provider_configuration_changed", "Provider credentials changed during request preparation. Retry the request.") }
          }
        }

        if (request.signal.aborted) {
          lease?.cancelBeforeDispatch()
          return { kind: "aborted" }
        }
        if (credential) attemptedCredentialIds.add(credential.id)
        else attemptedCredentialIds.add("__none__")
        const abort = new AbortController()
        let dispatched = false
        try {
          const headers = new Headers(baseHeaders)
          if (credential && upstream.authType === "bearer") headers.set("authorization", `Bearer ${credential.key}`)
          if (credential && upstream.authType === "x-api-key") headers.set("x-api-key", credential.key)
          const signal = request.signal ? AbortSignal.any([request.signal, abort.signal]) : abort.signal
          const pending = fetch(url, { method: "POST", headers, body, signal, cache: "no-store", redirect: "manual" })
          lease?.markDispatched()
          dispatched = true
          return { kind: "dispatched", pending, abort, credential, lease }
        } catch {
          abort.abort()
          if (!dispatched) {
            lease?.cancelBeforeDispatch()
            if (request.signal.aborted) return { kind: "aborted" }
            if (continuation.continuation) return { kind: "blocked", response: continuationUnavailable() }
            return { kind: "retry" }
          }
          lease?.release()
          return { kind: "blocked", response: ambiguousProviderFailure() }
        }
      })
    } catch {
      return { response: localProviderError(503, "provider_configuration_unavailable", "Provider configuration is temporarily unavailable.", { terminal: continuation.continuation }) }
    }
    if (dispatch.kind === "blocked") return { response: dispatch.response }
    if (dispatch.kind === "aborted") throw request.signal.reason
    if (dispatch.kind === "retry") continue
    const { abort, credential, lease } = dispatch
    let response: Response
    try { response = await dispatch.pending }
    catch {
      abort.abort()
      lease?.release()
      if (request.signal.aborted) throw request.signal.reason
      return { response: ambiguousProviderFailure() }
    }

    if (!response.ok) {
      let responseBody: Uint8Array
      try { responseBody = new Uint8Array(await response.arrayBuffer()) }
      catch { abort.abort(); lease?.release(); return { response: ambiguousProviderFailure() } }
      lease?.release()
      const failure = { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers), body: responseBody }
      lastFailure = failure
      const safeFallback = safeCredentialFallback(response.status)
      if (continuation.continuation || !safeFallback) {
        return responseFromProviderFailure(failure, clientProtocol, upstream.protocol, continuation.continuation || !safeFallback)
      }
      continue
    }

    const isEventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true
    if (isEventStream && response.body) {
      try {
        const referenceCredential: ProviderResponseCredential = {
          credentialId: credential?.id || null,
          ...(credential ? { keyFingerprint: credentialFingerprint(credential) } : {}),
        }
        const observer = responseCaptureEnabled
          ? createProviderResponseReferenceObserver(namespace!, referenceCredential)
          : undefined
        const lifetimeBody = providerBodyLifetime(response.body, abort, lease, observer)
        const [clientBody, accountingBody] = lifetimeBody.tee()
        const streamUsage = collectStreamUsage(accountingBody, upstream.protocol === "anthropic-messages" ? "anthropic" : "openai")
        const outputBody = prepared.converter
          ? convertStreamBody(clientBody, prepared.converter, clientProtocol, abort, prepared.includeChatStreamUsage)
          : clientProtocol === "openai-chat" && upstream.protocol === "openai-chat" && !prepared.includeChatStreamUsage
            ? filterUnrequestedChatUsage(clientBody, abort)
            : cancelablePassthrough(clientBody, abort)
        const headers = responseHeaders(response.headers)
        if (prepared.converter) headers.set("content-type", "text/event-stream; charset=utf-8")
        return { response: new Response(outputBody, { status: response.status, statusText: response.statusText, headers }), streamUsage }
      } catch {
        abort.abort()
        lease?.release()
        return { response: ambiguousProviderFailure() }
      }
    }

    try {
      const responseBody = new Uint8Array(await response.arrayBuffer())
      if (responseCaptureEnabled && response.headers.get("content-type")?.toLowerCase().includes("json")) {
        try { rememberProviderResponseValue(namespace!, { credentialId: credential?.id || null, ...(credential ? { keyFingerprint: credentialFingerprint(credential) } : {}) }, JSON.parse(new TextDecoder().decode(responseBody)), true) } catch {}
      }
      const usage = nativeUsage(responseBody, upstream.protocol, response.headers.get("content-type"))
      if (!prepared.converter) return { response: new Response(Buffer.from(responseBody), { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) }), usage }
      try {
        const value = objectValue(JSON.parse(new TextDecoder().decode(responseBody)))
        if (!value) throw new Error("The provider returned a non-JSON response.")
        const result = objectValue(prepared.converter.convertResponse(value))
        if (!result) throw new Error("The converter did not produce a JSON response.")
        const headers = responseHeaders(response.headers)
        headers.set("content-type", "application/json")
        headers.delete("content-length")
        return { response: new Response(JSON.stringify(result), { status: response.status, statusText: response.statusText, headers }), usage }
      } catch (error) {
        const message = error instanceof Error ? error.message : "The provider response could not be converted."
        return { response: localProviderError(502, "unsupported_protocol_conversion", message, { terminal: true }), usage }
      }
    } catch {
      abort.abort()
      return { response: ambiguousProviderFailure() }
    } finally {
      lease?.release()
    }
  }
}

/** Execute one provider request using fresh credentials and provider-owned admission. */
export async function proxyToProvider(
  request: Request,
  resolved: ResolvedGatewayModel,
  prepared: PreparedProviderRequest,
  clientProtocol: Protocol,
  caller?: GatewayCaller,
  scheduler: ProviderCredentialScheduler = providerCredentialScheduler,
): Promise<GatewayUpstreamResponse> {
  const upstream = resolved.upstream
  if (!upstream) return { response: Response.json({ error: { message: "Provider configuration is unavailable." } }, { status: 503 }) }
  if (upstream.codex) return proxyToCodexProvider(request, resolved, prepared, clientProtocol, caller)
  return proxyToOrdinaryProvider(request, resolved, prepared, clientProtocol, caller, scheduler)
}
