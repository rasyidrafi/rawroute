import { createHmac } from "node:crypto"

import type { Protocol } from "@/lib/types"

export interface SessionIdentity {
  key: string
  source: string
  hard: boolean
  responseId?: string
}

interface SessionContext {
  gatewayKeyId: string
  providerId: string
  modelId: string
  secret: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function hashed(value: string, source: string, context: SessionContext, hard = false, responseId?: string): SessionIdentity {
  const scoped = `${context.gatewayKeyId}\n${context.providerId}\n${context.modelId}\n${value}`
  return {
    key: createHmac("sha256", context.secret).update(scoped).digest("hex"),
    source,
    hard,
    ...(responseId ? { responseId } : {}),
  }
}

function promptPrefix(payload: Record<string, unknown>, protocol: Protocol) {
  const tools = payload.tools || payload.functions
  const system = payload.system || payload.instructions
  if (protocol === "openai-chat" || protocol === "anthropic-messages") {
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const stableMessages: unknown[] = []
    for (const message of messages) {
      const role = stringValue(record(message)?.role)
      if (role === "system") stableMessages.push(message)
      if (role === "user") {
        stableMessages.push(message)
        break
      }
    }
    if (tools || system || stableMessages.length) return canonicalize({ tools, system, messages: stableMessages })
  }
  if (tools || system) return canonicalize({ tools, system })
  return undefined
}

export function extractSessionIdentity(
  request: Request,
  payload: Record<string, unknown>,
  protocol: Protocol,
  context: SessionContext,
): SessionIdentity | undefined {
  const previousResponseId = protocol === "openai-responses" ? stringValue(payload.previous_response_id) : undefined
  const withHardAffinity = (identity: SessionIdentity) => previousResponseId
    ? { ...identity, hard: true, responseId: previousResponseId }
    : identity
  const explicitHeaders = ["x-rawroute-session-id", "x-session-id", "session_id", "x-client-request-id"]
  for (const header of explicitHeaders) {
    const value = stringValue(request.headers.get(header))
    if (value) return withHardAffinity(hashed(`explicit:${value}`, header, context))
  }

  const metadata = record(payload.metadata)
  for (const field of ["rawroute_session_id", "session_id", "user_id", "conversation_id"]) {
    const value = stringValue(metadata?.[field])
    if (value) return withHardAffinity(hashed(`metadata:${value}`, `metadata.${field}`, context))
  }

  if (previousResponseId) {
    return hashed(`response:${previousResponseId}`, "previous_response_id", context, true, previousResponseId)
  }
  for (const field of ["conversation", "prompt_cache_key", "conversation_id"] as const) {
    const value = stringValue(payload[field])
    if (value) return withHardAffinity(hashed(`${field}:${value}`, field, context))
  }

  const prefix = promptPrefix(payload, protocol)
  return prefix ? withHardAffinity(hashed(`prefix:${prefix}`, "prompt-prefix", context)) : undefined
}
