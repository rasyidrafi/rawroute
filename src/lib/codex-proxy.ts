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
  normalized.parallel_tool_calls = false
  normalized.include = ["reasoning.encrypted_content"]
  normalized.instructions ??= ""
  normalized.input = normalizeInput(normalized.input)
  for (const field of removedFields) delete normalized[field]
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

function responseEventBlocks(raw: string) {
  return raw.split(/\r?\n\r?\n/).filter((block) => block.trim().length > 0)
}

function responseEventData(block: string) {
  const dataLines = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
  if (!dataLines.length) return undefined
  const data = dataLines.join("\n")
  if (!data || data === "[DONE]") return undefined
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function formatResponsesSseBlock(block: string) {
  const lines = block.split(/\r?\n/)
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim()
  const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
  if (!dataLines.length) return ""
  const data = dataLines.join("\n")
  if (data === "[DONE]") return "data: [DONE]\n\n"
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    const type = eventName || (typeof parsed.type === "string" ? parsed.type : undefined)
    const serialized = JSON.stringify(parsed)
    return type ? `event: ${type}\ndata: ${serialized}\n\n` : `data: ${serialized}\n\n`
  } catch {
    return `${block.trim()}\n\n`
  }
}

export function normalizeCodexResponsesStream(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ""
      for (const block of blocks) {
        const formatted = formatResponsesSseBlock(block)
        if (formatted) controller.enqueue(encoder.encode(formatted))
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (!buffer.trim()) return
      const formatted = formatResponsesSseBlock(buffer)
      if (formatted) controller.enqueue(encoder.encode(formatted))
    },
  }))
}

export function collectCodexResponsesSse(raw: string) {
  let created: Record<string, unknown> | undefined
  let completed: Record<string, unknown> | undefined
  let terminalType = "response.completed"
  let sawResponsesEvent = false
  let terminalError: Record<string, unknown> | undefined
  const outputItems = new Map<number, unknown>()

  for (const block of responseEventBlocks(raw)) {
    const event = responseEventData(block)
    if (!event) continue
    const type = typeof event.type === "string" ? event.type : block.match(/^event:\s*([^\r\n]+)/m)?.[1]?.trim()
    if (type?.startsWith("response.") || type === "error") sawResponsesEvent = true
    const response = objectValue(event.response)
    if (type === "response.created" && response) created = response
    if (type === "response.output_item.done" && Number.isInteger(event.output_index)) {
      outputItems.set(event.output_index as number, event.item)
    }
    if (type === "response.completed" || type === "response.done" || type === "response.failed" || type === "error") {
      terminalType = type
      if (response) completed = response
      if (type === "error") terminalError = objectValue(event.error) || event
    }
  }

  if (!created && !completed && outputItems.size === 0 && !sawResponsesEvent) return undefined
  const base = { ...(created || {}), ...(completed || {}) }
  const output = outputItems.size > 0
    ? [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
    : Array.isArray(base.output) ? base.output : []
  const usage = objectValue(base.usage) || { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  return {
    ...base,
    id: typeof base.id === "string" ? base.id : `resp_${Date.now()}`,
    object: typeof base.object === "string" ? base.object : "response",
    created_at: typeof base.created_at === "number" ? base.created_at : Math.floor(Date.now() / 1000),
    status: typeof base.status === "string" ? base.status : (terminalType === "response.failed" || terminalType === "error" ? "failed" : "completed"),
    ...(terminalError && !base.error ? { error: terminalError } : {}),
    output,
    usage,
  }
}
