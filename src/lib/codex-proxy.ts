const removedFields = [
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens",
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
  let firstSystemIndex = -1
  for (let index = 0; index < input.length; index++) {
    if (objectValue(input[index])?.role === "system") {
      firstSystemIndex = index
      break
    }
  }
  if (firstSystemIndex < 0) return input
  const normalized = input.slice()
  for (let index = firstSystemIndex; index < normalized.length; index++) {
    const record = objectValue(normalized[index])
    if (record?.role === "system") normalized[index] = { ...record, role: "developer" }
  }
  return normalized
}

export function normalizeCodexRequest(payload: Record<string, unknown>, upstreamModel: string, sessionKey?: string) {
  const normalized = { ...payload }
  normalized.model = upstreamModel
  normalized.stream = true
  normalized.store = false
  // Codex Responses Lite rejects parallel tool calls. Keep the field explicit
  // when tools are present so clients cannot accidentally enable them upstream.
  normalized.parallel_tool_calls = false
  normalized.include = ["reasoning.encrypted_content"]
  normalized.instructions ??= ""
  normalized.input = normalizeInput(normalized.input)
  for (const field of removedFields) delete normalized[field]
  // Responses Lite requires this flag to be present and false, including
  // requests that do not contain tools.
  if (sessionKey && typeof normalized.prompt_cache_key !== "string") normalized.prompt_cache_key = sessionKey
  return normalized
}

const blocked = new Set([
  "authorization", "x-api-key", "cookie", "host", "content-length", "connection",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "x-rawroute-session-id", "x-session-id", "session_id",
])

export function buildCodexHeaders(requestHeaders: Headers, providerHeaders: Readonly<Record<string, string>>, accessToken: string, accountId?: string, sessionKey?: string) {
  const headers = new Headers()
  requestHeaders.forEach((value, key) => { if (!blocked.has(key)) headers.set(key, value) })
  for (const [key, value] of Object.entries(providerHeaders)) headers.set(key, value)
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
