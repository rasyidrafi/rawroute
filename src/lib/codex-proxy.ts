import type { Provider } from "@/lib/types"

const removedFields = [
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "truncation",
  "user",
  "context_management",
  "previous_response_id",
]

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function normalizeInput(input: unknown) {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]
  }
  if (!Array.isArray(input)) return input
  return input.map((item) => {
    const record = objectValue(item)
    if (!record || record.role !== "system") return item
    return { ...record, role: "developer" }
  })
}

export function normalizeCodexRequest(payload: Record<string, unknown>, upstreamModel: string, sessionKey?: string) {
  const normalized = structuredClone(payload)
  normalized.model = upstreamModel
  normalized.stream = true
  normalized.store = false
  normalized.parallel_tool_calls = true
  normalized.include = ["reasoning.encrypted_content"]
  normalized.instructions ??= ""
  normalized.input = normalizeInput(normalized.input)
  for (const field of removedFields) delete normalized[field]
  const tools = Array.isArray(normalized.tools) ? normalized.tools : []
  if (!tools.length) delete normalized.parallel_tool_calls
  if (sessionKey && typeof normalized.prompt_cache_key !== "string") normalized.prompt_cache_key = sessionKey
  return normalized
}

const blocked = new Set([
  "authorization", "x-api-key", "cookie", "host", "content-length", "connection",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "x-rawroute-session-id", "x-session-id", "session_id",
])

export function buildCodexHeaders(requestHeaders: Headers, provider: Provider, accessToken: string, accountId?: string, sessionKey?: string) {
  const headers = new Headers()
  requestHeaders.forEach((value, key) => { if (!blocked.has(key.toLowerCase())) headers.set(key, value) })
  Object.entries(provider.headers).forEach(([key, value]) => headers.set(key, value))
  headers.set("content-type", "application/json")
  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("accept", "text/event-stream")
  headers.set("originator", headers.get("originator") || process.env.CODEX_ORIGINATOR || "codex_cli_rs")
  headers.set("user-agent", headers.get("user-agent") || process.env.CODEX_USER_AGENT || "codex-tui/0.146.0")
  if (accountId) headers.set("chatgpt-account-id", accountId)
  if (sessionKey) {
    headers.set("session_id", sessionKey)
    headers.set("x-client-request-id", sessionKey)
  }
  return headers
}

