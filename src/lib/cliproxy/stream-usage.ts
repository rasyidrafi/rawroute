import { extractUsageMetrics, mergeUsage, type UsageMetrics } from "@/lib/usage-metrics"

function objectValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
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
